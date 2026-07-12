export function publicBrowserSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    droplet_id: row.droplet_id || null,
    public_ip: row.public_ip || null,
    region: row.region,
    size: row.size,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    droplet_connected: row.droplet_connected === true,
    extension_connected: row.extension_connected === true,
    runtime_ready: row.runtime_ready === true,
  };
}

export function publicRun(row) {
  if (!row) return null;
  return {
    run_id: row.id || row.run_id,
    status: row.status,
    session_id: row.browser_session_id || row.session_id,
    result: row.result ?? null,
    summary: row.summary || '',
    final_url: row.final_url || '',
    error: row.error || '',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    completed_at: row.completed_at || null,
  };
}

export function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

export function parseJsonMaybe(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
