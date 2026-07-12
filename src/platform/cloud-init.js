function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function renderCloudInit({ session, config, providerApiKey = '' }) {
  const repoUrl = config.droplet.repoUrl || 'https://github.com/esokullu/webbrain-platform.git';
  const webbrainRepoUrl = config.droplet.webbrainRepoUrl || 'https://github.com/webbrain-one/webbrain.git';
  const appDir = '/opt/webbrain-platform';
  const webbrainDir = '/opt/webbrain3';
  const env = {
    NODE_ENV: 'production',
    WEBBRAIN_ROLE: 'droplet',
    WEBBRAIN_SESSION_ID: session.id,
    WEBBRAIN_SESSION_TOKEN: session.connect_secret,
    WEBBRAIN_PLATFORM_URL: config.baseUrl,
    WEBBRAIN_CONTROL_WS_URL: config.baseUrl.replace(/^http/, 'ws') + '/droplet/control',
    WEBBRAIN_EXTENSION_DIR: `${webbrainDir}/src/chrome`,
    WEBBRAIN_PROVIDER_BASE_URL: config.droplet.providerBaseUrl,
    WEBBRAIN_PROVIDER_API_KEY: providerApiKey,
    WEBBRAIN_PROVIDER_MODEL: config.droplet.providerModel,
    WEBBRAIN_NOVNC_SECRET: session.connect_secret,
    WEBBRAIN_NOVNC_TARGET: 'http://127.0.0.1:6080',
    WEBBRAIN_NOVNC_GATE_PORT: String(config.droplet.noVncGatePort || 6081),
    DISPLAY: ':99',
    WEBBRAIN_HEADLESS: 'false',
    WEBBRAIN_START_URL: 'https://webbrain.one',
    WEBBRAIN_BROWSER_BIN: '/opt/chrome-linux64/chrome',
  };
  const envText = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join('\n');

  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - build-essential
  - ca-certificates
  - curl
  - git
  - unzip
  - ufw
  - xvfb
  - x11vnc
  - websockify
write_files:
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
      After=webbrain-sidecar.service webbrain-xvfb.service
      Requires=webbrain-xvfb.service
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      WorkingDirectory=${appDir}
      ExecStart=/usr/bin/npm run start:browser
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
  - path: /etc/systemd/system/webbrain-droplet.service
    content: |
      [Unit]
      Description=WebBrain droplet control client
      After=webbrain-sidecar.service webbrain-browser.service webbrain-novnc.service
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      WorkingDirectory=${appDir}
      ExecStart=/usr/bin/npm run start:droplet
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
runcmd:
  - ufw allow OpenSSH
  - ufw allow 6081/tcp
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
  - systemctl enable --now webbrain-sidecar.service webbrain-xvfb.service webbrain-x11vnc.service webbrain-novnc.service webbrain-browser.service webbrain-droplet.service
`;
}
