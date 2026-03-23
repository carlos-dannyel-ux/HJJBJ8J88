const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = 3000;
const SECRET_KEY = '30win_secret_key_2024';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// MySQL Connection Pool
const pool = mysql.createPool({
    host: 'localhost',
    user: 'win30_user',
    password: 'Win30@Pass',
    database: '30win',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
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
        const [existing] = await pool.execute('SELECT id FROM users WHERE phone = ?', [phone]);
        if (existing.length > 0) return res.status(400).json({ success: false, error: 'Telefone já cadastrado.' });

        // Retrieve System Settings for Bonus
        const [settingsRows] = await pool.execute("SELECT key_name, key_value FROM system_settings WHERE key_name IN ('signup_bonus_val', 'signup_rollover_mult')");
        let signupBonus = 0;
        let rolloverMult = 1;
        settingsRows.forEach(row => {
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

        const [result] = await pool.execute(
            'INSERT INTO users (id_user, phone, password, name, balance, bonus_balance, rollover_required, rollover_progress, referral_code, invited_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id_user, phone, hashedPassword, name, 0.00, signupBonus, rolloverReq, 0.00, referral_code, invitedBy || null]
        );

        res.json({ success: true, message: 'Cadastro realizado com sucesso!' });
    } catch (err) {
        console.error('Register Erro:', err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, error: 'Telefone já cadastrado.' });
        res.status(500).json({ success: false, error: 'Erro interno ao cadastrar.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE phone = ?', [phone]);
        if (rows.length === 0) return res.status(400).json({ success: false, error: 'Usuário não encontrado.' });

        const user = rows[0];
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ success: false, error: 'Senha incorreta.' });

        const token = jwt.sign({ id: user.id, phone: user.phone, referral_code: user.referral_code }, SECRET_KEY, { expiresIn: '24h' });
        res.json({ success: true, token, user: { phone: user.phone, balance: user.balance, id_user: user.id_user } });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro no servidor.' });
    }
});

// --- USER & REFERRAL ENDPOINTS ---

app.get('/api/user/info', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id_user, phone, balance, referral_code, rewards_pending, withdraw_password, rollover_required, rollover_progress FROM users WHERE id = ?', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });

        const user = rows[0];
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
        res.status(500).json({ success: false, error: 'Erro ao buscar perfil.' });
    }
});

app.get('/api/referral/qr', authenticateToken, async (req, res) => {
    const inviteUrl = `http://163.245.218.28:3000/AUTH.HTML?ref=${req.user.referral_code}`;
    try {
        const qrCodeData = await qrcode.toDataURL(inviteUrl);
        res.json({ success: true, qr: qrCodeData, url: inviteUrl });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao gerar QR Code.' });
    }
});

app.get('/api/referral/stats', authenticateToken, async (req, res) => {
    try {
        const [subs] = await pool.execute('SELECT COUNT(*) as count FROM users WHERE invited_by = ?', [req.user.referral_code]);
        const [user] = await pool.execute('SELECT rewards_pending FROM users WHERE id = ?', [req.user.id]);
        res.json({ success: true, stats: { totalSubordinates: subs[0].count, rewardsPending: user[0].rewards_pending } });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao buscar convites.' });
    }
});

app.post('/api/referral/claim', authenticateToken, async (req, res) => {
    try {
        const [user] = await pool.execute('SELECT rewards_pending FROM users WHERE id = ?', [req.user.id]);
        const amount = parseFloat(user[0].rewards_pending);
        if (amount <= 0) return res.status(400).json({ success: false, error: 'Nenhum prêmio para resgatar.' });

        await pool.execute('UPDATE users SET balance = balance + ?, rewards_pending = 0 WHERE id = ?', [amount, req.user.id]);
        res.json({ success: true, message: `R$ ${amount.toFixed(2)} resgatados com sucesso!` });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao resgatar.' });
    }
});

// --- ADMIN ENDPOINTS ---

app.post('/api/admin/login', async (req, res) => {
    const { operatorId, password } = req.body;
    try {
        const [rows] = await pool.execute('SELECT * FROM admins WHERE operator_id = ? AND password = ?', [operatorId, password]);
        if (rows.length > 0) {
            res.json({ success: true, message: 'Login realizado com sucesso!' });
        } else {
            res.status(401).json({ success: false, error: 'ID de Operador ou Senha inválidos.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao acessar o banco de dados.' });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const [usersCount] = await pool.execute('SELECT COUNT(*) as count FROM users');
        const [totalBilling] = await pool.execute('SELECT SUM(balance) as total FROM users');
        res.json({
            success: true,
            stats: {
                totalBilling: Number(totalBilling[0].total || 0).toFixed(2),
                activePlayers: Math.floor(Math.random() * 2000) + 500, // Placeholder simulado
                registeredUsers: usersCount[0].count
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
        const [rows] = await pool.execute('SELECT * FROM api_credentials WHERE module = ?', ['max_api']);
        res.json({ success: true, credentials: rows[0] || {} });
    } catch (err) {
        console.error('Error in /api/admin/api-credentials:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar credenciais.' });
    }
});

app.post('/api/admin/api-credentials', async (req, res) => {
    const { agent_code, agent_token, agent_secret } = req.body;
    try {
        await pool.execute(
            `INSERT INTO api_credentials (module, agent_code, agent_token, agent_secret) 
             VALUES ('max_api', ?, ?, ?) 
             ON DUPLICATE KEY UPDATE agent_code = ?, agent_token = ?, agent_secret = ?`,
            [agent_code, agent_token, agent_secret, agent_code, agent_token, agent_secret]
        );
        res.json({ success: true, message: 'Credenciais salvas com sucesso!' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao salvar credenciais.' });
    }
});

app.post('/api/admin/games/extract', async (req, res) => {
    try {
        const [creds] = await pool.execute('SELECT * FROM api_credentials WHERE module = ?', ['max_api']);
        if (creds.length === 0) return res.status(400).json({ success: false, error: 'Configure as credenciais primeiro.' });

        const { agent_code, agent_token } = creds[0];

        const response = await axios.post('https://maxapigames.com/api/v2', {
            method: 'game_list',
            agent_code,
            agent_token
        });

        const data = response.data;
        if (data.status !== 1) return res.status(400).json({ success: false, error: data.msg || 'Erro na API.' });

        const games = data.games;
        let inserted = 0;

        // Crie os diretórios de imagens se não existirem
        const imgsDir = path.join(__dirname, 'public', 'assets', 'images', 'games');
        if (!fs.existsSync(imgsDir)) {
            fs.mkdirSync(imgsDir, { recursive: true });
        }

        // Deletar jogos antigos para atualizar fresco
        await pool.execute('TRUNCATE TABLE games');

        for (const game of games) {
            let localBanner = null;
            if (game.banner) {
                try {
                    const imgUrl = `https://maxapigames.com${game.banner}`;
                    const imgFileName = `${game.game_code}.png`;
                    const imgPath = path.join(imgsDir, imgFileName);

                    const imgResponse = await axios({
                        url: imgUrl,
                        method: 'GET',
                        responseType: 'stream'
                    });

                    const writer = fs.createWriteStream(imgPath);
                    imgResponse.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });

                    localBanner = `/public/assets/images/games/${imgFileName}`;
                } catch (imgErr) {
                    console.error('Erro baixando imagem do jogo', game.game_code);
                }
            }

            await pool.execute(
                'INSERT INTO games (game_code, provider_code, game_name, banner_path, status) VALUES (?, ?, ?, ?, ?)',
                [game.game_code, game.provider_code, game.game_name, localBanner, game.status]
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
        await pool.execute('TRUNCATE TABLE games');
        const imgsDir = path.join(__dirname, 'public', 'assets', 'images', 'games');
        if (fs.existsSync(imgsDir)) {
            fs.rmSync(imgsDir, { recursive: true, force: true });
        }
        res.json({ success: true, message: 'Todos os jogos e imagens foram removidos.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao remover jogos.' });
    }
});

app.get('/api/games', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM games WHERE status = 1 ORDER BY provider_code, game_name');

        const grouped = {};
        for (const game of rows) {
            if (!grouped[game.provider_code]) {
                grouped[game.provider_code] = [];
            }
            grouped[game.provider_code].push(game);
        }

        res.json({ success: true, providers: grouped });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao buscar jogos.' });
    }
});

// --- ADMIN: USERS & GGPIX ---

app.get('/api/admin/users', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, id_user, phone, name, is_demo, plain_password, balance, bonus_balance, rollover_required, rollover_progress, (withdraw_password IS NOT NULL) as has_pin, created_at FROM users ORDER BY id DESC');
        res.json({ success: true, users: rows });
    } catch (err) {
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

        await pool.execute(
            'INSERT INTO users (id_user, phone, password, plain_password, name, is_demo, balance, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id_user, phone, hashedPassword, password, name || 'Demo', true, 0.00, referral_code]
        );
        res.json({ success: true, message: 'Usuário Demo criado com sucesso!' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, error: 'Telefone já cadastrado.' });
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
            await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
        }
        res.json({ success: true, message: 'Usuário atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao editar usuário.' });
    }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.execute('DELETE FROM users WHERE id = ?', [id]);
        res.json({ success: true, message: 'Usuário excluído com sucesso!' });
    } catch (err) {
        console.error('Delete User Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao excluir usuário (verifique relações externas).' });
    }
});

app.get('/api/admin/users/:id/details', async (req, res) => {
    const { id } = req.params;
    try {
        const [deposits] = await pool.execute("SELECT amount, method, status, external_id, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC", [id]);
        const [withdrawals] = await pool.execute("SELECT amount, pix_type, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC", [id]);

        res.json({
            success: true,
            deposits,
            withdrawals
        });
    } catch (err) {
        console.error('User Details Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao buscar histórico do usuário.' });
    }
});

app.get('/api/admin/ggpix-credentials', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM api_credentials WHERE module = ?', ['ggpix_api']);
        res.json({ success: true, credentials: rows[0] || {} });
    } catch (err) { res.status(500).json({ success: false, error: 'Erro ao buscar credenciais.' }); }
});

app.post('/api/admin/ggpix-credentials', async (req, res) => {
    const { agent_token } = req.body; // API Key do GGPIX
    if (!agent_token) return res.status(400).json({ success: false, error: 'API Key GGPIX é obrigatória' });
    try {
        await pool.execute(
            `INSERT INTO api_credentials (module, agent_code, agent_token) VALUES ('ggpix_api', 'ggpix', ?) 
             ON DUPLICATE KEY UPDATE agent_token = ?`,
            [agent_token, agent_token]
        );
        res.json({ success: true, message: 'Credenciais Salvas!' });
    } catch (err) { res.status(500).json({ success: false, error: 'Erro ao salvar credenciais' }); }
});

app.get('/api/admin/system/settings', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT key_name, key_value FROM system_settings');
        const settings = {};
        rows.forEach(r => settings[r.key_name] = r.key_value);

        // Ensure deposit_bonus_rules is a valid JSON string if it exists
        if (!settings.deposit_bonus_rules) {
            settings.deposit_bonus_rules = '[]';
        }

        res.json({ success: true, settings });
    } catch (err) {
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
            await pool.execute(
                'INSERT INTO system_settings (key_name, key_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE key_value = ?',
                [key, processedVal, processedVal]
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
        const [rows] = await pool.execute(`
            SELECT d.id, d.amount, d.status, d.created_at, u.phone, u.name, u.is_demo 
            FROM deposits d JOIN users u ON d.user_id = u.id ORDER BY d.id DESC LIMIT 200
        `);
        res.json({ success: true, deposits: rows });
    } catch (err) { res.status(500).json({ success: false, error: 'Erro ao buscar depositos' }); }
});

app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT w.id, w.amount, w.pix_key, w.pix_type, w.status, w.created_at, u.phone, u.name 
            FROM withdrawals w JOIN users u ON w.user_id = u.id ORDER BY w.id DESC
        `);
        res.json({ success: true, withdrawals: rows });
    } catch (err) { res.status(500).json({ success: false, error: 'Erro ao buscar saques' }); }
});

app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
    const { id } = req.params;
    try {
        const [wRows] = await pool.execute('SELECT * FROM withdrawals WHERE id = ? AND status = "pending"', [id]);
        if (wRows.length === 0) return res.status(400).json({ success: false, error: 'Saque não pendente ou inv.' });

        const w = wRows[0];

        const [apiRows] = await pool.execute('SELECT agent_token FROM api_credentials WHERE module = "ggpix_api"');
        if (apiRows.length === 0 || !apiRows[0].agent_token) return res.status(400).json({ success: false, error: 'GGPIX nao cfg.' });

        const apiKey = apiRows[0].agent_token;

        const response = await axios.post('https://ggpixapi.com/api/v1/pix/out', {
            amountCents: Math.round(w.amount * 100),
            pixKey: w.pix_key,
            pixKeyType: w.pix_type,
            externalId: 'sq-' + w.id
        }, { headers: { 'X-API-Key': apiKey } });

        if (response.status === 201 || response.status === 200) {
            await pool.execute('UPDATE withdrawals SET status = "approved" WHERE id = ?', [id]);
            res.json({ success: true, message: 'Saque aprovado e enviado!' });
        } else {
            res.status(400).json({ success: false, error: 'Falha GGPIX.' });
        }
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ success: false, error: 'Erro de integração GGPIX.' });
    }
});

app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
    const { id } = req.params;
    try {
        const [wRows] = await pool.execute('SELECT * FROM withdrawals WHERE id = ? AND status = "pending"', [id]);
        if (wRows.length === 0) return res.status(400).json({ success: false, error: 'Saque não pendente/inv.' });
        const w = wRows[0];

        await pool.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [w.amount, w.user_id]);
        await pool.execute('UPDATE withdrawals SET status = "rejected" WHERE id = ?', [id]);
        res.json({ success: true, message: 'Saque recusado, saldo devolvido.' });
    } catch (err) { res.status(500).json({ success: false, error: 'Erro ao recusar.' }); }
});

// --- GGPIX & PAYMENTS (CLIENTS) ---

app.post('/api/deposit', authenticateToken, async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ success: false, error: 'Mínimo de R$ 1,00.' });

    try {
        const [uRow] = await pool.execute('SELECT is_demo, name, phone FROM users WHERE id = ?', [req.user.id]);
        const user = uRow[0];

        if (user.is_demo) {
            return res.json({
                success: true,
                is_demo: true,
                pixCopyPaste: '00020101021226820014br.gov.bcb.pixFICTICIO_DEMO',
                pixCode: '00020101021226820014br.gov.bcb.pixFICTICIO_DEMO',
                message: 'QR Code Fictício Gerado (Aguarde 8s...)'
            });
        }

        const [apiRows] = await pool.execute('SELECT agent_token FROM api_credentials WHERE module = "ggpix_api"');
        if (apiRows.length === 0 || !apiRows[0].agent_token) return res.status(400).json({ success: false, error: 'Pix indisp.' });

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
            await pool.execute('INSERT INTO deposits (user_id, amount, method, status, external_id) VALUES (?, ?, ?, ?, ?)',
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
        const [uRow] = await pool.execute('SELECT is_demo FROM users WHERE id = ?', [req.user.id]);
        if (!uRow[0].is_demo) return res.status(403).json({ success: false, error: 'Restrito para modo demo.' });

        await pool.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, req.user.id]);
        await pool.execute('INSERT INTO deposits (user_id, amount, method, status) VALUES (?, ?, ?, ?)',
            [req.user.id, amount, 'FICTITICIO', 'completed']);

        res.json({ success: true, message: 'Depósito debitado na conta Demo!' });
    } catch (err) { res.status(500).json({ success: false, error: 'Erro ao debitar.' }); }
});

app.post('/api/ggpix/webhook', async (req, res) => {
    try {
        const payload = req.body;
        if (payload.status === 'COMPLETE' && payload.type === 'PIX_IN') {
            const external_id = payload.transactionId || payload.externalId;
            let stmt = 'SELECT * FROM deposits WHERE external_id = ? AND status = "pending"';
            let [dep] = await pool.execute(stmt, [payload.transactionId]);

            if (dep.length === 0 && payload.externalId) {
                const [dep2] = await pool.execute(stmt, [payload.externalId]);
                dep = dep2;
            }

            if (dep.length > 0) {
                const amount = parseFloat(dep[0].amount);

                // Get system settings for deposit bonus
                const [sRows] = await pool.execute("SELECT key_name, key_value FROM system_settings WHERE key_name IN ('deposit_bonus_val', 'deposit_rollover_mult', 'deposit_bonus_rules')");
                let bonusVal = 0;
                let rollMult = 1;
                let bonusRules = [];

                sRows.forEach(r => {
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

                await pool.execute(
                    'UPDATE users SET balance = balance + ?, bonus_balance = bonus_balance + ?, rollover_required = rollover_required + ? WHERE id = ?',
                    [amount, bonusVal, addedRollover, dep[0].user_id]
                );
                await pool.execute('UPDATE deposits SET status = "completed" WHERE id = ?', [dep[0].id]);
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
        const [uRows] = await pool.execute('SELECT balance, rollover_required, rollover_progress, withdraw_password FROM users WHERE id = ?', [req.user.id]);
        if (uRows.length === 0) return res.status(400).json({ success: false, error: 'Usuário não encontrado.' });

        const user = uRows[0];

        // Settings Check
        const [sRows] = await pool.execute('SELECT key_name, key_value FROM system_settings WHERE key_name = "min_withdraw"');
        let minWithdraw = 50.00;
        if (sRows.length > 0) minWithdraw = parseFloat(sRows[0].key_value) || 50.00;

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

        await pool.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, req.user.id]);
        await pool.execute('INSERT INTO withdrawals (user_id, amount, pix_key, pix_type, status) VALUES (?, ?, ?, ?, "pending")',
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
        await pool.execute('UPDATE users SET withdraw_password = ? WHERE id = ?', [hashedPassword, req.user.id]);
        res.json({ success: true, message: 'Senha de saque criada com sucesso!' });
    } catch (err) {
        console.error('PIN Create Err:', err);
        res.status(500).json({ success: false, error: 'Erro ao criar a senha de saque.' });
    }
});

// --- ROUTES FOR HTML ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'PAINEL_LOGIN.HTML')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'HOME.HTML')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'AUTH.HTML')));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
});
