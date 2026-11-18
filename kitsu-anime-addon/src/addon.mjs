import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { ApiError, CATALOGS, createApiClient, createKitsuService } from './kitsu.mjs';
import { createArtworkService } from './artwork.mjs';
import { createAnimeMappingLoader } from './anime-mappings.mjs';
import { createSeasonGroups } from './season-groups.mjs';
import { CATALOG_OPTIONS, SEARCH_CATALOG_ID, encodeConfig, manifestCatalog, parseConfig, parseExtra as parseCatalogExtra } from './catalog-config.mjs';

export const VERSION = '2.0.0-rc.1';

const BASE_MANIFEST = {
  id: 'personal.kitsu.anime.shelf',
  version: VERSION,
  name: 'Kitsu Anime Shelf',
  logo: 'https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/logo.png',
  types: ['series'],
  resources: [
    { name: 'catalog', types: ['series'] },
    { name: 'meta', types: ['series'], idPrefixes: ['kitsu:'] }
  ],
  idPrefixes: ['kitsu:']
};

// A configured install shows exactly the chosen lists and genres, plus search
// (which never appears as a row). Every install keeps the same add-on ID.
export function buildManifest(catalogIds) {
  const names = CATALOG_OPTIONS.filter(option => catalogIds.includes(option.id)).map(option => option.name);
  return {
    ...BASE_MANIFEST,
    description: `Anime from Kitsu.app with grouped TV seasons and search. Your rows: ${names.join(', ')}.`,
    catalogs: [...catalogIds, SEARCH_CATALOG_ID].map(manifestCatalog),
    behaviorHints: { adult: false, p2p: false, configurable: true }
  };
}

// The plain manifest shows no rows until the user chooses them on /configure.
export const manifest = {
  ...BASE_MANIFEST,
  description: 'Anime discovery from Kitsu.app: choose your own rows from Top 10, popular, top rated, airing, films and 40 genres. Open Configure to choose.',
  catalogs: [manifestCatalog(SEARCH_CATALOG_ID)],
  behaviorHints: { adult: false, p2p: false, configurable: true, configurationRequired: true }
};

export { encodeConfig, parseConfig };

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/configure', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/logo.svg', ['logo.svg', 'image/svg+xml']],
  ['/logo.png', ['logo.png', 'image/png']],
  ['/tmdb.svg', ['tmdb.svg', 'image/svg+xml']],
  // 2.0 dashboard. When accounts are enabled the v2 application serves these
  // with a Content-Security-Policy; otherwise the page explains it is disabled.
  ['/dashboard', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard/app.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard/app.css', ['dashboard.css', 'text/css; charset=utf-8']]
]);

function json(response, status, value, cache = 0, head = false) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache ? `public, max-age=${cache}, stale-if-error=3600` : 'no-store'
  });
  response.end(head ? undefined : JSON.stringify(value));
}

const parseExtra = (raw, url) => parseCatalogExtra(raw, url, ApiError);

// v2: optional factory from src/v2.mjs that adds accounts, the dashboard and
// personal catalogs. Without it the server is the unchanged public add-on.
export function createAddonServer({ service, artwork, logger = console,
  publicUrl = process.env.PUBLIC_URL || '', token = process.env.TMDB_READ_ACCESS_TOKEN || '', apiKey = process.env.TMDB_API_KEY || '',
  groupSeasons = process.env.GROUP_ANIME_SEASONS !== 'false', v2, api, loadMappings, seasonGroups,
  warmCatalogs = process.env.WARM_CATALOGS !== 'false', warmDelayMs = 3000 } = {}) {
  const groupingEnabled = !service && groupSeasons;
  const artworkCapability = artwork?.enabled;
  const ownService = !service;
  // The 2.0 extension (created below) may supply a persistent row store.
  const storeRef = {};
  const catalogStore = {
    get: key => storeRef.current?.get(key),
    set: (key, value, saved) => storeRef.current?.set(key, value, saved)
  };
  if (!service) {
    api ??= createApiClient();
    loadMappings ??= createAnimeMappingLoader();
    seasonGroups ??= groupSeasons ? createSeasonGroups({ loadMappings }) : undefined;
    artwork ??= createArtworkService({ token, apiKey, publicUrl, mappingLoader: loadMappings,
      getAnime: async id => {
        const result = await api.request(`anime/${id}`, { include: 'categories' }, 3600);
        if (!result.data || Array.isArray(result.data)) throw new ApiError('Anime not found.', 404);
        return result.data;
      }
    });
    service = createKitsuService(api, { artwork, seasonGroups, catalogStore });
  }
  const extension = v2?.({ api, service, artwork, loadMappings, seasonGroups });
  storeRef.current = extension?.catalogStore;
  const server = http.createServer(async (request, response) => {
    if (extension) {
      try {
        if (await extension.handle(request, response)) return;
      } catch (error) {
        logger.error(`${new Date().toISOString()} ${error.message}`);
        if (!response.headersSent) json(response, 500, { error: 'An unexpected error occurred.' });
        else response.destroy();
        return;
      }
    }
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
      // Configured installs: /c/<choices>/... behaves like /... with those rows.
      let chosen;
      const configured = /^\/c\/([^/]{1,1000})(\/.*)$/.exec(url.pathname);
      if (configured) {
        chosen = parseConfig(configured[1]);
        if (!chosen) throw new ApiError('This install link is not valid. Choose your rows again on the setup page.', 404);
        url.pathname = configured[2];
      }
      if (url.pathname === '/catalog-options.json') {
        sendJson(200, { options: CATALOG_OPTIONS }, 3600);
        return;
      }
      if (assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        const contents = await readFile(new URL(`../public/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : contents);
        return;
      }
      if (url.pathname === '/health') { sendJson(200, { status: 'ok', name: manifest.name, version: VERSION,
        titleLogos: Boolean(artwork?.enabled ?? service?.capabilities?.artwork ?? artworkCapability), seasonGrouping: groupingEnabled,
        accounts: Boolean(extension?.capabilities?.accounts), anilist: Boolean(extension?.capabilities?.anilist) }); return; }
      if (url.pathname === '/manifest.json') { sendJson(200, chosen ? buildManifest(chosen) : manifest, 300); return; }
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
  if (extension?.close) server.on('close', () => extension.close().catch(() => {}));
  // Warm every offered row shortly after start-up (one at a time, background
  // priority), restoring saved rows from the database when available.
  if (ownService && warmCatalogs && typeof service.warm === 'function') {
    let closed = false;
    server.on('close', () => { closed = true; });
    server.once('listening', () => {
      const timer = setTimeout(() => {
        service.warm(CATALOG_OPTIONS.map(option => option.id), { shouldStop: () => closed })
          .catch(error => logger.error(`Catalog warm-up failed: ${error.message}`));
      }, warmDelayMs);
      timer.unref?.();
    });
  }
  return server;
}
