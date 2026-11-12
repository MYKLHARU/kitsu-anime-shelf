# Kitsu Anime Shelf

A Stremio anime catalog add-on using **https://kitsu.app** directly. Browsing needs no account or Kitsu API key. Optional title logos use a free TMDB API key or Read Access Token; image composition uses the `sharp` package.

Current release: **1.4.3**. See [release notes](../CHANGELOG.md) and the [project website](https://myklharu.github.io/kitsu-anime-shelf/).

## Start and install on this computer

1. Install [Node.js](https://nodejs.org/) version 22 or newer if needed.
2. Double-click **Start-Addon.cmd** (installs dependencies on first run), or run `npm ci` then `node server.mjs` in this folder.
3. Open **http://127.0.0.1:47861/** and choose **Install in Stremio**.
4. If the button does not open Stremio, paste **http://127.0.0.1:47861/manifest.json** into Stremio's add-on URL field and install it.
5. Keep the server running while using the add-on. Press Ctrl+C in its terminal to stop it.

Open Stremio's Discover view and select **Series**. These are anime catalogs, but they use Stremio's Series content type so individual anime can open their episode lists. Each of your 40 categories is its own main catalog, selectable directly as Action, Adventure, Isekai, and so on. Each also appears as a separate catalog row where Stremio shows add-on catalogs. Search results appear under **Kitsu · Search**.

If you installed version 1.0.0, remove that add-on in Stremio and install again from the setup page so Stremio reads the updated catalog list.

The local address works on the computer running this server. It does not provide a public service or work from a different phone/TV by itself.

## Included catalogs

Your 40 main category catalogs appear first, in the requested order, with titles ranked by Kitsu popularity. Four general browse catalogs and one search catalog follow:

- Popular: ranked by Kitsu popularity.
- Top Rated: ranked by Kitsu's average rating; this is not an IMDb rating.
- Currently Airing: titles Kitsu marks as `current`, ranked by popularity.
- Anime Movies: Kitsu's movie subtype, ranked by popularity.
- Search: Kitsu title search.

These are the **40 main category catalogs**, in the requested order:

Action, Adventure, Asia, Children, Comedy, Demon, Drama, Earth, Ecchi, Fantasy, Fantasy World, Harem, Historical, Horror, Isekai, Japan, Josei, Magic, Martial Arts, Mecha, Military, Music, Mystery, Present, Psychological, Romance, School Life, Science Fiction, Seinen, Shoujo, Shoujo Ai, Shounen, Shounen Ai, Slice of Life, Sports, Supernatural, Superpower, Thriller, Violence, Yaoi.

**Category mappings:** Children uses Kitsu's `kids` category; Superpower uses `super-power`. The other labels map directly to their Kitsu category slugs. These mappings were checked against the live category API on 10 November 2026. Public API visibility follows Kitsu's unauthenticated-content rules, so some categories may have limited or empty results.

## Episodes and playback

The add-on serves catalogs and metadata. Playback comes from a separate stream add-on that understands Kitsu IDs.

- Anime IDs: `kitsu:1`
- Episode IDs: `kitsu:1:1`
- Metadata type: `series`, including single-episode anime films.
- Kitsu entries use local/absolute episode numbers within each Kitsu entry. Reliably mapped TV seasons are now presented under one main show; see below.
- At most ten pages (200 episode-detail records) are fetched per metadata request. Known episodes include Kitsu titles, summaries, dates and thumbnails when available. Missing details fall back to numbered entries. Unknown-count shows use only actual episode numbers from Kitsu.

## Grouped TV seasons

Version 1.3.0 groups TV anime when the mapping source supplies an explicit, unambiguous TMDB show ID and consecutive season numbers starting at 1. For example, My Hero Academia opens as one catalog entry (`kitsu:11469`) with seasons 1–8 and 170 episodes in the current Kitsu data. Season 2 episode 1 still uses `kitsu:12268:1`; only its displayed season changes. Stream addons continue receiving the original Kitsu video IDs.

- Films, OVAs, specials, music videos and separately mapped spin-offs remain separate. Similar names and collection membership are never used as evidence for grouping.
- Missing season numbers, multiple Kitsu entries for the same season, cross-show ID conflicts and split-cour episode offsets leave the affected show ungrouped. This deliberately limits coverage to straightforward mappings; some well-known shows will still have separate entries.
- The first-season Kitsu ID, name and artwork become the main catalog card. Selecting a later season in search leads to that same card. Details collect episodes, release years and genres across the mapped seasons; title-logo lookup runs only for the main card.
- Existing saved individual-season cards retain their original metadata and numbering. Open the main show from a freshly loaded Kitsu catalog/search to see the grouped version, then add that card to your library if desired. No saved library records are changed automatically.
- Catalog pagination counts unique shows and fetches more upstream pages to fill a page after merging duplicates. Search cursors (up to sixteen) last 15 minutes; fixed-catalog cursors (up to 64) stay with their cached first page, as described under Category loading speed. Cursors are limited to 10,000 show positions. Deep uncached jumps over 500 positions ask the client to reopen the catalog instead of scanning thousands of upstream pages. Main-show cards missing from the raw result are loaded in batches of 20.
- Grouping and artwork share one daily mapping download. A recent mapping index can be reused for up to seven days during a source outage, including across restarts when the best-effort local cache survives. Set `ANIME_MAPPING_CACHE_PATH` to a writable persistent path if required; the default system temporary directory may reset on deployment. Without a recent index, original individual entries remain usable. Known episode counts supply numbered episodes during episode-detail outages. If an entire required season cannot be fetched, grouped details return a retryable error rather than quietly omitting that season.
- Grouping is on by default. For rollback set `GROUP_ANIME_SEASONS=false` and restart/redeploy; leave the existing TMDB settings unchanged.

## Category loading speed

Every fixed catalog, including grouped categories and Anime Movies, keeps a complete first-page cache. Pages are fresh for 15 minutes; after that, the previous complete page can be served for up to 24 hours while it refreshes in the background. Only one catalog refresh runs at a time, and failed refreshes wait a minute before retrying. The cache holds at most 64 pages and resets when the process restarts. A first uncached visit still depends on Kitsu's response time.

Catalog requests select only the title/artwork fields needed by cards. They no longer expand the category relationships for every title. Category filtering still happens at Kitsu; filtered cards retain the selected genre label, while complete genre lists are fetched on the details page. All 100 catalog slots and season grouping remain intact. Detail/episode requests and catalog-completion work take priority over queued first-row and background work, with the same maximum of three concurrent Kitsu requests.

Grouped catalogs page through one browsing cursor per catalog. The cached first page and the cursor for later pages are replaced together: a background refresh builds a new cursor separately and installs it only when its new first page replaces the cached one. A client that received an older first page therefore keeps getting matching later pages until the refresh lands, and a failed refresh keeps both. Search results still use live 15-minute cursors.

## Run elsewhere

For Render, follow **[DEPLOY-RENDER.md](DEPLOY-RENDER.md)**. An optional `render.yaml` Blueprint is included with the Free plan and required host configuration.

For the existing Northflank service, follow **[DEPLOY-NORTHFLANK.md](DEPLOY-NORTHFLANK.md)**, including title-logo setup and checks.

This is a Node HTTP server using `sharp` for poster composition. Use a Node.js 22+ service, build command `npm ci`, start command `node server.mjs`, and environment variable `HOST=0.0.0.0`. It reads the host's `PORT` variable. The host must provide HTTPS; install `https://YOUR-HOST/manifest.json` on other devices.

## Anime title logos

Set `TMDB_API_KEY` (or `TMDB_READ_ACCESS_TOKEN`) and `PUBLIC_URL` as described in the Northflank guide. With neither credential, the original Kitsu artwork and text titles continue working. Never put credentials in Git, client scripts, or a manifest URL.

- Catalogs and metadata use a lazy poster endpoint. Browsing a catalog performs no artwork lookups; only posters actually requested by a client are composed.
- Matches use the free [Fribb anime ID mappings](https://github.com/Fribb/anime-lists), fetched once per day per running instance. The approximately 6 MB source is reduced to an in-memory Kitsu/TMDB index and never served to clients. A mapping outage retains the last index and retries after five minutes.
- Unmapped titles can match only Japanese-language animation with an exact normalized canonical/localized title and the same release year. Ambiguous matches are rejected. Movie and TV IDs stay separate. Mappings are community-maintained and can still contain errors.
- Logos prefer English, then language-neutral, then Japanese PNGs. These are existing title designs supplied through TMDB, not recreated logos; coverage and accuracy vary. An explicitly mapped TV sequel may share its parent series logo.
- Poster art stays from Kitsu for mapped TV entries, preserving season-specific artwork. Films and exact title/year matches prefer a textless TMDB poster when available. Otherwise the Kitsu image gets a shaded lower panel with the logo. Existing lettering baked into the source image may remain visible.
- Detail pages use `meta.logo` pointing directly to TMDB's image CDN. Missing logos leave Stremio's regular text title. Poster failures redirect to the original Kitsu image; artwork problems do not change Kitsu IDs or episode lists.
- Successful poster renders are 360×540 JPEGs below 100 KB, with seven-day browser/CDN caching and ETag/304 support. A 32 MiB byte-bounded render cache, an 8 MiB source-image cache and an 8 MiB TMDB response cache avoid unbounded storage. Successful logo resolutions last seven days; missing logos last a day; transient failures and redirects retry after a minute. There are at most two image renders, three TMDB API requests and four CDN image downloads in parallel, with bounded queues. Image downloads are limited to 4 MiB and decoding to 16 million pixels; only fixed Kitsu/TMDB image hosts are allowed, with redirects refused.
- There is no background poster generation or persistent image hosting. In-memory caches reset on deployment. Northflank still serves composed poster bytes; high traffic may benefit from a CDN in front of the same public origin. A week-long cache means artwork updates can take a week to appear.

TMDB is [free for non-commercial use with attribution](https://developer.themoviedb.org/docs/faq). The setup page includes its approved logo and required notice. Artwork remains the property of its respective owners.

Version 1.3.2 speeds up custom poster overlays without removing the title logos. It composites and JPEG-encodes once, uses the fast JPEG encoder rather than the slower mozjpeg settings, and avoids intermediate JPEG/PNG encode/decode passes. Repeated source images are cached and deduplicated, and image downloads have their own queue so they do not wait behind unrelated title-logo API lookups. Corrupt source images are invalidated so a short fallback does not turn into a day-long bad cache entry. JPEGs can be slightly larger than the previous output but remain below 100 KB; the artwork layout is unchanged. First-time posters can still wait for upstream images, especially during large bursts or provider outages.

## Stremio hero backgrounds

Version 1.4.0 supplies wide HD backgrounds for the Kitsu addon cards and details pages. It reuses the same conservative TMDB match and images response as title logos, so a background does not require another provider lookup. Backgrounds work even when the matched title has no logo.

- Prefer language-neutral JPEG backdrops, then English, then Japanese. Candidates must be at least 1280×720 and near 16:9; ranking balances community ratings with vote confidence. A language-neutral tag is a preference, not a guarantee that an image contains no lettering.
- Use TMDB's `w1280` CDN variant instead of transferring multi-megabyte original images. Details expose the CDN URL directly. Catalog cards receive a lazy background URL that returns a cacheable redirect only when Stremio requests the image. Catalog loading performs no new artwork lookups.
- Northflank does not download, render, cache or proxy background image bytes. Successful redirects are cached for seven days; Kitsu fallback redirects for five minutes. Background selection shares the existing bounded artwork caches, deduplication and provider queues.
- Missing matches, unsuitable backdrops and provider failures use the larger available Kitsu cover, including when TMDB is not configured. Posters, logos and original playback IDs keep their existing behavior.
- Stremio chooses the hero layout and which catalogs appear in its featured area. This improves artwork supplied by this addon; it does not change the client's layout or other addons' images. Refresh/restart Stremio after deployment; previously loaded metadata can remain cached for an hour.

See [VERIFIED-HERO.md](VERIFIED-HERO.md) for sample dimensions, sizes and checks.

## Checks and implementation

```
npm test
npm run test:live
npm run test:artwork -- https://YOUR-ADDON-HOST
npm run test:hero -- https://YOUR-ADDON-HOST
npm run test:seasons
npm run test:seasons -- https://YOUR-ADDON-HOST
```

The automated tests check conservative season grouping, playback IDs, old individual-season links, unique-show pagination, provider failures, artwork rendering and HTTP behavior. GitHub Actions runs these on Node.js 22/Linux. The Kitsu live check queries real categories with grouping enabled, search and episodes. The season check validates My Hero Academia's eight seasons, separate films/spin-offs, existing individual-season compatibility and two full grouped catalog pages. Without an argument it queries providers directly; with a service URL it checks the running addon. The artwork and hero live checks require TMDB credentials on the running instance. The hero check validates three real backgrounds, CDN redirects, image dimensions/size and retained episode lists.

The server implements the [Stremio add-on HTTP protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html), including CORS. Kitsu requests use the public [JSON:API](https://github.com/hummingbird-me/api-docs), 20-item upstream pages, a maximum of three concurrent requests, timeouts, caching and request deduplication. Catalogs are cached for 15 minutes; metadata for one hour. Previously fetched data can be reused for up to 24 hours during a temporary upstream outage.

Data and artwork belong to their respective providers. This is an independent, unofficial add-on and is not affiliated with Kitsu or Stremio.
