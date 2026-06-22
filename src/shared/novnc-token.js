import { hmac, safeEqual } from './crypto.js';

export function signNoVncToken({ sessionId, expiresAt, secret }) {
  const payload = Buffer.from(JSON.stringify({
    sid: sessionId,
    exp: new Date(expiresAt).getTime(),
  })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifyNoVncToken(token, secret) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return { ok: false, error: 'Malformed token' };
  if (!safeEqual(sig, hmac(secret, payload))) return { ok: false, error: 'Bad signature' };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Malformed payload' };
  }
  if (!parsed.sid || !Number.isFinite(Number(parsed.exp))) return { ok: false, error: 'Invalid payload' };
  if (Date.now() > Number(parsed.exp)) return { ok: false, error: 'Expired token' };
  return { ok: true, sessionId: parsed.sid, expiresAt: new Date(Number(parsed.exp)).toISOString() };
}
