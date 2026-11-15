// Personalised Stremio add-on served at /u/<install-token>/manifest.json.
//
// The install token is a revocable, read-only capability: it can list the
// owner's shelf catalogs and nothing else. It is unrelated to the session
// cookie, so it never grants dashboard access. Metadata requests are answered
// by the same Kitsu service as the public add-on, so IDs, episode video IDs
// and playback through Kitsu-compatible stream add-ons are unchanged.
import { sha256, TOKEN_PATTERN } from './security.mjs';
import { SEARCH_CATALOG_ID, manifestCatalog, normalizeCatalogIds, parseExtra } from './catalog-config.mjs';

export const PERSONAL_CATALOGS = Object.freeze({
  'shelf-watching': { name: 'My Shelf · Continue Watching', status: 'watching' },
  'shelf-for-you': { name: 'My Shelf · For You', recommendations: true },
  'shelf-planning': { name: 'My Shelf · Plan to Watch', status: 'planning' },
  'shelf-on-hold': { name: 'My Shelf · On Hold', status: 'on_hold' },
  'shelf-completed': { name: 'My Shelf · Completed', status: 'completed' }
});
const PAGE = 100;

// Shelf rows first, then the lists and genres the user chose in the dashboard,
// then Kitsu search (never shown as a row).
export function personalManifest({ version, logo, chosen = [] }) {
  return {
    id: 'personal.kitsu.anime.shelf.mine',
    version,
    name: 'Kitsu Anime Shelf · My Shelf',
    logo,
    description: 'Your Kitsu Anime Shelf watchlist, recommendations and the lists and genres you chose in your dashboard.',
    types: ['series'],
    resources: [
      { name: 'catalog', types: ['series'] },
      { name: 'meta', types: ['series'], idPrefixes: ['kitsu:'] }
    ],
    idPrefixes: ['kitsu:'],
    catalogs: [
      ...Object.entries(PERSONAL_CATALOGS).map(([id, definition]) => ({ id, type: 'series', name: definition.name, extra: [{ name: 'skip' }] })),
      ...[...chosen, SEARCH_CATALOG_ID].map(manifestCatalog)
    ],
    // Configure opens the dashboard, where rows are chosen.
    behaviorHints: { adult: false, p2p: false, configurable: true }
  };
}

function entryMeta(entry, artwork) {
  const meta = {
    id: entry.animeId,
    type: 'series',
    name: entry.anime.title,
    poster: entry.anime.poster || undefined,
    posterShape: 'poster',
    releaseInfo: entry.anime.startYear ? String(entry.anime.startYear) : undefined,
    description: entry.status === 'watching'
      ? `Watched ${entry.progress}${entry.anime.episodeCount ? ` of ${entry.anime.episodeCount}` : ''} episode${entry.progress === 1 ? '' : 's'}.`
      : undefined
  };
  return artwork?.enabled ? artwork.decorate(meta) : meta;
}

export function createPersonalAddon({ accounts, library, recommender, service, artwork, version, logo, rateLimiter, clientIp = request => request.socket?.remoteAddress || 'unknown', logger = console }) {

  function send(response, status, value, head, cache = 'private, max-age=60') {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? cache : 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    response.end(head ? undefined : JSON.stringify(value));
  }

  // Returns true when the request belonged to the personal add-on.
  return async function handle(request, response, url) {
    const match = /^\/u\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!match) return false;
    const head = request.method === 'HEAD';
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept' });
      response.end();
      return true;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { send(response, 405, { error: 'Method not allowed.' }, head); return true; }
    const [, token, rest] = match;
    const tooMany = result => {
      response.setHeader('Retry-After', String(result.retryAfter));
      send(response, 429, { error: 'Too many requests.' }, head);
      return true;
    };
    // Per-address limit first, so random tokens cannot create unlimited
    // limiter keys or database lookups.
    const byIp = rateLimiter.hit(`install-ip:${clientIp(request)}`, 300, 60000);
    if (!byIp.allowed) return tooMany(byIp);
    if (!TOKEN_PATTERN.test(token)) { send(response, 404, { error: 'Resource not found.' }, head); return true; }
    const tokenHash = sha256(token);
    try {
      const install = await accounts.findInstallToken(tokenHash);
      // Revoked and unknown links are indistinguishable.
      if (!install) { send(response, 404, { error: 'This install link is not valid. Create a new one in your dashboard.' }, head); return true; }
      const byToken = rateLimiter.hit(`install:${install.id}`, 240, 60000);
      if (!byToken.allowed) return tooMany(byToken);
      if (rest === '/configure') {
        response.writeHead(302, { Location: '/dashboard#connections', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        response.end();
        return true;
      }
      const chosen = normalizeCatalogIds(await accounts.getCatalogChoices(install.user_id)) ?? [];
      if (rest === '/manifest.json') { send(response, 200, personalManifest({ version, logo, chosen }), head, 'private, max-age=300'); return true; }
      const catalog = /^\/catalog\/(?:series|anime)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(rest);
      if (catalog) {
        const definition = PERSONAL_CATALOGS[catalog[1]];
        if (!definition) {
          // A chosen public list or genre (or search) is served by the public catalog service.
          if (!chosen.includes(catalog[1]) && catalog[1] !== SEARCH_CATALOG_ID) { send(response, 404, { error: 'Catalog not found.' }, head); return true; }
          send(response, 200, await service.catalog(catalog[1], parseExtra(catalog[2], url)), head, 'private, max-age=900');
          return true;
        }
        const extra = new URLSearchParams(catalog[2] || '');
        const skip = Number(extra.get('skip') ?? url.searchParams.get('skip') ?? 0);
        if (!Number.isSafeInteger(skip) || skip < 0 || skip > 100000) { send(response, 400, { error: 'Invalid catalog offset.' }, head); return true; }
        let metas;
        if (definition.recommendations) {
          const entries = await library.list(install.user_id);
          metas = (await recommender.recommend(install.user_id, entries, { limit: 100 })).map(({ reason, ...meta }) => ({ ...meta, description: reason }));
        } else {
          metas = (await library.list(install.user_id, { status: definition.status })).map(entry => entryMeta(entry, artwork));
        }
        send(response, 200, { metas: metas.slice(skip, skip + PAGE) }, head);
        return true;
      }
      const meta = /^\/meta\/series\/([^/]+)\.json$/.exec(rest);
      if (meta) { send(response, 200, await service.metadata(decodeURIComponent(meta[1])), head, 'private, max-age=3600'); return true; }
      send(response, 404, { error: 'Resource not found.' }, head);
    } catch (error) {
      const status = error instanceof URIError ? 400 : error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) logger.error?.(`Personal add-on error: ${error.message}`);
      send(response, status, { error: status === 500 ? 'An unexpected error occurred.' : error.message }, head);
    }
    return true;
  };
}
