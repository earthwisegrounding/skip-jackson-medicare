#!/usr/bin/env bash
# Runs ON the server as root. Safe to re-run.
#   sudo SITE_HOST=crm.example.com bash server-setup.sh
# Without SITE_HOST it uses <ip>.sslip.io so HTTPS works before a domain exists.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

NODE_VERSION="${NODE_VERSION:-v25.9.0}"
REPO="${REPO:-https://github.com/earthwisegrounding/skip-jackson-medicare.git}"
APP_DIR=/opt/skip-crm
DATA_DIR=/var/lib/skip-crm
BACKUP_DIR=/var/backups/skip-crm
APP_USER=skipcrm

if [ -z "${SITE_HOST:-}" ]; then
  IP=$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)
  SITE_HOST="${IP//./-}.sslip.io"
fi
echo "==> Site host: $SITE_HOST"

echo "==> Swap (e2-micro has 1 GB RAM)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Packages and automatic security updates"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates xz-utils libatomic1 gnupg debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades >/dev/null
echo 'APT::Periodic::Update-Package-Lists "1"; APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

echo "==> Node $NODE_VERSION (official build, checksum verified)"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  T=$(mktemp -d); cd "$T"
  F="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$F"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  grep " $F\$" SHASUMS256.txt | sha256sum -c -
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf "$F" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  cd / && rm -rf "$T"
fi

echo "==> Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> App user, code, data folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR" "$BACKUP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$APP_DIR"; fi
chown -R root:root "$APP_DIR"   # the app can read its code but never change it

cat > /etc/skip-crm.env <<ENV
PORT=8790
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
BACKUP_DIR=$BACKUP_DIR
COOKIE_SECURE=1
TRUST_PROXY=1
TRUST_PROXY_HOPS=1
PUBLIC_URL=https://$SITE_HOST
NODE_ENV=production
ENV
chmod 644 /etc/skip-crm.env

cat > /etc/systemd/system/skip-crm.service <<UNIT
[Unit]
Description=Skip Jackson website and CRM
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/skip-crm.env
ExecStart=/usr/local/bin/node server/index.js
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA_DIR $BACKUP_DIR

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/skip-crm-backup.service <<UNIT
[Unit]
Description=Nightly CRM database backup

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/skip-crm.env
UMask=0077
ExecStart=/usr/local/bin/node scripts/backup.js
ExecStartPost=/usr/bin/find $BACKUP_DIR -name 'crm-*.db' -mtime +30 -delete
UNIT

cat > /etc/systemd/system/skip-crm-backup.timer <<UNIT
[Unit]
Description=Run the CRM backup every night

[Timer]
OnCalendar=*-*-* 03:30:00 America/New_York
Persistent=true

[Install]
WantedBy=timers.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$SITE_HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8790
}
CADDY

cat > /usr/local/bin/skip-crm-update <<'UPD'
#!/usr/bin/env bash
# Pull the latest code from GitHub and restart the app.
set -euo pipefail
git -C /opt/skip-crm pull --ff-only
systemctl restart skip-crm
systemctl --no-pager --lines=3 status skip-crm
UPD
chmod 755 /usr/local/bin/skip-crm-update

systemctl daemon-reload
systemctl enable --now skip-crm skip-crm-backup.timer
systemctl reload caddy || systemctl restart caddy

sleep 2
curl -fsS -o /dev/null -w "app: %{http_code}\n" http://127.0.0.1:8790/healthz
echo "==> Ready at https://$SITE_HOST/  (CRM: https://$SITE_HOST/crm/)"
