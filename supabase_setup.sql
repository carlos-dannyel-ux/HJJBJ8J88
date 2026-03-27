-- Schema do Supabase (PostgreSQL) para 30win

-- Criar tabela de Usuários
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    id_user VARCHAR(50) UNIQUE NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    plain_password VARCHAR(255) DEFAULT NULL,
    name VARCHAR(100) DEFAULT NULL,
    is_demo BOOLEAN DEFAULT FALSE,
    balance DECIMAL(15, 2) DEFAULT 10.00,
    referral_code VARCHAR(20) UNIQUE NOT NULL,
    invited_by VARCHAR(20) DEFAULT NULL,
    rewards_pending DECIMAL(15, 2) DEFAULT 0.00,
    bonus_balance DECIMAL(15, 2) DEFAULT 0.00,
    rollover_required DECIMAL(15, 2) DEFAULT 0.00,
    rollover_progress DECIMAL(15, 2) DEFAULT 0.00,
    withdraw_password VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Rastreamento de Convites
CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_code VARCHAR(20) NOT NULL REFERENCES users(referral_code),
    invitee_phone VARCHAR(20) NOT NULL,
    deposit_total DECIMAL(15, 2) DEFAULT 0.00,
    bet_total DECIMAL(15, 2) DEFAULT 0.00,
    goal_reached BOOLEAN DEFAULT FALSE,
    reward_claimed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de Admins
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    operator_id VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'admin',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de Depósitos
CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    amount DECIMAL(15, 2) NOT NULL,
    method VARCHAR(50),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    external_id VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de Saques
CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount DECIMAL(15, 2) NOT NULL,
    pix_key VARCHAR(100) NOT NULL,
    pix_type VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    external_id VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de Credenciais de API
CREATE TABLE IF NOT EXISTS api_credentials (
    module VARCHAR(50) PRIMARY KEY,
    agent_code VARCHAR(100) NOT NULL,
    agent_token VARCHAR(255) NOT NULL,
    agent_secret VARCHAR(255) DEFAULT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de Jogos
CREATE TABLE IF NOT EXISTS games (
    game_code VARCHAR(100) PRIMARY KEY,
    provider_code VARCHAR(50) NOT NULL,
    game_name VARCHAR(255) NOT NULL,
    banner_path VARCHAR(255) DEFAULT NULL,
    status INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Criar tabela de Configurações do Sistema
CREATE TABLE IF NOT EXISTS system_settings (
    id SERIAL PRIMARY KEY,
    key_name VARCHAR(50) UNIQUE NOT NULL,
    key_value TEXT DEFAULT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Inserções de dados padrão (com ON CONFLICT para não duplicar)

-- Admin Padrão
INSERT INTO admins (operator_id, password) 
VALUES ('admin', 'admin_pass_30win')
ON CONFLICT (operator_id) DO NOTHING;

-- Usuário de Exemplo
INSERT INTO users (id_user, phone, password, balance, referral_code) 
VALUES ('291603625', '92996036214', 'User@2024', 10.00, 'REF123456')
ON CONFLICT (id_user) DO NOTHING;

-- Configurações Padrão
INSERT INTO system_settings (key_name, key_value) VALUES 
('min_deposit', '10.00'),
('min_withdraw', '50.00'),
('signup_bonus_type', 'fixed'),
('signup_bonus_val', '0.00'),
('signup_rollover_mult', '1'),
('deposit_bonus_type', 'fixed'),
('deposit_bonus_val', '0.00'),
('deposit_rollover_mult', '1')
ON CONFLICT (key_name) DO NOTHING;
