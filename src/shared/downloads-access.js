import { createHmac, timingSafeEqual } from 'node:crypto';

export const DOWNLOADS_USERNAME = 'webbrain';
export const DOWNLOADS_PATH_PREFIX = '/downloads';
export const DOWNLOADS_PROXY_TIMESTAMP_HEADER = 'x-webbrain-downloads-timestamp';
export const DOWNLOADS_PROXY_SIGNATURE_HEADER = 'x-webbrain-downloads-signature';
export const DOWNLOADS_UPLOAD_TARGET_HEADER = 'x-webbrain-upload-target';
export const DOWNLOADS_UPLOAD_TARGET_BROWSER = 'browser';
export const DEFAULT_DOWNLOADS_SIGNATURE_MAX_AGE_MS = 30_000;
export const DEFAULT_DOWNLOADS_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

const PASSWORD_CONTEXT = 'webbrain-downloads-basic-auth-v1';
const SIGNATURE_CONTEXT = 'webbrain-downloads-proxy-v1';

export function downloadsAccessPassword(secret) {
  requireSecret(secret);
  return createHmac('sha256', String(secret))
    .update(PASSWORD_CONTEXT)
    .digest('base64url');
}

export function downloadsAccessCredentials(secret) {
  return {
    username: DOWNLOADS_USERNAME,
    password: downloadsAccessPassword(secret),
  };
}

export function isDownloadsRequestPath(value) {
  let pathname;
  try {
    pathname = new URL(String(value || '/'), 'http://127.0.0.1').pathname;
  } catch {
    return false;
  }
  return pathname === DOWNLOADS_PATH_PREFIX || pathname.startsWith(`${DOWNLOADS_PATH_PREFIX}/`);
}

export function verifyDownloadsBasicAuthorization(header, secret) {
  const expected = downloadsAccessCredentials(secret);
  const parsed = parseBasicAuthorization(header);
  return Boolean(parsed
    && safeEqual(parsed.username, expected.username)
    && safeEqual(parsed.password, expected.password));
}

export function signDownloadsProxyRequest(secret, {
  timestamp = Date.now(),
  method = 'GET',
  path = '/',
} = {}) {
  requireSecret(secret);
  const normalizedTimestamp = String(timestamp);
  return {
    timestamp: normalizedTimestamp,
    signature: createHmac('sha256', String(secret))
      .update(canonicalProxyRequest(normalizedTimestamp, method, path))
      .digest('base64url'),
  };
}

export function verifyDownloadsProxyRequest(secret, {
  timestamp,
  signature,
  method = 'GET',
  path = '/',
  now = Date.now(),
  maxAgeMs = DEFAULT_DOWNLOADS_SIGNATURE_MAX_AGE_MS,
} = {}) {
  requireSecret(secret);
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || !signature) return false;
  const age = Number(now) - numericTimestamp;
  if (age < -5_000 || age > Number(maxAgeMs)) return false;
  const expected = signDownloadsProxyRequest(secret, { timestamp: String(timestamp), method, path });
  return safeEqual(String(signature), expected.signature);
}

function parseBasicAuthorization(header) {
  const match = /^Basic\s+([^\s]+)$/i.exec(String(header || ''));
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function canonicalProxyRequest(timestamp, method, path) {
  return [SIGNATURE_CONTEXT, timestamp, String(method || 'GET').toUpperCase(), String(path || '/')].join('\n');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSecret(secret) {
  if (!secret) throw new Error('Downloads access requires a session secret.');
}
