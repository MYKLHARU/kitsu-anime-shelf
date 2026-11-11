import { createAnimeMappingLoader } from './anime-mappings.mjs';

const PAGE_SIZE = 20;
const RESULT_SIZE = 100;

export function buildSeasonIndex(rows) {
  const shows = new Map();
  const membership = new Map();
  const unsafe = new Set();
  for (const row of rows) {
    // A shared collection or a similar title is not proof of a TV season.
    if (row.type !== 'TV' || !Number.isSafeInteger(row.kitsu_id) || row.kitsu_id < 1 ||
      !Number.isSafeInteger(row.themoviedb_id?.tv) || row.themoviedb_id.tv < 1) continue;
    const show = row.themoviedb_id.tv;
    const season = row.season?.tmdb;
    const offset = row.episode_offset?.tmdb ?? 0;
    if (!Number.isSafeInteger(season) || season < 1 || season > 32 || offset !== 0) {
      unsafe.add(show);
      continue;
    }
    const id = String(row.kitsu_id);
    const seasons = shows.get(show) || new Map();
    if (seasons.has(season) && seasons.get(season) !== id) unsafe.add(show);
    seasons.set(season, id);
    shows.set(show, seasons);
    const previous = membership.get(id);
    if (previous && (previous.show !== show || previous.season !== season)) {
      unsafe.add(previous.show);
      unsafe.add(show);
    }
    membership.set(id, { show, season });
  }
  const byRoot = new Map();
  const byMember = new Map();
  for (const [show, seasons] of shows) {
    if (unsafe.has(show) || seasons.size < 2 || !seasons.has(1)) continue;
    const members = [...seasons].sort((a, b) => a[0] - b[0]).map(([season, id]) => ({ season, id }));
    if (members.some((member, index) => member.season !== index + 1)) continue;
    const group = { rootId: seasons.get(1), tmdbId: show, members };
    byRoot.set(group.rootId, group);
    for (const member of members) byMember.set(member.id, group);
  }
  return { byRoot, byMember };
}

export function createSeasonGroups({ loadMappings = createAnimeMappingLoader() } = {}) {
  let source;
  let index;
  return {
    async index() {
      try {
        const rows = await loadMappings();
        if (rows !== source) { index = buildSeasonIndex(rows); source = rows; }
        return index;
      } catch { return undefined; }
    }
  };
}

// skip counts unique shows, not the original Kitsu season entries. A small
// per-query cursor retains the canonical order across pages and concurrent calls.
export function createGroupedCatalog({ api, preview, now = Date.now }) {
  const cursors = new Map();
  const previews = new Map();

  function remember(item, included) {
    const meta = preview(item, included);
    previews.delete(item.id);
    previews.set(item.id, { meta, saved: now() });
    while (previews.size > 2048) previews.delete(previews.keys().next().value);
    return meta;
  }

  function cached(id) {
    const entry = previews.get(id);
    return entry && now() - entry.saved < 900000 ? entry.meta : undefined;
  }

  return async function catalog(id, params, skip, index) {
    const key = JSON.stringify([id, params]);
    let state = cursors.get(key);
    if (!state || now() - state.saved >= 900000) {
      state = { ids: [], seen: new Set(), genres: new Map(), nextPage: 1, ended: false,
        totalPages: Infinity, index, saved: now(), pending: Promise.resolve() };
    }
    cursors.delete(key);
    cursors.set(key, state);
    while (cursors.size > 16) cursors.delete(cursors.keys().next().value);
    const operation = state.pending.then(async () => {
      if (skip > state.ids.length + 500 || skip + RESULT_SIZE > 10000) {
        throw Object.assign(new Error('This catalog position has expired. Reopen the catalog and browse from the start.'), { status: 400 });
      }
      let pages = 0;
      while (!state.ended && state.ids.length < skip + RESULT_SIZE) {
        if (pages >= 50) throw Object.assign(new Error('This catalog is taking longer to load. Please try again.'), { status: 503 });
        const count = Math.min(state.nextPage === 1 ? 1 : 5, Math.ceil((skip + RESULT_SIZE - state.ids.length) / PAGE_SIZE),
          state.totalPages - state.nextPage + 1);
        if (count < 1) { state.ended = true; break; }
        const numbers = Array.from({ length: count }, (_, index) => state.nextPage + index);
        const batch = await Promise.all(numbers.map(number => api.request('anime', { ...params, 'page[number]': number })));
        for (const page of batch) {
          if (!Array.isArray(page.data)) throw new Error('Kitsu did not return an anime list.');
          const total = Number(page.meta?.count);
          if (Number.isFinite(total) && total >= 0) state.totalPages = Math.ceil(total / PAGE_SIZE);
          for (const item of page.data) {
            const meta = remember(item, page.included);
            const group = state.index.byMember.get(item.id);
            const canonical = group?.rootId || item.id;
            const genres = state.genres.get(canonical) || new Set();
            for (const genre of meta.genres || []) genres.add(genre);
            state.genres.set(canonical, genres);
            if (!state.seen.has(canonical)) { state.seen.add(canonical); state.ids.push(canonical); }
          }
          state.nextPage += 1;
          if (page.data.length < PAGE_SIZE || !page.links?.next) { state.ended = true; break; }
        }
        pages += count;
      }
      const ids = state.ids.slice(skip, skip + RESULT_SIZE);
      const missing = ids.filter(id => !cached(id));
      const batches = Array.from({ length: Math.ceil(missing.length / PAGE_SIZE) }, (_, index) => missing.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE));
      await Promise.all(batches.map(async ids => {
        const result = await api.request('anime', { 'filter[id]': ids.join(','), 'page[limit]': PAGE_SIZE, include: 'categories' });
        for (const item of result.data || []) remember(item, result.included);
      }));
      const metas = ids.map(id => {
        const meta = cached(id);
        if (!meta) throw Object.assign(new Error('Some grouped anime details are temporarily unavailable. Please try again.'), { status: 502 });
        const group = state.index.byRoot.get(id);
        const genres = [...new Set([...(meta.genres || []), ...(state.genres.get(id) || [])])];
        return { ...meta, ...(genres.length ? { genres } : {}),
          ...(group ? { description: `${meta.description || ''}${meta.description ? '\n\n' : ''}Seasons 1–${group.members.length}.` } : {}) };
      });
      return { metas };
    });
    state.pending = operation.catch(() => {});
    return operation;
  };
}

export async function groupedMetadata(group, metadata) {
  let results;
  try {
    results = await Promise.all(group.members.map(member => metadata(`kitsu:${member.id}`, { enrichArtwork: member.id === group.rootId })));
  } catch {
    throw Object.assign(new Error('Some seasons could not be loaded. Please try again shortly.'), { status: 502 });
  }
  const root = results[0].meta;
  const videos = results.flatMap(({ meta }, index) => meta.videos.map(video => ({ ...video, season: group.members[index].season })));
  const years = results.flatMap(({ meta }) => meta.releaseInfo?.match(/\d{4}/g) || []).map(Number);
  const ongoing = results.some(({ meta }) => meta.releaseInfo?.endsWith('-'));
  const first = years.length ? Math.min(...years) : undefined;
  const last = years.length ? Math.max(...years) : undefined;
  const genres = [...new Set(results.flatMap(({ meta }) => meta.genres || []))];
  const meta = { ...root, videos,
    description: `${root.description || ''}${root.description ? '\n\n' : ''}Seasons 1–${group.members.length}.`,
    ...(first ? { releaseInfo: ongoing ? `${first}-` : first === last ? String(first) : `${first}-${last}` } : {}),
    ...(genres.length ? { genres } : {}) };
  if (videos.length > 1 && meta.behaviorHints?.defaultVideoId) {
    meta.behaviorHints = { ...meta.behaviorHints };
    delete meta.behaviorHints.defaultVideoId;
  }
  return { meta };
}
