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

### Docker Compose (Ubuntu 24.04 image, all-in-one container)

This repo now includes:
- `Dockerfile` based on `ubuntu:24.04`
- `docker-compose.yml`
- Single-container runtime with **MariaDB + Node API + Nginx + OpenSSH**
- `nano` and `sudo` installed in the image

Start it from the project root:

```bash
docker compose up -d --build
```

Then open:
- Web app: `http://YOUR_SERVER_IP`
- API health: `http://YOUR_SERVER_IP/api/health`
- SSH: `ssh luna@YOUR_SERVER_IP -p 2222`

Default compose credentials are placeholders. Update `DB_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `API_KEY`, `JWT_SECRET`, and `SSH_PASSWORD` in `docker-compose.yml` before production use.

### Hardened Production Variant

Use the production compose variant for stronger defaults:
- disables SSH password authentication (SSH key-only)
- does not expose MariaDB port `3306` on the host
- requires explicit secrets via environment variables

Setup:

```bash
cp .env.prod.example .env
# edit .env and set strong values, including SSH_PUBLIC_KEY
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

Notes:
- SSH login uses key auth only on port `2222`
- Database remains internal to the container network only
- Required secrets are enforced by compose variable checks

### Docker Setup Details

#### Included Compose Profiles

| File | Purpose |
|---|---|
| `docker-compose.yml` | Development/all-in-one defaults (includes host DB port mapping) |
| `docker-compose.prod.yml` | Hardened production defaults (no host DB port mapping, key-only SSH) |

#### Production Environment File

1. Copy `.env.prod.example` to `.env`
2. Set strong random values for `DB_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `API_KEY`, and `JWT_SECRET`
3. Set `SSH_PUBLIC_KEY` to a valid single-line OpenSSH public key

#### Common Docker Operations

```bash
# Build and start production
docker compose -f docker-compose.prod.yml --env-file .env up -d --build

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Restart service
docker compose -f docker-compose.prod.yml restart

# Stop and remove container
docker compose -f docker-compose.prod.yml down
```

### One-command installer (recommended)

Run the guided setup script from the project root:

```bash
chmod +x install.sh
./install.sh
```

The installer prompts for:

- Database credentials and app settings
- Admin display name, admin username, and admin password

During setup, it creates/updates the admin user in `users` with `is_admin = 1` and also inserts admin membership in `user_admins`.

Use the manual steps below if you prefer fully manual provisioning.

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

### 11. Embed the full Diary view in Home Assistant

You can embed the full diary page directly:
- `http://YOUR_SERVER_IP/diary`

With embed token auth:
- `http://YOUR_SERVER_IP/diary?token=YOUR_EMBED_TOKEN`

---

## Journal / Diary Feature

Luna now includes a full journal system in addition to cycle, mood, and symptom tracking.

### What it includes

- Full-page diary experience with themed visuals
- Desktop diary widget and dedicated full diary route
- Multi-entry support (multiple entries on the same date)
- Archive list of saved entries
- Open existing entries for read/edit
- Delete entries from the archive

### How save behavior works

- Saving an entry creates or updates the selected entry
- After save, the editor is ready for the next entry workflow
- Entries are persisted in MariaDB (`journal_entries`) and tied to the authenticated user

### Journal API endpoints

All journal endpoints require authentication token.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/journal?date=YYYY-MM-DD` | Get journal entries for a date |
| `POST` | `/api/journal` | Create or update an entry (by `id` when provided) |
| `DELETE` | `/api/journal/:id` | Delete one journal entry |

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

---

## Theming

### Built-in Themes

Luna ships with several built-in colour themes selectable from the dropdown in the top-right of the header:

| Theme | Description |
|---|---|
| **Luna** | Default soft rose/pink |
| **Azure** | Cool blue tones |
| **Sage** | Muted green |
| **Peach** | Warm peach/terracotta |
| **Blossom** | Bright pink blossom |
| **Rosé** | Deep dusty rose |
| **Lavender** | Soft purple |
| **Dusk** | Warm dusk/mauve |
| **Quartz** | Glassmorphism — transparent cards over a gradient background |
| **Demon Slayer** | Dark anime-inspired with custom wallpaper |

---

### Theme Studio

Theme Studio lets you create and save fully custom themes. Open it by clicking **🎨 Theme Studio** in the header.

#### Layout

Theme Studio has two panels:

- **Left — Draft Preview**: A live miniature preview of the app rendered using your current draft colours. Click any coloured swatch to select that element for editing.
- **Right — Create / Save**: Controls for editing the selected element's colour, button style presets, glass background options, and saving.

#### Swatch Sections

Swatches are grouped into collapsible sections:

| Section | What it controls |
|---|---|
| **Core** | Primary accent, background gradient, text, muted text, border |
| **Header** | Header bar background, text, border |
| **Cards** | Card background, card art overlay, drop shadow |
| **Stats** | Stat tile background, border, text, label |
| **Calendar** | Calendar grid background, day hover, today border, other-month days, header text, legend |
| **Log Day** | Section labels, toggle borders/active states, pill borders/active states |
| **Buttons** | Primary button background, text, border, hover background, hover text, muted button, muted hover, secondary button variants |
| **Inputs** | Input background, text, border, placeholder, focus border, focus ring |
| **Modals** | Overlay, modal background, border, accent, text, muted text |
| **Other** | Any remaining CSS variables |

Click a section header to collapse or expand it. Use **Collapse All** / **Expand All** buttons at the top.

#### Editing a Colour

1. Click any swatch in the Draft Preview — it highlights and the right panel updates to show that element's name.
2. Use the **colour picker** to choose a new colour.
3. Use the **opacity slider** to set transparency (useful for overlays and glass effects).
4. Switch the **Fill Type** dropdown to *Gradient* to set a two-colour gradient instead of a solid.
5. The Draft Preview updates live.

#### Button Style Presets

Quick presets that apply a coordinated set of button CSS variables:

| Preset | Style |
|---|---|
| **Soft** | Slightly transparent, rounded — default Luna look |
| **Minimal** | Outline-only, no fill |
| **Pill** | Fully rounded pill shape |
| **Sharp** | Square corners |
| **Glass** | Frosted glass appearance |

#### Glass Background (Quartz Style)

Adds a transparent/frosted card background to any theme:

1. Choose a **tint colour** with the colour picker.
2. Drag the **Opacity** slider to control how transparent the cards are.
3. Drag the **Blur** slider to control backdrop blur strength (0–20 px).
4. Tick **Apply same clear background to calendar card** to match the calendar card.
5. Click **Apply Quartz Glass** for a one-click preset (white tint, 38% opacity, 5 px blur, gradient art).
6. Click **Reset Solid** to return cards to a plain white solid background.

#### Saving a Theme

1. Select a **Base Theme** from the dropdown — your custom theme inherits all values from it, then applies your overrides on top.
2. Enter a **Name** for your theme.
3. Optionally pick a **Flower icon** and **Logo icon**.
4. Click **Save Theme**. The theme is stored in `localStorage` under `luna_custom_themes` and immediately appears in the theme selector dropdown.

#### Deleting a Custom Theme

Custom themes appear in the theme selector with a **🗑** delete button next to their name.

---

### Wallpaper Manager

The Wallpaper Manager lets you attach background images to any theme. Open it by clicking **🖼 Wallpapers** in the header.

#### Adding a Wallpaper

1. Paste an image URL into the input field and click **Add Link**. The image is saved to your wallpaper library in `localStorage`.
2. Click any thumbnail in **Saved Wallpapers** to select it (highlighted with a border).
3. Click **Use On Current Theme** to attach the selected wallpaper to the currently active theme.

#### Wallpapers Used In Themes

The **Wallpapers Used In Themes** section shows all images currently assigned to any theme, so you can quickly reuse them.

#### How Wallpapers Are Stored

- Wallpaper URLs are stored in `localStorage` under `luna_wallpaper_library`.
- Theme-to-wallpaper associations are stored under `luna_theme_wallpapers`.
- When a theme is applied, its wallpaper (if any) is set as the `--bg-art` CSS variable, replacing the gradient background.

