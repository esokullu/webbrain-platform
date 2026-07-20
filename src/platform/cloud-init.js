import { createHash } from 'node:crypto';
import { WEBBRAIN_CONFIG_ENV } from '../shared/webbrain-config.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ufwTcpPortSpec(startPort, count = 1) {
  const start = Number(startPort || 6100);
  const end = start + Math.max(1, Number(count || 1)) - 1;
  return start === end ? `${start}/tcp` : `${start}:${end}/tcp`;
}

export function chromeExtensionIdForPath(extensionPath) {
  const hex = createHash('sha256').update(String(extensionPath)).digest('hex').slice(0, 32);
  return [...hex].map(char => String.fromCharCode(97 + Number.parseInt(char, 16))).join('');
}

export function renderCloudInit({
  session,
  config,
  providerApiKey = '',
  proxyUrl = '',
  webbrainConfig = '',
}) {
  const repoUrl = config.droplet.repoUrl || 'https://github.com/esokullu/webbrain-platform.git';
  const webbrainRepoUrl = config.droplet.webbrainRepoUrl || 'https://github.com/webbrain-one/webbrain.git';
  const appDir = '/opt/webbrain-platform';
  const webbrainDir = '/opt/webbrain3';
  const extensionDir = `${webbrainDir}/src/chrome`;
  const extensionId = chromeExtensionIdForPath(extensionDir);
  const hasProfileVolume = Boolean(session.volume_id && session.volume_name);
  const profileMount = config.droplet.profileMount || '/mnt/webbrain-profile';
  const profileDir = hasProfileVolume ? `${profileMount}/chrome` : `${appDir}/.webbrain-sessions/${session.id}`;
  const proxyStatePath = hasProfileVolume ? `${profileMount}/proxy.json` : config.browserProxy.statePath;
  const downloadsSyncEnabled = hasProfileVolume && config.downloads?.spaces?.enabled === true;
  const downloadsStagingDir = '/var/lib/webbrain/download-staging';
  const ephemeralGatePortSpec = ufwTcpPortSpec(
    config.droplet.ephemeralGateBasePort || 6100,
    config.droplet.ephemeralMaxSessions || 1
  );
  const profileMountScript = hasProfileVolume ? `#!/usr/bin/env bash
set -euo pipefail
device=${shellQuote(`/dev/disk/by-id/scsi-0DO_Volume_${session.volume_name}`)}
mount_path=${shellQuote(profileMount)}
for attempt in $(seq 1 120); do
  [ -b "$device" ] && break
  sleep 1
done
[ -b "$device" ] || { echo "WebBrain profile volume did not appear: $device" >&2; exit 1; }
uuid=$(blkid -s UUID -o value "$device")
[ -n "$uuid" ] || { echo "WebBrain profile volume has no filesystem UUID" >&2; exit 1; }
mkdir -p "$mount_path"
if ! grep -q "^UUID=$uuid " /etc/fstab; then
  echo "UUID=$uuid $mount_path ext4 defaults,discard,noatime,nofail 0 2" >> /etc/fstab
fi
mountpoint -q "$mount_path" || mount "$mount_path"
mkdir -p "$mount_path/chrome"
chmod 0700 "$mount_path" "$mount_path/chrome"
` : '';
  const env = {
    NODE_ENV: 'production',
    WEBBRAIN_ROLE: 'droplet',
    WEBBRAIN_SESSION_ID: session.id,
    WEBBRAIN_SESSION_TOKEN: session.connect_secret,
    WEBBRAIN_PLATFORM_URL: config.baseUrl,
    WEBBRAIN_CONTROL_WS_URL: config.baseUrl.replace(/^http/, 'ws') + '/droplet/control',
    WEBBRAIN_EXTENSION_DIR: extensionDir,
    WEBBRAIN_PROVIDER_BASE_URL: config.droplet.providerBaseUrl,
    WEBBRAIN_PROVIDER_API_KEY: providerApiKey,
    WEBBRAIN_PROVIDER_MODEL: config.droplet.providerModel,
    ...(webbrainConfig ? { [WEBBRAIN_CONFIG_ENV]: webbrainConfig } : {}),
    WEBBRAIN_NOVNC_SECRET: session.connect_secret,
    WEBBRAIN_NOVNC_TARGET: 'http://127.0.0.1:6080',
    WEBBRAIN_NOVNC_GATE_PORT: String(config.droplet.noVncGatePort || 6081),
    WEBBRAIN_EPHEMERAL_GATE_BASE_PORT: String(config.droplet.ephemeralGateBasePort || 6100),
    WEBBRAIN_EPHEMERAL_MAX_SESSIONS: String(config.droplet.ephemeralMaxSessions || 1),
    WEBBRAIN_EPHEMERAL_MEMORY_MAX: config.droplet.ephemeralMemoryMax || '2G',
    WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES: String(config.droplet.ephemeralDiskMaxBytes || 2 * 1024 * 1024 * 1024),
    WEBBRAIN_EPHEMERAL_DOWNLOAD_LIMIT_BYTES: String(config.droplet.ephemeralDownloadLimitBytes || 512 * 1024 * 1024),
    WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES: String(
      config.droplet.ephemeralDownloadTotalLimitBytes || 1024 * 1024 * 1024
    ),
    WEBBRAIN_EPHEMERAL_LAUNCH_DIR: '/run/webbrain-ephemeral-launch',
    WEBBRAIN_DOWNLOADS_TARGET: 'http://127.0.0.1:6082',
    WEBBRAIN_DOWNLOADS_HOST: '127.0.0.1',
    WEBBRAIN_DOWNLOADS_PORT: '6083',
    WEBBRAIN_DOWNLOADS_ROOT: '/root/Downloads',
    WEBBRAIN_DOWNLOADS_UPLOAD_LIMIT_BYTES: String(downloadsSyncEnabled
      ? config.downloads.maxUploadBytes
      : 5 * 1024 * 1024 * 1024),
    WEBBRAIN_DOWNLOADS_SYNC_ENABLED: String(downloadsSyncEnabled),
    WEBBRAIN_DOWNLOADS_STAGING_DIR: downloadsStagingDir,
    WEBBRAIN_DOWNLOADS_INGEST_URL: `${config.baseUrl}/droplet/downloads`,
    DISPLAY: ':99',
    WEBBRAIN_HEADLESS: 'false',
    WEBBRAIN_START_URL: 'https://webbrain.one',
    WEBBRAIN_BROWSER_BIN: '/opt/chrome-linux64/chrome',
    WEBBRAIN_PROFILE_DIR: profileDir,
    WEBBRAIN_PROFILE_MOUNT: hasProfileVolume ? profileMount : '',
    WEBBRAIN_BROWSER_DISK_CACHE_DIR: '/var/cache/webbrain-chrome',
    WEBBRAIN_BROWSER_PROXY_URL: proxyUrl,
    WEBBRAIN_BROWSER_PROXY_SERVER: `http://${config.browserProxy.relayHost}:${config.browserProxy.relayPort}`,
    WEBBRAIN_BROWSER_PROXY_BYPASS_LIST: config.browserProxy.bypassList,
    WEBBRAIN_PROXY_RELAY_HOST: config.browserProxy.relayHost,
    WEBBRAIN_PROXY_RELAY_PORT: String(config.browserProxy.relayPort),
    WEBBRAIN_PROXY_STATE_PATH: proxyStatePath,
    WEBBRAIN_PROXY_VERIFY_URL: config.browserProxy.verifyUrl,
    WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS: String(config.browserProxy.verifyTimeoutMs),
  };
  const envText = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join('\n');

  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - build-essential
  - apt-transport-https
  - ca-certificates
  - curl
  - debian-archive-keyring
  - debian-keyring
  - git
  - gnupg
  - unzip
  - ufw
  - xvfb
  - x11vnc
  - websockify
write_files:
${hasProfileVolume ? `  - path: /usr/local/sbin/webbrain-mount-profile
    permissions: '0755'
    content: |
${profileMountScript.split('\n').map(line => `      ${line}`).join('\n')}` : ''}
  - path: /etc/opt/chrome_for_testing/policies/managed/webbrain.json
    permissions: '0644'
    content: |
      {"PasswordManagerEnabled":false,"ExtensionSettings":{"${extensionId}":{"installation_mode":"allowed","toolbar_pin":"force_pinned"}}}
  - path: /etc/webbrain-droplet.env
    permissions: '0600'
    content: |
${envText.split('\n').map(line => `      ${line}`).join('\n')}
  - path: /etc/systemd/system/webbrain-sidecar.service
    content: |
      [Unit]
      Description=WebBrain local sidecar
      After=network-online.target
      Wants=network-online.target
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      WorkingDirectory=${appDir}
      ExecStart=/usr/bin/npm run start:sidecar
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/webbrain-xvfb.service
    content: |
      [Unit]
      Description=WebBrain virtual display
      After=network-online.target
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -ac -noreset
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/webbrain-x11vnc.service
    content: |
      [Unit]
      Description=WebBrain VNC server
      After=webbrain-xvfb.service
      Requires=webbrain-xvfb.service
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -rfbport 5900 -nopw
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/webbrain-novnc.service
    content: |
      [Unit]
      Description=WebBrain noVNC proxy
      After=webbrain-x11vnc.service
      Requires=webbrain-x11vnc.service
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      ExecStart=/opt/noVNC/utils/novnc_proxy --listen 127.0.0.1:6080 --vnc 127.0.0.1:5900
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/webbrain-browser.service
    content: |
      [Unit]
      Description=WebBrain cloud browser
      After=webbrain-droplet.service webbrain-sidecar.service webbrain-xvfb.service${hasProfileVolume ? ' local-fs.target' : ''}
      Wants=webbrain-droplet.service
      Requires=webbrain-xvfb.service
${hasProfileVolume ? `      RequiresMountsFor=${profileMount}` : ''}
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      WorkingDirectory=${appDir}
${hasProfileVolume ? `      ExecStartPre=/usr/bin/node ${appDir}/scripts/clean-stale-chrome-singletons.mjs
` : ''}      ExecStart=/usr/bin/npm run start:browser
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/webbrain-droplet.service
    content: |
      [Unit]
      Description=WebBrain droplet control client
      After=network-online.target webbrain-sidecar.service webbrain-novnc.service
      Wants=network-online.target
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      WorkingDirectory=${appDir}
      RuntimeDirectory=webbrain-ephemeral-launch
      RuntimeDirectoryMode=0700
      RuntimeDirectoryPreserve=no
      ExecStart=/usr/bin/npm run start:droplet
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
runcmd:
  - ufw allow OpenSSH
  - ufw allow 6081/tcp
  - ufw allow ${ephemeralGatePortSpec}
  - ufw --force enable
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs
  - curl -fsSL -o /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  - apt-get install -y /tmp/google-chrome-stable_current_amd64.deb
  - node --input-type=module -e "const r = await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'); const j = await r.json(); console.log(j.channels.Stable.downloads.chrome.find(x => x.platform === 'linux64').url);" > /tmp/chrome-for-testing-url
  - curl -fsSL -o /tmp/chrome-linux64.zip "$(cat /tmp/chrome-for-testing-url)"
  - rm -rf /opt/chrome-linux64 && unzip -q /tmp/chrome-linux64.zip -d /opt
  - git clone ${shellQuote(repoUrl)} ${appDir}
  - git clone ${shellQuote(webbrainRepoUrl)} ${webbrainDir}
  - git clone https://github.com/novnc/noVNC.git /opt/noVNC
  - cd ${appDir} && npm ci --omit=dev
  - cd ${appDir} && bash scripts/install-downloads-share.sh
  - cd ${webbrainDir} && git checkout ${shellQuote(config.droplet.webbrainRef)}
${hasProfileVolume ? '  - /usr/local/sbin/webbrain-mount-profile' : ''}
  - mkdir -p /var/cache/webbrain-chrome ${downloadsStagingDir}
  - chmod 0700 /var/cache/webbrain-chrome ${downloadsStagingDir}
  - systemctl daemon-reload
  - systemctl enable webbrain-sidecar.service webbrain-xvfb.service webbrain-x11vnc.service webbrain-novnc.service webbrain-droplet.service webbrain-browser.service
  - systemctl start webbrain-sidecar.service webbrain-xvfb.service webbrain-x11vnc.service webbrain-novnc.service webbrain-droplet.service webbrain-browser.service
`;
}

export function renderWarmPoolCloudInit({ pool, config }) {
  const repoUrl = config.droplet.repoUrl || 'https://github.com/esokullu/webbrain-platform.git';
  const webbrainRepoUrl = config.droplet.webbrainRepoUrl || 'https://github.com/webbrain-one/webbrain.git';
  const appDir = '/opt/webbrain-platform';
  const webbrainDir = '/opt/webbrain3';
  const extensionDir = `${webbrainDir}/src/chrome`;
  const poolControlUrl = config.baseUrl.replace(/^http/, 'ws') + '/droplet/pool-control';
  const sessionControlUrl = config.baseUrl.replace(/^http/, 'ws') + '/droplet/control';
  const ephemeralGatePortSpec = ufwTcpPortSpec(
    config.droplet.ephemeralGateBasePort || 6100,
    config.droplet.ephemeralMaxSessions || 1
  );
  const env = {
    NODE_ENV: 'production',
    WEBBRAIN_ROLE: 'warm-pool',
    WEBBRAIN_POOL_ID: pool.id,
    WEBBRAIN_POOL_TOKEN: pool.pool_token,
    WEBBRAIN_PLATFORM_URL: config.baseUrl,
    WEBBRAIN_POOL_CONTROL_WS_URL: poolControlUrl,
    WEBBRAIN_CONTROL_WS_URL: sessionControlUrl,
    WEBBRAIN_EXTENSION_DIR: extensionDir,
    WEBBRAIN_PROVIDER_BASE_URL: config.droplet.providerBaseUrl,
    WEBBRAIN_PROVIDER_MODEL: config.droplet.providerModel,
    WEBBRAIN_NOVNC_GATE_PORT: String(config.droplet.noVncGatePort || 6081),
    WEBBRAIN_EPHEMERAL_GATE_BASE_PORT: String(config.droplet.ephemeralGateBasePort || 6100),
    WEBBRAIN_EPHEMERAL_MAX_SESSIONS: String(config.droplet.ephemeralMaxSessions || 1),
    WEBBRAIN_EPHEMERAL_MEMORY_MAX: config.droplet.ephemeralMemoryMax || '2G',
    WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES: String(config.droplet.ephemeralDiskMaxBytes || 2 * 1024 * 1024 * 1024),
    WEBBRAIN_EPHEMERAL_DOWNLOAD_LIMIT_BYTES: String(config.droplet.ephemeralDownloadLimitBytes || 512 * 1024 * 1024),
    WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES: String(
      config.droplet.ephemeralDownloadTotalLimitBytes || 1024 * 1024 * 1024
    ),
    WEBBRAIN_BROWSER_BIN: '/opt/chrome-linux64/chrome',
    WEBBRAIN_START_URL: 'https://webbrain.one',
    WEBBRAIN_PROFILE_MOUNT: config.droplet.profileMount || '/mnt/webbrain-profile',
    WEBBRAIN_DOWNLOADS_INGEST_URL: `${config.baseUrl}/droplet/downloads`,
    WEBBRAIN_DOWNLOADS_MAX_UPLOAD_BYTES: String(config.downloads.maxUploadBytes),
    WEBBRAIN_DOWNLOADS_SPACES_ENABLED: String(config.downloads?.spaces?.enabled === true),
    WEBBRAIN_BROWSER_PROXY_SERVER: `http://${config.browserProxy.relayHost}:${config.browserProxy.relayPort}`,
    WEBBRAIN_BROWSER_PROXY_BYPASS_LIST: config.browserProxy.bypassList,
    WEBBRAIN_PROXY_RELAY_HOST: config.browserProxy.relayHost,
    WEBBRAIN_PROXY_RELAY_PORT: String(config.browserProxy.relayPort),
    WEBBRAIN_PROXY_VERIFY_URL: config.browserProxy.verifyUrl,
    WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS: String(config.browserProxy.verifyTimeoutMs),
  };
  const envText = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join('\n');
  const extensionId = chromeExtensionIdForPath(extensionDir);

  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - build-essential
  - apt-transport-https
  - ca-certificates
  - curl
  - debian-archive-keyring
  - debian-keyring
  - git
  - gnupg
  - unzip
  - ufw
  - xvfb
  - x11vnc
  - websockify
write_files:
  - path: /etc/opt/chrome_for_testing/policies/managed/webbrain.json
    permissions: '0644'
    content: |
      {"PasswordManagerEnabled":false,"ExtensionSettings":{"${extensionId}":{"installation_mode":"allowed","toolbar_pin":"force_pinned"}}}
  - path: /etc/webbrain-pool.env
    permissions: '0600'
    content: |
${envText.split('\n').map(line => `      ${line}`).join('\n')}
  - path: /etc/systemd/system/webbrain-pool-agent.service
    content: |
      [Unit]
      Description=WebBrain warm Droplet pool agent
      After=network-online.target
      Wants=network-online.target
      [Service]
      EnvironmentFile=/etc/webbrain-pool.env
      WorkingDirectory=${appDir}
      ExecStart=/usr/bin/npm run start:pool-agent
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
runcmd:
  - ufw allow OpenSSH
  - ufw allow ${Number(config.droplet.noVncGatePort || 6081)}/tcp
  - ufw allow ${ephemeralGatePortSpec}
  - ufw --force enable
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs
  - curl -fsSL -o /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  - apt-get install -y /tmp/google-chrome-stable_current_amd64.deb
  - node --input-type=module -e "const r = await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'); const j = await r.json(); console.log(j.channels.Stable.downloads.chrome.find(x => x.platform === 'linux64').url);" > /tmp/chrome-for-testing-url
  - curl -fsSL -o /tmp/chrome-linux64.zip "$(cat /tmp/chrome-for-testing-url)"
  - rm -rf /opt/chrome-linux64 && unzip -q /tmp/chrome-linux64.zip -d /opt
  - git clone ${shellQuote(repoUrl)} ${appDir}
  - git clone ${shellQuote(webbrainRepoUrl)} ${webbrainDir}
  - git clone https://github.com/novnc/noVNC.git /opt/noVNC
  - cd ${appDir} && npm ci --omit=dev
  - cd ${webbrainDir} && git checkout ${shellQuote(config.droplet.webbrainRef)}
  - systemctl daemon-reload
  - systemctl enable webbrain-pool-agent.service
  - systemctl start webbrain-pool-agent.service
`;
}
