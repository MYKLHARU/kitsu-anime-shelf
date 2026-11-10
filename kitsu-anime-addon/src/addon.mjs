import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { ApiError, CATALOGS, createKitsuService } from './kitsu.mjs';

export const manifest = {
  id: 'personal.kitsu.anime.shelf',
  version: '1.1.0',
  name: 'Kitsu Anime Shelf',
  description: 'Anime discovery from Kitsu.app with 40 main category catalogs, plus popular, top rated, currently airing, films, and search.',
  types: ['anime', 'series'],
  resources: [
    { name: 'catalog', types: ['anime'] },
    { name: 'meta', types: ['series'], idPrefixes: ['kitsu:'] }
  ],
  idPrefixes: ['kitsu:'],
  catalogs: Object.entries(CATALOGS).map(([id, definition]) => ({
    id,
    type: 'anime',
    name: definition.name,
    extra: [
      ...(definition.searchOnly ? [{ name: 'search', isRequired: true }] : []),
      { name: 'skip' }
    ]
  })),
  behaviorHints: { adult: false, p2p: false }
};

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/configure', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/logo.svg', ['logo.svg', 'image/svg+xml']]
]);

function json(response, status, value, cache = 0) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache ? `public, max-age=${cache}, stale-if-error=3600` : 'no-store'
  });
  response.end(JSON.stringify(value));
}

function parseExtra(raw, url) {
  const extra = {};
  if (raw) {
    // Split before decoding so an encoded '&' stays inside a search value.
    for (const part of raw.split('&')) {
      const separator = part.indexOf('=');
      if (separator < 0) throw new ApiError('Invalid catalog filters.', 400);
      const key = decodeURIComponent(part.slice(0, separator));
      if (!['search', 'skip'].includes(key)) throw new ApiError('Unknown catalog filter.', 400);
      extra[key] = decodeURIComponent(part.slice(separator + 1));
    }
  }
  for (const key of ['search', 'skip']) if (url.searchParams.has(key)) extra[key] = url.searchParams.get(key);
  return extra;
}

export function createAddonServer({ service = createKitsuService(), logger = console } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD, OPTIONS');
      json(response, 405, { error: 'Method not allowed.' });
      return;
    }
    try {
      if (request.url.length > 4096) throw new ApiError('URL is too long.', 414);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        const contents = await readFile(new URL(`../public/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        response.end(contents);
        return;
      }
      if (url.pathname === '/health') { json(response, 200, { status: 'ok', name: manifest.name }); return; }
      if (url.pathname === '/manifest.json') { json(response, 200, manifest, 300); return; }
      const catalog = /^\/catalog\/anime\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(url.pathname);
      if (catalog) {
        const result = await service.catalog(decodeURIComponent(catalog[1]), parseExtra(catalog[2], url));
        json(response, 200, result, 900);
        return;
      }
      const meta = /^\/meta\/series\/([^/]+)\.json$/.exec(url.pathname);
      if (meta) {
        json(response, 200, await service.metadata(decodeURIComponent(meta[1])), 3600);
        return;
      }
      json(response, 404, { error: 'Resource not found.' });
    } catch (error) {
      const status = error instanceof URIError ? 400 : error.status || 500;
      if (status >= 500) logger.error(`${new Date().toISOString()} ${error.message}`);
      json(response, status, { error: status === 500 ? 'An unexpected error occurred.' : error.message });
    }
  });
}
