function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function renderCloudInit({ session, config, providerApiKey = '' }) {
  const repoUrl = config.droplet.repoUrl || 'https://github.com/esokullu/webbrain-platform.git';
  const webbrainRepoUrl = config.droplet.webbrainRepoUrl || 'https://github.com/esokullu/webbrain.git';
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
    WEBBRAIN_NOVNC_GATE_PORT: '6081',
  };
  const envText = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join('\n');

  return `#cloud-config
package_update: true
packages:
  - git
  - nodejs
  - npm
  - chromium-browser
  - xvfb
  - x11vnc
  - novnc
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
  - path: /etc/systemd/system/webbrain-browser.service
    content: |
      [Unit]
      Description=WebBrain cloud browser
      After=webbrain-sidecar.service
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
      After=webbrain-sidecar.service webbrain-browser.service
      [Service]
      EnvironmentFile=/etc/webbrain-droplet.env
      WorkingDirectory=${appDir}
      ExecStart=/usr/bin/npm run start:droplet
      Restart=always
      RestartSec=3
      [Install]
      WantedBy=multi-user.target
runcmd:
  - git clone ${shellQuote(repoUrl)} ${appDir}
  - git clone ${shellQuote(webbrainRepoUrl)} ${webbrainDir}
  - cd ${appDir} && npm ci --omit=dev
  - cd ${webbrainDir} && git checkout ${shellQuote(config.droplet.webbrainRef)}
  - systemctl daemon-reload
  - systemctl enable --now webbrain-sidecar.service webbrain-browser.service webbrain-droplet.service
`;
}
