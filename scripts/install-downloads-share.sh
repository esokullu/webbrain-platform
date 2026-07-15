#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "install-downloads-share.sh must run as root" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=${WEBBRAIN_APP_DIR:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}
ENV_FILE=${WEBBRAIN_DROPLET_ENV_FILE:-/etc/webbrain-droplet.env}
DOWNLOADS_ROOT=${WEBBRAIN_DOWNLOADS_ROOT:-/root/Downloads}

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

systemctl stop caddy.service >/dev/null 2>&1 || true
install -d -m 0700 -o root -g root "${DOWNLOADS_ROOT}"

if grep -q '^WEBBRAIN_DOWNLOADS_TARGET=' "${ENV_FILE}"; then
  sed -i "s|^WEBBRAIN_DOWNLOADS_TARGET=.*|WEBBRAIN_DOWNLOADS_TARGET='http://127.0.0.1:6082'|" "${ENV_FILE}"
else
  printf "\nWEBBRAIN_DOWNLOADS_TARGET='http://127.0.0.1:6082'\n" >> "${ENV_FILE}"
fi
chmod 0600 "${ENV_FILE}"

install -d -m 0755 /etc/caddy
cat > /etc/caddy/Caddyfile <<'CADDYFILE'
{
  admin off
  auto_https off
}

http://127.0.0.1:6082 {
  bind 127.0.0.1
  reverse_proxy 127.0.0.1:6083
}
CADDYFILE
chmod 0644 /etc/caddy/Caddyfile

cat > /etc/systemd/system/webbrain-downloads.service <<EOF
[Unit]
Description=WebBrain Downloads service
After=network.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/droplet/downloads-index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${DOWNLOADS_ROOT}

[Install]
WantedBy=multi-user.target
EOF

caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable webbrain-downloads.service caddy.service
systemctl restart webbrain-downloads.service
systemctl restart caddy.service
systemctl is-active --quiet webbrain-downloads.service
systemctl is-active --quiet caddy.service
