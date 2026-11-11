import { createHash } from 'node:crypto';
import sharp from 'sharp';

const DAY = 86400000;
const MAPPINGS_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const TMDB_API = 'https://api.themoviedb.org/3/';
const KITSU_HOSTS = new Set(['media.kitsu.app', 'media.kitsu.io', 'kitsu-production-media.s3.amazonaws.com']);
// Avoid libvips retaining a second, unbounded image cache on a small host.
sharp.cache(false);
sharp.concurrency(1);

export function boundedCache({ maxEntries = 2048, maxBytes = Infinity, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes;
    entries.delete(key);
  }
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= now()) { remove(key); return undefined; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, ttl, size = 0) {
      remove(key);
      if (size > maxBytes) return;
      entries.set(key, { value, expires: now() + ttl, bytes: size });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
    }
  };
}

function limiter(maximum, maxQueue = 32) {
  let active = 0;
  const queue = [];
  return async task => {
    if (active >= maximum) {
      if (queue.length >= maxQueue) throw new Error('Artwork is busy.');
      await new Promise(resolve => queue.push(resolve));
    } else active += 1;
    try { return await task(); }
    finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

async function readLimited(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Artwork source unavailable.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new Error('Artwork source too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function safeImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'image.tmdb.org' || KITSU_HOSTS.has(url.hostname)) ? url.href : undefined;
  } catch { return undefined; }
}

export function mappingIndex(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid anime mapping list.');
  const index = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.kitsu_id) || row.kitsu_id < 1) continue;
    const candidates = index.get(String(row.kitsu_id)) || new Map();
    for (const type of ['tv', 'movie']) {
      const ids = [row.themoviedb_id?.[type]].flat();
      for (const id of ids) {
        if (Number.isSafeInteger(id) && id > 0) candidates.set(`${type}:${id}`, { type, id });
      }
    }
    index.set(String(row.kitsu_id), candidates);
  }
  return index;
}

function normalize(value) {
  // Keep season numbers and subtitles: fuzzy franchise matches are unsafe here.
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function strictTitleMatch(results, attributes, type) {
  const names = new Set([attributes.canonicalTitle, ...Object.values(attributes.titles || {})].filter(Boolean).map(normalize));
  const year = Number(attributes.startDate?.slice(0, 4));
  if (!year) return undefined;
  const matches = results.filter(result => {
    const date = type === 'movie' ? result.release_date : result.first_air_date;
    return result.genre_ids?.includes(16) && result.original_language === 'ja' &&
      Number(date?.slice(0, 4)) === year &&
      [result.name, result.original_name, result.title, result.original_title].some(name => name && names.has(normalize(name)));
  });
  const unique = new Map(matches.map(result => [result.id, result]));
  const id = unique.size === 1 ? unique.values().next().value.id : undefined;
  return Number.isSafeInteger(id) && id > 0 ? { type, id } : undefined;
}

function imagePath(path, size = 'w500') {
  return typeof path === 'string' && /^\/[a-zA-Z0-9_-]+\.(png|jpg)$/.test(path)
    ? `https://image.tmdb.org/t/p/${size}${path}` : undefined;
}

export function chooseLogo(logos = []) {
  const rank = new Map([['en', 0], [null, 1], ['ja', 2]]);
  return [...logos].filter(logo => rank.has(logo.iso_639_1) && logo.width > 0 && logo.height > 0 &&
    logo.file_path?.endsWith('.png') && imagePath(logo.file_path))
    .sort((a, b) => rank.get(a.iso_639_1) - rank.get(b.iso_639_1) ||
      (b.vote_count || 0) - (a.vote_count || 0) || (b.width || 0) - (a.width || 0))[0];
}

export async function composePoster(poster, logo) {
  const options = { limitInputPixels: 16000000, animated: false };
  const base = await sharp(poster, options).rotate().resize(360, 540, { fit: 'cover' }).toBuffer();
  const mark = await sharp(logo, options).trim().resize(304, 116, { fit: 'inside' }).png().toBuffer();
  const info = await sharp(mark).metadata();
  const shade = Buffer.from('<svg width="360" height="540"><defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-opacity="0"/><stop offset="1" stop-opacity=".92"/></linearGradient></defs><rect y="320" width="360" height="220" fill="url(#g)"/></svg>');
  const pipeline = sharp(base).composite([
    { input: shade, top: 0, left: 0 },
    { input: mark, top: 540 - info.height - 28, left: Math.floor((360 - info.width) / 2) }
  ]);
  for (const quality of [82, 68, 50]) {
    const result = await pipeline.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (result.length < 100000) return result;
  }
  throw new Error('Rendered poster is too large.');
}

export function createArtworkService({ getAnime, token = '', apiKey = '', publicUrl = '', fetchImpl = fetch, now = Date.now,
  mappingLoader, posterCacheBytes = 16 * 1024 * 1024 } = {}) {
  const enabled = Boolean(token.trim() || apiKey.trim());
  if (enabled) {
    if (!publicUrl) throw new Error('PUBLIC_URL is required when TMDB credentials are set.');
    const url = new URL(publicUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
      throw new Error('PUBLIC_URL must be an HTTPS origin (or local HTTP origin).');
    }
    publicUrl = url.origin;
  }
  const records = boundedCache({ now });
  const resolved = boundedCache({ now });
  const apiCache = boundedCache({ maxEntries: 256, maxBytes: 8 * 1024 * 1024, now });
  const posters = boundedCache({ maxEntries: 512, maxBytes: posterCacheBytes, now });
  const pending = new Map();
  const requests = limiter(3);
  const renders = limiter(2, 24);
  let mappings;
  let mappingExpires = 0;
  let mappingRetry = 0;
  let blockedUntil = 0;

  async function once(key, operation) {
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 128) throw new Error('Artwork is busy.');
    const promise = operation();
    pending.set(key, promise);
    try { return await promise; }
    finally { pending.delete(key); }
  }

  async function json(url, headers = {}, limit = 1024 * 1024) {
    return requests(async () => {
      const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (url.startsWith(TMDB_API) && [401, 403, 429].includes(response.status)) {
        blockedUntil = now() + 300000;
      }
      return JSON.parse((await readLimited(response, limit)).toString('utf8'));
    });
  }

  async function tmdb(path, params = {}) {
    const url = new URL(path, TMDB_API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (!token.trim()) url.searchParams.set('api_key', apiKey.trim());
    const cached = apiCache.get(url.href);
    if (cached !== undefined) return cached;
    return once(url.href, async () => {
      if (now() < blockedUntil) throw new Error('TMDB is temporarily unavailable.');
      const value = await json(url.href, { ...(token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}), Accept: 'application/json' });
      apiCache.set(url.href, value, DAY, Buffer.byteLength(JSON.stringify(value)));
      return value;
    });
  }

  async function getMappings() {
    if (mappings && mappingExpires > now()) return mappings;
    if (mappingRetry > now()) return mappings;
    return once('mappings', async () => {
      try {
        mappings = mappingIndex(mappingLoader ? await mappingLoader() : await json(MAPPINGS_URL, {}, 10 * 1024 * 1024));
        mappingExpires = now() + DAY;
      } catch { mappingRetry = now() + 300000; }
      return mappings;
    });
  }

  function remember(item, meta) {
    records.set(String(item.id), { attributes: matchAttributes(item.attributes), poster: safeImageUrl(meta.poster) }, DAY);
  }

  function matchAttributes(a = {}) {
    return { canonicalTitle: a.canonicalTitle, titles: a.titles, subtype: a.subtype, startDate: a.startDate };
  }

  function decorate(meta) {
    return enabled && safeImageUrl(meta.poster) ? { ...meta, poster: `${publicUrl}/artwork/v1/poster/${meta.id}.jpg` } : meta;
  }

  async function record(id) {
    const saved = records.get(id);
    if (saved) return saved;
    const item = await getAnime(id);
    const a = item.attributes || {};
    const poster = ['medium', 'small', 'large', 'original'].map(size => safeImageUrl(a.posterImage?.[size])).find(Boolean);
    const value = { attributes: matchAttributes(a), poster };
    records.set(id, value, DAY);
    return value;
  }

  async function resolve(id, a) {
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    return once(`resolve:${id}`, async () => {
      try {
        const type = a.subtype?.toLowerCase() === 'movie' ? 'movie' : 'tv';
        const candidates = (await getMappings())?.get(id);
        const matching = [...(candidates?.values() || [])].filter(candidate => candidate.type === type);
        // Multiple IDs can represent split films/compilations. Do not guess.
        if (matching.length > 1) { resolved.set(id, null, DAY); return null; }
        let match = matching[0];
        if (!match) {
          const query = a.titles?.en || a.titles?.en_us || a.canonicalTitle;
          const year = a.startDate?.slice(0, 4);
          if (query && year) {
            const result = await tmdb(`search/${type}`, { query, include_adult: 'false', language: 'en-US',
              [type === 'movie' ? 'primary_release_year' : 'first_air_date_year']: year });
            match = strictTitleMatch(result.results || [], a, type);
          }
        }
        let result = null;
        if (match) {
          const images = await tmdb(`${match.type}/${match.id}/images`, { include_image_language: 'en,null,ja' });
          const logo = chooseLogo(images.logos);
          if (logo) {
            // Use textless art only for a title matched by name/year or a film.
            // A mapped TV entry can be a later Kitsu season of the same series.
            const textless = (type === 'movie' || !matching.length) && (images.posters || [])
              .filter(poster => poster.iso_639_1 === null && imagePath(poster.file_path))
              .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))[0];
            result = { logo: imagePath(logo.file_path), poster: textless ? imagePath(textless.file_path, 'w342') : undefined };
          }
        }
        resolved.set(id, result, result ? 7 * DAY : DAY);
        return result;
      } catch {
        // Missing credentials, rate limits and upstream outages never break metadata.
        resolved.set(id, null, 60000);
        return null;
      }
    });
  }

  async function enrich(meta, item) {
    if (!enabled) return meta;
    try {
      const result = await resolve(String(item.id), item.attributes || {});
      return result ? { ...meta, logo: result.logo } : meta;
    } catch { return meta; }
  }

  async function download(url) {
    if (!safeImageUrl(url)) throw new Error('Unsupported artwork URL.');
    return requests(async () => {
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!/^image\/(png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw new Error('Unsupported artwork format.');
      }
      return readLimited(response, 4 * 1024 * 1024);
    });
  }

  async function poster(id) {
    if (!/^[1-9]\d{0,9}$/.test(id)) return null;
    const cached = posters.get(id);
    if (cached !== undefined) return cached;
    // Prefer the known original to an error when a burst fills the work queue.
    if (pending.size >= 128 && !pending.has(`poster:${id}`)) {
      const saved = records.get(id);
      return saved?.poster ? { redirect: saved.poster } : null;
    }
    return once(`poster:${id}`, async () => {
      const saved = await record(id);
      const fallback = saved.poster ? { redirect: saved.poster } : null;
      try {
        const art = enabled ? await resolve(id, saved.attributes) : null;
        if (!art) { posters.set(id, fallback, 60000); return fallback; }
        const buffer = await renders(async () => {
          const [base, logo] = await Promise.all([download(art.poster || saved.poster), download(art.logo)]);
          return composePoster(base, logo);
        });
        const result = { buffer, etag: `"${createHash('sha256').update(buffer).digest('hex')}"` };
        posters.set(id, result, 7 * DAY, buffer.length);
        return result;
      } catch {
        posters.set(id, fallback, 60000);
        return fallback;
      }
    });
  }

  return { enabled, remember, decorate, enrich, poster };
}
