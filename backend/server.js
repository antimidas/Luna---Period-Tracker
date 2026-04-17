const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

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
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";
const JWT_EXPIRES_IN = "7d";
const API_KEY = process.env.API_KEY || "mysecretapikey";

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
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

  await pool.query(
    `INSERT IGNORE INTO settings (user_id, setting_key, setting_value)
     SELECT id, 'average_cycle_length', '28' FROM users
     UNION ALL
     SELECT id, 'average_period_length', '5' FROM users
     UNION ALL
     SELECT id, 'ha_notifications_enabled', 'true' FROM users`
  );
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

async function notifyHomeAssistant(eventType, data) {
  const webhookUrl = process.env.HA_WEBHOOK_URL;
  const haToken = process.env.HA_TOKEN;
  if (!webhookUrl) return;

  try {
    await axios.post(webhookUrl, { event: eventType, ...data }, {
      headers: haToken ? { Authorization: `Bearer ${haToken}` } : {},
      timeout: 5000,
    });
    console.log(`[HA] Notified: ${eventType}`);
  } catch (err) {
    console.error(`[HA] Notification failed: ${err.message}`);
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
      `INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`,
      [uname, hash, displayName]
    );

    await pool.query(
      `INSERT IGNORE INTO settings (user_id, setting_key, setting_value) VALUES
       (?, 'average_cycle_length', '28'),
       (?, 'average_period_length', '5'),
       (?, 'ha_notifications_enabled', 'true')`,
      [result.insertId, result.insertId, result.insertId]
    );

    const user = { id: result.insertId, username: uname, display_name: displayName };
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
    `SELECT id, username, display_name, password_hash FROM users WHERE username=? LIMIT 1`,
    [String(username).trim().toLowerCase()]
  );

  const user = rows[0];
  if (!user) return res.status(401).json({ error: "invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, display_name: user.display_name },
  });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, username, display_name FROM users WHERE id=? LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "user not found" });
  res.json(rows[0]);
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
});

app.patch("/api/cycles/:id", requireAuth, async (req, res) => {
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
});

app.delete("/api/cycles/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM cycles WHERE id=? AND user_id=?", [req.params.id, req.user.id]);
  res.json({ success: true });
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
});

app.delete("/api/symptoms/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM symptoms WHERE id=? AND user_id=?", [req.params.id, req.user.id]);
  res.json({ success: true });
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
  const { log_date, mood, energy_level, notes } = req.body;
  if (!log_date || !mood) return res.status(400).json({ error: "log_date and mood required" });

  await pool.query(
    `INSERT INTO moods (user_id, log_date, mood, energy_level, notes) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mood=VALUES(mood), energy_level=VALUES(energy_level), notes=VALUES(notes)`,
    [req.user.id, log_date, mood, energy_level || null, notes || null]
  );

  await notifyHomeAssistant("mood_logged", {
    user_id: req.user.id,
    username: req.user.username,
    log_date,
    mood,
    energy_level,
  });

  res.json({ success: true });
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

    const [ownerRows] = await pool.query(`SELECT id, username FROM users WHERE username='owner' LIMIT 1`);
    if (!ownerRows.length) return res.status(404).json({ error: "owner user not found" });
    contextUser = ownerRows[0];
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

  res.json({ cycles, symptoms, moods });
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

const PORT = process.env.PORT || 3001;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Period Tracker API running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to initialize schema:", err.message);
    process.exit(1);
  });
