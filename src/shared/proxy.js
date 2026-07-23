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

const ISO_COUNTRY_CODES = new Set([
  'ad', 'ae', 'af', 'ag', 'ai', 'al', 'am', 'ao', 'aq', 'ar', 'as', 'at', 'au', 'aw', 'ax', 'az',
  'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj', 'bl', 'bm', 'bn', 'bo', 'bq', 'br', 'bs', 'bt', 'bv', 'bw', 'by', 'bz',
  'ca', 'cc', 'cd', 'cf', 'cg', 'ch', 'ci', 'ck', 'cl', 'cm', 'cn', 'co', 'cr', 'cu', 'cv', 'cw', 'cx', 'cy', 'cz',
  'de', 'dj', 'dk', 'dm', 'do', 'dz',
  'ec', 'ee', 'eg', 'eh', 'er', 'es', 'et',
  'fi', 'fj', 'fk', 'fm', 'fo', 'fr',
  'ga', 'gb', 'gd', 'ge', 'gf', 'gg', 'gh', 'gi', 'gl', 'gm', 'gn', 'gp', 'gq', 'gr', 'gs', 'gt', 'gu', 'gw', 'gy',
  'hk', 'hm', 'hn', 'hr', 'ht', 'hu',
  'id', 'ie', 'il', 'im', 'in', 'io', 'iq', 'ir', 'is', 'it',
  'je', 'jm', 'jo', 'jp',
  'ke', 'kg', 'kh', 'ki', 'km', 'kn', 'kp', 'kr', 'kw', 'ky', 'kz',
  'la', 'lb', 'lc', 'li', 'lk', 'lr', 'ls', 'lt', 'lu', 'lv', 'ly',
  'ma', 'mc', 'md', 'me', 'mf', 'mg', 'mh', 'mk', 'ml', 'mm', 'mn', 'mo', 'mp', 'mq', 'mr', 'ms', 'mt', 'mu', 'mv', 'mw', 'mx', 'my', 'mz',
  'na', 'nc', 'ne', 'nf', 'ng', 'ni', 'nl', 'no', 'np', 'nr', 'nu', 'nz',
  'om',
  'pa', 'pe', 'pf', 'pg', 'ph', 'pk', 'pl', 'pm', 'pn', 'pr', 'ps', 'pt', 'pw', 'py',
  'qa',
  're', 'ro', 'rs', 'ru', 'rw',
  'sa', 'sb', 'sc', 'sd', 'se', 'sg', 'sh', 'si', 'sj', 'sk', 'sl', 'sm', 'sn', 'so', 'sr', 'ss', 'st', 'sv', 'sx', 'sy', 'sz',
  'tc', 'td', 'tf', 'tg', 'th', 'tj', 'tk', 'tl', 'tm', 'tn', 'to', 'tr', 'tt', 'tv', 'tw', 'tz',
  'ua', 'ug', 'um', 'us', 'uy', 'uz',
  'va', 'vc', 've', 'vg', 'vi', 'vn', 'vu',
  'wf', 'ws',
  'xk', 'ye', 'yt',
  'za', 'zm', 'zw', 'uk', 'eu'
]);

export function resolveConfiguredProxyUrl(templateUrl, location, { allowEmpty = true } = {}) {
  const rawTemplate = String(templateUrl ?? '').trim();
  if (!rawTemplate) {
    if (allowEmpty) return '';
    throw invalidProxyUrl('Configured browser proxy is unavailable.');
  }

  if (!rawTemplate.includes('%')) {
    return normalizeProxyUrl(rawTemplate, { allowEmpty });
  }

  const loc = String(location ?? '').trim().toLowerCase();
  const isValidLocation = ISO_COUNTRY_CODES.has(loc);

  let substituted;
  if (rawTemplate.includes('%-rotate')) {
    substituted = isValidLocation
      ? rawTemplate.replace(/%/g, loc)
      : rawTemplate.replace(/%-rotate/g, 'rotate');
  } else {
    substituted = rawTemplate.replace(/%/g, isValidLocation ? loc : 'rotate');
  }

  return normalizeProxyUrl(substituted, { allowEmpty: false });
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
