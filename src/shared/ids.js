import crypto from 'node:crypto';

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function nowIso() {
  return new Date().toISOString();
}

export function isoAfterMs(ms) {
  return new Date(Date.now() + ms).toISOString();
}

export function isTerminalStatus(status) {
  return ['completed', 'failed', 'aborted', 'stopped', 'destroyed'].includes(status);
}
