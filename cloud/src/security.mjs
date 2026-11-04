import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function safeEqual(a, b) {
  const left = Buffer.from(a || ''); const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyPassword(value, encoded) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const [salt, hash] = (encoded || '').split(':');
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hash || '')) return false;
  return safeEqual(scryptSync(value, salt, 64).toString('hex'), hash);
}
function encryptionKey(hex) {
  if (!/^[a-f0-9]{64}$/i.test(hex || '')) throw new Error('Missing valid cloud encryption key');
  return Buffer.from(hex, 'hex');
}
// Matches the existing local FreeLLMAPI AES-256-GCM field format. Cloud uses a NEW key.
export function encrypt(secret, key) {
  const iv = randomBytes(16); const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]).toString('hex');
  return { encrypted, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}
export function decrypt(secret, key) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), Buffer.from(secret.iv, 'hex'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(secret.authTag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(secret.encrypted, 'hex')), decipher.final()]).toString('utf8');
}
export function signSession(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + 12 * 3600000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function validSession(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 512) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  if (!safeEqual(signature, createHmac('sha256', secret).update(payload).digest('base64url'))) return false;
  try { const { exp } = JSON.parse(Buffer.from(payload, 'base64url')); return Number.isFinite(exp) && exp > now && exp <= now + 12 * 3600000; }
  catch { return false; }
}
export function cookieToken(req) {
  return String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('__Host-freellmapi='))?.slice('__Host-freellmapi='.length);
}
export function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}
