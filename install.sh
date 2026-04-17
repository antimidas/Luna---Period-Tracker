#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════
#  Luna Period Tracker — Bare-Metal Installer
#  Supports: Debian / Ubuntu (apt-based distros)
# ══════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || die "This installer must be run as root (sudo ./install.sh)"
}

# ── Helper: generate a random secret ─────────────────────
rand_secret() { openssl rand -hex 32; }

# ── Prompt helpers ────────────────────────────────────────
prompt() {
  local var="$1" msg="$2" default="${3:-}"
  local val
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${YELLOW}?${NC} $msg [$default]: ")" val
    val="${val:-$default}"
  else
    read -rp "$(echo -e "${YELLOW}?${NC} $msg: ")" val
    while [[ -z "$val" ]]; do
      echo -e "${RED}  Value is required.${NC}"
      read -rp "$(echo -e "${YELLOW}?${NC} $msg: ")" val
    done
  fi
  printf -v "$var" '%s' "$val"
}

prompt_password() {
  local var="$1" msg="$2" default="${3:-}"
  local val confirm
  while true; do
    read -srp "$(echo -e "${YELLOW}?${NC} $msg (input hidden): ")" val; echo
    if [[ -z "$val" && -n "$default" ]]; then val="$default"; fi
    if [[ -z "$val" ]]; then echo -e "${RED}  Value is required.${NC}"; continue; fi
    read -srp "$(echo -e "${YELLOW}?${NC} Confirm $msg: ")" confirm; echo
    if [[ "$val" == "$confirm" ]]; then break; fi
    echo -e "${RED}  Passwords do not match, try again.${NC}"
  done
  printf -v "$var" '%s' "$val"
}

prompt_yn() {
  local var="$1" msg="$2" default="${3:-y}"
  local val
  read -rp "$(echo -e "${YELLOW}?${NC} $msg [${default}]: ")" val
  val="${val:-$default}"
  [[ "$val" =~ ^[Yy] ]] && printf -v "$var" 'y' || printf -v "$var" 'n'
}

# ══════════════════════════════════════════════════════════
#  GATHER CONFIGURATION
# ══════════════════════════════════════════════════════════
gather_config() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Luna Period Tracker — Installation Setup  ${NC}"
  echo -e "${CYAN}════════════════════════════════════════════${NC}"
  echo ""

  # Luna URL
  prompt LUNA_URL \
    "Public URL for Luna (e.g. https://pt.example.com)" \
    "http://$(hostname -I | awk '{print $1}')"

  # Strip trailing slash
  LUNA_URL="${LUNA_URL%/}"

  # Home Assistant
  prompt_yn SETUP_HA "Do you want to configure Home Assistant integration?" "y"
  if [[ "$SETUP_HA" == "y" ]]; then
    prompt HA_URL \
      "Home Assistant URL (e.g. https://homeassistant.example.com)" \
      ""
    HA_URL="${HA_URL%/}"
    prompt HA_WEBHOOK_ID \
      "HA webhook ID (must match automation in HA)" \
      "period_tracker_12345"
    prompt HA_TOKEN \
      "HA Long-Lived Access Token (leave blank to skip)" \
      ""
  else
    HA_URL=""; HA_WEBHOOK_ID=""; HA_TOKEN=""
  fi

  echo ""
  echo -e "${CYAN}── Database ──────────────────────────────────${NC}"
  prompt DB_NAME   "MariaDB database name"  "period_tracker"
  prompt DB_USER   "MariaDB app username"   "tracker"
  prompt_password DB_PASS  "MariaDB app user password"

  echo ""
  echo -e "${CYAN}── Security ──────────────────────────────────${NC}"
  local default_api_key; default_api_key=$(rand_secret)
  local default_jwt;     default_jwt=$(rand_secret)
  prompt API_KEY    "API key for Home Assistant REST sensor" "$default_api_key"
  prompt JWT_SECRET "JWT secret"                             "$default_jwt"

  echo ""
  echo -e "${CYAN}── Admin account ─────────────────────────────${NC}"
  prompt       OWNER_DISPLAY "Admin display name"  "Owner"
  prompt       OWNER_USER    "Admin username"       "owner"
  prompt_password OWNER_PASS "Admin password"

  echo ""
  info "Configuration collected. Starting installation…"
  echo ""
}

# ══════════════════════════════════════════════════════════
#  INSTALL SYSTEM DEPENDENCIES
# ══════════════════════════════════════════════════════════
install_deps() {
  info "Updating apt and installing dependencies…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq

  # Node.js 20 LTS via NodeSource if not present or < 18
  if ! command -v node &>/dev/null || [[ $(node -e "process.exit(process.version.slice(1).split('.')[0] < 18 ? 1 : 0)" 2>/dev/null; echo $?) -eq 1 ]]; then
    info "Installing Node.js 20 LTS…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
  else
    info "Node.js $(node -v) already present."
  fi

  apt-get install -y -qq nginx mariadb-server openssl

  success "System dependencies installed."
}

# ══════════════════════════════════════════════════════════
#  DATABASE SETUP
# ══════════════════════════════════════════════════════════
setup_database() {
  info "Starting MariaDB…"
  systemctl enable --now mariadb

  info "Creating database and user…"

  # Build owner password hash using node/bcrypt after npm install
  # For now we'll insert a placeholder and update after npm install
  mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

  # Run the schema (tables only — server.js handles migrations on start)
  mysql -u root "${DB_NAME}" < "${INSTALL_DIR}/db/init.sql"

  success "Database '${DB_NAME}' and user '${DB_USER}' ready."
}

# ══════════════════════════════════════════════════════════
#  WRITE .env
# ══════════════════════════════════════════════════════════
write_env() {
  local HA_WEBHOOK_URL=""
  if [[ -n "$HA_URL" && -n "$HA_WEBHOOK_ID" ]]; then
    HA_WEBHOOK_URL="${HA_URL}/api/webhook/${HA_WEBHOOK_ID}"
  fi

  cat > "${INSTALL_DIR}/.env" <<ENV
# Generated by install.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Database
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}

# API
PORT=3001
API_KEY=${API_KEY}
JWT_SECRET=${JWT_SECRET}

# Luna public URL
LUNA_URL=${LUNA_URL}

# Home Assistant
HA_WEBHOOK_URL=${HA_WEBHOOK_URL}
HA_TOKEN=${HA_TOKEN}
ENV

  chmod 600 "${INSTALL_DIR}/.env"
  success ".env written."
}

# ══════════════════════════════════════════════════════════
#  NPM INSTALL
# ══════════════════════════════════════════════════════════
install_npm() {
  info "Installing Node.js dependencies…"
  cd "${INSTALL_DIR}/backend"
  npm install --omit=dev --silent
  cd "${INSTALL_DIR}"
  success "npm install complete."
}

# ══════════════════════════════════════════════════════════
#  SET ADMIN PASSWORD VIA NODE/BCRYPT
# ══════════════════════════════════════════════════════════
set_owner_account() {
  info "Hashing admin password…"
  local hash
  hash=$(node -e "
    const b = require('bcryptjs');
    b.hash('${OWNER_PASS}', 10, (err,h) => { process.stdout.write(h); });
  ")

  mysql -u root "${DB_NAME}" <<SQL
INSERT INTO users (username, password_hash, display_name)
  VALUES ('${OWNER_USER}', '${hash}', '${OWNER_DISPLAY}')
  ON DUPLICATE KEY UPDATE
    password_hash = '${hash}',
    display_name  = '${OWNER_DISPLAY}';
SQL

  success "Admin account '${OWNER_USER}' ready."
}

# ══════════════════════════════════════════════════════════
#  NGINX CONFIGURATION
# ══════════════════════════════════════════════════════════
setup_nginx() {
  info "Configuring Nginx…"

  # Extract hostname from LUNA_URL for server_name
  local hostname
  hostname=$(echo "$LUNA_URL" | sed -E 's|https?://||; s|/.*||')

  cat > /etc/nginx/sites-available/luna <<NGINX
server {
    listen 80;
    server_name ${hostname} _;

    root ${INSTALL_DIR}/frontend;
    index index.html;
    autoindex off;

    location = /favicon.ico {
        log_not_found off;
        access_log off;
        return 204;
    }

    location /api/ {
        proxy_pass         http://127.0.0.1:3001/api/;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX

  # Enable site, disable default if still pointing to default root
  ln -sf /etc/nginx/sites-available/luna /etc/nginx/sites-enabled/luna
  rm -f /etc/nginx/sites-enabled/default

  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  success "Nginx configured for ${hostname}."
}

# ══════════════════════════════════════════════════════════
#  SYSTEMD SERVICE
# ══════════════════════════════════════════════════════════
setup_systemd() {
  info "Creating systemd service…"

  cat > /etc/systemd/system/luna.service <<UNIT
[Unit]
Description=Luna Period Tracker API
After=network.target mariadb.service
Requires=mariadb.service

[Service]
Type=simple
User=www-data
WorkingDirectory=${INSTALL_DIR}/backend
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=luna

[Install]
WantedBy=multi-user.target
UNIT

  # www-data needs read access to install dir
  chown -R www-data:www-data "${INSTALL_DIR}/backend" "${INSTALL_DIR}/.env"
  chmod 750 "${INSTALL_DIR}/backend"

  systemctl daemon-reload
  systemctl enable luna
  systemctl restart luna
  sleep 2

  if systemctl is-active --quiet luna; then
    success "Luna service running."
  else
    warn "Luna service may not have started. Check: journalctl -u luna -n 30"
  fi
}

# ══════════════════════════════════════════════════════════
#  UPDATE HOME ASSISTANT CONFIG FILES
# ══════════════════════════════════════════════════════════
update_ha_configs() {
  [[ "$SETUP_HA" != "y" ]] && return

  info "Patching ha-config/configuration.yaml…"

  sed -i \
    -e "s|http://TRACKER_HOST:3001|${LUNA_URL}|g" \
    -e "s|YOUR_API_KEY|${API_KEY}|g" \
    -e "s|\"period_tracker_12345\"|\"${HA_WEBHOOK_ID}\"|g" \
    "${INSTALL_DIR}/ha-config/configuration.yaml"

  info "Patching ha-config/lovelace-card.yaml…"

  sed -i \
    -e "s|http://127.0.0.1|${LUNA_URL}|g" \
    -e "s|https://pt.3evils.com|${LUNA_URL}|g" \
    "${INSTALL_DIR}/ha-config/lovelace-card.yaml"

  success "Home Assistant config files updated."
}

# ══════════════════════════════════════════════════════════
#  SUMMARY
# ══════════════════════════════════════════════════════════
print_summary() {
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Luna installation complete!               ${NC}"
  echo -e "${GREEN}════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${CYAN}Luna URL:${NC}       ${LUNA_URL}"
  echo -e "  ${CYAN}Admin login:${NC}    ${OWNER_USER} / (your chosen password)"
  echo -e "  ${CYAN}API key:${NC}        ${API_KEY}"
  echo ""
  if [[ "$SETUP_HA" == "y" ]]; then
    echo -e "  ${CYAN}HA webhook URL:${NC}"
    echo -e "         ${HA_URL}/api/webhook/${HA_WEBHOOK_ID}"
    echo ""
    echo -e "  ${YELLOW}Next steps for Home Assistant:${NC}"
    echo -e "   1. Copy ha-config/configuration.yaml content into your HA config"
    echo -e "   2. Copy ha-config/lovelace-card.yaml into a manual Lovelace card"
    echo -e "   3. Restart Home Assistant"
    echo ""
  fi
  echo -e "  ${CYAN}Service commands:${NC}"
  echo -e "    sudo systemctl status luna"
  echo -e "    sudo journalctl -u luna -f"
  echo ""
}

# ══════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════
main() {
  require_root
  gather_config
  install_deps
  setup_database
  write_env
  install_npm
  set_owner_account
  setup_nginx
  setup_systemd
  update_ha_configs
  print_summary
}

main "$@"
