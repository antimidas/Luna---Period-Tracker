-- Period Tracker Database Schema

CREATE DATABASE IF NOT EXISTS period_tracker;
USE period_tracker;

-- Create app user
CREATE USER IF NOT EXISTS 'tracker'@'localhost' IDENTIFIED BY 'changeme_tracker';
GRANT ALL PRIVILEGES ON period_tracker.* TO 'tracker'@'localhost';
FLUSH PRIVILEGES;

-- App users table
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    is_admin TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Default local account (password: changeme123)
INSERT IGNORE INTO users (username, password_hash, display_name, is_admin) VALUES
    ('owner', '$2a$10$Q32qU2fd6T9EMVOU95dzWunH6NjUPyaoT1LPiWka2weG8NBHWPFRG', 'Owner', 1);

-- Admin membership table (authoritative admin source)
CREATE TABLE IF NOT EXISTS user_admins (
    user_id INT PRIMARY KEY,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_admins_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT IGNORE INTO user_admins (user_id)
SELECT id FROM users WHERE is_admin = 1;

-- Cycles table: tracks period start/end dates
CREATE TABLE IF NOT EXISTS cycles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NULL,
    flow_intensity ENUM('none', 'spotting', 'light', 'medium', 'heavy') DEFAULT 'medium',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_start (user_id, start_date),
    CONSTRAINT fk_cycles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Symptoms table: daily symptom logs
CREATE TABLE IF NOT EXISTS symptoms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    log_date DATE NOT NULL,
    symptom VARCHAR(100) NOT NULL,
    severity ENUM('mild', 'moderate', 'severe') DEFAULT 'moderate',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_date (log_date),
    UNIQUE KEY unique_symptom_per_day (user_id, log_date, symptom),
    CONSTRAINT fk_symptoms_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Moods table: daily mood tracking
CREATE TABLE IF NOT EXISTS moods (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    log_date DATE NOT NULL,
    mood VARCHAR(50) NOT NULL,
    energy_level TINYINT UNSIGNED CHECK (energy_level BETWEEN 1 AND 5),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_mood_per_day (user_id, log_date),
    CONSTRAINT fk_moods_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Journal entries: daily diary pages
CREATE TABLE IF NOT EXISTS journal_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    log_date DATE NOT NULL,
    entry_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_journal_user_date (user_id, log_date),
    KEY idx_journal_user_created_at (user_id, created_at),
    CONSTRAINT fk_journal_entries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Daily planner items with optional reminders
CREATE TABLE IF NOT EXISTS planner_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    plan_date DATE NOT NULL,
    title VARCHAR(255) NOT NULL,
    notes TEXT NULL,
    is_done TINYINT(1) NOT NULL DEFAULT 0,
    reminder_at DATETIME NULL,
    reminder_target VARCHAR(255) NULL,
    reminder_audio_url TEXT NULL,
    reminder_media_player VARCHAR(255) NULL,
    reminder_sent_at DATETIME NULL,
    reminder_at_2 DATETIME NULL,
    reminder_target_2 VARCHAR(255) NULL,
    reminder_audio_url_2 TEXT NULL,
    reminder_media_player_2 VARCHAR(255) NULL,
    reminder_sent_at_2 DATETIME NULL,
    reminder_at_3 DATETIME NULL,
    reminder_target_3 VARCHAR(255) NULL,
    reminder_audio_url_3 TEXT NULL,
    reminder_media_player_3 VARCHAR(255) NULL,
    reminder_sent_at_3 DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_planner_user_date (user_id, plan_date),
    KEY idx_planner_due (user_id, reminder_at, reminder_sent_at),
    KEY idx_planner_due_2 (user_id, reminder_at_2, reminder_sent_at_2),
    KEY idx_planner_due_3 (user_id, reminder_at_3, reminder_sent_at_3),
    CONSTRAINT fk_planner_items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Settings table: user preferences & HA config
CREATE TABLE IF NOT EXISTS settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    setting_key VARCHAR(100) NOT NULL UNIQUE,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_setting (user_id, setting_key),
    CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Default settings
INSERT IGNORE INTO settings (user_id, setting_key, setting_value)
SELECT id, 'average_cycle_length', '28' FROM users
UNION ALL
SELECT id, 'average_period_length', '5' FROM users
UNION ALL
SELECT id, 'ha_notifications_enabled', 'true' FROM users;

-- View: useful summary for HA SQL sensor
CREATE OR REPLACE VIEW v_current_status AS
SELECT
    (SELECT start_date FROM cycles WHERE user_id = 1 ORDER BY start_date DESC LIMIT 1) AS last_period_start,
    (SELECT end_date FROM cycles WHERE user_id = 1 ORDER BY start_date DESC LIMIT 1) AS last_period_end,
    DATEDIFF(CURDATE(), (SELECT start_date FROM cycles WHERE user_id = 1 ORDER BY start_date DESC LIMIT 1)) AS days_since_period,
    (SELECT CAST(setting_value AS UNSIGNED) FROM settings WHERE user_id = 1 AND setting_key = 'average_cycle_length') AS avg_cycle_length,
    (
        (SELECT start_date FROM cycles WHERE user_id = 1 ORDER BY start_date DESC LIMIT 1)
        + INTERVAL (SELECT CAST(setting_value AS UNSIGNED) FROM settings WHERE user_id = 1 AND setting_key = 'average_cycle_length') DAY
    ) AS next_period_predicted;
