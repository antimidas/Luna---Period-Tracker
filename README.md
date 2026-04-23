# 🌙 Luna
### A personal Journal, Tracker and Planner for young ladies.

---

## Project Description

Luna was born out of a father's instinct to protect his daughter's privacy. Unwilling to hand her personal health data over to third-party companies, he built something better: a self-hosted period tracker that kept everything close to home.

What started as a simple cycle tracker grew into something much more: a full health companion with cycle tracking, journaling, day planning, and smart reminders, all delivered privately, on your own terms. Luna even integrates with Home Assistant, so notifications reach the right devices without ever leaving your network.

This project is free to use, modify, and share.

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
cp .env.example .env
# edit .env as needed
docker compose up -d --build
```

Then open:
- Web app: `http://YOUR_SERVER_IP`
- API health: `http://YOUR_SERVER_IP/api/health`
- SSH: `ssh luna@YOUR_SERVER_IP -p 2222`

The development compose file now reads `.env` automatically. Default values are placeholders, so set `DB_PASSWORD` or `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `API_KEY`, `JWT_SECRET`, and any optional Home Assistant values before relying on it.

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
4. Set `HA_BASE_URL`, `HA_WEBHOOK_URL`, and `HA_TOKEN` if you want Home Assistant device discovery and companion app notifications in Docker

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
| `DB_PASSWORD` | Preferred app DB user password variable for Docker/systemd deployments |
| `API_KEY` | Secret key for API access |
| `HA_BASE_URL` | Base URL for Home Assistant API, e.g. `https://homeassistant.example.com` |
| `HA_WEBHOOK_URL` | Your HA webhook URL (see step 6) |
| `HA_TOKEN` | HA long-lived token for device discovery and companion app notifications |

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

### 7b. Set up planner reminders to Home Assistant users/devices

Luna now sends `planner_reminder` webhook events when planner reminders become due.

For direct device discovery and companion-app notifications, set both `HA_BASE_URL` and `HA_TOKEN` in `.env`. When those are present, Luna can:

- populate planner reminder target dropdowns from Home Assistant
- discover `notify.*` services, including `notify.mobile_app_*`
- resolve `device_tracker.*` entities to matching mobile app notify services when possible
- send reminder notifications directly through Home Assistant companion apps in addition to the webhook event

Useful Home Assistant helper endpoints:

- `GET /api/ha/notify-devices` returns the current list of valid Home Assistant reminder targets for the signed-in Luna user
- `GET /api/ha/users` lists Luna users for embed generation
- `GET /api/ha/embed-config?username=<luna_username>&base_url=<public_luna_url>` returns per-user planner, diary, calendar, and overview iframe URLs

Create a Home Assistant automation that receives those webhook events and forwards them to a user/device.

Example automation YAML:

```yaml
alias: Luna Planner Reminder
description: Send planner reminders from Luna to a mobile app device
mode: parallel
trigger:
  - platform: webhook
    webhook_id: period_tracker_12345
condition:
  - condition: template
    value_template: "{{ trigger.json.event == 'planner_reminder' }}"
action:
  - service: notify.mobile_app_your_phone
    data:
      title: "Luna Reminder"
      message: >-
        {{ trigger.json.title }}
        {% if trigger.json.notes %}
        - {{ trigger.json.notes }}
        {% endif %}
      data:
        tag: "luna-planner-reminder"
```

Routing reminders to specific users/devices:
- Set planner `reminder_target` in Luna (for example: `alice_phone`, `mom_tablet`, `group_family`).
- In Home Assistant, use `choose` logic on `trigger.json.reminder_target` to call different `notify.*` services.

Example target routing snippet:

```yaml
action:
  - choose:
      - conditions:
          - condition: template
            value_template: "{{ trigger.json.reminder_target == 'alice_phone' }}"
        sequence:
          - service: notify.mobile_app_alice_phone
            data:
              title: "Luna Reminder"
              message: "{{ trigger.json.message }}"
      - conditions:
          - condition: template
            value_template: "{{ trigger.json.reminder_target == 'mom_tablet' }}"
        sequence:
          - service: notify.mobile_app_mom_tablet
            data:
              title: "Luna Reminder"
              message: "{{ trigger.json.message }}"
    default:
      - service: notify.notify
        data:
          title: "Luna Reminder"
          message: "{{ trigger.json.message }}"
```

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
- `http://YOUR_SERVER_IP/planner`
- `http://YOUR_SERVER_IP/diary`

Landing page behavior:

- `/planner` opens the dedicated planner landing page directly
- `/diary` opens the dedicated diary landing page directly
- both routes accept `?token=YOUR_EMBED_TOKEN` for Home Assistant iframes

If you are using embed token auth, append `?token=YOUR_EMBED_TOKEN` to each URL:
- `http://YOUR_SERVER_IP/calendar?token=YOUR_EMBED_TOKEN`
- `http://YOUR_SERVER_IP/log-day?token=YOUR_EMBED_TOKEN`
- `http://YOUR_SERVER_IP/cycle-overview?token=YOUR_EMBED_TOKEN`
- `http://YOUR_SERVER_IP/planner?token=YOUR_EMBED_TOKEN`
- `http://YOUR_SERVER_IP/diary?token=YOUR_EMBED_TOKEN`

### 11. Embed the full Diary view in Home Assistant

You can embed the full diary page directly:
- `http://YOUR_SERVER_IP/diary`

With embed token auth:
- `http://YOUR_SERVER_IP/diary?token=YOUR_EMBED_TOKEN`

### 12. Add Luna calendar for a specific Home Assistant user

Luna now provides helper endpoints so you can generate per-user calendar/planner embed links and card JSON.

1. List Luna users:

```bash
curl -H "X-Api-Key: YOUR_API_KEY" \
  "http://YOUR_SERVER_IP/api/ha/users"
```

2. Generate Home Assistant embed config for one Luna user:

```bash
curl -H "X-Api-Key: YOUR_API_KEY" \
  "http://YOUR_SERVER_IP/api/ha/embed-config?username=mila&ha_user=alice&base_url=https://luna.example.com"
```

3. Use values from the response:
- `urls.calendar` for a calendar iframe card
- `urls.planner` for a planner iframe card
- `urls.diary` for a diary iframe card
- `lovelace.calendar_webpage_card` and `lovelace.planner_webpage_card` for ready-to-paste card config

Direct planner card example:

```yaml
type: iframe
title: Luna Planner (Username)
url: https://luna.example.com/planner?token=GENERATED_TOKEN
aspect_ratio: 170%
```

Example manual card using response URL:

```yaml
type: iframe
title: Luna Calendar (Username)
url: https://luna.example.com/calendar?token=GENERATED_TOKEN
aspect_ratio: 100%
```

Notes:
- Tokens generated by `/api/ha/embed-config` are valid for `365d`.
- Use one embed token per Luna user profile.
- Regenerate a token anytime if you need to rotate access.

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

## Daily Planner + Reminders

Luna includes a daily planner with reminders:

- Dedicated planner landing page at `/planner`
- Timed events with start/end times rendered in the hourly planner
- Add planner tasks for any selected date
- Edit or delete planner tasks
- Up to 3 reminders per event
- Optional Home Assistant reminder target per reminder
- Reminder targets can come from discovered Home Assistant companion apps and device trackers

When a reminder is due, Luna sends a `planner_reminder` event to your configured `HA_WEBHOOK_URL`.

Planner API endpoints:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/planner?date=YYYY-MM-DD` | List planner tasks for a date |
| `POST` | `/api/planner` | Create planner task |
| `PATCH` | `/api/planner/:id` | Update planner task fields |
| `DELETE` | `/api/planner/:id` | Delete planner task |

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

Current theming coverage includes the main dashboard, cycle overview, log day, calendar, planner landing page, and diary landing page.

Theme Studio supports:

- quick and advanced editing modes
- per-card background, border, blur, shadow, title text, and body text controls
- dedicated Quartz/Glass controls for dashboard cards, overview cards, log day cards, calendar cards, planner cards, and diary cards
- planner-specific paper tone, line colour, floral accent, and border darkness controls
- wallpaper-backed page shells so planner and diary can visually match the main app while still keeping their own card styling

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
| **Planner** | Planner card glass, planner text, paper tone, line colour, floral accents, planner event styling |
| **Log Day** | Section labels, toggle borders/active states, pill borders/active states |
| **Diary** | Diary card glass, diary text, diary title, book container styling |
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
4. Adjust the matching border opacity controls for each card family.
5. Use the dedicated planner and diary glass rows to tune those page cards independently from the main dashboard.
6. Click **Apply Quartz Glass** for a one-click preset (white tint, 38% opacity, 5 px blur, gradient art).
7. Click **Reset Solid** to return cards to a plain white solid background.

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

