#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${DB_NAME:-period_tracker}"
DB_USER="${DB_USER:-tracker}"
DB_PASSWORD="${DB_PASSWORD:-changeme_tracker}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-rootpass}"

wait_for_db() {
  local retries=60
  while (( retries > 0 )); do
    if mariadb-admin ping --host=127.0.0.1 --port=3306 --user=root --password="${MYSQL_ROOT_PASSWORD}" --silent >/dev/null 2>&1; then
      return 0
    fi
    if mariadb-admin ping --host=127.0.0.1 --port=3306 --user=root --silent >/dev/null 2>&1; then
      return 0
    fi
    retries=$((retries - 1))
    sleep 2
  done
  echo "MariaDB did not become ready in time" >&2
  return 1
}

set_root_password_if_needed() {
  if mariadb --host=127.0.0.1 --port=3306 --user=root --password="${MYSQL_ROOT_PASSWORD}" -e "SELECT 1" >/dev/null 2>&1; then
    return 0
  fi

  mariadb --host=127.0.0.1 --port=3306 --user=root <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '${MYSQL_ROOT_PASSWORD}';
FLUSH PRIVILEGES;
SQL
}

wait_for_db
set_root_password_if_needed

mariadb --host=127.0.0.1 --port=3306 --user=root --password="${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL

mariadb --host=127.0.0.1 --port=3306 --user=root --password="${MYSQL_ROOT_PASSWORD}" < /opt/period-tracker/db/init.sql

echo "Database bootstrap complete"
