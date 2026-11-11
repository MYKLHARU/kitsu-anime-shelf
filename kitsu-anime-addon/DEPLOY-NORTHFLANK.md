# Update the existing Northflank service

Service: [kitsu-anime-addon](https://app.northflank.com/t/toshiharus-team/project/default/services/kitsu-anime-addon)

Public URL: `https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run`

## Season-grouping update (1.3.0)

For an existing 1.2.0 deployment with working title logos, keep all current runtime variables and build settings. Merge/deploy the reviewed 1.3.0 change through the same service. TV grouping is enabled by default and requires no additional API credential or paid service. `GROUP_ANIME_SEASONS=false` disables grouping if a rollback is needed.

After deployment, confirm `/manifest.json` reports `1.3.0` and `/health` reports `seasonGrouping: true`. Run:

```text
npm run test:seasons -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run
npm run test:artwork -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run
```

Remove/reinstall or refresh the addon in Stremio, then search **My Hero Academia** in the Kitsu catalog and open the main show. It should expose seasons 1–8. Existing saved cards for individual later seasons intentionally keep their old numbering, so replace those library cards with the main show if you want the grouped view. Catalog responses can remain cached for 15 minutes and metadata for an hour. See the README for conservative matching, split-cour limitations and browsing-cache limits.

## 1. Obtain the free logo-source credential

Create/sign in to a [TMDB account](https://www.themoviedb.org/settings/api), apply for a non-commercial developer API key, and copy either the short **API Key** or the long **API Read Access Token**. Both formats are supported using separate runtime variable names. TMDB documents [authentication](https://developer.themoviedb.org/docs/authentication-application) and [free non-commercial usage with attribution](https://developer.themoviedb.org/docs/faq). The setup page supplies the required credits and approved logo.

Keep this credential in Northflank's runtime secrets. Do not commit it or paste it into an addon URL. Stremio does not need the key itself.

## 2. Configure this service

Keep the current repository, networking/public port and health check. Confirm these build settings:

| Setting | Value |
| --- | --- |
| Repository | `MYKLHARU/kitsu-anime-shelf` |
| Production branch | `main` |
| Build context / project directory | `kitsu-anime-addon/` |
| Runtime | Node.js 22 or newer |
| Dependency install / build command | `npm ci` (include optional dependencies; sharp supplies the Linux image library) |
| Start command | `npm start` or `node server.mjs` |
| Health check | `/health` |

Add these **runtime** variables to the existing service:

| Variable | Value |
| --- | --- |
| `TMDB_API_KEY` | Your private short TMDB API key |
| `PUBLIC_URL` | `https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run` |
| `HOST` | Keep `0.0.0.0` |
| `PORT` | Keep the existing working value supplied/configured by Northflank |

Alternatively, set `TMDB_READ_ACCESS_TOKEN` to the long Read Access Token instead of `TMDB_API_KEY`. If both exist, the Read Access Token takes precedence. Do not include a `Bearer ` prefix or surrounding quotes.

`PUBLIC_URL` must be the HTTPS origin with no path, credentials or query string. No volume, database, extra public port, image bucket or paid artwork plan is required. If both credentials are omitted, the addon serves its original Kitsu artwork. Credentials with a missing/invalid public URL deliberately fail startup with a configuration error.

## 3. Deploy the reviewed change

Merge the title-logo PR into `main` when ready. With CI and CD enabled for this branch, Northflank builds the commit and deploys its successful build automatically. Otherwise start a build of the merged commit and deploy it in this same service. [Northflank CI/CD documentation](https://northflank.com/docs/v1/application/release/manage-ci-cd).

The new release adds `sharp`, so a rebuild that installs dependencies is required; restarting an old image is insufficient. Keep optional npm dependencies enabled. Check build/deployment logs and confirm the service is running. No live deployment or runtime secret change is made merely by opening the PR.

## 4. Verify and refresh Stremio

1. Open [`/manifest.json`](https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/manifest.json) and confirm version `1.3.0`.
2. Open [`/health`](https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/health) and confirm `titleLogos: true`. This means configured, not that TMDB has accepted the credential.
3. Open [`/meta/series/kitsu:1.json`](https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/meta/series/kitsu:1.json): Cowboy Bebop should keep its 26 episode videos and, when TMDB has a suitable PNG, include a `logo` URL on `image.tmdb.org`. Its `poster` should use your `/artwork/v1/poster/` route.
4. In a checked-out addon directory run `npm ci`, `npm test`, then `npm run test:artwork -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run`. The final check tests real TV/film logo PNGs, JPEG size/dimensions, episodes and ETag/304 behavior. It reports failures if credentials are rejected or all sample logos fall back. Run `npm run test:live` for the broader Kitsu checks.
5. Remove the old Kitsu Anime Shelf addon from Stremio and reinstall from the same manifest URL. Restart Stremio to refresh metadata/artwork caches. Verify the Kitsu catalog cards and the title details on your device; client support for detail-page logos can vary.

If every title lacks a logo, confirm a short API key is in `TMDB_API_KEY` or a long Read Access Token is in `TMDB_READ_ACCESS_TOKEN`, and redeploy after changing it. Individual missing/ambiguous logos are expected and preserve the Kitsu poster and text name. On provider failures, short negative caches prevent repeated requests; metadata may also be cached by Stremio for an hour. Existing successful posters can remain cached for seven days.

## Bandwidth and rollback

The README describes cache sizes and matching rules. Logos on details pages are served by TMDB; posters are composed on demand and cached as small JPEGs. A missing logo produces a short-cached redirect to Kitsu, avoiding proxying the original image through Northflank. No claim is made that Northflank bandwidth is unlimited or that every anime has an official-source logo.

For a quick fallback, remove both `TMDB_API_KEY` and `TMDB_READ_ACCESS_TOKEN` and redeploy: new metadata/catalog responses use original Kitsu artwork. Old cached poster URLs still redirect to Kitsu without credentials. Client-cached successful overlays can remain until their seven-day expiry. To roll back all code, deploy the previous known-good Northflank build.
