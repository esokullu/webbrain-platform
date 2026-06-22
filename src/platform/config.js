export function loadConfig(env = process.env) {
  const baseUrl = env.WEBBRAIN_PLATFORM_URL || `http://127.0.0.1:${env.PORT || 3000}`;
  return {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    baseUrl,
    cookieName: env.WEBBRAIN_COOKIE_NAME || 'wbp_session',
    cookieSecure: env.WEBBRAIN_COOKIE_SECURE === 'true',
    sessionTtlMs: Number(env.WEBBRAIN_WEB_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000),
    browserSessionTtlMs: Number(env.WEBBRAIN_BROWSER_SESSION_TTL_MS || 6 * 60 * 60 * 1000),
    connectTokenTtlMs: Number(env.WEBBRAIN_CONNECT_TOKEN_TTL_MS || 5 * 60 * 1000),
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
      sshKeys: (env.DO_SSH_KEYS || '').split(',').map(s => s.trim()).filter(Boolean),
    },
    modelProxy: {
      baseUrl: env.WEBBRAIN_MODEL_PROXY_BASE_URL || '',
      apiKey: env.WEBBRAIN_MODEL_PROXY_API_KEY || '',
    },
    droplet: {
      repoUrl: env.WEBBRAIN_PLATFORM_REPO_URL || 'https://github.com/esokullu/webbrain-platform.git',
      webbrainRepoUrl: env.WEBBRAIN_REPO_URL || 'https://github.com/esokullu/webbrain.git',
      webbrainRef: env.WEBBRAIN_REF || 'main',
      providerBaseUrl: env.WEBBRAIN_PROVIDER_BASE_URL || `${baseUrl}/v1`,
      providerModel: env.WEBBRAIN_PROVIDER_MODEL || 'webbrain-cloud 1.0',
    },
  };
}
