#!/usr/bin/env bash
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-period_tracker}"
DB_USER="${DB_USER:-tracker}"
DB_PASSWORD="${DB_PASSWORD:-changeme_tracker}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-rootpass}"
PORT="${PORT:-3001}"

# Export defaults for child processes managed by supervisord.
export DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD MYSQL_ROOT_PASSWORD PORT
export API_KEY="${API_KEY:-mysecretapikey}"
export JWT_SECRET="${JWT_SECRET:-change-me-in-env}"
export HA_WEBHOOK_URL="${HA_WEBHOOK_URL:-}"
export HA_TOKEN="${HA_TOKEN:-}"

mkdir -p /var/run/sshd /run/mysqld
chown -R mysql:mysql /run/mysqld

# Initialize MariaDB datadir on first boot.
if [[ ! -d /var/lib/mysql/mysql ]]; then
  mariadb-install-db --user=mysql --datadir=/var/lib/mysql
fi

# Prepare SSH user for optional shell access.
SSH_USER="${SSH_USER:-luna}"
SSH_PASSWORD="${SSH_PASSWORD:-luna}"
SSH_PASSWORD_AUTH="${SSH_PASSWORD_AUTH:-true}"
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-}"
if ! id -u "$SSH_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SSH_USER"
fi
usermod -aG sudo "$SSH_USER"

if [[ "$SSH_PASSWORD_AUTH" == "false" ]]; then
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?UsePAM.*/UsePAM no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

  if [[ -z "$SSH_PUBLIC_KEY" ]]; then
    echo "SSH_PUBLIC_KEY is required when SSH_PASSWORD_AUTH=false" >&2
    exit 1
  fi

  install -d -m 700 -o "$SSH_USER" -g "$SSH_USER" "/home/$SSH_USER/.ssh"
  printf '%s\n' "$SSH_PUBLIC_KEY" > "/home/$SSH_USER/.ssh/authorized_keys"
  chown "$SSH_USER:$SSH_USER" "/home/$SSH_USER/.ssh/authorized_keys"
  chmod 600 "/home/$SSH_USER/.ssh/authorized_keys"
else
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  echo "$SSH_USER:$SSH_PASSWORD" | chpasswd
fi

# Ensure host keys exist.
ssh-keygen -A

exec "$@"
