# Kitsu Anime Shelf

A complete Stremio anime catalog add-on using **https://kitsu.app** directly. No account, API key, npm packages, or Kitsu login required.

## Start and install on this computer

1. Install [Node.js](https://nodejs.org/) version 22 or newer if needed.
2. Double-click **Start-Addon.cmd**, or run `node server.mjs` in this folder.
3. Open **http://127.0.0.1:47861/** and choose **Install in Stremio**.
4. If the button does not open Stremio, paste **http://127.0.0.1:47861/manifest.json** into Stremio's add-on URL field and install it.
5. Keep the server running while using the add-on. Press Ctrl+C in its terminal to stop it.

Open Stremio's Discover view and select **Anime**. Each of your 40 categories is its own main catalog, selectable directly as Action, Adventure, Isekai, and so on. Each also appears as a separate catalog row where Stremio shows add-on catalogs. Search results appear under **Kitsu · Search**.

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

This is an ordinary Node HTTP server with no package dependencies. For a private deployment on a hosting provider, use a persistent Node.js 22+ service, start command `node server.mjs`, and environment variable `HOST=0.0.0.0`. It reads the host's `PORT` variable. The host must provide HTTPS; install `https://YOUR-HOST/manifest.json` on other devices. No deployment or public directory listing is created automatically.

## Checks and implementation

```
npm test
npm run test:live
```

The automated tests use a simulated Kitsu API to check Stremio endpoints, category mappings, 100-item catalog pagination, episode IDs, metadata fallback and error handling. The live check queries Kitsu.app and does not change any account data.

The server implements the [Stremio add-on HTTP protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html), including CORS. Kitsu requests use the public [JSON:API](https://github.com/hummingbird-me/api-docs), 20-item upstream pages, a maximum of three concurrent requests, timeouts, caching and request deduplication. Catalogs are cached for 15 minutes; metadata for one hour. Previously fetched data can be reused for up to 24 hours during a temporary upstream outage.

Data and artwork belong to their respective providers. This is an independent, unofficial add-on and is not affiliated with Kitsu or Stremio.
