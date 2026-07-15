const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

function invalidProxyUrl(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function normalizeProxyUrl(value, { allowEmpty = true } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    if (allowEmpty) return '';
    throw invalidProxyUrl('`proxy_url` is required');
  }
  if ([...raw].some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    throw invalidProxyUrl('`proxy_url` contains invalid control characters');
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidProxyUrl('`proxy_url` must be a valid proxy URL');
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw invalidProxyUrl('`proxy_url` must use HTTP, HTTPS, SOCKS4, or SOCKS5');
  }
  if (!parsed.hostname) throw invalidProxyUrl('`proxy_url` must include a hostname');
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw invalidProxyUrl('`proxy_url` cannot include a path, query string, or fragment');
  }
  parsed.pathname = '';
  return parsed.toString();
}

export function proxyUrlFromParts(parts, { allowEmpty = true } = {}) {
  const input = parts && typeof parts === 'object' ? parts : {};
  const host = String(input.host ?? input.hostname ?? input.domain ?? '').trim();
  const port = String(input.port ?? '').trim();
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const protocol = String(input.protocol || 'http').trim().toLowerCase().replace(/:$/, '');
  const hasAnyValue = Boolean(host || port || username || password);
  if (!hasAnyValue) {
    if (allowEmpty) return '';
    throw invalidProxyUrl('Proxy domain, port, username, and password are required');
  }
  if (!host || !port || !username || !password) {
    throw invalidProxyUrl('Proxy domain, port, username, and password are required');
  }
  if (/[:/\s]/.test(host)) {
    throw invalidProxyUrl('Proxy domain must be a hostname without a protocol or path');
  }
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw invalidProxyUrl('Proxy port must be between 1 and 65535');
  }

  let parsed;
  try {
    parsed = new URL(`${protocol}://${host}:${numericPort}`);
  } catch {
    throw invalidProxyUrl('Proxy domain is invalid');
  }
  parsed.username = username;
  parsed.password = password;
  return normalizeProxyUrl(parsed.toString(), { allowEmpty: false });
}

export function publicProxyEndpoint(value) {
  const normalized = normalizeProxyUrl(value);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname}${port}`;
}

export function publicProxyState({ proxyUrl = '', endpoint, exitIp = null, updatedAt = null, verifiedAt = null } = {}) {
  const publicEndpoint = endpoint === undefined ? publicProxyEndpoint(proxyUrl) : endpoint;
  return {
    enabled: Boolean(publicEndpoint),
    endpoint: publicEndpoint || null,
    exit_ip: exitIp || null,
    updated_at: updatedAt || null,
    verified_at: verifiedAt || null,
  };
}
