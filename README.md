# 🌙 Luna — Period Tracker
### Self-hosted period tracker with Home Assistant integration

---

## Architecture

```
[Browser] → [Nginx :80] → [Node.js API :3001] → [MariaDB :3306]
                              ↕ webhook
                      [Home Assistant]
```

All services run directly on your Linux host.

---

## Quick Start

### 1. Install dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install MariaDB
sudo apt install -y mariadb-server

# Install Node.js (LTS)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# Install Nginx
sudo apt install -y nginx
```

### 2. Copy files to your server

```bash
scp -r period-tracker/ user@YOUR_SERVER_IP:~/
ssh user@YOUR_SERVER_IP
cd period-tracker
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env   # fill in all values
```

Key values to set:
| Variable | Description |
|---|---|
| `MYSQL_ROOT_PASSWORD` | Strong root DB password |
| `MYSQL_PASSWORD` | App DB user password |
| `API_KEY` | Secret key for API access |
| `HA_WEBHOOK_URL` | Your HA webhook URL (see step 6) |
| `HA_TOKEN` | HA long-lived token (optional, for future use) |

### 4. Set up MariaDB

```bash
sudo systemctl start mariadb
sudo mysql_secure_installation  # Follow prompts, set root password
sudo mysql -u root -p < db/init.sql
```

### 5. Configure Nginx

```bash
sudo cp nginx.conf /etc/nginx/sites-available/period-tracker
sudo ln -s /etc/nginx/sites-available/period-tracker /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### 6. Start the API

```bash
cd backend
npm install

# Install and enable systemd service (auto-start on boot)
sudo cp luna.service.example /etc/systemd/system/luna.service
sudo systemctl daemon-reload
sudo systemctl enable --now luna
```

Wait ~10 seconds for the API to start, then visit:
- **Web App**: `http://YOUR_SERVER_IP`
- **API**: `http://YOUR_SERVER_IP/api/health`

To inspect API logs:
```bash
sudo journalctl -u luna -f
```

### 7. Set up Home Assistant webhook

1. In HA: **Settings → Automations → + New Automation**
2. Set trigger: **Webhook** — note the webhook ID
3. Copy full URL to `.env` as `HA_WEBHOOK_URL`
4. Restart the API: `pkill -f "node server.js"` then `node server.js &`

### 8. Add HA sensors

Copy the contents of `ha-config/configuration.yaml` into your HA `configuration.yaml`.

Replace:
- `TRACKER_HOST` with your server's IP/hostname
- `YOUR_API_KEY` with your `API_KEY` from `.env`
- `period_tracker_12345` with your actual HA webhook ID

Then: **Developer Tools → YAML → Check Configuration → Restart**

### 9. Add Lovelace dashboard card

1. Go to your HA dashboard → Edit → Add Card → Manual
2. Paste contents of `ha-config/lovelace-card.yaml`
3. Replace `TRACKER_HOST` with your server's IP

### 10. Embed Luna views directly in Home Assistant iframes

Luna supports direct embedding of key index views as Home Assistant webpage cards (iframes).

Use these routes directly:
- `http://YOUR_SERVER_IP/calendar`
- `http://YOUR_SERVER_IP/log-day`
- `http://YOUR_SERVER_IP/cycle-overview`

If you are using embed token auth, append `?token=YOUR_EMBED_TOKEN` to each URL:
- `http://YOUR_SERVER_IP/calendar?token=YOUR_EMBED_TOKEN`
- `http://YOUR_SERVER_IP/log-day?token=YOUR_EMBED_TOKEN`
- `http://YOUR_SERVER_IP/cycle-overview?token=YOUR_EMBED_TOKEN`

---

## API Reference

All endpoints require header: `X-Api-Key: YOUR_API_KEY`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/summary` | Full status (used by HA) |
| `GET` | `/api/calendar?year=&month=` | All data for a month |
| `POST` | `/api/cycles` | Log period start |
| `PATCH` | `/api/cycles/:id` | Update cycle |
| `DELETE` | `/api/cycles/:id` | Delete cycle |
| `GET` | `/api/symptoms?date=` | Get symptoms for date |
| `POST` | `/api/symptoms` | Log a symptom |
| `DELETE` | `/api/symptoms/:id` | Remove symptom |
| `GET` | `/api/moods?date=` | Get mood for date |
| `POST` | `/api/moods` | Log mood |

---

## HA Sensors Created

| Sensor | Description |
|---|---|
| `sensor.period_tracker_days_since_period` | Days since last period started |
| `sensor.period_tracker_next_period_date` | Predicted next period date |
| `sensor.period_tracker_today_mood` | Today's logged mood |
| `sensor.period_tracker_today_symptoms` | Today's symptoms (comma-separated) |
| `sensor.period_tracker_avg_cycle_length` | Average cycle length |
| `sensor.days_until_next_period` | Countdown to next period |
| `sensor.period_phase` | Current phase (Menstrual/Follicular/Ovulation/Luteal) |
| `input_text.period_tracker_last_event` | Last webhook event received |

---

## Updating the frontend API key

If you change `API_KEY` in `.env`, also update `frontend/index.html`:
```js
const API_KEY = "your_new_key_here";   // line ~300
```
Then reload the web app in your browser.

---

## Backup database

```bash
mysqldump -u tracker -p'YOUR_MYSQL_PASSWORD' period_tracker \
  > backup_$(date +%Y%m%d).sql
```

---

## Useful commands

```bash
# Start services
sudo systemctl start mariadb
sudo systemctl start nginx
sudo systemctl start luna

# Stop services
sudo systemctl stop mariadb
sudo systemctl stop nginx
sudo systemctl stop luna

# View logs
sudo journalctl -u mariadb -f
sudo journalctl -u nginx -f
sudo journalctl -u luna -f
```

## Enable API Auto-Start On Existing Install

If Luna is already installed and you currently run `node server.js` manually, run:

```bash
cd /opt/period-tracker/backend
sudo cp luna.service.example /etc/systemd/system/luna.service
sudo systemctl daemon-reload
sudo systemctl enable --now luna
sudo systemctl status luna
```
