-- Create the database
CREATE DATABASE IF NOT EXISTS 30win;
USE 30win;

-- Create Users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ensure columns exist if table was already there (MySQL 8 compatibility)
ALTER TABLE users ADD COLUMN plain_password VARCHAR(255) DEFAULT NULL;
ALTER TABLE users ADD COLUMN name VARCHAR(100) DEFAULT NULL;
ALTER TABLE users ADD COLUMN is_demo BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN referral_code VARCHAR(20) UNIQUE NOT NULL;
ALTER TABLE users ADD COLUMN rewards_pending DECIMAL(15, 2) DEFAULT 0.00;
ALTER TABLE users ADD COLUMN invited_by VARCHAR(20) DEFAULT NULL;
ALTER TABLE users ADD COLUMN bonus_balance DECIMAL(15, 2) DEFAULT 0.00;
ALTER TABLE users ADD COLUMN rollover_required DECIMAL(15, 2) DEFAULT 0.00;
ALTER TABLE users ADD COLUMN rollover_progress DECIMAL(15, 2) DEFAULT 0.00;
ALTER TABLE users ADD COLUMN withdraw_password VARCHAR(255) DEFAULT NULL;

-- Referrals tracking (Logic: Subordinate Deposit >= 20, Betting >= 300)
CREATE TABLE IF NOT EXISTS referrals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    referrer_code VARCHAR(20) NOT NULL,
    invitee_phone VARCHAR(20) NOT NULL,
    deposit_total DECIMAL(15, 2) DEFAULT 0.00,
    bet_total DECIMAL(15, 2) DEFAULT 0.00,
    goal_reached BOOLEAN DEFAULT FALSE,
    reward_claimed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_code) REFERENCES users(referral_code)
);

-- Create Admins table
CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    operator_id VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Deposits table (for auditing)
CREATE TABLE IF NOT EXISTS deposits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    amount DECIMAL(15, 2) NOT NULL,
    method VARCHAR(50),
    status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
    external_id VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

ALTER TABLE deposits ADD COLUMN external_id VARCHAR(100) DEFAULT NULL;

-- Create Withdrawals table
CREATE TABLE IF NOT EXISTS withdrawals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    pix_key VARCHAR(100) NOT NULL,
    pix_type VARCHAR(20) NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    external_id VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Insert a default admin
INSERT IGNORE INTO admins (operator_id, password) VALUES ('admin', 'admin_pass_30win');

-- Insert a sample user with R$ 10
INSERT IGNORE INTO users (id_user, phone, password, balance, referral_code) 
VALUES ('291603625', '92996036214', 'User@2024', 10.00, 'REF123456');

-- Create API Credentials table (usually only 1 row or indexed by 'max_api')
CREATE TABLE IF NOT EXISTS api_credentials (
    module VARCHAR(50) PRIMARY KEY,
    agent_code VARCHAR(100) NOT NULL,
    agent_token VARCHAR(255) NOT NULL,
    agent_secret VARCHAR(255) DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Create Games table for synced games
CREATE TABLE IF NOT EXISTS games (
    game_code VARCHAR(100) PRIMARY KEY,
    provider_code VARCHAR(50) NOT NULL,
    game_name VARCHAR(255) NOT NULL,
    banner_path VARCHAR(255) DEFAULT NULL,
    status INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create System Settings table
CREATE TABLE IF NOT EXISTS system_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_name VARCHAR(50) UNIQUE NOT NULL,
    key_value VARCHAR(255) DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Insert Default Settings
INSERT IGNORE INTO system_settings (key_name, key_value) VALUES 
('min_deposit', '10.00'),
('min_withdraw', '50.00'),
('signup_bonus_type', 'fixed'),
('signup_bonus_val', '0.00'),
('signup_rollover_mult', '1'),
('deposit_bonus_type', 'fixed'),
('deposit_bonus_val', '0.00'),
('deposit_rollover_mult', '1');
