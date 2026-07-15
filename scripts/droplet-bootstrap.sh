#!/usr/bin/env bash
# WebBrain Platform droplet bootstrap
# Run on a fresh Ubuntu 24.04 droplet:
#   scp scripts/droplet-bootstrap.sh root@<DROPLET_IP>:/root/
#   ssh root@<DROPLET_IP> 'bash /root/droplet-bootstrap.sh'
set -euo pipefail

echo "==> Updating apt"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

echo "==> Installing base tooling"
apt-get install -y curl git build-essential ufw

echo "==> Installing Node.js 20 LTS"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version
npm --version

echo "==> Preparing app directory"
mkdir -p /opt/webbrain-platform
cd /opt/webbrain-platform

# Private repo: provide a GitHub token or use a deploy key, e.g.
#   git clone https://<TOKEN>@github.com/esokullu/webbrain-platform.git .
# Then:
#   npm install --omit=dev

echo "==> Basic firewall (SSH + HTTP/HTTPS)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
yes | ufw enable || true

cat <<'NOTE'

==> Base setup complete.
Next steps (manual, needs your secrets):
  1) Clone the repo into /opt/webbrain-platform (private repo needs auth):
       cd /opt/webbrain-platform
       git clone https://<GITHUB_TOKEN>@github.com/esokullu/webbrain-platform.git .
  2) npm install --omit=dev
  3) Set env: WEBBRAIN_DB_DRIVER, MYSQL_*, DO_API_TOKEN, DO_REGION, DO_SIZE,
     DO_IMAGE, DO_SSH_KEYS, DO_BROWSER_VOLUME_SIZE_GIB, WEBBRAIN_PLATFORM_URL,
     WEBBRAIN_SPACES_*, WEBBRAIN_DOWNLOADS_*, and model proxy vars.
  4) Run: npm run start:platform   (consider a systemd unit for production)
NOTE
