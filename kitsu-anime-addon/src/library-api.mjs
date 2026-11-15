// Optional authenticated JSON API handler. Not mounted by the public Stremio server.
// Caller MUST supply a session verifier that resolves a trusted user ID from the
// request. Never derive the user ID from URL parameters or JSON request bodies.
import { createLibraryEntry } from './library-model.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const ANIME_ID = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function respond(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(type)) {
    const error = new Error('Content-Type must be application/json');
    error.status = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
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

export function createLibraryApiHandler({ library, authenticate, allowedOrigin } = {}) {
  if (!library || typeof library.get !== 'function' || typeof library.save !== 'function') {
    throw new TypeError('Library service is required');
  }
  if (typeof authenticate !== 'function') throw new TypeError('Session authentication is required');
  if (typeof allowedOrigin !== 'string' || !/^https:\/\/[^/]+$/.test(allowedOrigin)) {
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
    if (req.method !== 'GET' && req.method !== 'PATCH') {
      respond(res, 405, { error: 'Method not allowed' });
      return;
    }
    const url = new URL(req.url, 'http://internal.invalid');
    const match = /^\/api\/v2\/library\/([^/]+)$/.exec(url.pathname);
    let animeId;
    try { animeId = match && decodeURIComponent(match[1]); }
    catch { animeId = null; }
    if (!animeId || !ANIME_ID.test(animeId) || url.search) {
      respond(res, 404, { error: 'Not found' });
      return;
    }
    try {
      const userId = await authenticate(req);
      if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) {
        respond(res, 401, { error: 'Authentication required' });
        return;
      }
      if (req.method === 'GET') {
        const entry = await library.get(userId, animeId);
        respond(res, entry ? 200 : 404, entry ?? { error: 'Entry not found' });
        return;
      }
      // Authenticated browser requests must carry a valid Origin header;
      // reject missing Origin to reduce cross-site request forgery exposure.
      if (origin !== allowedOrigin) {
        respond(res, 403, { error: 'Origin required' });
        return;
      }
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
      const entry = await library.save(userId, animeId, changes);
      respond(res, 200, entry);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        respond(res, 400, { error: 'Invalid library entry' });
      } else if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        respond(res, error.status, { error: error.message });
      } else {
        // Do not leak SQL or auth implementation errors.
        respond(res, 500, { error: 'Internal error' });
      }
    }
  };
}
