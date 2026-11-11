import { setTimeout as delay } from 'node:timers/promises';
import { CATEGORIES } from './categories.mjs';

const API_BASE = 'https://kitsu.app/api/edge/';
const API_PAGE_SIZE = 20;
const CATALOG_PAGE_SIZE = 100;
const MAX_EPISODES = 20000;

export class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export const CATALOGS = Object.freeze({
  ...Object.fromEntries(Object.entries(CATEGORIES).map(([name, category]) => [
    `kitsu-category-${category}`, { name, category, sort: 'popularityRank' }
  ])),
  'kitsu-popular': { name: 'Kitsu · Popular', sort: 'popularityRank' },
  'kitsu-top-rated': { name: 'Kitsu · Top Rated', sort: '-averageRating' },
  'kitsu-airing': { name: 'Kitsu · Currently Airing', sort: 'popularityRank', status: 'current' },
  'kitsu-movies': { name: 'Kitsu · Anime Movies', sort: 'popularityRank', subtype: 'movie' },
  'kitsu-search': { name: 'Kitsu · Search', searchOnly: true }
});

function limiter(maximum) {
  let active = 0;
  const queue = [];
  return async function run(task) {
    if (active >= maximum) await new Promise(resolve => queue.push(resolve));
    else active += 1;
    try { return await task(); }
    finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export function createApiClient({ fetchImpl = fetch, now = Date.now, timeoutMs = 12000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  const run = limiter(3);

  async function request(path, params = {}, ttl = 900) {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.sort();
    const key = url.href;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (pending.has(key)) return pending.get(key);

    const operation = run(async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetchImpl(url, {
            headers: {
              Accept: 'application/vnd.api+json',
              'User-Agent': 'KitsuAnimeShelf/1.0 (personal Stremio catalog)'
            },
            signal: AbortSignal.timeout(timeoutMs)
          });
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            await response.body?.cancel();
            const retrySeconds = Number(response.headers.get('retry-after'));
            await delay(Math.min(4000, Math.max(500, (retrySeconds || 1) * 1000)));
            continue;
          }
          if (!response.ok) throw new ApiError(`Kitsu returned HTTP ${response.status}.`, response.status === 404 ? 404 : 502);
          const value = await response.json();
          if (!value || !Object.hasOwn(value, 'data') || value.errors) throw new ApiError('Kitsu returned an unexpected response.');
          cache.delete(key);
          cache.set(key, { value, expires: now() + ttl * 1000, saved: now() });
          while (cache.size > 1024) cache.delete(cache.keys().next().value);
          return value;
        }
      } catch (error) {
        // Keep previously fetched catalogs useful during a temporary outage.
        if (cached && now() - cached.saved < 86400000 && error.status !== 404) return cached.value;
        if (error instanceof ApiError) throw error;
        throw new ApiError('Cannot reach Kitsu.app. Check your connection and try again.');
      }
    });
    pending.set(key, operation);
    try { return await operation; }
    finally { pending.delete(key); }
  }

  return { request };
}

function image(images, ...sizes) {
  return sizes.map(size => images?.[size]).find(url => typeof url === 'string' && /^https?:\/\//.test(url));
}

function title(attributes, fallback) {
  return attributes.canonicalTitle || attributes.titles?.en || attributes.titles?.en_us || attributes.titles?.en_jp || fallback;
}

function realDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function toMeta(item, included = []) {
  const a = item.attributes || {};
  const year = a.startDate?.slice(0, 4);
  const endYear = a.endDate?.slice(0, 4);
  const categoryIds = new Set((item.relationships?.categories?.data || []).map(category => category.id));
  const genres = included.filter(resource => resource.type === 'categories' && categoryIds.has(resource.id))
    .map(resource => resource.attributes?.title).filter(Boolean);
  return {
    id: `kitsu:${item.id}`,
    // Kitsu anime entries (including films) use series + absolute episode IDs.
    type: 'series',
    name: title(a, `Anime ${item.id}`),
    poster: image(a.posterImage, 'medium', 'small', 'large', 'original'),
    posterShape: 'poster',
    background: image(a.coverImage, 'small', 'large', 'original'),
    description: a.synopsis || a.description || undefined,
    releaseInfo: year ? (a.status === 'current' ? `${year}-` : endYear && endYear !== year ? `${year}-${endYear}` : year) : undefined,
    released: realDate(a.startDate),
    runtime: a.episodeLength ? `${a.episodeLength} min` : undefined,
    genres: genres.length ? genres : undefined,
    links: [{ name: 'View on Kitsu', category: 'Website', url: `https://kitsu.app/anime/${a.slug || item.id}` }],
    trailers: a.youtubeVideoId ? [{ source: a.youtubeVideoId, type: 'Trailer' }] : undefined
  };
}

function episodeVideo(animeId, number, attributes = {}) {
  return {
    id: `kitsu:${animeId}:${number}`,
    season: 1,
    episode: number,
    title: title(attributes, `Episode ${number}`),
    released: realDate(attributes.airdate),
    thumbnail: image(attributes.thumbnail, 'original'),
    overview: attributes.synopsis || attributes.description || undefined
  };
}

export function createKitsuService(api = createApiClient(), { artwork } = {}) {
  function preview(item, included) {
    const meta = toMeta(item, included);
    artwork?.remember(item, meta);
    return artwork ? artwork.decorate(meta) : meta;
  }

  async function catalog(id, extra = {}) {
    const definition = CATALOGS[id];
    if (!definition) throw new ApiError('Catalog not found.', 404);
    const skip = extra.skip === undefined ? 0 : Number(extra.skip);
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > 1000000) throw new ApiError('Invalid catalog offset.', 400);
    const query = typeof extra.search === 'string' ? extra.search.trim() : '';
    if (query.length > 200) throw new ApiError('Search must be 200 characters or fewer.', 400);
    if (definition.searchOnly && !query) return { metas: [] };
    const params = { 'page[size]': API_PAGE_SIZE, include: 'categories' };
    if (query) params['filter[text]'] = query;
    else if (definition.sort) params.sort = definition.sort;
    if (definition.status) params['filter[status]'] = definition.status;
    if (definition.subtype) params['filter[subtype]'] = definition.subtype;
    if (definition.category) params['filter[categories]'] = definition.category;

    // Kitsu's Typesense search currently repeats the first page for offset=20.
    // Its number/size paginator works for both filtered and unfiltered anime.
    const firstPage = Math.floor(skip / API_PAGE_SIZE) + 1;
    const firstIndex = skip % API_PAGE_SIZE;
    const first = await api.request('anime', { ...params, 'page[number]': firstPage });
    if (!Array.isArray(first.data)) throw new ApiError('Kitsu did not return an anime list.');
    const pages = [first];
    if (first.data.length === API_PAGE_SIZE && first.links?.next) {
      const count = Number(first.meta?.count);
      const numbers = Array.from({ length: Math.ceil((CATALOG_PAGE_SIZE + firstIndex) / API_PAGE_SIZE) - 1 }, (_, i) => firstPage + i + 1)
        .filter(number => !Number.isFinite(count) || (number - 1) * API_PAGE_SIZE < count);
      pages.push(...await Promise.all(numbers.map(number => api.request('anime', { ...params, 'page[number]': number }))));
    }
    const seen = new Set();
    const metas = pages.flatMap(page => page.data.map(item => preview(item, page.included)))
      .filter(meta => !seen.has(meta.id) && seen.add(meta.id))
      .slice(firstIndex, firstIndex + CATALOG_PAGE_SIZE);
    return { metas };
  }

  async function metadata(id) {
    const match = /^kitsu:([1-9]\d*)$/.exec(id);
    if (!match) throw new ApiError('Anime not found.', 404);
    const animeId = match[1];
    const data = await api.request(`anime/${animeId}`, { include: 'categories' }, 3600);
    if (!data.data || Array.isArray(data.data)) throw new ApiError('Anime not found.', 404);
    const a = data.data.attributes || {};
    const meta = preview(data.data, data.included);
    const enriched = artwork?.enrich(meta, data.data);
    const path = `anime/${animeId}/episodes`;
    let episodePages = [];
    try {
      const first = await api.request(path, { 'page[limit]': API_PAGE_SIZE, 'page[offset]': 0, sort: 'number' }, 3600);
      episodePages.push(first);
      const count = Number(first.meta?.count);
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_EPISODES) throw new ApiError('Invalid Kitsu episode count.');
      const offsets = Array.from({ length: Math.max(0, Math.ceil(count / API_PAGE_SIZE) - 1) }, (_, i) => (i + 1) * API_PAGE_SIZE);
      // Retain completed pages if individual episode detail requests fail.
      const rest = await Promise.allSettled(offsets.map(offset => api.request(path, {
        'page[limit]': API_PAGE_SIZE, 'page[offset]': offset, sort: 'number'
      }, 3600)));
      if (rest.some(result => result.status === 'rejected') && !Number.isSafeInteger(a.episodeCount)) {
        throw new ApiError('Kitsu episode details are temporarily unavailable. Try again.');
      }
      episodePages.push(...rest.filter(result => result.status === 'fulfilled').map(result => result.value));
    } catch {
      // Known episode counts still permit playback using numbered entries.
      if (!Number.isSafeInteger(a.episodeCount) || a.episodeCount < 1) throw new ApiError('Kitsu episode details are temporarily unavailable. Try again.');
    }
    const actual = new Map();
    for (const page of episodePages) {
      for (const item of page.data || []) {
        const number = item.attributes?.number;
        if (Number.isInteger(number) && number > 0 && number <= MAX_EPISODES) actual.set(number, item.attributes);
      }
    }
    const declaredCount = Number.isSafeInteger(a.episodeCount) && a.episodeCount > 0 ? Math.min(a.episodeCount, MAX_EPISODES) : 0;
    // When the count is unknown, show only episode numbers actually known to Kitsu.
    const numbers = new Set([...Array.from({ length: declaredCount }, (_, index) => index + 1), ...actual.keys()]);
    if (!numbers.size && a.subtype?.toLowerCase() === 'movie') numbers.add(1);
    meta.videos = [...numbers].sort((a, b) => a - b).map(number => episodeVideo(animeId, number, actual.get(number)));
    if (meta.videos.length === 1) meta.behaviorHints = { defaultVideoId: meta.videos[0].id };
    return { meta: enriched ? { ...meta, ...await enriched } : meta };
  }

  return { catalog, metadata };
}
