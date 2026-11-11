# Kitsu Anime Shelf

A Stremio anime catalog add-on using **https://kitsu.app** directly. Browsing needs no account or Kitsu API key. Optional title logos use a free TMDB API key or Read Access Token; image composition uses the `sharp` package.

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
- Kitsu entries use absolute episode numbering. Sequels and seasons can be separate Kitsu entries.
- Known episodes include Kitsu titles, summaries, dates and thumbnails when available. Missing details fall back to numbered entries. Unknown-count shows use only actual episode numbers from Kitsu.

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
- Successful poster renders are 360×540 JPEGs below 100 KB, with seven-day browser/CDN caching and ETag/304 support. A 16 MiB byte-bounded render cache and an 8 MiB TMDB response cache avoid unbounded image storage. Successful logo resolutions last seven days; missing logos last a day; transient failures and redirects retry after a minute. There are at most two image renders and three artwork network requests in parallel, with bounded queues. Image downloads are limited to 4 MiB and decoding to 16 million pixels; only fixed Kitsu/TMDB image hosts are allowed, with redirects refused.
- There is no background poster generation or persistent image hosting. In-memory caches reset on deployment. Northflank still serves composed poster bytes; high traffic may benefit from a CDN in front of the same public origin. A week-long cache means artwork updates can take a week to appear.

TMDB is [free for non-commercial use with attribution](https://developer.themoviedb.org/docs/faq). The setup page includes its approved logo and required notice. Artwork remains the property of its respective owners.

## Checks and implementation

```
npm test
npm run test:live
npm run test:artwork -- https://YOUR-ADDON-HOST
```

The automated tests simulate provider responses and render actual image fixtures to check matching, artwork fallback, cache behavior, image limits, Stremio endpoints, 100-item catalog pagination and episode IDs. GitHub Actions runs these on Node.js 22/Linux. The Kitsu live check queries real categories, search and episodes. The artwork live check requires a running instance with TMDB credentials configured and checks real logos, posters, episodes and cache validation for a TV anime and a film.

The server implements the [Stremio add-on HTTP protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html), including CORS. Kitsu requests use the public [JSON:API](https://github.com/hummingbird-me/api-docs), 20-item upstream pages, a maximum of three concurrent requests, timeouts, caching and request deduplication. Catalogs are cached for 15 minutes; metadata for one hour. Previously fetched data can be reused for up to 24 hours during a temporary upstream outage.

Data and artwork belong to their respective providers. This is an independent, unofficial add-on and is not affiliated with Kitsu or Stremio.
