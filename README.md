# Kitsu Anime Shelf

Discover anime in Stremio with 40 Kitsu category catalogs, grouped TV seasons, title logos, and HD backgrounds.

**Current release: [v1.4.3](https://github.com/MYKLHARU/kitsu-anime-shelf/releases/latest).**

- [Project website](https://myklharu.github.io/kitsu-anime-shelf/)
- [Open the hosted add-on](https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/)
- [Manifest URL](https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/manifest.json) — paste this into Stremio's add-on URL field.
- [Setup and features](kitsu-anime-addon/README.md)
- [Release notes](CHANGELOG.md)
- 2.0 release candidate (personal shelves, AniList sync, recommendations, personal Stremio rows): [architecture](docs/ARCHITECTURE-2.0.md), [security](docs/SECURITY-2.0.md), [deployment](kitsu-anime-addon/DEPLOY-2.0.md)

The add-on provides catalogs and episode metadata. Playback requires a separate stream add-on that supports Kitsu IDs.

## Development

Use Node.js 22 or newer. In `kitsu-anime-addon`, run `npm ci`, `npm test`, then `npm start`. Set `TEST_DATABASE_URL` to a disposable PostgreSQL database to include the 2.0 database and end-to-end tests.

The existing Node service serves the API and setup website. GitHub Pages publishes the same website from `docs/`, with requests directed to the hosted API. After editing `kitsu-anime-addon/public/`, run `npm run build:pages` inside `kitsu-anime-addon` and commit the generated `docs/` files. GitHub Actions checks that they remain in sync.
