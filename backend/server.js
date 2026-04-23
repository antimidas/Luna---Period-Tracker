const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { execFile } = require("child_process");
require("dotenv").config();

const execFileAsync = util.promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: process.env.DB_PORT || 3306,
  database: process.env.DB_NAME || "period_tracker",
  user: process.env.DB_USER || "tracker",
  password: process.env.DB_PASSWORD || "",
  waitForConnections: true,
  connectionLimit: 10,
});

const FLOW_OPTIONS = ["none", "spotting", "light", "medium", "heavy"];
const SYMPTOM_EMOJIS = {
  "Cramps": "😖",
  "Back pain": "🌀",
  "Headache": "🤕",
  "Bloating": "🎈",
  "Breast tenderness": "💗",
  "Fatigue": "🥱",
  "Nausea": "🤢",
  "Acne": "🫧",
  "Insomnia": "🌙",
  "Hot flashes": "🔥",
  "Food cravings": "🍫",
  "Spotting": "🩸",
  "Dizziness": "💫",
  "Joint pain": "🦴",
  "Mood swings": "🎭",
};
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";
const JWT_EXPIRES_IN = "7d";
const API_KEY = process.env.API_KEY || "mysecretapikey";
const PHPMYADMIN_URL = process.env.PHPMYADMIN_URL || "/phpmyadmin";
const BACKUP_DIR = path.join(__dirname, "..", "backups");

function symptomEmoji(symptom) {
  return SYMPTOM_EMOJIS[symptom] || "✏️";
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, is_admin: !!user.is_admin }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

async function runMigration(query, ignoredCodes = []) {
  try {
    await pool.query(query);
  } catch (err) {
    if (!ignoredCodes.includes(err.code)) throw err;
  }
}

async function ensureSchema() {
  await runMigration(
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runMigration(
    `CREATE TABLE IF NOT EXISTS user_admins (
      user_id INT PRIMARY KEY,
      granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_user_admins_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );

  const defaultHash = await bcrypt.hash("changeme123", 10);
  await pool.query(
    `INSERT IGNORE INTO users (username, password_hash, display_name) VALUES ('owner', ?, 'Owner')`,
    [defaultHash]
  );

  const [ownerRows] = await pool.query(`SELECT id FROM users WHERE username='owner' LIMIT 1`);
  const ownerId = ownerRows[0]?.id || 1;

  await runMigration(`ALTER TABLE cycles MODIFY flow_intensity ENUM('none', 'spotting', 'light', 'medium', 'heavy') DEFAULT 'medium'`);

  await runMigration(`ALTER TABLE cycles ADD COLUMN user_id INT NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE symptoms ADD COLUMN user_id INT NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE moods ADD COLUMN user_id INT NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE settings ADD COLUMN user_id INT NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(
    `CREATE TABLE IF NOT EXISTS journal_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      log_date DATE NOT NULL,
      entry_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_journal_per_day (user_id, log_date),
      CONSTRAINT fk_journal_entries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await runMigration(
    `CREATE TABLE IF NOT EXISTS planner_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      plan_date DATE NOT NULL,
      title VARCHAR(255) NOT NULL,
      notes TEXT NULL,
      is_done TINYINT(1) NOT NULL DEFAULT 0,
      reminder_at DATETIME NULL,
      reminder_target VARCHAR(255) NULL,
      reminder_sent_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_planner_user_date (user_id, plan_date),
      KEY idx_planner_due (user_id, reminder_at, reminder_sent_at),
      CONSTRAINT fk_planner_items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await runMigration(`ALTER TABLE planner_items ADD COLUMN notes TEXT NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN is_done TINYINT(1) NOT NULL DEFAULT 0`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_at DATETIME NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_target VARCHAR(255) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_sent_at DATETIME NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_audio_url VARCHAR(1024) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_media_player VARCHAR(255) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_at_2 DATETIME NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_target_2 VARCHAR(255) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_sent_at_2 DATETIME NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_audio_url_2 VARCHAR(1024) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_media_player_2 VARCHAR(255) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_at_3 DATETIME NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_target_3 VARCHAR(255) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_sent_at_3 DATETIME NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_audio_url_3 VARCHAR(1024) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD COLUMN reminder_media_player_3 VARCHAR(255) NULL`, ["ER_DUP_FIELDNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD KEY idx_planner_user_date (user_id, plan_date)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD KEY idx_planner_due (user_id, reminder_at, reminder_sent_at)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD KEY idx_planner_due_2 (user_id, reminder_at_2, reminder_sent_at_2)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE planner_items ADD KEY idx_planner_due_3 (user_id, reminder_at_3, reminder_sent_at_3)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE journal_entries ADD KEY idx_journal_user_date (user_id, log_date)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE journal_entries ADD KEY idx_journal_user_created_at (user_id, created_at)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE journal_entries DROP INDEX unique_journal_per_day`, ["ER_CANT_DROP_FIELD_OR_KEY"]);

  await pool.query(`UPDATE cycles SET user_id=? WHERE user_id IS NULL`, [ownerId]);
  await pool.query(`UPDATE symptoms SET user_id=? WHERE user_id IS NULL`, [ownerId]);
  await pool.query(`UPDATE moods SET user_id=? WHERE user_id IS NULL`, [ownerId]);
  await pool.query(`UPDATE settings SET user_id=? WHERE user_id IS NULL`, [ownerId]);

  await runMigration(`ALTER TABLE cycles MODIFY user_id INT NOT NULL`);
  await runMigration(`ALTER TABLE symptoms MODIFY user_id INT NOT NULL`);
  await runMigration(`ALTER TABLE moods MODIFY user_id INT NOT NULL`);
  await runMigration(`ALTER TABLE settings MODIFY user_id INT NOT NULL`);

  await runMigration(`ALTER TABLE cycles DROP INDEX unique_start`, ["ER_CANT_DROP_FIELD_OR_KEY", "ER_DROP_INDEX_FK"]);
  await runMigration(`ALTER TABLE symptoms DROP INDEX unique_symptom_per_day`, ["ER_CANT_DROP_FIELD_OR_KEY", "ER_DROP_INDEX_FK"]);
  await runMigration(`ALTER TABLE moods DROP INDEX log_date`, ["ER_CANT_DROP_FIELD_OR_KEY", "ER_DROP_INDEX_FK"]);
  await runMigration(`ALTER TABLE settings DROP INDEX setting_key`, ["ER_CANT_DROP_FIELD_OR_KEY", "ER_DROP_INDEX_FK"]);

  await runMigration(`ALTER TABLE cycles ADD UNIQUE KEY unique_start (user_id, start_date)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE symptoms ADD UNIQUE KEY unique_symptom_per_day (user_id, log_date, symptom)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE moods ADD UNIQUE KEY unique_mood_per_day (user_id, log_date)`, ["ER_DUP_KEYNAME"]);
  await runMigration(`ALTER TABLE settings ADD UNIQUE KEY unique_user_setting (user_id, setting_key)`, ["ER_DUP_KEYNAME"]);

  await runMigration(`ALTER TABLE cycles ADD CONSTRAINT fk_cycles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`, ["ER_DUP_KEYNAME", "ER_FK_DUP_NAME", "ER_CANT_CREATE_TABLE"]);
  await runMigration(`ALTER TABLE symptoms ADD CONSTRAINT fk_symptoms_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`, ["ER_DUP_KEYNAME", "ER_FK_DUP_NAME", "ER_CANT_CREATE_TABLE"]);
  await runMigration(`ALTER TABLE moods ADD CONSTRAINT fk_moods_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`, ["ER_DUP_KEYNAME", "ER_FK_DUP_NAME", "ER_CANT_CREATE_TABLE"]);
  await runMigration(`ALTER TABLE settings ADD CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`, ["ER_DUP_KEYNAME", "ER_FK_DUP_NAME", "ER_CANT_CREATE_TABLE"]);

  await runMigration(`ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0`, ["ER_DUP_FIELDNAME"]);
  await pool.query(`UPDATE users SET is_admin=1 WHERE username='owner'`);

  const antiHash = await bcrypt.hash("Edifice692vacuum$", 10);
  await pool.query(
    `INSERT IGNORE INTO users (username, password_hash, display_name, is_admin) VALUES ('anti', ?, 'Anti', 1)`,
    [antiHash]
  );

  await pool.query(
    `INSERT IGNORE INTO user_admins (user_id)
     SELECT id FROM users WHERE is_admin=1`
  );

  await pool.query(
    `UPDATE users u
     LEFT JOIN user_admins ua ON ua.user_id=u.id
     SET u.is_admin = IF(ua.user_id IS NULL, 0, 1)`
  );

  await pool.query(
    `INSERT IGNORE INTO settings (user_id, setting_key, setting_value)
     SELECT id, 'average_cycle_length', '28' FROM users
     UNION ALL
     SELECT id, 'average_period_length', '5' FROM users
     UNION ALL
     SELECT id, 'ha_notifications_enabled', 'true' FROM users`
  );

  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireApiKey(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "";
  const isInternal = ip === "::1" || ip === "127.0.0.1" || ip.startsWith("172.") || ip.startsWith("10.");
  if (isInternal) return next();

  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}

async function requireAdmin(req, res, next) {
  try {
    const [rows] = await pool.query(`SELECT user_id FROM user_admins WHERE user_id=? LIMIT 1`, [req.user.id]);
    if (!rows.length) return res.status(403).json({ error: "Admin access required" });
    next();
  } catch (err) {
    next(err);
  }
}

async function getApiContextUser(req) {
  const username = String(req.query.username || "owner").trim().toLowerCase();
  const [rows] = await pool.query(
    `SELECT id, username FROM users WHERE username=? LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function notifyHomeAssistant(eventType, data) {
  const webhookUrl = process.env.HA_WEBHOOK_URL;
  const haToken = process.env.HA_TOKEN;
  if (!webhookUrl) return { sent: false, skipped: true, reason: "missing_webhook_url" };

  try {
    await axios.post(webhookUrl, { event: eventType, ...data }, {
      headers: haToken ? { Authorization: `Bearer ${haToken}` } : {},
      timeout: 5000,
    });
    console.log(`[HA] Notified: ${eventType}`);
    return { sent: true };
  } catch (err) {
    console.error(`[HA] Notification failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

function getHomeAssistantApiConfig() {
  const baseUrl = String(process.env.HA_BASE_URL || "").trim().replace(/\/+$/, "");
  const token = String(process.env.HA_TOKEN || "").trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

function normalizeHaNotifyTarget(target) {
  const raw = String(target || "").trim();
  if (!raw) return "";
  if (raw.startsWith("notify.")) return raw;
  if (/^[a-z0-9_]+$/i.test(raw)) return `notify.${raw.toLowerCase()}`;
  return "";
}

function formatHaNotifyLabel(entityId) {
  const safeId = normalizeHaNotifyTarget(entityId);
  if (!safeId) return "";
  const name = safeId.replace(/^notify\./, "").replace(/_/g, " ");
  return name.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function normalizeHaMediaPlayerTarget(target) {
  const raw = String(target || "").trim();
  if (!raw) return "";
  if (raw.startsWith("media_player.")) return raw;
  if (/^[a-z0-9_]+$/i.test(raw)) return `media_player.${raw.toLowerCase()}`;
  return "";
}

function formatHaEntityLabel(entityId) {
  const raw = String(entityId || "").trim();
  if (!raw) return "";
  const name = raw.replace(/^[^.]+\./, "").replace(/_/g, " ");
  return name.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

async function fetchHomeAssistantNotifyDevices() {
  const config = getHomeAssistantApiConfig();
  if (!config) return [];

  try {
    const servicesResponse = await axios.get(`${config.baseUrl}/api/services`, {
      headers: { Authorization: `Bearer ${config.token}` },
      timeout: 7000,
    });

    const services = Array.isArray(servicesResponse.data) ? servicesResponse.data : [];
    const notifyDomain = services.find((entry) => entry && entry.domain === "notify");
    const notifyServices = notifyDomain && typeof notifyDomain.services === "object"
      ? Object.keys(notifyDomain.services)
      : [];

    return notifyServices
      .filter((name) => /^[a-z0-9_]+$/i.test(name))
      .map((serviceName) => {
        const service = `notify.${serviceName}`;
        return {
          id: service,
          service,
          label: formatHaNotifyLabel(service),
          type: serviceName.startsWith("mobile_app_") ? "mobile_app" : "notify_service",
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    console.error("HA notify device discovery failed:", err.message);
    return [];
  }
}

async function fetchHomeAssistantMediaPlayers() {
  const config = getHomeAssistantApiConfig();
  if (!config) return [];

  try {
    const statesResponse = await axios.get(`${config.baseUrl}/api/states`, {
      headers: { Authorization: `Bearer ${config.token}` },
      timeout: 7000,
    });

    const states = Array.isArray(statesResponse.data) ? statesResponse.data : [];
    return states
      .filter((entry) => entry && typeof entry.entity_id === "string" && entry.entity_id.startsWith("media_player."))
      .filter((entry) => String(entry.state || "").toLowerCase() !== "unavailable")
      .map((entry) => ({
        id: entry.entity_id,
        entity_id: entry.entity_id,
        label: String(entry.attributes?.friendly_name || formatHaEntityLabel(entry.entity_id)),
        state: entry.state || "unknown",
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    console.error("HA media player discovery failed:", err.message);
    return [];
  }
}

async function sendHomeAssistantCompanionNotification(target, title, message, data = {}) {
  const config = getHomeAssistantApiConfig();
  const entityId = normalizeHaNotifyTarget(target);
  if (!config || !entityId) return { sent: false, reason: "missing_config_or_target" };

  const serviceName = entityId.replace(/^notify\./, "");
  if (!serviceName) return { sent: false, reason: "invalid_service" };

  try {
    await axios.post(
      `${config.baseUrl}/api/services/notify/${serviceName}`,
      {
        title: String(title || "Luna Reminder"),
        message: String(message || "Planner reminder"),
        data,
      },
      {
        headers: { Authorization: `Bearer ${config.token}` },
        timeout: 7000,
      }
    );
    return { sent: true };
  } catch (err) {
    console.error(`HA direct notify failed (${entityId}):`, err.message);
    return { sent: false, reason: err.message };
  }
}

async function playHomeAssistantMedia(mediaPlayerTarget, audioUrl) {
  const config = getHomeAssistantApiConfig();
  const entityId = normalizeHaMediaPlayerTarget(mediaPlayerTarget);
  const mediaContentId = String(audioUrl || "").trim();
  if (!config || !entityId || !mediaContentId) return { sent: false, reason: "missing_config_or_media" };

  try {
    await axios.post(
      `${config.baseUrl}/api/services/media_player/play_media`,
      {
        entity_id: entityId,
        media_content_id: mediaContentId,
        media_content_type: "music",
      },
      {
        headers: { Authorization: `Bearer ${config.token}` },
        timeout: 7000,
      }
    );
    return { sent: true };
  } catch (err) {
    console.error(`HA media playback failed (${entityId}):`, err.message);
    return { sent: false, reason: err.message };
  }
}

async function getPrediction(userId) {
  const [rows] = await pool.query(
    `SELECT start_date FROM cycles WHERE user_id=? ORDER BY start_date DESC LIMIT 1`,
    [userId]
  );
  if (!rows.length) return null;

  const [settings] = await pool.query(
    `SELECT setting_value FROM settings WHERE user_id=? AND setting_key='average_cycle_length'`,
    [userId]
  );

  const cycleLen = parseInt(settings[0]?.setting_value || "28", 10);
  const lastStart = new Date(rows[0].start_date);
  const nextDate = new Date(lastStart);
  nextDate.setDate(nextDate.getDate() + cycleLen);
  return nextDate.toISOString().split("T")[0];
}

async function getCurrentStatus(userId) {
  const [latestCycle] = await pool.query(
    `SELECT start_date, end_date FROM cycles WHERE user_id=? ORDER BY start_date DESC LIMIT 1`,
    [userId]
  );

  const [settings] = await pool.query(
    `SELECT setting_value FROM settings WHERE user_id=? AND setting_key='average_cycle_length' LIMIT 1`,
    [userId]
  );

  const avgCycle = parseInt(settings[0]?.setting_value || "28", 10);
  const last = latestCycle[0];
  const today = new Date();

  if (!last) {
    return {
      last_period_start: null,
      last_period_end: null,
      days_since_period: null,
      avg_cycle_length: avgCycle,
    };
  }

  const start = new Date(last.start_date);
  const daysSince = Math.floor((today - start) / 86400000);

  return {
    last_period_start: last.start_date,
    last_period_end: last.end_date,
    days_since_period: daysSince,
    avg_cycle_length: avgCycle,
  };
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace("T", " ")}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function serializeRowsAsInsert(tableName, rows) {
  if (!rows.length) return `-- ${tableName}: no rows\n`;
  const cols = Object.keys(rows[0]);
  const values = rows.map((row) => `(${cols.map((c) => sqlValue(row[c])).join(", ")})`).join(",\n");
  return `INSERT INTO ${tableName} (${cols.join(", ")}) VALUES\n${values};\n`;
}

async function createMySqlDump() {
  const host = process.env.DB_HOST || "127.0.0.1";
  const port = String(process.env.DB_PORT || 3306);
  const db = process.env.DB_NAME || "period_tracker";
  const user = process.env.DB_USER || "tracker";
  const password = process.env.DB_PASSWORD || "";
  const args = ["-h", host, "-P", port, "-u", user, `--password=${password}`, "--single-transaction", db];
  const { stdout } = await execFileAsync("mysqldump", args, { maxBuffer: 1024 * 1024 * 32 });
  return stdout;
}

async function buildHomeAssistantCalendar(userId) {
  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const month = monthIndex + 1;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, month, 0).toISOString().split("T")[0];
  const today = now.toISOString().split("T")[0];

  const [cycles] = await pool.query(
    `SELECT * FROM cycles
     WHERE user_id=? AND start_date <= ? AND COALESCE(end_date, start_date) >= ?
     ORDER BY start_date ASC`,
    [userId, monthEnd, monthStart]
  );
  const [symptoms] = await pool.query(
    `SELECT * FROM symptoms WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=? ORDER BY log_date ASC, symptom ASC`,
    [userId, year, month]
  );
  const [moods] = await pool.query(
    `SELECT * FROM moods WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=? ORDER BY log_date ASC`,
    [userId, year, month]
  );
  const [journals] = await pool.query(
    `SELECT * FROM journal_entries WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=? ORDER BY log_date ASC`,
    [userId, year, month]
  );

  const predictedStart = await getPrediction(userId);
  const predictedDays = new Set();
  if (predictedStart) {
    const base = new Date(predictedStart);
    for (let i = 0; i < 5; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      predictedDays.add(d.toISOString().split("T")[0]);
    }
  }

  const periodDays = new Set();
  cycles.forEach((cycle) => {
    const start = new Date(cycle.start_date);
    const end = new Date(cycle.end_date || cycle.start_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      periodDays.add(d.toISOString().split("T")[0]);
    }
  });

  const symptomsByDay = new Map();
  symptoms.forEach((entry) => {
    const day = String(entry.log_date).split("T")[0];
    if (!symptomsByDay.has(day)) symptomsByDay.set(day, []);
    const list = symptomsByDay.get(day);
    if (!list.includes(entry.symptom)) list.push(entry.symptom);
  });

  const moodDays = new Set(moods.map((entry) => String(entry.log_date).split("T")[0]));
  const journalDays = new Set(journals.map((entry) => String(entry.log_date).split("T")[0]));
  const firstDay = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const weeks = [];
  let week = [];

  for (let i = 0; i < firstDay; i++) {
    week.push({ in_month: false, label: "" });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const daySymptoms = symptomsByDay.get(dateStr) || [];
    const showIcons = periodDays.has(dateStr) && daySymptoms.length > 0;
    week.push({
      in_month: true,
      label: String(day),
      date: dateStr,
      is_today: dateStr === today,
      is_period: periodDays.has(dateStr),
      is_predicted: !periodDays.has(dateStr) && predictedDays.has(dateStr),
      has_mood: moodDays.has(dateStr),
      has_journal: journalDays.has(dateStr),
      symptom_count: daySymptoms.length,
      symptom_icons: showIcons ? daySymptoms.slice(0, 3).map(symptomEmoji) : [],
      more_symptoms: showIcons && daySymptoms.length > 3 ? "+" : "",
    });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }

  while (week.length && week.length < 7) {
    week.push({ in_month: false, label: "" });
  }
  if (week.length) weeks.push(week);

  return {
    month_label: now.toLocaleString("en-US", { month: "long", year: "numeric" }),
    weekdays: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
    weeks,
  };
}

// Authentication
app.post("/api/auth/register", async (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  if (String(username).length < 3 || String(password).length < 6) {
    return res.status(400).json({ error: "username min 3 chars and password min 6 chars" });
  }

  const uname = String(username).trim().toLowerCase();
  const displayName = (display_name || username).trim().slice(0, 100);

  const hash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.query(
      `INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, 0)`,
      [uname, hash, displayName]
    );

    await pool.query(
      `INSERT IGNORE INTO settings (user_id, setting_key, setting_value) VALUES
       (?, 'average_cycle_length', '28'),
       (?, 'average_period_length', '5'),
       (?, 'ha_notifications_enabled', 'true')`,
      [result.insertId, result.insertId, result.insertId]
    );

    const user = { id: result.insertId, username: uname, display_name: displayName, is_admin: 0 };
    return res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "username already exists" });
    throw err;
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password required" });

  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.password_hash,
            CASE WHEN ua.user_id IS NULL THEN 0 ELSE 1 END AS is_admin
     FROM users u
     LEFT JOIN user_admins ua ON ua.user_id=u.id
     WHERE u.username=?
     LIMIT 1`,
    [String(username).trim().toLowerCase()]
  );

  const user = rows[0];
  if (!user) return res.status(401).json({ error: "invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, display_name: user.display_name, is_admin: !!user.is_admin },
  });
});

// Generate a long-lived embed token using the API key (no password needed)
app.get("/api/auth/embed-token", requireApiKey, async (req, res) => {
  const username = String(req.query.username || "").trim().toLowerCase();
  if (!username) return res.status(400).json({ error: "username query param required" });

  const [rows] = await pool.query(
    `SELECT id, username, display_name FROM users WHERE username=? LIMIT 1`,
    [username]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "user not found" });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: "365d",
  });
  res.json({ token, expires_in: "365d", user: { id: user.id, username: user.username } });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.display_name,
            CASE WHEN ua.user_id IS NULL THEN 0 ELSE 1 END AS is_admin
     FROM users u
     LEFT JOIN user_admins ua ON ua.user_id=u.id
     WHERE u.id=?
     LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "user not found" });
  res.json(rows[0]);
});

app.get("/api/admin/phpmyadmin", requireAuth, requireAdmin, async (req, res) => {
  res.json({ url: PHPMYADMIN_URL });
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY id ASC`
  );
  res.json(rows.map((u) => ({ ...u, is_admin: !!u.is_admin })));
});

app.get("/api/admin/export/users", requireAuth, requireAdmin, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY id ASC`
  );
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename=users_export_${new Date().toISOString().slice(0, 10)}.json`);
  res.send(JSON.stringify(rows.map((u) => ({ ...u, is_admin: !!u.is_admin })), null, 2));
});

app.get("/api/admin/export/user-db", requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.query.user_id);
  if (!userId || Number.isNaN(userId)) return res.status(400).json({ error: "user_id query param required" });

  const [userRows] = await pool.query(
    `SELECT id, username, display_name, is_admin, created_at FROM users WHERE id=? LIMIT 1`,
    [userId]
  );
  if (!userRows.length) return res.status(404).json({ error: "user not found" });

  const [cycles] = await pool.query(`SELECT * FROM cycles WHERE user_id=? ORDER BY start_date ASC`, [userId]);
  const [symptoms] = await pool.query(`SELECT * FROM symptoms WHERE user_id=? ORDER BY log_date ASC, symptom ASC`, [userId]);
  const [moods] = await pool.query(`SELECT * FROM moods WHERE user_id=? ORDER BY log_date ASC`, [userId]);
  const [journals] = await pool.query(`SELECT * FROM journal_entries WHERE user_id=? ORDER BY log_date ASC`, [userId]);
  const [settings] = await pool.query(`SELECT * FROM settings WHERE user_id=? ORDER BY setting_key ASC`, [userId]);

  const format = String(req.query.format || "json").toLowerCase();
  if (format === "sql") {
    const chunks = [];
    chunks.push("-- Luna Period Tracker user-scoped export\n");
    chunks.push(`-- user_id=${userId}\n\n`);
    chunks.push(serializeRowsAsInsert("users", userRows));
    chunks.push(serializeRowsAsInsert("cycles", cycles));
    chunks.push(serializeRowsAsInsert("symptoms", symptoms));
    chunks.push(serializeRowsAsInsert("moods", moods));
    chunks.push(serializeRowsAsInsert("journal_entries", journals));
    chunks.push(serializeRowsAsInsert("settings", settings));
    res.setHeader("Content-Type", "application/sql");
    res.setHeader("Content-Disposition", `attachment; filename=user_${userId}_export.sql`);
    return res.send(chunks.join("\n"));
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename=user_${userId}_export.json`);
  return res.send(JSON.stringify({ user: userRows[0], cycles, symptoms, moods, journals, settings }, null, 2));
});

app.get("/api/admin/export/full-db", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const dump = await createMySqlDump();
    res.setHeader("Content-Type", "application/sql");
    res.setHeader("Content-Disposition", `attachment; filename=period_tracker_full_${new Date().toISOString().slice(0, 10)}.sql`);
    res.send(dump);
  } catch (err) {
    next(new Error(`Failed to export DB. Ensure mysqldump is installed: ${err.message}`));
  }
});

app.post("/api/admin/backup", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const dump = await createMySqlDump();
    const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+/, "");
    const fileName = `period_tracker_backup_${stamp}.sql`;
    const filePath = path.join(BACKUP_DIR, fileName);
    await fs.promises.writeFile(filePath, dump, "utf8");
    res.json({ success: true, file: fileName, download_url: `/api/admin/backup/${encodeURIComponent(fileName)}` });
  } catch (err) {
    next(new Error(`Failed to create backup. Ensure mysqldump is installed: ${err.message}`));
  }
});

app.get("/api/admin/backup/:file", requireAuth, requireAdmin, async (req, res) => {
  const base = path.basename(req.params.file);
  const target = path.join(BACKUP_DIR, base);
  if (!fs.existsSync(target)) return res.status(404).json({ error: "backup file not found" });
  res.download(target, base);
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password and new_password required" });
  }
  if (String(new_password).length < 6) {
    return res.status(400).json({ error: "new password must be at least 6 characters" });
  }

  const [rows] = await pool.query(
    `SELECT id, password_hash FROM users WHERE id=? LIMIT 1`,
    [req.user.id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "user not found" });

  const matches = await bcrypt.compare(current_password, user.password_hash);
  if (!matches) return res.status(401).json({ error: "current password is incorrect" });

  const same = await bcrypt.compare(new_password, user.password_hash);
  if (same) return res.status(400).json({ error: "new password must be different" });

  const newHash = await bcrypt.hash(new_password, 10);
  await pool.query(`UPDATE users SET password_hash=? WHERE id=?`, [newHash, req.user.id]);

  res.json({ success: true });
});

// Cycles
app.get("/api/cycles", requireAuth, async (req, res) => {
  const { year, month } = req.query;
  let query = "SELECT * FROM cycles WHERE user_id=? ORDER BY start_date DESC";
  let params = [req.user.id];

  if (year && month) {
    query = `SELECT * FROM cycles WHERE user_id=? AND YEAR(start_date)=? AND MONTH(start_date)=? ORDER BY start_date DESC`;
    params = [req.user.id, year, month];
  }

  const [rows] = await pool.query(query, params);
  res.json(rows);
});

app.post("/api/cycles", requireAuth, async (req, res) => {
  try {
  const { start_date, end_date, flow_intensity, notes } = req.body;
  if (!start_date) return res.status(400).json({ error: "start_date required" });

  const flow = FLOW_OPTIONS.includes(flow_intensity) ? flow_intensity : "medium";

  const [result] = await pool.query(
    `INSERT INTO cycles (user_id, start_date, end_date, flow_intensity, notes)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE end_date=VALUES(end_date), flow_intensity=VALUES(flow_intensity), notes=VALUES(notes)`,
    [req.user.id, start_date, end_date || null, flow, notes || null]
  );

  const prediction = await getPrediction(req.user.id);
  await notifyHomeAssistant("period_logged", {
    user_id: req.user.id,
    username: req.user.username,
    start_date,
    flow_intensity: flow,
    next_predicted: prediction,
  });

  res.json({ id: result.insertId, start_date, prediction });
  } catch (e) { console.error("POST /api/cycles:", e.message); res.status(500).json({ error: e.message }); }
});

app.patch("/api/cycles/:id", requireAuth, async (req, res) => {
  try {
  const { end_date, flow_intensity, notes } = req.body;
  await pool.query(
    `UPDATE cycles
     SET end_date=COALESCE(?, end_date),
         flow_intensity=COALESCE(?, flow_intensity),
         notes=COALESCE(?, notes)
     WHERE id=? AND user_id=?`,
    [end_date, flow_intensity, notes, req.params.id, req.user.id]
  );
  res.json({ success: true });
  } catch (e) { console.error("PATCH /api/cycles:", e.message); res.status(500).json({ error: e.message }); }
});

app.delete("/api/cycles/:id", requireAuth, async (req, res) => {
  try {
  await pool.query("DELETE FROM cycles WHERE id=? AND user_id=?", [req.params.id, req.user.id]);
  res.json({ success: true });
  } catch (e) { console.error("DELETE /api/cycles:", e.message); res.status(500).json({ error: e.message }); }
});

// Symptoms
app.get("/api/symptoms", requireAuth, async (req, res) => {
  const { date, month, year } = req.query;
  let rows;

  if (date) {
    [rows] = await pool.query(
      "SELECT * FROM symptoms WHERE user_id=? AND log_date=? ORDER BY symptom",
      [req.user.id, date]
    );
  } else if (month && year) {
    [rows] = await pool.query(
      "SELECT * FROM symptoms WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=? ORDER BY log_date",
      [req.user.id, year, month]
    );
  } else {
    [rows] = await pool.query(
      "SELECT * FROM symptoms WHERE user_id=? ORDER BY log_date DESC LIMIT 100",
      [req.user.id]
    );
  }

  res.json(rows);
});

app.post("/api/symptoms", requireAuth, async (req, res) => {
  try {
  const { log_date, symptom, severity } = req.body;
  if (!log_date || !symptom) return res.status(400).json({ error: "log_date and symptom required" });

  const [result] = await pool.query(
    `INSERT INTO symptoms (user_id, log_date, symptom, severity) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE severity=VALUES(severity)`,
    [req.user.id, log_date, symptom, severity || "moderate"]
  );

  await notifyHomeAssistant("symptom_logged", {
    user_id: req.user.id,
    username: req.user.username,
    log_date,
    symptom,
    severity,
  });

  res.json({ id: result.insertId, log_date, symptom });
  } catch (e) { console.error("POST /api/symptoms:", e.message); res.status(500).json({ error: e.message }); }
});

app.delete("/api/symptoms/:id", requireAuth, async (req, res) => {
  try {
  await pool.query("DELETE FROM symptoms WHERE id=? AND user_id=?", [req.params.id, req.user.id]);
  res.json({ success: true });
  } catch (e) { console.error("DELETE /api/symptoms:", e.message); res.status(500).json({ error: e.message }); }
});

// Moods
app.get("/api/moods", requireAuth, async (req, res) => {
  const { date } = req.query;
  if (date) {
    const [rows] = await pool.query(
      "SELECT * FROM moods WHERE user_id=? AND log_date=?",
      [req.user.id, date]
    );
    return res.json(rows[0] || null);
  }

  const [rows] = await pool.query(
    "SELECT * FROM moods WHERE user_id=? ORDER BY log_date DESC LIMIT 90",
    [req.user.id]
  );
  res.json(rows);
});

app.post("/api/moods", requireAuth, async (req, res) => {
  try {
    const { log_date, mood, energy_level, notes } = req.body;
    if (!log_date || !mood) return res.status(400).json({ error: "log_date and mood required" });

    // Clamp energy_level to valid DB range (1-5)
    let energy = energy_level != null ? parseInt(energy_level) : null;
    if (energy != null && (energy < 1 || energy > 5)) energy = Math.min(5, Math.max(1, energy));

    await pool.query(
      `INSERT INTO moods (user_id, log_date, mood, energy_level, notes) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE mood=VALUES(mood), energy_level=VALUES(energy_level), notes=VALUES(notes)`,
      [req.user.id, log_date, mood, energy, notes || null]
    );

    await notifyHomeAssistant("mood_logged", {
      user_id: req.user.id,
      username: req.user.username,
      log_date,
      mood,
      energy_level: energy,
    });

    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/moods error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/moods", requireAuth, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date query param required" });
    await pool.query("DELETE FROM moods WHERE user_id=? AND log_date=?", [req.user.id, date]);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/moods error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/journal", requireAuth, async (req, res) => {
  const { date, id, month, year } = req.query;
  let rows;

  if (id) {
    [rows] = await pool.query(
      "SELECT * FROM journal_entries WHERE user_id=? AND id=? LIMIT 1",
      [req.user.id, id]
    );
    return res.json(rows[0] || null);
  }

  if (date) {
    [rows] = await pool.query(
      "SELECT * FROM journal_entries WHERE user_id=? AND log_date=? ORDER BY created_at ASC, id ASC",
      [req.user.id, date]
    );
    return res.json(rows);
  }

  if (month && year) {
    [rows] = await pool.query(
      "SELECT * FROM journal_entries WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=? ORDER BY log_date DESC, created_at DESC, id DESC",
      [req.user.id, year, month]
    );
    return res.json(rows);
  }

  [rows] = await pool.query(
    "SELECT * FROM journal_entries WHERE user_id=? ORDER BY log_date DESC, created_at DESC, id DESC LIMIT 250",
    [req.user.id]
  );
  return res.json(rows);
});

app.post("/api/journal", requireAuth, async (req, res) => {
  try {
    const { id, log_date, entry_text } = req.body;
    const trimmedEntry = String(entry_text || "").trim();
    if (!log_date) return res.status(400).json({ error: "log_date required" });
    if (!trimmedEntry) return res.status(400).json({ error: "entry_text required" });

    if (id) {
      const [result] = await pool.query(
        `UPDATE journal_entries
         SET log_date=?, entry_text=?
         WHERE user_id=? AND id=?`,
        [log_date, trimmedEntry, req.user.id, id]
      );
      if (!result.affectedRows) return res.status(404).json({ error: "journal entry not found" });

      const [rows] = await pool.query(
        "SELECT * FROM journal_entries WHERE user_id=? AND id=? LIMIT 1",
        [req.user.id, id]
      );
      return res.json({ success: true, entry: rows[0] || null });
    }

    const [result] = await pool.query(
      `INSERT INTO journal_entries (user_id, log_date, entry_text)
       VALUES (?, ?, ?)`,
      [req.user.id, log_date, trimmedEntry]
    );

    const [rows] = await pool.query(
      "SELECT * FROM journal_entries WHERE user_id=? AND id=? LIMIT 1",
      [req.user.id, result.insertId]
    );

    res.json({ success: true, entry: rows[0] || null });
  } catch (e) {
    console.error("POST /api/journal error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/journal", requireAuth, async (req, res) => {
  try {
    const { date, id } = req.query;
    if (!date && !id) return res.status(400).json({ error: "id or date query param required" });

    if (id) {
      await pool.query("DELETE FROM journal_entries WHERE user_id=? AND id=?", [req.user.id, id]);
      return res.json({ success: true });
    }

    await pool.query("DELETE FROM journal_entries WHERE user_id=? AND log_date=?", [req.user.id, date]);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/journal error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/planner", requireAuth, async (req, res) => {
  try {
    const { date, from, to } = req.query;
    const reminderSortExpr = `NULLIF(LEAST(IFNULL(reminder_at, '9999-12-31 23:59:59'), IFNULL(reminder_at_2, '9999-12-31 23:59:59'), IFNULL(reminder_at_3, '9999-12-31 23:59:59')), '9999-12-31 23:59:59')`;
    let rows;

    if (date) {
      [rows] = await pool.query(
        `SELECT * FROM planner_items
         WHERE user_id=? AND plan_date=?
         ORDER BY is_done ASC, (${reminderSortExpr}) IS NULL, ${reminderSortExpr} ASC, created_at ASC, id ASC`,
        [req.user.id, date]
      );
      return res.json(rows);
    }

    if (from && to) {
      [rows] = await pool.query(
        `SELECT * FROM planner_items
         WHERE user_id=? AND plan_date BETWEEN ? AND ?
         ORDER BY plan_date ASC, is_done ASC, (${reminderSortExpr}) IS NULL, ${reminderSortExpr} ASC, created_at ASC, id ASC`,
        [req.user.id, from, to]
      );
      return res.json(rows);
    }

    [rows] = await pool.query(
      `SELECT * FROM planner_items
       WHERE user_id=?
       ORDER BY plan_date DESC, is_done ASC, (${reminderSortExpr}) IS NULL, ${reminderSortExpr} ASC, created_at DESC, id DESC
       LIMIT 500`,
      [req.user.id]
    );

    return res.json(rows);
  } catch (e) {
    console.error("GET /api/planner error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/planner", requireAuth, async (req, res) => {
  try {
    const {
      plan_date,
      title,
      notes,
      reminder_at,
      reminder_target,
      reminder_audio_url,
      reminder_media_player,
      reminder_at_2,
      reminder_target_2,
      reminder_audio_url_2,
      reminder_media_player_2,
      reminder_at_3,
      reminder_target_3,
      reminder_audio_url_3,
      reminder_media_player_3,
    } = req.body || {};
    const cleanedTitle = String(title || "").trim();
    const hasReminder = [reminder_at, reminder_at_2, reminder_at_3].some((value) => Boolean(value));
    if (!plan_date) return res.status(400).json({ error: "plan_date required" });
    if (!cleanedTitle && !hasReminder) return res.status(400).json({ error: "title or reminder required" });

    const [result] = await pool.query(
      `INSERT INTO planner_items (
        user_id,
        plan_date,
        title,
        notes,
        reminder_at,
        reminder_target,
        reminder_audio_url,
        reminder_media_player,
        reminder_at_2,
        reminder_target_2,
        reminder_audio_url_2,
        reminder_media_player_2,
        reminder_at_3,
        reminder_target_3,
        reminder_audio_url_3,
        reminder_media_player_3
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        plan_date,
        cleanedTitle,
        notes ? String(notes) : null,
        reminder_at || null,
        reminder_target ? String(reminder_target).trim() : null,
        reminder_audio_url ? String(reminder_audio_url).trim() : null,
        reminder_media_player ? String(reminder_media_player).trim() : null,
        reminder_at_2 || null,
        reminder_target_2 ? String(reminder_target_2).trim() : null,
        reminder_audio_url_2 ? String(reminder_audio_url_2).trim() : null,
        reminder_media_player_2 ? String(reminder_media_player_2).trim() : null,
        reminder_at_3 || null,
        reminder_target_3 ? String(reminder_target_3).trim() : null,
        reminder_audio_url_3 ? String(reminder_audio_url_3).trim() : null,
        reminder_media_player_3 ? String(reminder_media_player_3).trim() : null,
      ]
    );

    const [rows] = await pool.query(
      `SELECT * FROM planner_items WHERE user_id=? AND id=? LIMIT 1`,
      [req.user.id, result.insertId]
    );

    res.json({ success: true, item: rows[0] || null });
  } catch (e) {
    console.error("POST /api/planner error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch("/api/planner/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ error: "valid id required" });

    const [existingRows] = await pool.query(
      `SELECT title, reminder_at, reminder_at_2, reminder_at_3 FROM planner_items WHERE user_id=? AND id=? LIMIT 1`,
      [req.user.id, id]
    );
    const existingItem = existingRows[0];
    if (!existingItem) return res.status(404).json({ error: "planner item not found" });

    const {
      plan_date,
      title,
      notes,
      is_done,
      reminder_at,
      reminder_target,
      reminder_audio_url,
      reminder_media_player,
      reminder_at_2,
      reminder_target_2,
      reminder_audio_url_2,
      reminder_media_player_2,
      reminder_at_3,
      reminder_target_3,
      reminder_audio_url_3,
      reminder_media_player_3,
    } = req.body || {};

    const mergedTitle = title !== undefined ? String(title || "").trim() : String(existingItem.title || "").trim();
    const mergedReminder1 = reminder_at !== undefined ? (reminder_at || null) : existingItem.reminder_at;
    const mergedReminder2 = reminder_at_2 !== undefined ? (reminder_at_2 || null) : existingItem.reminder_at_2;
    const mergedReminder3 = reminder_at_3 !== undefined ? (reminder_at_3 || null) : existingItem.reminder_at_3;
    const hasReminder = [mergedReminder1, mergedReminder2, mergedReminder3].some((value) => Boolean(value));
    if (!mergedTitle && !hasReminder) return res.status(400).json({ error: "title or reminder required" });

    const fields = [];
    const values = [];

    if (plan_date !== undefined) {
      fields.push("plan_date=?");
      values.push(plan_date);
    }
    if (title !== undefined) {
      fields.push("title=?");
      values.push(String(title || "").trim());
    }
    if (notes !== undefined) {
      fields.push("notes=?");
      values.push(notes ? String(notes) : null);
    }
    if (is_done !== undefined) {
      fields.push("is_done=?");
      values.push(is_done ? 1 : 0);
    }
    if (reminder_at !== undefined) {
      fields.push("reminder_at=?");
      values.push(reminder_at || null);
      fields.push("reminder_sent_at=NULL");
    }
    if (reminder_target !== undefined) {
      fields.push("reminder_target=?");
      values.push(reminder_target ? String(reminder_target).trim() : null);
    }
    if (reminder_audio_url !== undefined) {
      fields.push("reminder_audio_url=?");
      values.push(reminder_audio_url ? String(reminder_audio_url).trim() : null);
    }
    if (reminder_media_player !== undefined) {
      fields.push("reminder_media_player=?");
      values.push(reminder_media_player ? String(reminder_media_player).trim() : null);
    }
    if (reminder_at_2 !== undefined) {
      fields.push("reminder_at_2=?");
      values.push(reminder_at_2 || null);
      fields.push("reminder_sent_at_2=NULL");
    }
    if (reminder_target_2 !== undefined) {
      fields.push("reminder_target_2=?");
      values.push(reminder_target_2 ? String(reminder_target_2).trim() : null);
    }
    if (reminder_audio_url_2 !== undefined) {
      fields.push("reminder_audio_url_2=?");
      values.push(reminder_audio_url_2 ? String(reminder_audio_url_2).trim() : null);
    }
    if (reminder_media_player_2 !== undefined) {
      fields.push("reminder_media_player_2=?");
      values.push(reminder_media_player_2 ? String(reminder_media_player_2).trim() : null);
    }
    if (reminder_at_3 !== undefined) {
      fields.push("reminder_at_3=?");
      values.push(reminder_at_3 || null);
      fields.push("reminder_sent_at_3=NULL");
    }
    if (reminder_target_3 !== undefined) {
      fields.push("reminder_target_3=?");
      values.push(reminder_target_3 ? String(reminder_target_3).trim() : null);
    }
    if (reminder_audio_url_3 !== undefined) {
      fields.push("reminder_audio_url_3=?");
      values.push(reminder_audio_url_3 ? String(reminder_audio_url_3).trim() : null);
    }
    if (reminder_media_player_3 !== undefined) {
      fields.push("reminder_media_player_3=?");
      values.push(reminder_media_player_3 ? String(reminder_media_player_3).trim() : null);
    }

    if (!fields.length) return res.json({ success: true });

    values.push(req.user.id, id);
    const [result] = await pool.query(
      `UPDATE planner_items
       SET ${fields.join(", ")}
       WHERE user_id=? AND id=?`,
      values
    );
    if (!result.affectedRows) return res.status(404).json({ error: "planner item not found" });

    const [rows] = await pool.query(
      `SELECT * FROM planner_items WHERE user_id=? AND id=? LIMIT 1`,
      [req.user.id, id]
    );

    res.json({ success: true, item: rows[0] || null });
  } catch (e) {
    console.error("PATCH /api/planner/:id error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/planner/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ error: "valid id required" });
    await pool.query(`DELETE FROM planner_items WHERE user_id=? AND id=?`, [req.user.id, id]);
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/planner/:id error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/theme-customization", requireAuth, async (req, res) => {
  try {
    const keys = [
      "theme_wallpaper_library",
      "theme_wallpapers",
      "theme_custom_themes",
      "theme_selected",
    ];

    const [rows] = await pool.query(
      `SELECT setting_key, setting_value
       FROM settings
       WHERE user_id=? AND setting_key IN (?, ?, ?, ?)`,
      [req.user.id, ...keys]
    );

    const byKey = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));

    const parseSafe = (raw, fallback) => {
      if (!raw) return fallback;
      try {
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
      } catch (_) {
        return fallback;
      }
    };

    res.json({
      wallpaperLibrary: parseSafe(byKey.theme_wallpaper_library, []),
      themeWallpapers: parseSafe(byKey.theme_wallpapers, {}),
      customThemes: parseSafe(byKey.theme_custom_themes, {}),
      selectedTheme: byKey.theme_selected || "",
    });
  } catch (e) {
    console.error("GET /api/theme-customization error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/theme-customization", requireAuth, async (req, res) => {
  try {
    const { wallpaperLibrary, themeWallpapers, customThemes, selectedTheme } = req.body || {};

    const updates = [];

    if (wallpaperLibrary !== undefined) {
      const safeWallpaperLibrary = Array.isArray(wallpaperLibrary) ? wallpaperLibrary : [];
      updates.push(["theme_wallpaper_library", JSON.stringify(safeWallpaperLibrary)]);
    }

    if (themeWallpapers !== undefined) {
      const safeThemeWallpapers = (themeWallpapers && typeof themeWallpapers === "object" && !Array.isArray(themeWallpapers)) ? themeWallpapers : {};
      updates.push(["theme_wallpapers", JSON.stringify(safeThemeWallpapers)]);
    }

    if (customThemes !== undefined) {
      const safeCustomThemes = (customThemes && typeof customThemes === "object" && !Array.isArray(customThemes)) ? customThemes : {};
      updates.push(["theme_custom_themes", JSON.stringify(safeCustomThemes)]);
    }

    if (selectedTheme !== undefined) {
      updates.push(["theme_selected", String(selectedTheme || "").trim()]);
    }

    if (!updates.length) return res.json({ success: true });

    const placeholders = updates.map(() => "(?, ?, ?)").join(", ");
    const params = updates.flatMap(([key, value]) => [req.user.id, key, value]);

    await pool.query(
      `INSERT INTO settings (user_id, setting_key, setting_value)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         setting_value=VALUES(setting_value),
         updated_at=CURRENT_TIMESTAMP`,
      params
    );

    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/theme-customization error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Summary for logged-in user (or owner via API key for HA)
app.get("/api/summary", async (req, res) => {
  let contextUser = null;

  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    try {
      contextUser = jwt.verify(auth.slice(7), JWT_SECRET);
    } catch (_) {
      return res.status(401).json({ error: "Invalid token" });
    }
  } else {
    const key = req.headers["x-api-key"] || req.query.api_key;
    if (key !== API_KEY) return res.status(403).json({ error: "Forbidden" });

    contextUser = await getApiContextUser(req);
    if (!contextUser) return res.status(404).json({ error: "requested user not found" });
  }

  const status = await getCurrentStatus(contextUser.id);
  const [recentSymptoms] = await pool.query(
    `SELECT symptom, COUNT(*) as count
     FROM symptoms
     WHERE user_id=? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
     GROUP BY symptom
     ORDER BY count DESC
     LIMIT 5`,
    [contextUser.id]
  );

  const prediction = await getPrediction(contextUser.id);
  const today = new Date().toISOString().split("T")[0];

  const [todaySymptoms] = await pool.query(
    "SELECT symptom, severity FROM symptoms WHERE user_id=? AND log_date=?",
    [contextUser.id, today]
  );

  const [todayMood] = await pool.query(
    "SELECT mood, energy_level FROM moods WHERE user_id=? AND log_date=?",
    [contextUser.id, today]
  );

  res.json({
    ...status,
    next_period_predicted: prediction,
    today_symptoms: todaySymptoms,
    today_mood: todayMood[0] || null,
    recent_symptoms_7d: recentSymptoms,
  });
});

app.get("/api/ha-calendar", requireApiKey, async (req, res) => {
  const contextUser = await getApiContextUser(req);
  if (!contextUser) return res.status(404).json({ error: "requested user not found" });

  const calendar = await buildHomeAssistantCalendar(contextUser.id);
  res.json(calendar);
});

app.get("/api/ha/notify-devices", requireAuth, async (req, res) => {
  try {
    const devices = await fetchHomeAssistantNotifyDevices();
    res.json({
      available: devices.length > 0,
      devices,
    });
  } catch (e) {
    console.error("GET /api/ha/notify-devices error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ha/media-players", requireAuth, async (req, res) => {
  try {
    const devices = await fetchHomeAssistantMediaPlayers();
    res.json({
      available: devices.length > 0,
      devices,
    });
  } catch (e) {
    console.error("GET /api/ha/media-players error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Calendar data for month
app.get("/api/calendar", requireAuth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "year and month required" });

  const [cycles] = await pool.query(
    "SELECT * FROM cycles WHERE user_id=? AND YEAR(start_date)=? AND MONTH(start_date)=?",
    [req.user.id, year, month]
  );
  const [symptoms] = await pool.query(
    "SELECT * FROM symptoms WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=?",
    [req.user.id, year, month]
  );
  const [moods] = await pool.query(
    "SELECT * FROM moods WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=?",
    [req.user.id, year, month]
  );
  const [journals] = await pool.query(
    "SELECT * FROM journal_entries WHERE user_id=? AND YEAR(log_date)=? AND MONTH(log_date)=?",
    [req.user.id, year, month]
  );

  res.json({ cycles, symptoms, moods, journals });
});

// Export data for printable/PDF calendar across months
app.get("/api/export-data", requireAuth, async (req, res) => {
  const [cycles] = await pool.query(
    "SELECT * FROM cycles WHERE user_id=? ORDER BY start_date ASC",
    [req.user.id]
  );
  const [symptoms] = await pool.query(
    "SELECT * FROM symptoms WHERE user_id=? ORDER BY log_date ASC, symptom ASC",
    [req.user.id]
  );
  const [moods] = await pool.query(
    "SELECT * FROM moods WHERE user_id=? ORDER BY log_date ASC",
    [req.user.id]
  );
  const [journals] = await pool.query(
    "SELECT * FROM journal_entries WHERE user_id=? ORDER BY log_date ASC",
    [req.user.id]
  );

  res.json({ cycles, symptoms, moods, journals });
});

// Health check
app.get("/api/health", (req, res) => res.json({ status: "ok", timestamp: new Date() }));

// Root route for direct backend access
app.get("/", (req, res) => {
  res.json({
    service: "period-tracker-api",
    status: "ok",
    message: "Use the frontend at / on port 80, or API endpoints under /api",
  });
});

// Daily webhook summary for owner
cron.schedule("0 8 * * *", async () => {
  try {
    const [ownerRows] = await pool.query(`SELECT id, username FROM users WHERE username='owner' LIMIT 1`);
    const owner = ownerRows[0];
    if (!owner) return;

    const today = new Date().toISOString().split("T")[0];
    const prediction = await getPrediction(owner.id);

    await notifyHomeAssistant("daily_summary", {
      user_id: owner.id,
      username: owner.username,
      date: today,
      next_period_predicted: prediction,
    });
  } catch (err) {
    console.error("[CRON] daily summary failed:", err.message);
  }
});

// Reminder dispatcher: checks every minute and sends due planner reminders to Home Assistant webhook.
cron.schedule("* * * * *", async () => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.user_id, p.plan_date, p.title, p.notes,
              p.reminder_at, p.reminder_target, p.reminder_sent_at, p.reminder_audio_url, p.reminder_media_player,
              p.reminder_at_2, p.reminder_target_2, p.reminder_sent_at_2, p.reminder_audio_url_2, p.reminder_media_player_2,
              p.reminder_at_3, p.reminder_target_3, p.reminder_sent_at_3, p.reminder_audio_url_3, p.reminder_media_player_3,
              u.username
       FROM planner_items p
       INNER JOIN users u ON u.id = p.user_id
       WHERE (p.reminder_at IS NOT NULL AND p.reminder_sent_at IS NULL AND p.reminder_at <= NOW())
          OR (p.reminder_at_2 IS NOT NULL AND p.reminder_sent_at_2 IS NULL AND p.reminder_at_2 <= NOW())
          OR (p.reminder_at_3 IS NOT NULL AND p.reminder_sent_at_3 IS NULL AND p.reminder_at_3 <= NOW())
       ORDER BY LEAST(
         IFNULL(p.reminder_at, '9999-12-31 23:59:59'),
         IFNULL(p.reminder_at_2, '9999-12-31 23:59:59'),
         IFNULL(p.reminder_at_3, '9999-12-31 23:59:59')
       ) ASC
       LIMIT 200`
    );

    for (const row of rows) {
      try {
        const reminders = [
          { slot: 1, at: row.reminder_at, target: row.reminder_target, sentAt: row.reminder_sent_at, sentCol: "reminder_sent_at", audioUrl: row.reminder_audio_url, mediaPlayer: row.reminder_media_player },
          { slot: 2, at: row.reminder_at_2, target: row.reminder_target_2, sentAt: row.reminder_sent_at_2, sentCol: "reminder_sent_at_2", audioUrl: row.reminder_audio_url_2, mediaPlayer: row.reminder_media_player_2 },
          { slot: 3, at: row.reminder_at_3, target: row.reminder_target_3, sentAt: row.reminder_sent_at_3, sentCol: "reminder_sent_at_3", audioUrl: row.reminder_audio_url_3, mediaPlayer: row.reminder_media_player_3 },
        ];

        for (const reminder of reminders) {
          if (!reminder.at || reminder.sentAt) continue;
          if (new Date(reminder.at).getTime() > Date.now()) continue;

          const message = row.notes ? `${row.title} — ${row.notes}` : row.title;
          const deliveryResults = [];

          const webhookResult = await notifyHomeAssistant("planner_reminder", {
            planner_item_id: row.id,
            user_id: row.user_id,
            username: row.username,
            plan_date: row.plan_date,
            reminder_slot: reminder.slot,
            reminder_at: reminder.at,
            reminder_target: reminder.target || null,
            reminder_audio_url: reminder.audioUrl || null,
            reminder_media_player: reminder.mediaPlayer || null,
            title: row.title,
            notes: row.notes || "",
            message,
          });
          if (!webhookResult?.skipped) {
            deliveryResults.push({ channel: "webhook", result: webhookResult });
          }

          if (reminder.target) {
            const notifyResult = await sendHomeAssistantCompanionNotification(
              reminder.target,
              "Luna Reminder",
              message,
              {
                tag: `luna-planner-${row.id}-${reminder.slot}`,
                planner_item_id: row.id,
                reminder_slot: reminder.slot,
                plan_date: String(row.plan_date || ""),
              }
            );
            deliveryResults.push({ channel: "notify", result: notifyResult });
          }

          if (reminder.audioUrl && reminder.mediaPlayer) {
            const audioResult = await playHomeAssistantMedia(reminder.mediaPlayer, reminder.audioUrl);
            deliveryResults.push({ channel: "audio", result: audioResult });
          }

          if (!deliveryResults.length) {
            console.warn(`planner reminder ${row.id}/${reminder.slot} skipped: no Home Assistant delivery path configured`);
            continue;
          }

          const failedDelivery = deliveryResults.find(({ result }) => !result?.sent);
          if (failedDelivery) {
            console.error(
              `planner reminder ${row.id}/${reminder.slot} not marked sent because ${failedDelivery.channel} delivery failed: ${failedDelivery.result?.reason || "unknown error"}`
            );
            continue;
          }

          await pool.query(
            `UPDATE planner_items SET ${reminder.sentCol}=NOW() WHERE id=? AND ${reminder.sentCol} IS NULL`,
            [row.id]
          );
        }
      } catch (err) {
        console.error("planner reminder dispatch failed:", err.message);
      }
    }
  } catch (err) {
    console.error("planner reminder cron failed:", err.message);
  }
});

const PORT = process.env.PORT || 3001;

// Global error handler — prevents unhandled DB/route errors from crashing the process
app.use((err, req, res, next) => {
  console.error("Unhandled route error:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Period Tracker API running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize schema:", err.message);
    process.exit(1);
  });
