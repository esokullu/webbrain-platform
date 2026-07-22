CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(40) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  name VARCHAR(255) NOT NULL,
  prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS billing_accounts (
  user_id VARCHAR(40) PRIMARY KEY,
  credit_cents BIGINT NOT NULL DEFAULT 0,
  usage_remainder_units BIGINT NOT NULL DEFAULT 0,
  unlimited TINYINT(1) NOT NULL DEFAULT 0,
  stripe_customer_id VARCHAR(255) NULL,
  stripe_payment_method_id VARCHAR(255) NULL,
  auto_top_up_enabled TINYINT(1) NOT NULL DEFAULT 0,
  auto_top_up_threshold_cents BIGINT NOT NULL DEFAULT 500,
  auto_top_up_amount_cents BIGINT NOT NULL DEFAULT 2500,
  auto_top_up_status VARCHAR(32) NOT NULL DEFAULT 'disabled',
  auto_top_up_attempt_id VARCHAR(64) NULL,
  auto_top_up_next_attempt_at DATETIME NULL,
  auto_top_up_last_error VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS billing_transactions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  amount_cents BIGINT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  provider VARCHAR(32) NULL,
  provider_ref VARCHAR(255) NULL UNIQUE,
  description VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_billing_transactions_user_created (user_id, created_at)
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  display_name VARCHAR(120) NULL,
  status VARCHAR(32) NOT NULL,
  droplet_id VARCHAR(64) NULL,
  public_ip VARCHAR(64) NULL,
  region VARCHAR(64) NOT NULL,
  size VARCHAR(64) NOT NULL,
  volume_id VARCHAR(64) NULL,
  volume_name VARCHAR(128) NULL,
  volume_size_gib INT NULL,
  profile_mode VARCHAR(16) NOT NULL DEFAULT 'persistent',
  host_session_id VARCHAR(40) NULL,
  runtime_port INT NULL,
  runtime_generation VARCHAR(64) NULL,
  connect_secret TEXT NOT NULL,
  proxy_enabled TINYINT(1) NOT NULL DEFAULT 0,
  proxy_endpoint VARCHAR(512) NULL,
  proxy_updated_at DATETIME NULL,
  paused_at DATETIME NULL,
  billing_metered_at DATETIME NULL,
  ended_at DATETIME NULL,
  end_reason VARCHAR(255) NULL,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_browser_sessions_host (host_session_id)
);

CREATE TABLE IF NOT EXISTS warm_droplets (
  id VARCHAR(40) PRIMARY KEY,
  droplet_id VARCHAR(64) NULL,
  public_ip VARCHAR(64) NULL,
  region VARCHAR(64) NOT NULL,
  size VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  assigned_session_id VARCHAR(40) NULL,
  pool_token TEXT NOT NULL,
  last_error TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_warm_droplets_status (status, assigned_session_id),
  INDEX idx_warm_droplets_droplet (droplet_id),
  FOREIGN KEY (assigned_session_id) REFERENCES browser_sessions(id)
);

CREATE TABLE IF NOT EXISTS cloud_runs (
  id VARCHAR(40) PRIMARY KEY,
  browser_session_id VARCHAR(40) NOT NULL,
  user_id VARCHAR(40) NOT NULL,
  workflow_id VARCHAR(40) NULL,
  parent_run_id VARCHAR(40) NULL,
  tab_id BIGINT NULL,
  task TEXT NOT NULL,
  output_schema JSON NULL,
  status VARCHAR(32) NOT NULL,
  result JSON NULL,
  summary TEXT NULL,
  final_url TEXT NULL,
  error TEXT NULL,
  updates JSON NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  FOREIGN KEY (browser_session_id) REFERENCES browser_sessions(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE INDEX idx_cloud_runs_parent_run (parent_run_id)
);

CREATE TABLE IF NOT EXISTS saved_workflows (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  schema_version VARCHAR(64) NOT NULL,
  definition JSON NOT NULL,
  source_browser_session_id VARCHAR(40) NOT NULL,
  source_run_id VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_saved_workflows_user_updated (user_id, updated_at, id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NULL,
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id VARCHAR(64) NULL,
  metadata JSON NULL,
  ip VARCHAR(128) NULL,
  user_agent TEXT NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_audit_user_created (user_id, created_at)
);
