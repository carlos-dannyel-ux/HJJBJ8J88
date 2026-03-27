require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const serverless = require('serverless-http');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'dev_secret_30win';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// PostgreSQL Connection Pool
const dbUrl = (process.env.DATABASE_URL || '').trim();

if (!dbUrl) {
    console.error('CRITICAL: DATABASE_URL is not defined!');
}

const pool = new Pool({
    connectionString: dbUrl,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
});

// --- Middleware: Verify JWT ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, error: 'Acesso negado. Faça login.' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ success: false, error: 'Sessão expirada.' });
        req.user = user;
        next();
    });
};

// --- AUTH ENDPOINTS ---

app.post('/api/auth/register', async (req, res) => {
    const { phone, password, invitedBy } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, error: 'Telefone e senha obrigatórios.' });

    try {
        // Check phone uniqueness
        const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (existing.rows.length > 0) return res.status(400).json({ success: false, error: 'Telefone já cadastrado.' });

        // Retrieve System Settings for Bonus
        const settingsRows = await pool.query("SELECT key_name, key_value FROM system_settings WHERE key_name IN ('signup_bonus_val', 'signup_rollover_mult')");
        let signupBonus = 0;
        let rolloverMult = 1;
        settingsRows.rows.forEach(row => {
            if (row.key_name === 'signup_bonus_val') signupBonus = parseFloat(row.key_value) || 0;
            if (row.key_name === 'signup_rollover_mult') rolloverMult = parseFloat(row.key_value) || 1;
        });

        const rolloverReq = signupBonus * rolloverMult;

        // Auto-generate ID and Username
        const randNum = Math.floor(10000 + Math.random() * 90000).toString(); // e.g. 83921
        const id_user = randNum;
        const name = `user${randNum}`;

        const hashedPassword = await bcrypt.hash(password, 10);
        const referral_code = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();

        await pool.query(
            'INSERT INTO users (id_user, phone, password, name, balance, bonus_balance, rollover_required, rollover_progress, referral_code, invited_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
            [id_user, phone, hashedPassword, name, 0.00, signupBonus, rolloverReq, 0.00, referral_code, invitedBy || null]
        );

        res.json({ success: true, message: 'Cadastro realizado com sucesso!' });
    } catch (err) {
        console.error('Register Erro:', err);
        if (err.code === '23505') return res.status(400).json({ success: false, error: 'Telefone já cadastrado.' });
        res.status(500).json({ success: false, error: 'Erro interno ao cadastrar.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const rows = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (rows.rows.length === 0) return res.status(400).json({ success: false, error: 'Usuário não encontrado.' });

        const user = rows.rows[0];
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ success: false, error: 'Senha incorreta.' });

        const token = jwt.sign({ id: user.id, phone: user.phone, referral_code: user.referral_code }, SECRET_KEY, { expiresIn: '24h' });
        res.json({ success: true, token, user: { phone: user.phone, balance: user.balance, id_user: user.id_user } });
    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ success: false, error: 'Erro no servidor.' });
    }
});

// --- USER & REFERRAL ENDPOINTS ---

app.get('/api/user/info', authenticateToken, async (req, res) => {
    try {
        const rows = await pool.query('SELECT id_user, phone, balance, referral_code, rewards_pending, withdraw_password, rollover_required, rollover_progress FROM users WHERE id = $1', [req.user.id]);
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

        const user = rows.rows[0];
        const userData = {
            id_user: user.id_user,
            phone: user.phone,
            balance: user.balance,
            referral_code: user.referral_code,
            rewards_pending: user.rewards_pending,
            rollover_required: user.rollover_required,
            rollover_progress: user.rollover_progress,
            has_withdraw_password: !!user.withdraw_password
        };

        res.json({ success: true, user: userData });
    } catch (err) {
        console.error('User Info Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar perfil.' });
    }
});

app.get('/api/referral/qr', authenticateToken, async (req, res) => {
    const inviteUrl = `/AUTH.HTML?ref=${req.user.referral_code}`;
    try {
        const qrCodeData = await qrcode.toDataURL(inviteUrl);
        res.json({ success: true, qr: qrCodeData, url: inviteUrl });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao gerar QR Code.' });
    }
});

app.get('/api/referral/stats', authenticateToken, async (req, res) => {
    try {
        const subs = await pool.query('SELECT COUNT(*) as count FROM users WHERE invited_by = $1', [req.user.referral_code]);
        const user = await pool.query('SELECT rewards_pending FROM users WHERE id = $1', [req.user.id]);
        res.json({ success: true, stats: { totalSubordinates: parseInt(subs.rows[0].count), rewardsPending: user.rows[0].rewards_pending } });
    } catch (err) {
        console.error('Referral Stats Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar convites.' });
    }
});

app.post('/api/referral/claim', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query('SELECT rewards_pending FROM users WHERE id = $1', [req.user.id]);
        const amount = parseFloat(user.rows[0].rewards_pending);
        if (amount <= 0) return res.status(400).json({ success: false, error: 'Nenhum prêmio para resgatar.' });

        await pool.query('UPDATE users SET balance = balance + $1, rewards_pending = 0 WHERE id = $2', [amount, req.user.id]);
        res.json({ success: true, message: `R$ ${amount.toFixed(2)} resgatados com sucesso!` });
    } catch (err) {
        console.error('Claim Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao resgatar.' });
    }
});

// --- ADMIN ENDPOINTS ---

app.post('/api/admin/login', async (req, res) => {
    const { operatorId, password } = req.body;
    try {
        const rows = await pool.query('SELECT * FROM admins WHERE operator_id = $1 AND password = $2', [operatorId, password]);
        if (rows.rows.length > 0) {
            res.json({ success: true, message: 'Login realizado com sucesso!' });
        } else {
            res.status(401).json({ success: false, error: 'ID de Operador ou Senha inválidos.' });
        }
    } catch (err) {
        console.error('Admin Login Error:', err);
        return res.status(500).json({
            success: false,
            error: 'Erro no servidor ao acessar o banco.',
            details: err.message,
            code: err.code
        });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*) as count FROM users');
        const totalBilling = await pool.query('SELECT SUM(balance) as total FROM users');
        res.json({
            success: true,
            stats: {
                totalBilling: Number(totalBilling.rows[0].total || 0).toFixed(2),
                activePlayers: Math.floor(Math.random() * 2000) + 500, // Placeholder simulado
                registeredUsers: parseInt(usersCount.rows[0].count)
            }
        });
    } catch (err) {
        console.error('Error in /api/admin/stats:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas.' });
    }
});

// --- MAX API GAMES INTEGRATION ---

app.get('/api/admin/api-credentials', async (req, res) => {
    try {
        const rows = await pool.query('SELECT * FROM api_credentials WHERE module = $1', ['max_api']);
        res.json({ success: true, credentials: rows.rows[0] || {} });
    } catch (err) {
        console.error('Error in /api/admin/api-credentials:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar credenciais.' });
    }
});

app.post('/api/admin/api-credentials', async (req, res) => {
    const { agent_code, agent_token, agent_secret } = req.body;
    try {
        await pool.query(
            `INSERT INTO api_credentials (module, agent_code, agent_token, agent_secret) 
             VALUES ('max_api', $1, $2, $3) 
             ON CONFLICT (module) DO UPDATE SET agent_code = EXCLUDED.agent_code, agent_token = EXCLUDED.agent_token, agent_secret = EXCLUDED.agent_secret`,
            [agent_code, agent_token, agent_secret]
        );
        res.json({ success: true, message: 'Credenciais salvas com sucesso!' });
    } catch (err) {
        console.error('Save Credentials Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao salvar credenciais.' });
    }
});

app.post('/api/admin/games/extract', async (req, res) => {
    try {
        const creds = await pool.query('SELECT * FROM api_credentials WHERE module = $1', ['max_api']);
        if (creds.rows.length === 0) return res.status(400).json({ success: false, error: 'Configure as credenciais primeiro.' });

        const { agent_code, agent_token } = creds.rows[0];

        const response = await axios.post('https://maxapigames.com/api/v2', {
            method: 'game_list',
            agent_code: agent_code,
            agent_token: agent_token
        });

        const data = response.data;
        if (data.status !== 1) return res.status(400).json({ success: false, error: data.msg || 'Erro na API.' });

        const games = data.games || [];
        let inserted = 0;

        for (const game of games) {
            let bannerPath = null;
            if (game.banner) {
                const remoteUrl = `https://maxapigames.com${game.banner}`;
                const localFileName = `${game.game_code}.png`;
                const localPath = path.join(__dirname, 'public', 'banners', localFileName);
                const publicPath = `/public/banners/${localFileName}`;

                try {
                    // Solo intenta descargar si NO existe localmente para ahorrar recursos
                    if (!fs.existsSync(localPath)) {
                        const imgRes = await axios({
                            url: remoteUrl,
                            method: 'GET',
                            responseType: 'arraybuffer',
                            headers: { 'Referer': 'https://maxapigames.com/' },
                            timeout: 5000
                        });
                        fs.writeFileSync(localPath, imgRes.data);
                    }
                    bannerPath = publicPath;
                } catch (err) {
                    bannerPath = `https://wsrv.nl/?url=${encodeURIComponent(remoteUrl)}&w=300&output=webp`;
                }
            }

            await pool.query(
                `INSERT INTO games (game_code, provider_code, game_name, banner_path, status)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (game_code) DO UPDATE SET
                    provider_code = EXCLUDED.provider_code,
                    game_name = EXCLUDED.game_name,
                    banner_path = EXCLUDED.banner_path,
                    status = EXCLUDED.status`,
                [game.game_code, game.provider_code, game.game_name, bannerPath, game.status]
            );
            inserted++;
        }

        res.json({ success: true, message: `Extração concluída! ${inserted} jogos salvos.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Erro ao extrair jogos.' });
    }
});

app.post('/api/admin/games/remove', async (req, res) => {
    try {
        await pool.query('TRUNCATE TABLE games');
        res.json({ success: true, message: 'Todos os jogos foram removidos.' });
    } catch (err) {
        console.error('Remove Games Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao remover jogos.' });
    }
});

// Removido proxy local que estava lento

app.get('/api/games', async (req, res) => {
    try {
        const rows = await pool.query('SELECT * FROM games WHERE status = 1 ORDER BY provider_code, game_name');

        const grouped = {};
        const popular = [];

        for (const game of rows.rows) {
            if (game.is_popular) {
                popular.push(game);
            }

            if (!grouped[game.provider_code]) {
                grouped[game.provider_code] = [];
            }
            grouped[game.provider_code].push(game);
        }

        res.json({ success: true, providers: grouped, popular: popular });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao buscar jogos.' });
    }
});

app.post('/api/admin/games/update-popular', async (req, res) => {
    const { gameCodes, isPopular } = req.body;
    if (!Array.isArray(gameCodes)) return res.status(400).json({ success: false, error: 'IDs inválidos' });

    try {
        await pool.query(
            'UPDATE games SET is_popular = $1 WHERE game_code = ANY($2)',
            [isPopular, gameCodes]
        );
        res.json({ success: true, message: 'Status atualizado com sucesso!' });
    } catch (err) {
        console.error('Update Popular Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao atualizar status popular.' });
    }
});

// --- ADMIN: USERS & GGPIX ---

app.get('/api/admin/users', async (req, res) => {
    try {
        const rows = await pool.query('SELECT id, id_user, phone, name, is_demo, plain_password, balance, bonus_balance, rollover_required, rollover_progress, (withdraw_password IS NOT NULL) as has_pin, created_at FROM users ORDER BY id DESC');
        res.json({ success: true, users: rows.rows });
    } catch (err) {
        console.error('Get Users Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar usuários.' });
    }
});

app.post('/api/admin/users/demo', async (req, res) => {
    const { phone, password, name } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, error: 'Telefone e senha são obrigatórios.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const id_user = Math.floor(100000000 + Math.random() * 900000000).toString();
        const referral_code = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();

        await pool.query(
            'INSERT INTO users (id_user, phone, password, plain_password, name, is_demo, balance, referral_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [id_user, phone, hashedPassword, password, name || 'Demo', true, 0.00, referral_code]
        );
        res.json({ success: true, message: 'Usuário Demo criado com sucesso!' });
    } catch (err) {
        console.error('Insert Demo Error:', err);
        if (err.code === '23505') return res.status(400).json({ success: false, error: 'Telefone já cadastrado.' });
        res.status(500).json({ success: false, error: 'Erro interno ao cadastrar demo.' });
    }
});

app.put('/api/admin/users/:id', async (req, res) => {
    const { id } = req.params;
    const { password, name } = req.body;
    try {
        const updates = [];
        const values = [];

        if (password) {
            updates.push('password = ?', 'plain_password = ?');
            values.push(await bcrypt.hash(password, 10), password);
        }
        if (name !== undefined) {
            updates.push('name = ?');
            values.push(name);
        }

        if (updates.length > 0) {
            values.push(id);
            await pool.query(`UPDATE users SET ${updates.map((u, i) => u.replace('?', '$' + (i + 1))).join(', ')} WHERE id = $${updates.length + 1}`, values);
        }
        res.json({ success: true, message: 'Usuário atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao editar usuário.' });
    }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true, message: 'Usuário excluído com sucesso!' });
    } catch (err) {
        console.error('Delete User Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao excluir usuário (verifique relações externas).' });
    }
});

app.get('/api/admin/users/:id/details', async (req, res) => {
    const { id } = req.params;
    try {
        const deposits = await pool.query("SELECT amount, method, status, external_id, created_at FROM deposits WHERE user_id = $1 ORDER BY created_at DESC", [id]);
        const withdrawals = await pool.query("SELECT amount, pix_type, status, created_at FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC", [id]);

        res.json({
            success: true,
            deposits: deposits.rows,
            withdrawals: withdrawals.rows
        });
    } catch (err) {
        console.error('User Details Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar histórico do usuário.' });
    }
});

app.get('/api/admin/ggpix-credentials', async (req, res) => {
    try {
        const rows = await pool.query('SELECT * FROM api_credentials WHERE module = $1', ['ggpix_api']);
        res.json({ success: true, credentials: rows.rows[0] || {} });
    } catch (err) {
        console.error('Get GGPIX Credentials Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar credenciais.' });
    }
});

app.post('/api/admin/ggpix-credentials', async (req, res) => {
    const { agent_token } = req.body; // API Key do GGPIX
    if (!agent_token) return res.status(400).json({ success: false, error: 'API Key GGPIX é obrigatória' });
    try {
        await pool.query(
            `INSERT INTO api_credentials (module, agent_code, agent_token) VALUES ('ggpix_api', 'ggpix', $1) 
             ON CONFLICT (module) DO UPDATE SET agent_token = EXCLUDED.agent_token`,
            [agent_token]
        );
        res.json({ success: true, message: 'Credenciais Salvas!' });
    } catch (err) {
        console.error('Save GGPIX Credentials Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao salvar credenciais' });
    }
});

app.get('/api/admin/system/settings', async (req, res) => {
    try {
        const rows = await pool.query('SELECT key_name, key_value FROM system_settings');
        const settings = {};
        rows.rows.forEach(r => settings[r.key_name] = r.key_value);

        // Ensure deposit_bonus_rules is a valid JSON string if it exists
        if (!settings.deposit_bonus_rules) {
            settings.deposit_bonus_rules = '[]';
        }

        res.json({ success: true, settings });
    } catch (err) {
        console.error('Get System Settings Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar configurações.' });
    }
});

app.post('/api/admin/system/settings', async (req, res) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ success: false, error: 'Dados inválidos.' });

    try {
        for (const [key, val] of Object.entries(settings)) {
            let processedVal = String(val);
            if (key === 'deposit_bonus_rules' && typeof val === 'object') {
                processedVal = JSON.stringify(val);
            }
            await pool.query(
                'INSERT INTO system_settings (key_name, key_value) VALUES ($1, $2) ON CONFLICT (key_name) DO UPDATE SET key_value = EXCLUDED.key_value',
                [key, processedVal]
            );
        }
        res.json({ success: true, message: 'Configurações salvas!' });
    } catch (err) {
        console.error('System Settings Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao salvar configurações.' });
    }
});

app.get('/api/admin/deposits', async (req, res) => {
    try {
        const rows = await pool.query(`
            SELECT d.id, d.amount, d.status, d.created_at, u.phone, u.name, u.is_demo 
            FROM deposits d JOIN users u ON d.user_id = u.id ORDER BY d.id DESC LIMIT 200
        `);
        res.json({ success: true, deposits: rows.rows });
    } catch (err) {
        console.error('Admin Deposits Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar depositos' });
    }
});

app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const rows = await pool.query(`
            SELECT w.id, w.amount, w.pix_key, w.pix_type, w.status, w.created_at, u.phone, u.name 
            FROM withdrawals w JOIN users u ON w.user_id = u.id ORDER BY w.id DESC
        `);
        res.json({ success: true, withdrawals: rows.rows });
    } catch (err) {
        console.error('Admin Withdrawals Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar saques' });
    }
});

app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
    const { id } = req.params;
    try {
        const wRows = await pool.query('SELECT * FROM withdrawals WHERE id = $1 AND status = \'pending\'', [id]);
        if (wRows.rows.length === 0) return res.status(400).json({ success: false, error: 'Saque não pendente ou inv.' });

        const w = wRows.rows[0];

        const apiRows = await pool.query('SELECT agent_token FROM api_credentials WHERE module = \'ggpix_api\'');
        if (apiRows.rows.length === 0 || !apiRows.rows[0].agent_token) return res.status(400).json({ success: false, error: 'GGPIX nao cfg.' });

        const apiKey = apiRows[0].agent_token;

        const response = await axios.post('https://ggpixapi.com/api/v1/pix/out', {
            amountCents: Math.round(w.amount * 100),
            pixKey: w.pix_key,
            pixKeyType: w.pix_type,
            externalId: 'sq-' + w.id
        }, { headers: { 'X-API-Key': apiKey } });

        if (response.status === 201 || response.status === 200) {
            await pool.query('UPDATE withdrawals SET status = \'approved\' WHERE id = $1', [id]);
            res.json({ success: true, message: 'Saque aprovado e enviado!' });
        } else {
            res.status(400).json({ success: false, error: 'Falha GGPIX.' });
        }
    } catch (err) {
        console.error('Approve Withdrawal Error:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: 'Erro de integração GGPIX.' });
    }
});

app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
    const { id } = req.params;
    try {
        const wRows = await pool.query('SELECT * FROM withdrawals WHERE id = $1 AND status = \'pending\'', [id]);
        if (wRows.rows.length === 0) return res.status(400).json({ success: false, error: 'Saque não pendente/inv.' });
        const w = wRows.rows[0];

        await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [w.amount, w.user_id]);
        await pool.query('UPDATE withdrawals SET status = \'rejected\' WHERE id = $1', [id]);
        res.json({ success: true, message: 'Saque recusado, saldo devolvido.' });
    } catch (err) {
        console.error('Reject Withdrawal Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao recusar.' });
    }
});

// --- GGPIX & PAYMENTS (CLIENTS) ---

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ success: false, error: 'Mínimo de R$ 1,00.' });

    try {
        const uRow = await pool.query('SELECT is_demo, name, phone FROM users WHERE id = $1', [req.user.id]);
        const user = uRow.rows[0];

        if (user.is_demo) {
            return res.json({
                success: true,
                is_demo: true,
                pixCopyPaste: '00020101021226820014br.gov.bcb.pixFICTICIO_DEMO',
                pixCode: '00020101021226820014br.gov.bcb.pixFICTICIO_DEMO',
                message: 'QR Code Fictício Gerado (Aguarde 8s...)'
            });
        }

        const apiRows = await pool.query('SELECT agent_token FROM api_credentials WHERE module = \'ggpix_api\'');
        if (apiRows.rows.length === 0 || !apiRows.rows[0].agent_token) return res.status(400).json({ success: false, error: 'Pix indisp.' });

        const apiKey = apiRows[0].agent_token;
        const externalId = 'dep-' + req.user.id + '-' + Date.now();
        // The fake/default document helps bypass if users don't have valid CPF. But ggpix likely needs exactly 11 valid numbers. We'll pass random CPF generic if needed, but user might have a generic phone like '92996036214'. Let's send the phone.
        let doc = user.phone && user.phone.length >= 11 ? user.phone.substring(0, 11) : '00000000000';

        const response = await axios.post('https://ggpixapi.com/api/v1/pix/in', {
            amountCents: Math.round(amount * 100),
            description: 'Depósito Plataforma',
            payerName: user.name || 'Jogador',
            payerDocument: doc,
            externalId: externalId
        }, { headers: { 'X-API-Key': apiKey } });

        if (response.status === 201 || response.status === 200) {
            const data = response.data;
            await pool.query('INSERT INTO deposits (user_id, amount, method, status, external_id) VALUES ($1, $2, $3, $4, $5)',
                [req.user.id, amount, 'PIX', 'pending', data.id || externalId]);
            res.json({ success: true, pixCopyPaste: data.pixCopyPaste, pixCode: data.pixCode });
        } else {
            res.status(400).json({ success: false, error: 'Erro ao gerar PIX.' });
        }
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ success: false, error: 'Sistema PIX indisponível.' });
    }
});

app.post('/api/fictitious-deposit', authenticateToken, async (req, res) => {
    const { amount } = req.body;
    try {
        const uRow = await pool.query('SELECT is_demo FROM users WHERE id = $1', [req.user.id]);
        if (!uRow.rows[0].is_demo) return res.status(403).json({ success: false, error: 'Restrito para modo demo.' });

        await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, req.user.id]);
        await pool.query('INSERT INTO deposits (user_id, amount, method, status) VALUES ($1, $2, $3, $4)',
            [req.user.id, amount, 'FICTITICIO', 'completed']);

        res.json({ success: true, message: 'Depósito debitado na conta Demo!' });
    } catch (err) {
        console.error('Fictitious Deposit Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao debitar.' });
    }
});

app.post('/api/ggpix/webhook', async (req, res) => {
    try {
        const payload = req.body;
        if (payload.status === 'COMPLETE' && payload.type === 'PIX_IN') {
            const external_id = payload.transactionId || payload.externalId;
            let stmt = 'SELECT * FROM deposits WHERE external_id = $1 AND status = \'pending\'';
            let dep = await pool.query(stmt, [payload.transactionId]);

            if (dep.rows.length === 0 && payload.externalId) {
                const dep2 = await pool.query(stmt, [payload.externalId]);
                dep = dep2;
            }

            if (dep.rows.length > 0) {
                const amount = parseFloat(dep.rows[0].amount);

                // Get system settings for deposit bonus
                const sRows = await pool.query("SELECT key_name, key_value FROM system_settings WHERE key_name IN ('deposit_bonus_val', 'deposit_rollover_mult', 'deposit_bonus_rules')");
                let bonusVal = 0;
                let rollMult = 1;
                let bonusRules = [];

                sRows.rows.forEach(r => {
                    if (r.key_name === 'deposit_bonus_val') bonusVal = parseFloat(r.key_value) || 0;
                    if (r.key_name === 'deposit_rollover_mult') rollMult = parseFloat(r.key_value) || 1;
                    if (r.key_name === 'deposit_bonus_rules') {
                        try {
                            bonusRules = JSON.parse(r.key_value);
                        } catch (e) { bonusRules = []; }
                    }
                });

                // Apply Dynamic Rules if they exist
                if (Array.isArray(bonusRules) && bonusRules.length > 0) {
                    // Sort rules by min amount descending to find the highest applicable rule
                    const applicableRule = bonusRules
                        .filter(rule => amount >= rule.min)
                        .sort((a, b) => b.min - a.min)[0];

                    if (applicableRule) {
                        bonusVal = parseFloat(applicableRule.bonus) || 0;
                        rollMult = parseFloat(applicableRule.rollover) || 1;
                    }
                }

                let addedRollover = 0;
                // Rollover applies if bonus is given
                if (bonusVal > 0) {
                    addedRollover = (amount + bonusVal) * rollMult;
                }

                await pool.query(
                    'UPDATE users SET balance = balance + $1, bonus_balance = bonus_balance + $2, rollover_required = rollover_required + $3 WHERE id = $4',
                    [amount, bonusVal, addedRollover, dep.rows[0].user_id]
                );
                await pool.query('UPDATE deposits SET status = \'completed\' WHERE id = $1', [dep.rows[0].id]);
            }
        }
        res.json({ received: true });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Erro no webhook' });
    }
});

app.post('/api/withdraw', authenticateToken, async (req, res) => {
    const { amount, pix_key, pix_type, withdraw_password } = req.body;

    try {
        const uRows = await pool.query('SELECT balance, rollover_required, rollover_progress, withdraw_password FROM users WHERE id = $1', [req.user.id]);
        if (uRows.rows.length === 0) return res.status(400).json({ success: false, error: 'Usuário não encontrado.' });

        const user = uRows.rows[0];

        // Settings Check
        const sRows = await pool.query('SELECT key_name, key_value FROM system_settings WHERE key_name = \'min_withdraw\'');
        let minWithdraw = 50.00;
        if (sRows.rows.length > 0) minWithdraw = parseFloat(sRows.rows[0].key_value) || 50.00;

        if (!amount || amount < minWithdraw) return res.status(400).json({ success: false, error: `Saque mínimo de R$ ${minWithdraw.toFixed(2)}.` });
        if (!pix_key || !pix_type) return res.status(400).json({ success: false, error: 'Chave PIX inválida.' });

        // Password validation
        if (!user.withdraw_password) {
            return res.status(400).json({ success: false, error: 'Crie uma senha de saque antes de solicitar o primeiro resgate.', requires_pin_setup: true });
        }

        const validPass = await bcrypt.compare(String(withdraw_password), user.withdraw_password);
        if (!validPass) return res.status(400).json({ success: false, error: 'Senha de saque incorreta.' });

        // Rollover validation
        if (user.rollover_progress < user.rollover_required) {
            const diff = user.rollover_required - user.rollover_progress;
            return res.status(400).json({ success: false, error: `Ainda falta R$ ${diff.toFixed(2)} em apostas para sacar.` });
        }

        if (parseFloat(user.balance) < amount) return res.status(400).json({ success: false, error: 'Saldo insuficiente.' });

        await pool.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);
        await pool.query('INSERT INTO withdrawals (user_id, amount, pix_key, pix_type, status) VALUES ($1, $2, $3, $4, \'pending\')',
            [req.user.id, amount, pix_key, pix_type]);

        res.json({ success: true, message: 'Solicitação de saque enviada com sucesso!' });
    } catch (err) {
        console.error('Withdraw Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao solicitar saque.' });
    }
});

app.post('/api/finance/withdraw-password', authenticateToken, async (req, res) => {
    const { new_password } = req.body;
    if (!new_password || String(new_password).length < 4) return res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 4 caracteres.' });

    try {
        const hashedPassword = await bcrypt.hash(String(new_password), 10);
        await pool.query('UPDATE users SET withdraw_password = $1 WHERE id = $2', [hashedPassword, req.user.id]);
        res.json({ success: true, message: 'Senha de saque criada com sucesso!' });
    } catch (err) {
        console.error('PIN Create Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao criar a senha de saque.' });
    }
});

// --- ROUTES FOR HTML ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

// --- EXPORT FOR NETLIFY ---
module.exports = app;
module.exports.handler = serverless(app);

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Servidor rodando localmente em http://localhost:${PORT}`);
    });
}
