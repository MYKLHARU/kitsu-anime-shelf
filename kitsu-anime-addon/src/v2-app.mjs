// Kitsu Anime Shelf 2.0 application: accounts, library, AniList, recommendations,
// personal Stremio catalogs and the dashboard. Mounted in front of the public
// add-on by createAddonServer; every other path is left to the public add-on.
//
// Security model (see docs/SECURITY-2.0.md):
// - Opaque 256-bit session tokens in an HttpOnly, SameSite=Lax cookie
//   (__Host- prefixed over HTTPS); only SHA-256 hashes are stored.
// - Every state-changing request must come from the dashboard origin (Origin
//   header, and Sec-Fetch-Site when sent) and carry a JSON content type.
// - The user ID comes only from the verified session.
// - Per-IP and per-account rate limits; security events are audit-logged.
import { readFile } from 'node:fs/promises';
import { createLibraryApiHandler, readJson, respond } from './library-api.mjs';
import { createPersonalAddon } from './personal-addon.mjs';
import {
  cleanText, clientIp, createRateLimiter, dummyPasswordCheck, hashPassword, needsRehash, normalizeEmail, parseCookies,
  randomToken, serializeCookie, sha256, TOKEN_PATTERN, validatePassword, verifyPassword
} from './security.mjs';
import { SESSION_ABSOLUTE_MS } from './account-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KITSU_ID = /^kitsu:([1-9]\d{0,9})$/;
const DASHBOARD_ASSETS = new Map([
  ['/dashboard', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard/app.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard/app.css', ['dashboard.css', 'text/css; charset=utf-8']]
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; manifest-src 'self'";

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

export function createV2App({
  accounts, library, animeStore, recommender, anilist, anilistSync, cipher, service, artwork,
  publicUrl, version, trustProxyHops = 0, registrationOpen = true, rateLimiter = createRateLimiter(),
  // Credential-related limits live in their own store so that floods of other
  // keys can never evict them.
  authLimiter = createRateLimiter({ maxKeys: 200000 }),
  logger = console, publicDir = new URL('../public/', import.meta.url)
}) {
  const origin = new URL(publicUrl).origin;
  const secure = origin.startsWith('https://');
  const cookieName = secure ? '__Host-kas_session' : 'kas_session';
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {})
  };

  const sessionFor = new WeakMap();
  async function session(request) {
    if (sessionFor.has(request)) return sessionFor.get(request);
    const token = parseCookies(request.headers.cookie)[cookieName];
    const found = token && TOKEN_PATTERN.test(token) ? await accounts.findSession(sha256(token)) : null;
    const value = found ? { ...found, tokenHash: sha256(token) } : null;
    sessionFor.set(request, value);
    return value;
  }
  const authenticate = async request => (await session(request))?.user_id ?? null;
  async function requireUser(request) {
    const current = await session(request);
    if (!current) throw new HttpError(401, 'Sign in to continue.');
    return current;
  }

  function limit(key, max, windowMs, message = 'Too many attempts. Try again later.', store = rateLimiter) {
    const result = store.hit(key, max, windowMs);
    if (!result.allowed) throw new HttpError(429, message, { 'Retry-After': String(result.retryAfter) });
  }

  // Cross-site request forgery defence for every non-GET API request.
  function assertSameOrigin(request) {
    if (request.headers.origin !== origin) throw new HttpError(403, 'Origin not allowed');
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') throw new HttpError(403, 'Cross-site request blocked');
  }

  function setSessionCookie(response, token, maxAgeMs) {
    response.setHeader('Set-Cookie', serializeCookie(cookieName, token, { maxAge: maxAgeMs / 1000, secure }));
  }
  function clearSessionCookie(response) {
    response.setHeader('Set-Cookie', serializeCookie(cookieName, '', { maxAge: 0, secure }));
  }
  async function startSession(response, userId, request) {
    const token = randomToken();
    await accounts.createSession(userId, sha256(token), request.headers['user-agent']);
    // The browser may keep the cookie for the absolute lifetime; the server
    // enforces the shorter idle expiry on every request.
    setSessionCookie(response, token, SESSION_ABSOLUTE_MS);
  }
  const audit = (request, userId, action, detail) =>
    accounts.audit(userId, action, clientIp(request, trustProxyHops), detail).catch(error => logger.error?.(`Audit failed: ${error.message}`));

  // Canonical anime records are created only for Kitsu IDs that Kitsu confirms.
  async function prepare(animeId) {
    const kitsuId = KITSU_ID.exec(animeId)?.[1];
    if (!kitsuId) throw new HttpError(400, 'Only Kitsu anime IDs (kitsu:<number>) can be added.');
    const ids = await animeStore.ensureKitsu([kitsuId]);
    if (!ids.has(kitsuId)) throw new HttpError(404, 'Anime not found on Kitsu.');
    return animeStore.get(kitsuId);
  }

  const libraryHandler = createLibraryApiHandler({
    library, authenticate, allowedOrigin: origin, prepare, logger,
    onChange: async (userId, animeId, entry, changes) => {
      recommender.invalidate(userId);
      if (anilistSync) await anilistSync.pushChange(userId, animeId, entry, changes);
    }
  });

  const personal = createPersonalAddon({ accounts, library, recommender, service, artwork, version,
    logo: `${origin}/logo.png`, rateLimiter, clientIp: request => clientIp(request, trustProxyHops), logger });

  let proxyWarningShown = false;
  function warnAboutProxy(request) {
    if (proxyWarningShown || trustProxyHops || !request.headers['x-forwarded-for']) return;
    proxyWarningShown = true;
    logger.error?.('Requests arrive through a proxy but TRUST_PROXY_HOPS is 0, so all clients share one rate-limit address. Set TRUST_PROXY_HOPS=1 on Northflank or Render.');
  }

  function publicUser(current) {
    return { id: current.user_id ?? current.id, email: current.email, displayName: current.display_name ?? null };
  }

  async function connectionSummary(userId) {
    if (!anilist) return { available: false };
    const connection = await accounts.getConnection(userId, 'anilist');
    if (!connection) return { available: true, connected: false };
    return {
      available: true, connected: true, username: connection.external_username, connectedAt: connection.connected_at,
      lastSyncedAt: connection.last_synced_at, syncStatus: connection.sync_status, syncResult: connection.sync_result,
      autoPush: connection.auto_push, tokenExpiresAt: connection.token_expires_at
    };
  }

  // ---- Route handlers -------------------------------------------------------
  const routes = {
    'GET /api/v2/config': async () => ({ accounts: true, registrationOpen, anilist: Boolean(anilist), version }),

    'POST /api/v2/auth/register': async (request, response, ip) => {
      if (!registrationOpen) throw new HttpError(403, 'New registrations are closed on this server.');
      limit(`register:${ip}`, 5, 3600000, undefined, authLimiter);
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(400, 'Enter a valid email address.');
      const problem = validatePassword(body.password, email);
      if (problem) throw new HttpError(400, problem);
      const displayName = cleanText(body.displayName, 60);
      if (displayName === undefined) throw new HttpError(400, 'Enter a name without control characters.');
      const user = await accounts.createUser({ email, passwordHash: await hashPassword(body.password), displayName });
      await startSession(response, user.id, request);
      audit(request, user.id, 'account.created');
      return [201, { user: publicUser(user) }];
    },

    'POST /api/v2/auth/login': async (request, response, ip) => {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      limit(`login-ip:${ip}`, 30, 900000, undefined, authLimiter);
      limit(`login:${ip}:${email}`, 10, 900000, undefined, authLimiter);
      const user = email ? await accounts.findUserByEmail(email) : null;
      const valid = user ? await verifyPassword(body.password, user.password_hash) : await dummyPasswordCheck(body.password);
      if (!valid) {
        if (user) audit(request, user.id, 'login.failed');
        throw new HttpError(401, 'Email or password is incorrect.');
      }
      if (needsRehash(user.password_hash)) await accounts.rehashPassword(user.id, await hashPassword(body.password));
      await startSession(response, user.id, request);
      authLimiter.reset(`login:${ip}:${email}`);
      audit(request, user.id, 'login.succeeded');
      return { user: publicUser(user) };
    },

    'POST /api/v2/auth/logout': async (request, response) => {
      const current = await session(request);
      if (current) await accounts.deleteSession(current.tokenHash);
      clearSessionCookie(response);
      return { signedOut: true };
    },

    'GET /api/v2/me': async request => {
      const current = await requireUser(request);
      return { user: publicUser(current), anilist: await connectionSummary(current.user_id) };
    },

    'PATCH /api/v2/me': async request => {
      const current = await requireUser(request);
      const body = await readJson(request);
      if (Object.keys(body).some(key => key !== 'displayName')) throw new HttpError(400, 'Unsupported profile field.');
      const displayName = cleanText(body.displayName, 60);
      if (displayName === undefined) throw new HttpError(400, 'displayName must be text without control characters, or null.');
      return { user: publicUser(await accounts.updateProfile(current.user_id, { displayName })) };
    },

    'POST /api/v2/me/password': async request => {
      const current = await requireUser(request);
      limit(`password:${current.user_id}`, 5, 900000, undefined, authLimiter);
      const body = await readJson(request);
      const user = await accounts.getUser(current.user_id);
      if (!await verifyPassword(body.currentPassword, user.password_hash)) {
        audit(request, current.user_id, 'password.change_failed');
        throw new HttpError(403, 'Your current password is incorrect.');
      }
      const problem = validatePassword(body.newPassword, user.email);
      if (problem) throw new HttpError(400, problem);
      await accounts.updatePassword(current.user_id, await hashPassword(body.newPassword), current.tokenHash);
      audit(request, current.user_id, 'password.changed');
      return { changed: true, otherSessionsSignedOut: true };
    },

    'GET /api/v2/me/sessions': async request => {
      const current = await requireUser(request);
      return { sessions: await accounts.listSessions(current.user_id) };
    },

    'POST /api/v2/me/sessions/revoke-others': async request => {
      const current = await requireUser(request);
      const count = await accounts.deleteOtherSessions(current.user_id, current.tokenHash);
      audit(request, current.user_id, 'sessions.revoked', { count });
      return { revoked: count };
    },

    'GET /api/v2/me/export': async (request, response) => {
      const current = await requireUser(request);
      limit(`export:${current.user_id}`, 10, 3600000);
      const data = await accounts.exportUser(current.user_id);
      audit(request, current.user_id, 'data.exported');
      response.setHeader('Content-Disposition', 'attachment; filename="kitsu-anime-shelf-export.json"');
      return data;
    },

    'POST /api/v2/me/delete': async (request, response) => {
      const current = await requireUser(request);
      limit(`delete:${current.user_id}`, 5, 900000, undefined, authLimiter);
      const body = await readJson(request);
      const user = await accounts.getUser(current.user_id);
      if (!await verifyPassword(body.password, user.password_hash)) throw new HttpError(403, 'Your password is incorrect.');
      audit(request, current.user_id, 'account.deleted');
      await accounts.deleteUser(current.user_id);
      recommender.invalidate(current.user_id);
      clearSessionCookie(response);
      return { deleted: true };
    },

    'GET /api/v2/recommendations': async request => {
      const current = await requireUser(request);
      limit(`recs:${current.user_id}`, 30, 60000);
      const entries = await library.list(current.user_id);
      return { metas: await recommender.recommend(current.user_id, entries, { limit: 40 }) };
    },

    'GET /api/v2/stremio/tokens': async request => {
      const current = await requireUser(request);
      return { tokens: await accounts.listInstallTokens(current.user_id) };
    },

    'POST /api/v2/stremio/tokens': async request => {
      const current = await requireUser(request);
      limit(`tokens:${current.user_id}`, 20, 3600000);
      const body = await readJson(request);
      const cleaned = cleanText(body.label, 60);
      if (cleaned === undefined) throw new HttpError(400, 'Enter a device name without control characters.');
      const label = cleaned ?? 'Stremio';
      const token = randomToken();
      const created = await accounts.createInstallToken(current.user_id, sha256(token), label);
      audit(request, current.user_id, 'install_token.created', { id: created.id });
      const manifestUrl = `${origin}/u/${token}/manifest.json`;
      // The token is shown once; only its hash is stored.
      return [201, { ...created, manifestUrl, installUrl: manifestUrl.replace(/^https?:/, 'stremio:') }];
    },

    'POST /api/v2/anilist/connect': async request => {
      const current = await requireUser(request);
      if (!anilist) throw new HttpError(404, 'AniList is not configured on this server.');
      limit(`anilist-connect:${current.user_id}`, 10, 3600000);
      const state = randomToken();
      await accounts.createOAuthState(current.user_id, 'anilist', sha256(state));
      return { url: anilist.authorizeUrl(state) };
    },

    'GET /api/v2/anilist/status': async request => (await connectionSummary((await requireUser(request)).user_id)),

    'PATCH /api/v2/anilist/settings': async request => {
      const current = await requireUser(request);
      const body = await readJson(request);
      if (typeof body.autoPush !== 'boolean' || Object.keys(body).length !== 1) throw new HttpError(400, 'Send { "autoPush": true|false }.');
      if (!await accounts.setAutoPush(current.user_id, 'anilist', body.autoPush)) throw new HttpError(404, 'AniList is not connected.');
      return connectionSummary(current.user_id);
    },

    'POST /api/v2/anilist/sync': async request => {
      const current = await requireUser(request);
      if (!anilistSync) throw new HttpError(404, 'AniList is not configured on this server.');
      limit(`anilist-sync:${current.user_id}`, 6, 3600000, 'You can sync up to six times an hour.');
      const connection = await accounts.getConnection(current.user_id, 'anilist');
      if (!connection) throw new HttpError(404, 'AniList is not connected.');
      anilistSync.start(current.user_id);
      return [202, { started: true }];
    },

    'DELETE /api/v2/anilist': async request => {
      const current = await requireUser(request);
      const removed = await accounts.deleteConnection(current.user_id, 'anilist');
      if (removed) audit(request, current.user_id, 'anilist.disconnected');
      return { disconnected: removed };
    }
  };

  // OAuth redirect target: a top-level GET navigation from AniList.
  async function anilistCallback(request, response, url, ip) {
    const redirect = (outcome) => {
      response.writeHead(303, { ...securityHeaders, Location: `/dashboard?anilist=${outcome}`, 'Cache-Control': 'no-store' });
      response.end();
    };
    if (!anilist) return redirect('unavailable');
    limit(`anilist-callback:${ip}`, 20, 600000);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !TOKEN_PATTERN.test(state)) return redirect('invalid');
    const stored = await accounts.consumeOAuthState(sha256(state), 'anilist');
    const current = await session(request);
    // The state must be fresh and belong to the user who started the flow.
    if (!stored?.valid || !current || stored.user_id !== current.user_id) return redirect('invalid');
    if (!code) return redirect('denied');
    try {
      const { accessToken, expiresAt } = await anilist.exchangeCode(code);
      const viewer = await anilist.viewer(accessToken);
      await accounts.saveConnection(current.user_id, {
        provider: 'anilist', externalUserId: viewer.id, externalUsername: viewer.name,
        accessTokenEnc: cipher.encrypt(accessToken, `anilist:${current.user_id}`), tokenExpiresAt: expiresAt
      });
      audit(request, current.user_id, 'anilist.connected', { anilistUser: viewer.id });
      anilistSync.start(current.user_id);
      return redirect('connected');
    } catch (error) {
      logger.error?.(`AniList connection failed: ${error.message}`);
      return redirect(error.status === 409 ? 'in-use' : 'failed');
    }
  }

  async function serveAsset(request, response, file, contentType) {
    const contents = await readFile(new URL(file, publicDir));
    response.writeHead(200, { ...securityHeaders, 'Content-Type': contentType, 'Cache-Control': 'no-cache',
      ...(contentType.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}) });
    response.end(request.method === 'HEAD' ? undefined : contents);
  }

  // Returns true when the request was handled by the 2.0 application.
  return async function handle(request, response) {
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { return false; }
    const path = url.pathname;
    warnAboutProxy(request);
    if (path.startsWith('/u/')) return personal(request, response, url);
    if (DASHBOARD_ASSETS.has(path)) {
      if (!['GET', 'HEAD'].includes(request.method)) return false;
      const [file, type] = DASHBOARD_ASSETS.get(path);
      await serveAsset(request, response, file, type);
      return true;
    }
    if (!path.startsWith('/api/v2/')) return false;

    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const ip = clientIp(request, trustProxyHops);
    try {
      if (request.url.length > 4096) throw new HttpError(414, 'URL is too long.');
      limit(`api:${ip}`, 600, 60000, 'Too many requests. Slow down.');
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (unsafe) assertSameOrigin(request);
      else if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, 'Origin not allowed');
      if (request.method === 'OPTIONS') { response.writeHead(204, { Allow: 'GET, POST, PATCH, DELETE' }); response.end(); return true; }

      if (path === '/api/v2/library' || path.startsWith('/api/v2/library/')) {
        const current = await session(request);
        if (current) limit(`writes:${current.user_id}`, unsafe ? 240 : 100000, 60000, 'Too many changes. Slow down.');
        await libraryHandler(request, response);
        return true;
      }
      if (path === '/api/v2/anilist/callback' && request.method === 'GET') {
        await anilistCallback(request, response, url, ip);
        return true;
      }
      const tokenRoute = /^\/api\/v2\/stremio\/tokens\/([^/]+)$/.exec(path);
      if (tokenRoute && request.method === 'DELETE') {
        const current = await requireUser(request);
        if (!UUID.test(tokenRoute[1])) throw new HttpError(404, 'Install link not found.');
        if (!await accounts.revokeInstallToken(current.user_id, tokenRoute[1])) throw new HttpError(404, 'Install link not found.');
        audit(request, current.user_id, 'install_token.revoked', { id: tokenRoute[1] });
        respond(response, 200, { revoked: true });
        return true;
      }
      const route = routes[`${request.method === 'HEAD' ? 'GET' : request.method} ${path}`];
      if (!route) {
        const exists = Object.keys(routes).some(key => key.endsWith(` ${path}`));
        throw new HttpError(exists ? 405 : 404, exists ? 'Method not allowed.' : 'Not found.');
      }
      const result = await route(request, response, ip);
      const [status, body] = Array.isArray(result) ? result : [200, result];
      respond(response, status, body);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) logger.error?.(`API error on ${request.method} ${path}: ${error.message}`);
      if (status === 401 && (await session(request).catch(() => null)) === null) clearSessionCookie(response);
      if (!response.headersSent) respond(response, status, { error: status === 500 ? 'An unexpected error occurred.' : error.message }, error.headers);
    }
    return true;
  };
}
