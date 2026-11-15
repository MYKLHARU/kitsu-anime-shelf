// Authenticated JSON library API (mounted by the 2.0 application in v2-app.mjs).
// Caller MUST supply a session verifier that resolves a trusted user ID from the
// request. Never derive the user ID from URL parameters or JSON request bodies.
//
//   GET    /api/v2/library[?status=watching]   list entries with cached metadata
//   GET    /api/v2/library/:animeId            one entry (ETag = revision)
//   PATCH  /api/v2/library/:animeId            partial update; optional If-Match
//   DELETE /api/v2/library/:animeId            remove from library
import { LIBRARY_STATUSES, createLibraryEntry } from './library-model.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const ANIME_ID = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export function isAllowedOriginSetting(origin) {
  return typeof origin === 'string' && (/^https:\/\/[^/\s]+$/.test(origin) || LOCAL_ORIGIN.test(origin));
}

export function respond(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(JSON.stringify(payload));
}

export async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(type)) {
    const error = new Error('Content-Type must be application/json');
    error.status = 415;
    throw error;
  }
  if (Number(req.headers['content-length']) > maxBytes) {
    const error = new Error('Request body too large');
    error.status = 413;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); }
  catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('JSON object required');
    error.status = 400;
    throw error;
  }
  return body;
}

function parseIfMatch(header) {
  if (header === undefined) return undefined;
  const match = /^\s*(?:W\/)?"([1-9]\d{0,15})"\s*$/.exec(String(header));
  if (!match) {
    const error = new Error('If-Match must be a revision ETag');
    error.status = 400;
    throw error;
  }
  return Number(match[1]);
}

const etag = entry => (entry?.revision ? { ETag: `"${entry.revision}"` } : {});

export function createLibraryApiHandler({ library, authenticate, allowedOrigin, prepare, onChange, logger = console } = {}) {
  if (!library || typeof library.get !== 'function' || typeof library.save !== 'function') {
    throw new TypeError('Library service is required');
  }
  if (typeof authenticate !== 'function') throw new TypeError('Session authentication is required');
  if (!isAllowedOriginSetting(allowedOrigin)) {
    throw new TypeError('An exact HTTPS dashboard origin is required');
  }
  return async function handleLibraryApi(req, res) {
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      respond(res, 403, { error: 'Origin not allowed' });
      return;
    }
    // Do not enable cross-origin cookies. A dashboard must use same-site
    // requests or explicitly managed bearer authentication.
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      respond(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, PATCH, DELETE' });
      return;
    }
    const url = new URL(req.url, 'http://internal.invalid');
    const isList = url.pathname === '/api/v2/library';
    const match = /^\/api\/v2\/library\/([^/]+)$/.exec(url.pathname);
    let animeId;
    try { animeId = match && decodeURIComponent(match[1]); }
    catch { animeId = null; }
    if (isList ? method !== 'GET' : (!animeId || !ANIME_ID.test(animeId) || url.search)) {
      respond(res, isList ? 405 : 404, { error: isList ? 'Method not allowed' : 'Not found' });
      return;
    }
    try {
      const userId = await authenticate(req);
      if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) {
        respond(res, 401, { error: 'Authentication required' });
        return;
      }
      if (isList) {
        const status = url.searchParams.get('status') ?? undefined;
        if (status !== undefined && !LIBRARY_STATUSES.includes(status)) {
          respond(res, 400, { error: 'Unknown status filter' });
          return;
        }
        respond(res, 200, { entries: await library.list(userId, { status }) });
        return;
      }
      if (method === 'GET') {
        const entry = await library.get(userId, animeId);
        respond(res, entry ? 200 : 404, entry ?? { error: 'Entry not found' }, etag(entry));
        return;
      }
      // Authenticated browser requests must carry a valid Origin header;
      // reject missing Origin to reduce cross-site request forgery exposure.
      if (origin !== allowedOrigin) {
        respond(res, 403, { error: 'Origin required' });
        return;
      }
      if (req.method === 'DELETE') {
        const removed = await library.remove(userId, animeId);
        respond(res, removed ? 200 : 404, removed ? { removed: true } : { error: 'Entry not found' });
        if (removed) onChange?.(userId, animeId, null, null)?.catch?.(error => logger.error?.(`Library change hook failed: ${error.message}`));
        return;
      }
      const expectedRevision = parseIfMatch(req.headers['if-match']);
      const changes = await readJson(req);
      if (Object.hasOwn(changes, 'animeId')) {
        respond(res, 400, { error: 'animeId cannot be changed' });
        return;
      }
      // Validate the patch against the domain model before touching storage.
      const permitted = ['status', 'progress', 'score'];
      if (Object.keys(changes).some(key => !permitted.includes(key))) {
        respond(res, 400, { error: 'Unsupported library field' });
        return;
      }
      createLibraryEntry({ animeId, ...changes });
      const anime = prepare ? await prepare(animeId) : undefined;
      if (anime?.episodeCount && Number.isSafeInteger(changes.progress) && changes.progress > anime.episodeCount) {
        respond(res, 400, { error: `Progress cannot exceed ${anime.episodeCount} episodes` });
        return;
      }
      const entry = await library.save(userId, animeId, changes, expectedRevision === undefined ? {} : { expectedRevision });
      respond(res, 200, entry, etag(entry));
      onChange?.(userId, animeId, entry, changes)?.catch?.(error => logger.error?.(`Library change hook failed: ${error.message}`));
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        respond(res, 400, { error: 'Invalid library entry' });
      } else if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        respond(res, error.status, { error: error.message });
      } else {
        // Do not leak SQL or auth implementation errors.
        logger.error?.(`Library API error: ${error.message}`);
        respond(res, 500, { error: 'Internal error' });
      }
    }
  };
}
