import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { ApiError, CATALOGS, createApiClient, createKitsuService } from './kitsu.mjs';
import { createArtworkService } from './artwork.mjs';
import { createAnimeMappingLoader } from './anime-mappings.mjs';
import { createSeasonGroups } from './season-groups.mjs';

export const manifest = {
  id: 'personal.kitsu.anime.shelf',
  version: '1.4.1',
  name: 'Kitsu Anime Shelf',
  logo: 'https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/logo.png',
  description: 'Anime discovery from Kitsu.app with grouped TV seasons, 40 main category catalogs, popular, top rated, currently airing, films, and search.',
  types: ['series'],
  resources: [
    { name: 'catalog', types: ['series'] },
    { name: 'meta', types: ['series'], idPrefixes: ['kitsu:'] }
  ],
  idPrefixes: ['kitsu:'],
  catalogs: Object.entries(CATALOGS).map(([id, definition]) => ({
    id,
    type: 'series',
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
  ['/logo.svg', ['logo.svg', 'image/svg+xml']],
  ['/logo.png', ['logo.png', 'image/png']],
  ['/tmdb.svg', ['tmdb.svg', 'image/svg+xml']]
]);

function json(response, status, value, cache = 0, head = false) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache ? `public, max-age=${cache}, stale-if-error=3600` : 'no-store'
  });
  response.end(head ? undefined : JSON.stringify(value));
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

export function createAddonServer({ service, artwork, logger = console,
  publicUrl = process.env.PUBLIC_URL || '', token = process.env.TMDB_READ_ACCESS_TOKEN || '', apiKey = process.env.TMDB_API_KEY || '',
  groupSeasons = process.env.GROUP_ANIME_SEASONS !== 'false' } = {}) {
  const groupingEnabled = !service && groupSeasons;
  const artworkCapability = artwork?.enabled;
  if (!service) {
    const api = createApiClient();
    const loadMappings = createAnimeMappingLoader();
    const seasonGroups = groupSeasons ? createSeasonGroups({ loadMappings }) : undefined;
    artwork ??= createArtworkService({ token, apiKey, publicUrl, mappingLoader: loadMappings,
      getAnime: async id => {
        const result = await api.request(`anime/${id}`, { include: 'categories' }, 3600);
        if (!result.data || Array.isArray(result.data)) throw new ApiError('Anime not found.', 404);
        return result.data;
      }
    });
    service = createKitsuService(api, { artwork, seasonGroups });
  }
  return http.createServer(async (request, response) => {
    // All JSON responses (including errors) honor HEAD.
    const sendJson = (status, value, cache = 0) => json(response, status, value, cache, request.method === 'HEAD');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD, OPTIONS');
      sendJson(405, { error: 'Method not allowed.' });
      return;
    }
    try {
      if (request.url.length > 4096) throw new ApiError('URL is too long.', 414);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        const contents = await readFile(new URL(`../public/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : contents);
        return;
      }
      if (url.pathname === '/health') { sendJson(200, { status: 'ok', name: manifest.name,
        titleLogos: Boolean(artwork?.enabled ?? service?.capabilities?.artwork ?? artworkCapability), seasonGrouping: groupingEnabled }); return; }
      if (url.pathname === '/manifest.json') { sendJson(200, manifest, 300); return; }
      const background = /^\/artwork\/v1\/background\/kitsu:([1-9]\d{0,9})\.jpg$/.exec(url.pathname);
      if (background && artwork?.background) {
        const result = await artwork.background(background[1]);
        if (!result) throw new ApiError('Background not found.', 404);
        response.writeHead(302, { Location: result.redirect, 'Cache-Control': `public, max-age=${result.cacheSeconds}` });
        response.end();
        return;
      }
      const poster = /^\/artwork\/v1\/poster\/kitsu:([1-9]\d{0,9})\.jpg$/.exec(url.pathname);
      if (poster && artwork) {
        const result = await artwork.poster(poster[1]);
        if (!result) throw new ApiError('Poster not found.', 404);
        if (result.redirect) {
          response.writeHead(302, { Location: result.redirect, 'Cache-Control': 'public, max-age=60' });
          response.end();
          return;
        }
        const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800', ETag: result.etag };
        const tags = (request.headers['if-none-match'] || '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
        if (tags.includes(result.etag) || tags.includes('*')) {
          response.writeHead(304, headers);
          response.end();
          return;
        }
        response.writeHead(200, { ...headers, 'Content-Length': result.buffer.length });
        response.end(request.method === 'HEAD' ? undefined : result.buffer);
        return;
      }
      const catalog = /^\/catalog\/(?:series|anime)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(url.pathname);
      if (catalog) {
        const result = await service.catalog(decodeURIComponent(catalog[1]), parseExtra(catalog[2], url));
        sendJson(200, result, 900);
        return;
      }
      const meta = /^\/meta\/series\/([^/]+)\.json$/.exec(url.pathname);
      if (meta) {
        sendJson(200, await service.metadata(decodeURIComponent(meta[1])), 3600);
        return;
      }
      sendJson(404, { error: 'Resource not found.' });
    } catch (error) {
      const status = error instanceof URIError ? 400 : error.status || 500;
      if (status >= 500) logger.error(`${new Date().toISOString()} ${error.message}`);
      sendJson(status, { error: status === 500 ? 'An unexpected error occurred.' : error.message });
    }
  });
}
