// Catalog choices for configurable installs.
//
// A plain install (/manifest.json) shows no rows until the user chooses lists
// and genres. Choices travel in the install URL as short keys:
//   /c/top10.popular.action.isekai/manifest.json
// Anime IDs, metadata and episode video IDs are identical for every choice.
import { CATALOGS } from './kitsu.mjs';
import { CATEGORIES } from './categories.mjs';

const LISTS = [
  ['trending', 'kitsu-trending', 'Trending This Week'],
  ['airing', 'kitsu-airing', 'Top Airing'],
  ['upcoming', 'kitsu-upcoming', 'Top Upcoming'],
  ['top-rated', 'kitsu-top-rated', 'Highest Rated'],
  ['popular', 'kitsu-popular', 'Most Popular']
];

// The genres offered as rows (a curated subset of Kitsu's categories).
export const GENRE_NAMES = Object.freeze([
  'Action', 'Adventure', 'Comedy', 'Demon', 'Drama', 'Earth', 'Ecchi', 'Fantasy', 'Fantasy World', 'Harem',
  'Historical', 'Horror', 'Isekai', 'Magic', 'Martial Arts', 'Mecha', 'Military', 'Music', 'Mystery', 'Present',
  'Psychological', 'Romance', 'School Life', 'Science Fiction', 'Seinen', 'Shounen', 'Slice of Life', 'Sports',
  'Supernatural', 'Superpower', 'Thriller', 'Violence'
]);

export const CATALOG_OPTIONS = Object.freeze([
  ...LISTS.map(([key, id, name]) => Object.freeze({ key, id, name, group: 'list' })),
  ...GENRE_NAMES.map(name => Object.freeze({ key: CATEGORIES[name], id: `kitsu-category-${CATEGORIES[name]}`, name, group: 'genre' }))
]);
const BY_KEY = new Map(CATALOG_OPTIONS.map(option => [option.key, option]));
const BY_ID = new Map(CATALOG_OPTIONS.map(option => [option.id, option]));
// Options offered earlier. Old install links and saved choices that contain
// them keep working; the retired rows are simply dropped.
const RETIRED_KEYS = new Set(['top10', 'movies', ...Object.values(CATEGORIES).filter(slug => !BY_KEY.has(slug))]);
const RETIRED_IDS = new Set(['kitsu-top10', 'kitsu-movies', ...Object.values(CATEGORIES).map(slug => `kitsu-category-${slug}`).filter(id => !BY_ID.has(id))]);
export const SEARCH_CATALOG_ID = 'kitsu-search';

// Returns catalog IDs in canonical order, or null for an invalid configuration.
export function parseConfig(text) {
  if (typeof text !== 'string' || text.length > 1000 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(text)) return null;
  const keys = new Set(text.split('.'));
  if ([...keys].some(key => !BY_KEY.has(key) && !RETIRED_KEYS.has(key))) return null;
  return CATALOG_OPTIONS.filter(option => keys.has(option.key)).map(option => option.id);
}

export function encodeConfig(ids) {
  const wanted = new Set(ids);
  return CATALOG_OPTIONS.filter(option => wanted.has(option.id)).map(option => option.key).join('.');
}

// Normalises a list of catalog IDs (from the dashboard API or the database).
// Retired options are dropped; anything else unknown is rejected.
export function normalizeCatalogIds(ids) {
  if (!Array.isArray(ids) || ids.length > 60 || ids.some(id => typeof id !== 'string' || (!BY_ID.has(id) && !RETIRED_IDS.has(id)))) return null;
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
