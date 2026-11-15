// Catalog choices for configurable installs.
//
// A plain install (/manifest.json) shows no rows until the user chooses lists
// and genres. Choices travel in the install URL as short keys:
//   /c/top10.popular.action.isekai/manifest.json
// Anime IDs, metadata and episode video IDs are identical for every choice.
import { CATALOGS } from './kitsu.mjs';
import { CATEGORIES } from './categories.mjs';

const LISTS = [
  ['top10', 'kitsu-top10', 'Top 10 Airing'],
  ['popular', 'kitsu-popular', 'Most popular'],
  ['top-rated', 'kitsu-top-rated', 'Top rated'],
  ['airing', 'kitsu-airing', 'Airing now'],
  ['movies', 'kitsu-movies', 'Movies']
];

export const CATALOG_OPTIONS = Object.freeze([
  ...LISTS.map(([key, id, name]) => Object.freeze({ key, id, name, group: 'list' })),
  ...Object.entries(CATEGORIES).map(([name, slug]) => Object.freeze({ key: slug, id: `kitsu-category-${slug}`, name, group: 'genre' }))
]);
const BY_KEY = new Map(CATALOG_OPTIONS.map(option => [option.key, option]));
const BY_ID = new Map(CATALOG_OPTIONS.map(option => [option.id, option]));
export const SEARCH_CATALOG_ID = 'kitsu-search';

// Returns catalog IDs in canonical order, or null for an invalid configuration.
export function parseConfig(text) {
  if (typeof text !== 'string' || text.length > 1000 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(text)) return null;
  const keys = new Set(text.split('.'));
  if ([...keys].some(key => !BY_KEY.has(key))) return null;
  return CATALOG_OPTIONS.filter(option => keys.has(option.key)).map(option => option.id);
}

export function encodeConfig(ids) {
  const wanted = new Set(ids);
  return CATALOG_OPTIONS.filter(option => wanted.has(option.id)).map(option => option.key).join('.');
}

// Normalises a list of catalog IDs (from the dashboard API or the database).
export function normalizeCatalogIds(ids) {
  if (!Array.isArray(ids) || ids.length > CATALOG_OPTIONS.length || ids.some(id => typeof id !== 'string' || !BY_ID.has(id))) return null;
  const wanted = new Set(ids);
  return CATALOG_OPTIONS.filter(option => wanted.has(option.id)).map(option => option.id);
}

export function manifestCatalog(id) {
  const definition = CATALOGS[id];
  return {
    id,
    type: 'series',
    name: definition.name,
    extra: [
      ...(definition.searchOnly ? [{ name: 'search', isRequired: true }] : []),
      { name: 'skip' }
    ]
  };
}

// Stremio extra arguments: path segment "search=x&skip=100" and/or query string.
export function parseExtra(raw, url, ErrorType = Error) {
  const extra = {};
  if (raw) {
    // Split before decoding so an encoded '&' stays inside a search value.
    for (const part of raw.split('&')) {
      const separator = part.indexOf('=');
      if (separator < 0) throw Object.assign(new ErrorType('Invalid catalog filters.'), { status: 400 });
      const key = decodeURIComponent(part.slice(0, separator));
      if (!['search', 'skip'].includes(key)) throw Object.assign(new ErrorType('Unknown catalog filter.'), { status: 400 });
      extra[key] = decodeURIComponent(part.slice(separator + 1));
    }
  }
  for (const key of ['search', 'skip']) if (url?.searchParams.has(key)) extra[key] = url.searchParams.get(key);
  return extra;
}
