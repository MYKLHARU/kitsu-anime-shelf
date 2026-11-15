// Security primitives for 2.0 accounts. No external dependencies.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

// ---- Tokens ----------------------------------------------------------------

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest();
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url.

// ---- Passwords (scrypt, OWASP-recommended parameters) ----------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function validatePassword(password, email = '') {
  if (typeof password !== 'string') return 'Enter a password.';
  const length = [...password].length;
  if (length < 10) return 'Use at least 10 characters.';
  if (length > 256) return 'Use 256 characters or fewer.';
  if (email && password.toLowerCase() === email.toLowerCase()) return 'Your password must differ from your email address.';
  if (/^(.)\1+$/.test(password)) return 'Choose a less predictable password.';
  return null;
}

export async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isSafeInteger) || N > 2 ** 20 || r > 32 || p > 16) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(parts[4], 'base64url'), expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function needsRehash(stored, params = SCRYPT) {
  const parts = String(stored).split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < params.N || Number(parts[2]) < params.r;
}

// A hash computed once, used to equalise timing for unknown accounts.
let dummyHash;
export async function dummyPasswordCheck(password) {
  dummyHash ??= await hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(typeof password === 'string' ? password : '', dummyHash);
  return false;
}

// ---- Symmetric encryption for third-party tokens (AES-256-GCM) -------------

export function parseEncryptionKey(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('TOKEN_ENCRYPTION_KEY is required');
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new TypeError('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)');
  return key;
}

export function createTokenCipher(key) {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return {
    encrypt(plaintext, context = '') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return ['v1', keyId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    },
    decrypt(value, context = '') {
      const [version, id, iv, tag, data] = String(value).split('.');
      if (version !== 'v1' || id !== keyId) throw new Error('Token was encrypted with a different key');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    }
  };
}

// ---- Cookies ---------------------------------------------------------------

export function parseCookies(header = '') {
  const cookies = {};
  for (const raw of String(header).split(';')) {
    const part = raw.trim();
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!Object.hasOwn(cookies, name)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge, secure = true, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ---- Client IP and rate limiting -------------------------------------------

// trustProxyHops: number of reverse proxies in front of the service that
// append to X-Forwarded-For (Northflank, Render: 1). 0 ignores the header.
export function clientIp(request, trustProxyHops = 0) {
  const socketIp = request.socket?.remoteAddress || 'unknown';
  if (!trustProxyHops) return socketIp;
  const chain = String(request.headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(Boolean);
  return chain[chain.length - trustProxyHops] || socketIp;
}

export function createRateLimiter({ now = Date.now, maxKeys = 50000 } = {}) {
  const buckets = new Map();
  return {
    // Fixed window counter. Returns { allowed, retryAfter } in seconds.
    hit(key, limit, windowMs) {
      const time = now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.reset <= time) {
        bucket = { count: 0, reset: time + windowMs };
        buckets.delete(key);
        if (buckets.size >= maxKeys) {
          // Drop expired windows first; only evict live ones as a last resort.
          for (const [name, value] of buckets) if (value.reset <= time) buckets.delete(name);
          while (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        }
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return { allowed: bucket.count <= limit, retryAfter: Math.ceil((bucket.reset - time) / 1000) };
    },
    reset(key) { buckets.delete(key); },
    get size() { return buckets.size; }
  };
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export const hasControlCharacters = value => typeof value === 'string' && CONTROL.test(value);

// Optional short text such as a display name or device label.
export function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || hasControlCharacters(value)) return undefined;
  return value.trim().slice(0, maxLength) || null;
}

export function normalizeEmail(value) {
  if (typeof value !== 'string' || hasControlCharacters(value)) return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
