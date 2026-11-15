// Personalised recommendations from Kitsu categories.
//
// A user's library builds a category-affinity profile (finished and highly
// scored titles count most, dropped titles count against their categories).
// Candidates come from Kitsu's popular titles in the strongest categories and
// are ranked by affinity, rating and popularity. Titles already in the library,
// and other seasons of the same show, are excluded. Upstream requests are
// shared between users through the Kitsu API cache.
import { toMeta } from './kitsu.mjs';

const STATUS_WEIGHT = { completed: 1, watching: 0.9, on_hold: 0.4, planning: 0.3, dropped: -0.8 };
// Broad setting/location tags say little about taste.
const GENERIC = new Set(['japan', 'asia', 'earth', 'present', 'past', 'future', 'other-planet', 'europe', 'americas', 'africa', 'australia']);
const EXCLUDED_SUBTYPES = new Set(['music']);
const TOP_CATEGORIES = 5;
const PAGES_PER_CATEGORY = 2;
const PAGE_SIZE = 20;
const CACHE_MS = 10 * 60000;
const FIELDS = 'canonicalTitle,titles,subtype,posterImage,coverImage,synopsis,description,startDate,endDate,status,episodeLength,slug,youtubeVideoId,averageRating,categories';

export function buildProfile(entries) {
  const affinity = new Map();
  for (const entry of entries) {
    const categories = entry.anime?.categories || [];
    if (!categories.length) continue;
    let weight = STATUS_WEIGHT[entry.status] ?? 0;
    if (weight > 0 && entry.score != null) weight *= 0.4 + (entry.score / 10) * 1.2;
    if (entry.status !== 'dropped' && entry.score != null && entry.score <= 3) weight = -0.5;
    // Normalise so heavily-tagged titles do not dominate.
    const share = weight / Math.sqrt(categories.length);
    for (const slug of categories) {
      affinity.set(slug, (affinity.get(slug) ?? 0) + share * (GENERIC.has(slug) ? 0.2 : 1));
    }
  }
  return affinity;
}

export function rankCandidates(candidates, affinity, { exclude = new Set(), groupOf = () => undefined, limit = 50 } = {}) {
  const positive = Math.max(1e-9, ...[...affinity.values()].filter(value => value > 0));
  const scored = [];
  const seenGroups = new Set([...exclude].map(id => groupOf(id)).filter(Boolean));
  const seen = new Set();
  for (const candidate of candidates) {
    if (exclude.has(candidate.id) || seen.has(candidate.id) || EXCLUDED_SUBTYPES.has(candidate.subtype)) continue;
    const group = groupOf(candidate.id);
    if (group && seenGroups.has(group)) continue;
    seen.add(candidate.id);
    if (group) seenGroups.add(group);
    let fit = 0;
    let best = { slug: undefined, value: 0 };
    for (const slug of candidate.categories) {
      const value = (affinity.get(slug) ?? 0) / positive;
      fit += value;
      if (value > best.value && !GENERIC.has(slug)) best = { slug, value };
    }
    fit /= Math.sqrt(Math.max(1, candidate.categories.length));
    const rating = Number.isFinite(candidate.rating) ? candidate.rating / 100 : 0.6;
    const popularity = 1 - Math.min(1, candidate.rank / (PAGES_PER_CATEGORY * PAGE_SIZE));
    scored.push({ ...candidate, score: fit * 0.7 + rating * 0.2 + popularity * 0.1, reasonSlug: best.slug });
  }
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  // Light diversity: at most 40% of the leading results are explained by one
  // category; the remaining places are then filled in score order.
  const cap = Math.max(3, Math.ceil(limit * 0.4));
  const perReason = new Map();
  const result = [];
  const deferred = [];
  for (const item of scored) {
    const count = perReason.get(item.reasonSlug) ?? 0;
    if (item.reasonSlug && count >= cap) { deferred.push(item); continue; }
    perReason.set(item.reasonSlug, count + 1);
    result.push(item);
    if (result.length >= limit) return result;
  }
  return result.concat(deferred.slice(0, limit - result.length));
}

export function createRecommender({ api, seasonGroups, artwork, now = Date.now } = {}) {
  const cache = new Map();

  async function candidatesFor(params, priority) {
    const pages = await Promise.allSettled(Array.from({ length: PAGES_PER_CATEGORY }, (_, page) => api.request('anime', {
      ...params, include: 'categories', 'fields[anime]': FIELDS, 'fields[categories]': 'slug,title',
      'page[size]': PAGE_SIZE, 'page[number]': page + 1
    }, 6 * 3600, { priority })));
    const items = [];
    const titles = new Map();
    for (const [pageIndex, page] of pages.entries()) {
      if (page.status !== 'fulfilled' || !Array.isArray(page.value.data)) continue;
      for (const resource of page.value.included || []) {
        if (resource.type === 'categories') titles.set(resource.attributes?.slug, resource.attributes?.title);
      }
      for (const [index, item] of page.value.data.entries()) {
        const ids = new Set((item.relationships?.categories?.data || []).map(category => category.id));
        const categories = (page.value.included || []).filter(resource => resource.type === 'categories' && ids.has(resource.id)).map(resource => resource.attributes?.slug).filter(Boolean);
        items.push({ id: `kitsu:${item.id}`, item, included: page.value.included, categories, subtype: item.attributes?.subtype,
          rating: Number(item.attributes?.averageRating), rank: pageIndex * PAGE_SIZE + index });
      }
    }
    return { items, titles };
  }

  function present(candidates, titles, fallbackReason) {
    return candidates.map(candidate => {
      const meta = toMeta(candidate.item, candidate.included);
      const decorated = artwork?.enabled ? artwork.decorate(meta) : meta;
      return { ...decorated, reason: candidate.reasonSlug ? `Because you enjoy ${titles.get(candidate.reasonSlug) || candidate.reasonSlug}` : fallbackReason };
    });
  }

  async function recommend(userId, entries, { limit = 50 } = {}) {
    const fingerprint = `${entries.length}:${entries.reduce((max, entry) => Math.max(max, new Date(entry.updatedAt || 0).getTime()), 0)}`;
    const cached = cache.get(userId);
    if (cached && cached.fingerprint === fingerprint && cached.expires > now()) return cached.value.slice(0, limit);

    const affinity = buildProfile(entries);
    const top = [...affinity].filter(([slug, value]) => value > 0 && !GENERIC.has(slug)).sort((a, b) => b[1] - a[1]).slice(0, TOP_CATEGORIES);
    const index = await seasonGroups?.index(); // Resolves undefined during mapping outages.
    const groupOf = id => index?.byMember.get(id.replace(/^kitsu:/, ''))?.rootId;
    const exclude = new Set(entries.map(entry => entry.animeId));
    let value;
    if (!top.length) {
      const { items, titles } = await candidatesFor({ sort: 'popularityRank' }, -1);
      value = present(rankCandidates(items, new Map(), { exclude, groupOf, limit }), titles, 'Popular on Kitsu');
    } else {
      const results = await Promise.all(top.map(([slug]) => candidatesFor({ sort: 'popularityRank', 'filter[categories]': slug }, -1)));
      const titles = new Map(results.flatMap(result => [...result.titles]));
      value = present(rankCandidates(results.flatMap(result => result.items), affinity, { exclude, groupOf, limit: 100 }), titles, 'Popular with similar viewers');
    }
    cache.delete(userId);
    cache.set(userId, { fingerprint, value, expires: now() + CACHE_MS });
    while (cache.size > 5000) cache.delete(cache.keys().next().value);
    return value.slice(0, limit);
  }

  return Object.freeze({ recommend, invalidate: userId => cache.delete(userId) });
}
