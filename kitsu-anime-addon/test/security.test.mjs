import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText, clientIp, createRateLimiter, createTokenCipher, hashPassword, needsRehash, normalizeEmail, parseCookies,
  parseEncryptionKey, serializeCookie, validatePassword, verifyPassword, randomToken, TOKEN_PATTERN
} from '../src/security.mjs';

test('passwords are salted scrypt hashes verified in constant time', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(hash, await hashPassword('correct horse battery'), 'unique salt');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterY', hash), false);
  assert.equal(await verifyPassword(undefined, hash), false);
  assert.equal(await verifyPassword('x', 'plaintext'), false);
  assert.equal(await verifyPassword('x', 'scrypt$999999999$8$1$a$b'), false, 'refuses absurd cost parameters');
  assert.equal(needsRehash(hash), false);
  assert.equal(needsRehash(await hashPassword('pw', { N: 1024, r: 8, p: 1, keyLength: 32 })), true);
});

test('password policy', () => {
  assert.match(validatePassword('short'), /10 characters/);
  assert.match(validatePassword('a'.repeat(257)), /256/);
  assert.match(validatePassword('aaaaaaaaaaaa'), /predictable/);
  assert.match(validatePassword('me@example.com', 'ME@example.com'), /differ/);
  assert.equal(validatePassword('a long passphrase'), null);
  assert.equal(validatePassword('pässwörd-ünïcode'), null);
});

test('third-party tokens use authenticated encryption bound to their owner', () => {
  const key = parseEncryptionKey('ab'.repeat(32));
  assert.equal(parseEncryptionKey(Buffer.alloc(32, 7).toString('base64')).length, 32);
  assert.throws(() => parseEncryptionKey('too-short'), TypeError);
  const cipher = createTokenCipher(key);
  const sealed = cipher.encrypt('secret-token', 'anilist:user-a');
  assert.ok(!sealed.includes('secret-token'));
  assert.notEqual(sealed, cipher.encrypt('secret-token', 'anilist:user-a'), 'random IV');
  assert.equal(cipher.decrypt(sealed, 'anilist:user-a'), 'secret-token');
  assert.throws(() => cipher.decrypt(sealed, 'anilist:user-b'), 'cannot be replayed for another user');
  const parts = sealed.split('.');
  parts[4] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => cipher.decrypt(parts.join('.'), 'anilist:user-a'));
  assert.throws(() => createTokenCipher(parseEncryptionKey('cd'.repeat(32))).decrypt(sealed, 'anilist:user-a'), /different key/);
});

test('cookies, tokens and emails', () => {
  assert.match(randomToken(), TOKEN_PATTERN);
  assert.deepEqual(parseCookies('a=1; b=2; a=3; junk; =x'), { a: '1', b: '2' });
  assert.equal(serializeCookie('__Host-s', 'v', { maxAge: 60 }), '__Host-s=v; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure');
  assert.equal(serializeCookie('s', '', { maxAge: 0, secure: false }), 's=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly');
  assert.equal(normalizeEmail('  Mixed@Example.COM '), 'mixed@example.com');
  for (const bad of ['', 'no-at', 'a@b', 'a b@c.d', null, 42, `${'a'.repeat(250)}@x.io`]) assert.equal(normalizeEmail(bad), null);
});

test('client IP honours only the configured number of proxies', () => {
  const request = { socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' } };
  assert.equal(clientIp(request, 0), '10.0.0.5', 'header ignored without trusted proxies');
  assert.equal(clientIp(request, 1), '198.51.100.7', 'spoofed left-most value ignored');
  assert.equal(clientIp(request, 2), '6.6.6.6');
  assert.equal(clientIp({ ...request, headers: {} }, 1), '10.0.0.5');
});

test('fixed-window rate limiter', () => {
  let time = 0;
  const limiter = createRateLimiter({ now: () => time, maxKeys: 3 });
  assert.equal(limiter.hit('k', 2, 1000).allowed, true);
  assert.equal(limiter.hit('k', 2, 1000).allowed, true);
  const blocked = limiter.hit('k', 2, 1000);
  assert.deepEqual(blocked, { allowed: false, retryAfter: 1 });
  time = 1000;
  assert.equal(limiter.hit('k', 2, 1000).allowed, true, 'window resets');
  limiter.reset('k');
  for (const key of ['a', 'b', 'c', 'd']) limiter.hit(key, 1, 1000);
  assert.equal(limiter.size, 3, 'memory is bounded');
});

test('limiter evicts expired windows before live ones', () => {
  let time = 0;
  const limiter = createRateLimiter({ now: () => time, maxKeys: 2 });
  limiter.hit('login', 1, 100000);
  limiter.hit('login', 1, 100000);
  limiter.hit('short', 1, 10);
  time = 50;
  limiter.hit('new', 1, 10);
  assert.equal(limiter.hit('login', 1, 100000).allowed, false, 'live security window survives');
});

test('control characters are rejected in text fields', () => {
  assert.equal(cleanText('  Haru  ', 60), 'Haru');
  assert.equal(cleanText('', 60), null);
  assert.equal(cleanText(null, 60), null);
  assert.equal(cleanText('a\u0000b', 60), undefined);
  assert.equal(cleanText(5, 60), undefined);
  assert.equal(normalizeEmail('a\u0000@example.com'), null);
});
