# HD Stremio hero backgrounds — 1.4.0

Checked on 11 November 2026 against a local HTTP instance using real Kitsu, Fribb and TMDB data. These checks do not constitute a visual test in every Stremio client.

## Real background samples

| Title | Dimensions | JPEG bytes | Delivery |
| --- | --- | --- | --- |
| Cowboy Bebop (`kitsu:1`) | 1280×720 | 191,138 | TMDB CDN |
| My Hero Academia (`kitsu:11469`) | 1280×720 | 317,727 | TMDB CDN |
| Princess Mononoke (`kitsu:142`) | 1280×720 | 146,596 | TMDB CDN |

All three samples were downloaded and visually inspected. They are wide landscape images without a title logo baked into the inspected examples. Future selection depends on provider data; language-neutral tagging cannot guarantee textless art. TMDB hosts community-contributed artwork; no claim is made that every backdrop is official promotional art.

Metadata exposes a direct `w1280` CDN URL. The matching lazy catalog route returns HTTP 302 to that URL with seven-day caching and no image body. Background bytes are not rendered, stored or proxied by Northflank. No new paid source or credential is required.

## Validation

- `npm test`: 59 automated tests pass. Added cases cover HD/landscape filtering, language preference, vote confidence, lazy catalog behavior, shared logo/background lookup, background-only matches, larger Kitsu fallback, provider outages, invalid IDs, HTTP GET/HEAD, CORS and redirect caching.
- `npm run test:hero -- <local URL>`: real TV and film images, matching redirects, retained episodes, dimensions and sample image sizes pass. The 500 KB sample check is a verification budget, not a guarantee about every future provider image.
- Existing artwork live checks pass: title-logo PNGs, composed JPEG dimensions/size, caching and episode lists.
- Existing season live checks pass: My Hero Academia's eight seasons, original Kitsu playback IDs, separate films/spin-offs, individual-season compatibility and grouped catalog pagination.

Unmatched titles and provider failures use the largest preferred Kitsu cover (`large`, then `original`, then `small`). A match can supply a background without a logo; poster fallback still works in that case. Backdrops must be JPEGs at least 1280×720, with aspect ratio 1.6–2.0. Selection prefers language-neutral, English and Japanese artwork in that order and reuses the existing conservative anime matching rules.

Stremio chooses its own featured layout and may cache old metadata for an hour. The update improves backgrounds supplied by Kitsu Anime Shelf rather than changing the client or artwork from other addons. Existing composed poster delivery and its bandwidth use are unchanged.
