# Kitsu Anime Shelf

Discover anime in Stremio with 40 Kitsu category catalogs, grouped TV seasons, title logos, and HD backgrounds.

**Current release: [v1.4.1](https://github.com/MYKLHARU/kitsu-anime-shelf/releases/latest).**

- [Project website](https://myklharu.github.io/kitsu-anime-shelf/)
- [Open the hosted add-on](https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/)
- [Manifest URL](https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/manifest.json) — paste this into Stremio's add-on URL field.
- [Setup and features](kitsu-anime-addon/README.md)
- [Release notes](CHANGELOG.md)

The add-on provides catalogs and episode metadata. Playback requires a separate stream add-on that supports Kitsu IDs.

## Development

Use Node.js 22 or newer. In `kitsu-anime-addon`, run `npm ci`, `npm test`, then `npm start`.

The existing Node service serves the API and setup website. GitHub Pages publishes the same website from `docs/`, with requests directed to the hosted API. After editing `kitsu-anime-addon/public/`, run `npm run build:pages` inside `kitsu-anime-addon` and commit the generated `docs/` files. GitHub Actions checks that they remain in sync.
