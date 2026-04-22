FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Core runtime packages for single-container deployment.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
        nginx \
        mariadb-server \
        mariadb-client \
        openssh-server \
        sudo \
        nano \
        supervisor \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/period-tracker

COPY backend/package*.json /opt/period-tracker/backend/
RUN cd /opt/period-tracker/backend && npm install --omit=dev

COPY . /opt/period-tracker/

RUN mkdir -p /var/run/sshd /run/mysqld /var/log/supervisor \
    && chown -R mysql:mysql /run/mysqld \
    && rm -f /etc/nginx/sites-enabled/default

COPY docker/nginx-luna.conf /etc/nginx/sites-available/luna
RUN ln -sf /etc/nginx/sites-available/luna /etc/nginx/sites-enabled/luna

COPY docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/init-db.sh /usr/local/bin/init-db.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/init-db.sh

EXPOSE 80 22 3306

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
