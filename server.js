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
} else {
    // Log partially masked URL for debugging in Netlify
    const maskedUrl = dbUrl.replace(/:([^@]+)@/, ':****@');
    console.log(`Database URL detected: ${maskedUrl}`);
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

// Test connection on startup
if (process.env.NODE_ENV === 'production') {
    pool.query('SELECT NOW()')
        .then(() => console.log('Database connected successfully on startup'))
        .catch(err => console.error('Database connection failed on startup:', err.message));
}

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

        const user_type = process.env.DEFAULT_DEMO_TYPE || 'standard'; // standard ou influencer
        await pool.query(
            'INSERT INTO users (id_user, phone, password, name, balance, is_demo, user_type, referral_code, invited_by, bonus_balance, rollover_required) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
            [id_user, phone, hashedPassword, name, signupBonus, true, user_type, referral_code, invitedBy || null, signupBonus, rolloverReq]
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

        // Update last_active for real-time active players tracking
        await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id]).catch(() => { });

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

app.get('/api/user/deposits', authenticateToken, async (req, res) => {
    try {
        const rows = await pool.query('SELECT amount, status, created_at FROM deposits WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json({ success: true, deposits: rows.rows });
    } catch (err) {
        console.error('Fetch Deposits Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar depósitos.' });
    }
});

app.get('/api/user/withdrawals', authenticateToken, async (req, res) => {
    try {
        const rows = await pool.query('SELECT amount, status, created_at FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.json({ success: true, withdrawals: rows.rows });
    } catch (err) {
        console.error('Fetch Withdrawals Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar saques.' });
    }
});

// --- SECURITY ENDPOINTS ---
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ success: false, error: 'Preencha todos os campos.' });
    if (new_password.length < 6) return res.status(400).json({ success: false, error: 'A nova senha deve ter pelo menos 6 caracteres.' });

    try {
        const rows = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

        const valid = await bcrypt.compare(current_password, rows.rows[0].password);
        if (!valid) return res.status(401).json({ success: false, error: 'Senha atual incorreta.' });

        const hashed = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id]);
        res.json({ success: true, message: 'Senha alterada com sucesso!' });
    } catch (err) {
        console.error('Change Password Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao alterar senha.' });
    }
});

app.post('/api/user/change-pin', authenticateToken, async (req, res) => {
    const { current_pin, new_pin } = req.body;
    if (!current_pin || !new_pin) return res.status(400).json({ success: false, error: 'Preencha todos os campos.' });
    if (new_pin.length !== 6) return res.status(400).json({ success: false, error: 'O novo PIN deve ter exatamente 6 dígitos.' });

    try {
        const rows = await pool.query('SELECT withdraw_password FROM users WHERE id = $1', [req.user.id]);
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
        if (!rows.rows[0].withdraw_password) return res.status(400).json({ success: false, error: 'Você ainda não tem um PIN. Crie um primeiro na tela de Saques.' });

        const valid = await bcrypt.compare(String(current_pin), rows.rows[0].withdraw_password);
        if (!valid) return res.status(401).json({ success: false, error: 'PIN atual incorreto.' });

        const hashedPin = await bcrypt.hash(String(new_pin), 10);
        await pool.query('UPDATE users SET withdraw_password = $1 WHERE id = $2', [hashedPin, req.user.id]);
        res.json({ success: true, message: 'PIN de saque alterado com sucesso!' });
    } catch (err) {
        console.error('Change PIN Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao alterar PIN.' });
    }
});

app.post('/api/user/delete-account', authenticateToken, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, error: 'Confirme com sua senha.' });

    try {
        const rows = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        if (rows.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

        const valid = await bcrypt.compare(password, rows.rows[0].password);
        if (!valid) return res.status(401).json({ success: false, error: 'Senha incorreta.' });

        await pool.query('DELETE FROM deposits WHERE user_id = $1', [req.user.id]);
        await pool.query('DELETE FROM withdrawals WHERE user_id = $1', [req.user.id]);
        await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);

        res.json({ success: true, message: 'Conta excluída com sucesso.' });
    } catch (err) {
        console.error('Delete Account Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao excluir conta.' });
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
        // Faturamento mensal: soma de depósitos PIX concluídos no mês atual
        const billingResult = await pool.query(`
            SELECT COALESCE(SUM(d.amount), 0) as total
            FROM deposits d
            WHERE d.status = 'completed'
              AND d.method = 'PIX'
              AND DATE_TRUNC('month', d.created_at) = DATE_TRUNC('month', NOW())
        `);

        // Faturamento de ontem para a %
        const yesterdayBilling = await pool.query(`
            SELECT COALESCE(SUM(d.amount), 0) as total
            FROM deposits d
            WHERE d.status = 'completed'
              AND d.method = 'PIX'
              AND DATE_TRUNC('day', d.created_at) = DATE_TRUNC('day', NOW() - INTERVAL '1 day')
        `);

        // Faturamento de hoje (para comparar com ontem)
        const todayBilling = await pool.query(`
            SELECT COALESCE(SUM(d.amount), 0) as total
            FROM deposits d
            WHERE d.status = 'completed'
              AND d.method = 'PIX'
              AND DATE_TRUNC('day', d.created_at) = DATE_TRUNC('day', NOW())
        `);

        const tToday = parseFloat(todayBilling.rows[0].total) || 0;
        const tYesterday = parseFloat(yesterdayBilling.rows[0].total) || 0;
        let pChange = 0;
        if (tYesterday > 0) {
            pChange = ((tToday - tYesterday) / tYesterday) * 100;
        } else if (tToday > 0) {
            pChange = 100; // se ontem foi 0 e hoje > 0, 100% de aumento
        }

        // Jogadores ativos: usuários com last_active nos últimos 5 minutos
        const activeResult = await pool.query(`
            SELECT COUNT(*) as count FROM users
            WHERE last_active >= NOW() - INTERVAL '5 minutes'
        `);

        // Usuários cadastrados: total de usuários reais + usuários demo do tipo 'standard'
        const usersCount = await pool.query("SELECT COUNT(*) as count FROM users WHERE is_demo = false OR user_type = 'standard'");

        // Capacidade do Servidor base (ex: 50% mock base + variação baseada em players)
        const activePlayers = parseInt(activeResult.rows[0].count) || 0;
        // Formula exemplo: 10% fixo + (active / 2000) * 90%, min 10 max 100
        let serverCap = 10 + Math.floor((activePlayers / 2000) * 90);
        if (serverCap > 100) serverCap = 100;

        res.json({
            success: true,
            stats: {
                totalBilling: Number(billingResult.rows[0].total || 0).toFixed(2),
                billingPercentChange: pChange.toFixed(1),
                activePlayers: activePlayers,
                serverCapacity: serverCap,
                registeredUsers: parseInt(usersCount.rows[0].count)
            }
        });
    } catch (err) {
        console.error('Error in /api/admin/stats:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas.' });
    }
});

// Endpoint: Histórico de Depósitos PIX para o Dashboard
app.get('/api/admin/dashboard-deposits', async (req, res) => {
    try {
        const rows = await pool.query(`
            SELECT
                d.id,
                d.amount,
                d.method,
                d.status,
                d.created_at,
                u.name,
                u.phone,
                u.id_user,
                u.is_demo
            FROM deposits d
            JOIN users u ON d.user_id = u.id
            WHERE d.method = 'PIX'
              AND d.status IN ('completed', 'pending', 'failed')
            ORDER BY d.created_at DESC
            LIMIT 20
        `);
        res.json({ success: true, deposits: rows.rows });
    } catch (err) {
        console.error('Dashboard Deposits Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar histórico de depósitos.' });
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
        console.error('Error in /api/games:', {
            message: err.message,
            code: err.code,
            detail: err.detail,
            stack: err.stack
        });
        res.status(500).json({ success: false, error: 'Erro ao buscar jogos.', debug: err.message });
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
        const rows = await pool.query('SELECT id, id_user, phone, name, is_demo, user_type, plain_password, balance, bonus_balance, rollover_required, rollover_progress, (withdraw_password IS NOT NULL) as has_pin, created_at FROM users ORDER BY id DESC');
        res.json({ success: true, users: rows.rows });
    } catch (err) {
        console.error('Get Users Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar usuários.' });
    }
});

app.post('/api/admin/users/demo', async (req, res) => {
    const { phone, password, name, user_type } = req.body;
    if (!phone || !password) return res.status(400).json({ success: false, error: 'Telefone e senha são obrigatórios.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const id_user = Math.floor(100000000 + Math.random() * 900000000).toString();
        const referral_code = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();

        const result = await pool.query(
            'INSERT INTO users (id_user, phone, password, plain_password, name, is_demo, user_type, balance, referral_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [id_user, phone, hashedPassword, password, name || 'Demo', true, user_type || 'standard', 0.00, referral_code]
        );
        const newUserId = result.rows[0].id;
        const isDemo = (user_type === 'influencer'); // For API sync logic below

        // --- AUTOMATIC SYNC WITH MAX API ---
        try {
            const creds = await pool.query('SELECT * FROM api_credentials WHERE module = $1', ['max_api']);
            if (creds.rows.length > 0) {
                const { agent_code, agent_token } = creds.rows[0];
                const userCode = `30win_user_${newUserId}`;

                // user_create
                await axios.post('https://maxapigames.com/api/v2', {
                    method: 'user_create',
                    agent_code,
                    agent_token,
                    user_code: userCode,
                    is_demo: isDemo
                }).catch(e => console.error(`[AutoSync] Error user_create for ${userCode}:`, e.message));

                // set_demo (ONLY FOR INFLUENCERS)
                if (isDemo) {
                    await axios.post('https://maxapigames.com/api/v2', {
                        method: 'set_demo',
                        agent_code,
                        agent_token,
                        user_code: userCode
                    }).catch(e => console.error(`[AutoSync] Error set_demo for ${userCode}:`, e.message));
                }

                console.log(`[AutoSync] User ${userCode} synced successfully as ${isDemo ? 'Demo/Influencer' : 'Real/Standard'}.`);
            }
        } catch (syncErr) {
            console.error('[AutoSync] Fatal sync error:', syncErr.message);
        }

        res.json({ success: true, message: 'Usuário Demo criado e sincronizado com a Max API!' });
    } catch (err) {
        console.error('Insert Demo Error:', err);
        if (err.code === '23505') return res.status(400).json({ success: false, error: 'Telefone já cadastrado.' });
        res.status(500).json({ success: false, error: 'Erro interno ao cadastrar demo.' });
    }
});

app.put('/api/admin/users/:id', async (req, res) => {
    const { id } = req.params;
    const { password, name, user_type } = req.body;
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
        if (user_type !== undefined) {
            updates.push('user_type = ?');
            values.push(user_type);
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
        // Limpar transações relacionadas primeiro para evitar erros de FK (opcional, dependendo do design, mas seguro)
        await pool.query('DELETE FROM deposits WHERE user_id = $1', [id]);
        await pool.query('DELETE FROM withdrawals WHERE user_id = $1', [id]);
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true, message: 'Usuário excluído com sucesso!' });
    } catch (err) {
        console.error('Delete User Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao excluir usuário.' });
    }
});

app.post('/api/admin/users/:id/adjust-balance', async (req, res) => {
    const { id } = req.params;
    const { amount, rollover_multiplier } = req.body;

    if (isNaN(amount)) return res.status(400).json({ success: false, error: 'Valor inválido.' });

    try {
        const addedRollover = parseFloat(amount) * (parseFloat(rollover_multiplier) || 0);

        await pool.query(
            'UPDATE users SET balance = balance + $1, rollover_required = rollover_required + $2 WHERE id = $3',
            [parseFloat(amount), addedRollover, id]
        );

        res.json({
            success: true,
            message: `Saldo ajustado em R$ ${parseFloat(amount).toFixed(2)}. Rollover adicionado: R$ ${addedRollover.toFixed(2)}`
        });
    } catch (err) {
        console.error('Adjust Balance Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao ajustar saldo.' });
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

        // Sincronização em tempo real com a MAX API para o RTP Demo (Standard seguindo o Ciclo)
        const allSettingsRows = await pool.query("SELECT key_name, key_value FROM system_settings WHERE key_name LIKE 'reward_%'");
        const allSettings = {};
        allSettingsRows.rows.forEach(r => allSettings[r.key_name] = r.key_value);

        const currentPhase = allSettings.reward_system_phase || 'arrecadacao';
        let rtpToSync = allSettings.reward_rtp_arrecadacao || '5';
        if (currentPhase === 'retribuicao') {
            rtpToSync = allSettings.reward_rtp_retribuicao || '98';
        }

        const apiCreds = await pool.query("SELECT * FROM api_credentials WHERE module = 'max_api'");
        if (apiCreds.rows.length > 0) {
            const cred = apiCreds.rows[0];
            if (cred.agent_code && cred.agent_token) {
                try {
                    await axios.post('https://maxapigames.com/api/v2', {
                        method: 'agent_update',
                        agent_code: cred.agent_code,
                        agent_token: cred.agent_token,
                        rtp_demo: parseInt(rtpToSync)
                    });
                    console.log(`[MAX API] RTP Demo Sincronizado via Painel: ${rtpToSync}% (Phase: ${currentPhase})`);
                } catch (e) {
                    console.error('[MAX API] Erro ao sincronizar RTP no Save:', e.message);
                }
            }
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
function getBonusForAmount(amount) {
    const amountVal = parseFloat(amount);
    if (amountVal === 15) return 2.30;
    if (amountVal === 35) return 4.30;
    if (amountVal === 55) return 4.30;
    if (amountVal === 155) return 9.07;
    if (amountVal === 555) return 23.60;
    if (amountVal === 1555) return 103.60;
    if (amountVal === 5555) return 245.60;
    if (amountVal === 15555) return 1041.30;
    return 0;
}

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

        const bonus = getBonusForAmount(amount);
        const totalCredited = parseFloat(amount) + bonus;

        await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [totalCredited, req.user.id]);
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
                const bonus = getBonusForAmount(amount);
                const totalBalanceCredit = amount + bonus;

                // Get system settings for deposit bonus (Legacy settings kept for compatibility)
                const sRows = await pool.query("SELECT key_name, key_value FROM system_settings WHERE key_name IN ('deposit_rollover_mult')");
                let rollMult = 1;
                sRows.rows.forEach(r => {
                    if (r.key_name === 'deposit_rollover_mult') rollMult = parseFloat(r.key_value) || 1;
                });

                let addedRollover = (amount + bonus) * rollMult;

                await pool.query(
                    'UPDATE users SET balance = balance + $1, rollover_required = rollover_required + $2 WHERE id = $3',
                    [totalBalanceCredit, addedRollover, dep.rows[0].user_id]
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

// Endpoint support both paths for frontend compatibility
app.post(['/api/withdraw', '/api/finance/withdraw'], authenticateToken, async (req, res) => {
    let { amount, pix_key, pix_type, withdraw_password } = req.body;
    if (!pix_type) pix_type = 'CPF'; // Default if not provided

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
    if (!new_password || String(new_password).length !== 6) return res.status(400).json({ success: false, error: 'A senha deve ter exatamente 6 caracteres numéricos.' });

    try {
        const hashedPassword = await bcrypt.hash(String(new_password), 10);
        await pool.query('UPDATE users SET withdraw_password = $1 WHERE id = $2', [hashedPassword, req.user.id]);
        res.json({ success: true, message: 'Senha de saque criada com sucesso!' });
    } catch (err) {
        console.error('PIN Create Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao criar a senha de saque.' });
    }
});

// --- MAX API WEBHOOK & LAUNCH ---
app.post('/api/games/launch', authenticateToken, async (req, res) => {
    const { gameCode } = req.body;
    if (!gameCode) return res.status(400).json({ error: 'Código do jogo é obrigatório.' });

    try {
        const creds = await pool.query('SELECT * FROM api_credentials WHERE module = $1', ['max_api']);
        if (creds.rows.length === 0) return res.status(400).json({ error: 'Credenciais da API não configuradas.' });

        const { agent_code, agent_token } = creds.rows[0];
        const userCode = `30win_user_${req.user.id}`;

        // Atualizar last_active para rastreamento de jogadores ativos
        pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [req.user.id]).catch(() => { });

        // Verifica se o usuario e demo no nosso banco
        const userRow = await pool.query('SELECT is_demo, user_type FROM users WHERE id = $1', [req.user.id]);
        const userFound = userRow.rows[0] || {};
        const isDemo = userFound.is_demo === true;
        const userType = userFound.user_type || 'standard';

        // Create player in Max API in case it does not exist, passando is_demo se for demo
        const createPayload = {
            method: 'user_create',
            agent_code,
            agent_token,
            user_code: userCode
        };
        if (isDemo) createPayload.is_demo = true; // Always true to save GGR

        await axios.post('https://maxapigames.com/api/v2', createPayload)
            .catch(e => console.error('Erro silent criar user:', e.message));

        // Se for influencer, usa o RTP Demo fixo (Step 4)
        if (isDemo && userType === 'influencer') {
            try {
                const rtpRow = await pool.query("SELECT key_value FROM system_settings WHERE key_name = 'reward_rtp_demo'");
                const influencerRtp = rtpRow.rows[0]?.key_value || '95';

                // Atualiza o RTP Demo GLOBAL para o modo Influencer
                await axios.post('https://maxapigames.com/api/v2', {
                    method: 'agent_update',
                    agent_code,
                    agent_token,
                    rtp_demo: parseInt(influencerRtp)
                });

                // Flag como demo
                await axios.post('https://maxapigames.com/api/v2', {
                    method: 'set_demo',
                    agent_code,
                    agent_token,
                    user_code: userCode
                });
            } catch (e) {
                console.error(`[MAX API] Erro sync influencer: ${e.message}`);
            }
        }
        // Se for standard e DEMO (Save GGR), forçamos o RTP do CICLO via agent_update
        else if (isDemo && userType === 'standard') {
            try {
                const sRow = await pool.query("SELECT key_value FROM system_settings WHERE key_name = 'reward_system_phase'");
                const phase = sRow.rows[0]?.key_value || 'arrecadacao';
                const rtpRow = await pool.query("SELECT key_value FROM system_settings WHERE key_name = $1", [phase === 'arrecadacao' ? 'reward_rtp_arrecadacao' : 'reward_rtp_retribuicao']);
                const currentRtp = rtpRow.rows[0]?.key_value || '5';

                // Atualiza o RTP Demo GLOBAL para seguir o Ciclo do Painel
                await axios.post('https://maxapigames.com/api/v2', {
                    method: 'agent_update',
                    agent_code,
                    agent_token,
                    rtp_demo: parseInt(currentRtp)
                });

                // Flag como demo
                await axios.post('https://maxapigames.com/api/v2', {
                    method: 'set_demo',
                    agent_code,
                    agent_token,
                    user_code: userCode
                });
            } catch (e) {
                console.error(`[MAX API] Erro sync standard: ${e.message}`);
            }
        }

        const launchPayload = {
            method: 'game_launch',
            agent_code,
            agent_token,
            user_code: userCode,
            game_code: gameCode,
            callback_url: `${process.env.PUBLIC_URL || `https://${req.get('host')}`}/api/webhook/maxapi`
        };

        const response = await axios.post('https://maxapigames.com/api/v2', launchPayload);
        const data = response.data;

        if (data.status === 1) {
            res.json({ launch_url: data.launch_url });
        } else {
            res.status(400).json({ error: data.msg || 'Erro na API MAX' });
        }
    } catch (err) {
        console.error('Launch Error Details:', {
            message: err.message,
            response: err.response ? err.response.data : 'no response',
            status: err.response ? err.response.status : 'n/a'
        });
        const errMsg = (err.response && err.response.data && err.response.data.msg) || 'Erro de comunicação backend';
        res.status(500).json({ error: errMsg });
    }
});

app.post('/api/webhook/maxapi', async (req, res) => {
    const { method, agent_code, agent_secret, user_code, slot } = req.body;

    try {
        const creds = await pool.query('SELECT * FROM api_credentials WHERE module = $1', ['max_api']);
        if (creds.rows.length === 0) return res.status(401).json({ status: 0, msg: 'INVALID_AGENT' });

        // Verifica Agent Secret
        const agentSettings = creds.rows[0];
        if (agentSettings.agent_code !== agent_code || agentSettings.agent_secret !== agent_secret) {
            return res.status(401).json({ status: 0, msg: 'INVALID_AGENT' });
        }

        const userId = parseInt(user_code.replace('30win_user_', ''));
        if (isNaN(userId)) return res.status(400).json({ status: 0, msg: 'INVALID_USER' });

        const userRows = await pool.query('SELECT balance, is_demo, user_type FROM users WHERE id = $1', [userId]);
        if (userRows.rows.length === 0) return res.status(400).json({ status: 0, msg: 'INVALID_USER' });

        const user = userRows.rows[0];
        const isDemo = user.is_demo === true;
        let userBalance = parseFloat(user.balance);

        if (method === 'user_balance') {
            console.log(`[Webhook Balance] user:${user_code} balance:${userBalance}`);
            return res.json({ status: 1, user_balance: userBalance });
        }

        if (method === 'transaction') {
            let bet = 0;
            let win = 0;

            // Robust extraction: MAX API sends data inside 'slot' object
            // Some providers may structure it differently (data, slot, root, etc.)
            const gameData = slot || req.body.slot || req.body.data || req.body || {};

            // More comprehensive field extraction for different providers
            bet = parseFloat(gameData.bet_money) || parseFloat(gameData.bet) || parseFloat(gameData.amount) || parseFloat(req.body.bet_money) || parseFloat(req.body.bet) || 0;
            win = parseFloat(gameData.win_money) || parseFloat(gameData.win) || parseFloat(req.body.win_money) || parseFloat(req.body.win) || 0;

            // Handle txn_type correctly
            const txnType = (gameData.txn_type || req.body.txn_type || 'debit_credit').toLowerCase();
            if (txnType === 'credit') {
                bet = 0; // credit-only: no debit
            } else if (txnType === 'debit') {
                win = 0; // debit-only: no credit
            }

            // --- IDEMPOTENCY CHECK ---
            const txnId = gameData.txn_id || gameData.transaction_id || req.body.txn_id || req.body.transactionId;
            if (txnId) {
                const existingTx = await pool.query('SELECT id FROM game_history WHERE txn_id = $1', [txnId]);
                if (existingTx.rows.length > 0) {
                    console.log(`[Webhook TX] Duplicate transaction IGNORED: ${txnId}`);
                    return res.json({ status: 1, user_balance: userBalance });
                }
            }

            // Logging para debug (Essencial para identificar provedores que falham)
            console.log(`[Webhook TX] user:${user_code} demo:${isDemo} bet:${bet} win:${win} txn:${txnType} txnId:${txnId} current_db_balance:${userBalance}`);

            // 1. Max Prize Constraint (Only for real players)
            // 1. Max Prize Constraint (Only for real players)
            const sRows = await pool.query("SELECT key_name, key_value FROM system_settings WHERE key_name LIKE 'reward_%'");
            const settings = {};
            sRows.rows.forEach(r => settings[r.key_name] = r.key_value);

            const maxPrize = parseFloat(settings['reward_max_prize']) || 99999.00;
            const phase = settings['reward_system_phase'] || 'arrecadacao';
            const rtpArrecadacao = parseFloat(settings['reward_rtp_arrecadacao']) || 5;

            console.log(`[Webhook DEBUG] user_type:${user.user_type} win:${win} maxPrize:${maxPrize} phase:${phase}`);

            // 1. PHASE HARD-CAP (Winning Blocker for Arrecadação)
            if (phase === 'arrecadacao' && user.user_type === 'standard') {
                const maxWinInArrecadacao = bet * (rtpArrecadacao / 100);
                if (win > maxWinInArrecadacao) {
                    console.log(`[Webhook PHASE-CAP] Capping win from ${win} to ${maxWinInArrecadacao.toFixed(2)} (RTP:${rtpArrecadacao}%) for standard user ${user_code}`);
                    win = maxWinInArrecadacao;
                }
            }

            // 2. GLOBAL MAX PRIZE CAP
            if ((!isDemo || user.user_type === 'standard') && win > maxPrize && maxPrize > 0) {
                console.log(`[Webhook MAX-CAP] Capping win from ${win} to ${maxPrize} for user ${user_code}`);
                win = maxPrize;
            }

            // Update local balance ATOMICALLY to avoid race conditions and force sync
            const result = await pool.query(
                'UPDATE users SET balance = GREATEST(0, balance - $1 + $2), last_active = NOW() WHERE id = $3 RETURNING balance',
                [bet, win, userId]
            );

            userBalance = parseFloat(result.rows[0].balance);
            console.log(`[Webhook TX] user:${user_code} sync_balance_after:${userBalance}`);

            // 1.5 Record Transaction in History
            await pool.query(
                'INSERT INTO game_history (user_id, game_code, bet, win, txn_id, txn_type, provider_code, is_demo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [userId, gameData.game_code || req.body.game_code || 'unknown', bet, win, txnId || `auto-${Date.now()}-${Math.random().toString(36).substring(7)}`, txnType, gameData.provider_code || req.body.provider_code || 'unknown', isDemo]
            );

            // 1.6 Update Rollover Progress (Real money and Standard Demo)
            if ((!isDemo || user.user_type === 'standard') && bet > 0) {
                await pool.query('UPDATE users SET rollover_progress = rollover_progress + $1 WHERE id = $2', [bet, userId]);
            }

            // 2. Cycle Logic (INCLUDE STANDARD DEMO USERS)
            if (!isDemo || user.user_type === 'standard') {
                let phase = settings['reward_system_phase'] || 'arrecadacao';
                const metaArrecadacao = parseFloat(settings['reward_meta_arrecadacao']) || 1000.00;
                const metaRetribuicao = parseFloat(settings['reward_meta_retribuicao']) || 500.00;
                let currentArrecadacao = parseFloat(settings['reward_current_arrecadacao']) || 0.00;
                let currentRetribuicao = parseFloat(settings['reward_current_retribuicao']) || 0.00;
                const rtpArrecadacao = settings['reward_rtp_arrecadacao'] || '5';
                const rtpRetribuicao = settings['reward_rtp_retribuicao'] || '95';

                let transitionOccurred = false;
                let nextRtp = null;
                let profit = bet - win;

                if (phase === 'arrecadacao') {
                    // ATOMIC UPDATE: currentArrecadacao += profit
                    await pool.query(`
                        UPDATE system_settings 
                        SET key_value = (CAST(key_value AS DECIMAL) + $1)::TEXT 
                        WHERE key_name = 'reward_current_arrecadacao'
                    `, [profit]);

                    // Re-fetch to check if meta reached
                    const updatedRow = await pool.query("SELECT key_value FROM system_settings WHERE key_name = 'reward_current_arrecadacao'");
                    currentArrecadacao = parseFloat(updatedRow.rows[0].key_value);

                    if (currentArrecadacao >= metaArrecadacao) {
                        phase = 'retribuicao';
                        await pool.query("UPDATE system_settings SET key_value = 'retribuicao' WHERE key_name = 'reward_system_phase'");
                        await pool.query("UPDATE system_settings SET key_value = '0.00' WHERE key_name = 'reward_current_arrecadacao'");
                        await pool.query("UPDATE system_settings SET key_value = '0.00' WHERE key_name = 'reward_current_retribuicao'");
                        transitionOccurred = true;
                        nextRtp = rtpRetribuicao;
                    }
                } else if (phase === 'retribuicao') {
                    const diff = (win - bet > 0 ? win - bet : 0);
                    // ATOMIC UPDATE: currentRetribuicao += diff
                    await pool.query(`
                        UPDATE system_settings 
                        SET key_value = (CAST(key_value AS DECIMAL) + $1)::TEXT 
                        WHERE key_name = 'reward_current_retribuicao'
                    `, [diff]);

                    // Re-fetch to check if meta reached
                    const updatedRow = await pool.query("SELECT key_value FROM system_settings WHERE key_name = 'reward_current_retribuicao'");
                    currentRetribuicao = parseFloat(updatedRow.rows[0].key_value);

                    if (currentRetribuicao >= metaRetribuicao) {
                        phase = 'arrecadacao';
                        await pool.query("UPDATE system_settings SET key_value = 'arrecadacao' WHERE key_name = 'reward_system_phase'");
                        await pool.query("UPDATE system_settings SET key_value = '0.00' WHERE key_name = 'reward_current_retribuicao'");
                        await pool.query("UPDATE system_settings SET key_value = '0.00' WHERE key_name = 'reward_current_arrecadacao'");
                        transitionOccurred = true;
                        nextRtp = rtpArrecadacao;
                    }
                }

                // 3. Trigger API RTP control on Phase Change
                if (transitionOccurred && nextRtp !== null) {
                    try {
                        await axios.post('https://maxapigames.com/api/v2', {
                            method: 'control_rtp',
                            agent_code: agentSettings.agent_code,
                            agent_token: agentSettings.agent_token,
                            rtp: parseInt(nextRtp)
                        });
                    } catch (apiErr) {
                        console.error('Failed to command RTP to MAX API:', apiErr.message);
                    }
                }
            }

            return res.json({ status: 1, user_balance: userBalance });
        }


        return res.status(400).json({ status: 0, msg: 'INVALID_METHOD' });
    } catch (err) {
        console.error('Webhook Max API Error:', err);
        return res.status(500).json({ status: 0, msg: 'INTERNAL_ERROR' });
    }
});

app.get('/api/admin/reward/total-stats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                COALESCE(SUM(h.bet), 0) as total_bet, 
                COALESCE(SUM(h.win), 0) as total_win,
                COALESCE(SUM(h.bet - h.win), 0) as total_profit
            FROM game_history h
            JOIN users u ON h.user_id = u.id
            WHERE u.is_demo = false OR u.user_type = 'standard'
        `);
        res.json({ success: true, stats: result.rows[0] });
    } catch (err) {
        console.error('Total Stats Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar estatísticas totais.' });
    }
});

app.post('/api/admin/reward/total-stats/reset', async (req, res) => {
    try {
        await pool.query('DELETE FROM game_history');
        res.json({ success: true, message: 'Histórico resetado com sucesso.' });
    } catch (err) {
        console.error('Reset Stats Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao resetar histórico.' });
    }
});

app.post('/api/admin/reward/reset', async (req, res) => {
    try {
        await pool.query("UPDATE system_settings SET key_value = 'arrecadacao' WHERE key_name = 'reward_system_phase'");
        await pool.query("UPDATE system_settings SET key_value = '0.00' WHERE key_name = 'reward_current_arrecadacao'");
        await pool.query("UPDATE system_settings SET key_value = '0.00' WHERE key_name = 'reward_current_retribuicao'");

        res.json({ success: true, message: 'Ciclo de RTP resetado com sucesso! Iniciando em ARRECADAÇÃO.' });
    } catch (err) {
        console.error('Reset Reward Error:', err);
        res.status(500).json({ success: false, error: 'Erro ao resetar ciclo.' });
    }
});

// --- ROUTES FOR HTML ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));
app.get('/provider-games.html', (req, res) => res.sendFile(path.join(__dirname, 'provider-games.html')));

// --- EXPORT FOR NETLIFY ---
module.exports = app;
module.exports.handler = serverless(app);

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Servidor rodando localmente em http://localhost:${PORT}`);
    });
}
