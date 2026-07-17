function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

export function loadConfig(env = process.env) {
  const baseUrl = env.WEBBRAIN_PLATFORM_URL || `http://127.0.0.1:${env.PORT || 3000}`;
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    baseUrl,
    cookieName: env.WEBBRAIN_COOKIE_NAME || 'wbp_session',
    cookieSecure: env.WEBBRAIN_COOKIE_SECURE === 'true',
    registrationEnabled: env.WEBBRAIN_REGISTRATION_ENABLED === 'true',
    sessionTtlMs: Number(env.WEBBRAIN_WEB_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000),
    browserSessionTtlMs: Number(env.WEBBRAIN_BROWSER_SESSION_TTL_MS || 6 * 60 * 60 * 1000),
    browserCleanupIntervalMs: Math.max(5000, Number(env.WEBBRAIN_BROWSER_CLEANUP_INTERVAL_MS || 30000)),
    connectTokenTtlMs: Number(env.WEBBRAIN_CONNECT_TOKEN_TTL_MS || 5 * 60 * 1000),
    instanceDomain: String(env.WEBBRAIN_INSTANCE_DOMAIN || '').trim().toLowerCase(),
    runWaitTimeoutMs: Number(env.WEBBRAIN_RUN_WAIT_TIMEOUT_MS || 120000),
    runPollIntervalMs: Number(env.WEBBRAIN_RUN_POLL_INTERVAL_MS || 500),
    db: {
      driver: env.WEBBRAIN_DB_DRIVER || (env.DATABASE_URL || env.MYSQL_HOST ? 'mysql' : 'memory'),
      url: env.DATABASE_URL || '',
      host: env.MYSQL_HOST || '127.0.0.1',
      port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER || 'webbrain',
      password: env.MYSQL_PASSWORD || '',
      database: env.MYSQL_DATABASE || 'webbrain_platform',
      sslRejectUnauthorized: env.MYSQL_SSL_REJECT_UNAUTHORIZED === 'true',
    },
    digitalOcean: {
      token: env.DO_API_TOKEN || '',
      region: env.DO_REGION || 'nyc3',
      size: env.DO_SIZE || 's-2vcpu-4gb',
      image: env.DO_IMAGE || 'ubuntu-24-04-x64',
      volumeSizeGiB: Number(env.DO_BROWSER_VOLUME_SIZE_GIB || 2),
      sshKeys: (env.DO_SSH_KEYS || '').split(',').map(s => s.trim()).filter(Boolean),
    },
    downloads: {
      quotaBytes: Number(env.WEBBRAIN_DOWNLOADS_USER_QUOTA_BYTES || 25 * 1024 * 1024 * 1024),
      maxUploadBytes: Number(env.WEBBRAIN_DOWNLOADS_MAX_UPLOAD_BYTES || 25 * 1024 * 1024 * 1024),
      spaces: {
        enabled: Boolean(
          env.WEBBRAIN_SPACES_ENDPOINT
          && env.WEBBRAIN_SPACES_ACCESS_KEY
          && env.WEBBRAIN_SPACES_SECRET_KEY
          && env.WEBBRAIN_SPACES_BUCKET
        ),
        endpoint: env.WEBBRAIN_SPACES_ENDPOINT || '',
        region: env.WEBBRAIN_SPACES_S3_REGION || 'us-east-1',
        accessKey: env.WEBBRAIN_SPACES_ACCESS_KEY || '',
        secretKey: env.WEBBRAIN_SPACES_SECRET_KEY || '',
        bucket: env.WEBBRAIN_SPACES_BUCKET || '',
      },
    },
    modelProxy: {
      baseUrl: env.WEBBRAIN_MODEL_PROXY_BASE_URL || '',
      apiKey: env.WEBBRAIN_MODEL_PROXY_API_KEY || '',
    },
    browserProxy: {
      url: env.WEBBRAIN_BROWSER_PROXY_URL || '',
      relayHost: env.WEBBRAIN_PROXY_RELAY_HOST || '127.0.0.1',
      relayPort: Number(env.WEBBRAIN_PROXY_RELAY_PORT || 17890),
      bypassList: env.WEBBRAIN_PROXY_BYPASS_LIST || hostnameFromUrl(baseUrl),
      statePath: env.WEBBRAIN_PROXY_STATE_PATH || '/var/lib/webbrain/proxy.json',
      verifyUrl: env.WEBBRAIN_PROXY_VERIFY_URL || 'http://api.ipify.org?format=json',
      verifyTimeoutMs: Number(env.WEBBRAIN_PROXY_VERIFY_TIMEOUT_MS || 10000),
    },
    droplet: {
      repoUrl: env.WEBBRAIN_PLATFORM_REPO_URL || 'https://github.com/esokullu/webbrain-platform.git',
      webbrainRepoUrl: env.WEBBRAIN_REPO_URL || 'https://github.com/webbrain-one/webbrain.git',
      webbrainRef: env.WEBBRAIN_REF || 'main',
      providerBaseUrl: env.WEBBRAIN_PROVIDER_BASE_URL || `${baseUrl}/v1`,
      providerModel: env.WEBBRAIN_PROVIDER_MODEL || 'webbrain-cloud 1.0',
      noVncGatePort: Number(env.WEBBRAIN_NOVNC_GATE_PORT || 6081),
      ephemeralGateBasePort: Number(env.WEBBRAIN_EPHEMERAL_GATE_BASE_PORT || 6100),
      ephemeralMaxSessions: Math.max(1, Number(env.WEBBRAIN_EPHEMERAL_MAX_SESSIONS || 1)),
      ephemeralMemoryMax: env.WEBBRAIN_EPHEMERAL_MEMORY_MAX || '2G',
      ephemeralDiskMaxBytes: Number(env.WEBBRAIN_EPHEMERAL_DISK_MAX_BYTES || 2 * 1024 * 1024 * 1024),
      ephemeralDownloadLimitBytes: Number(env.WEBBRAIN_EPHEMERAL_DOWNLOAD_LIMIT_BYTES || 512 * 1024 * 1024),
      ephemeralDownloadTotalLimitBytes: Number(
        env.WEBBRAIN_EPHEMERAL_DOWNLOAD_TOTAL_LIMIT_BYTES || 1024 * 1024 * 1024
      ),
      readyTimeoutMs: Number(env.WEBBRAIN_DROPLET_READY_TIMEOUT_MS || 1000),
      profileMount: env.WEBBRAIN_PROFILE_MOUNT || '/mnt/webbrain-profile',
    },
  };
}
