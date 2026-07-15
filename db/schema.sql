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

CREATE TABLE IF NOT EXISTS browser_sessions (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(40) NOT NULL,
  display_name VARCHAR(120) NULL,
  status VARCHAR(32) NOT NULL,
  droplet_id VARCHAR(64) NULL,
  public_ip VARCHAR(64) NULL,
  region VARCHAR(64) NOT NULL,
  size VARCHAR(64) NOT NULL,
  connect_secret TEXT NOT NULL,
  proxy_enabled TINYINT(1) NOT NULL DEFAULT 0,
  proxy_endpoint VARCHAR(512) NULL,
  proxy_updated_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cloud_runs (
  id VARCHAR(40) PRIMARY KEY,
  browser_session_id VARCHAR(40) NOT NULL,
  user_id VARCHAR(40) NOT NULL,
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
  FOREIGN KEY (user_id) REFERENCES users(id)
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
