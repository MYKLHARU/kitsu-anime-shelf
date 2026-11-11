# Poster-speed verification — 11 November 2026

Release: 1.3.2. Recorded before deployment.

The user clarified that the remaining delay was in the poster pictures. The separately approved category fix (PR #4, version 1.3.1) is already deployed; all 44 fixed catalog pages passed, with repeated responses measuring 0.050 seconds median and 0.096 seconds maximum in that check.

## Poster measurements before this change

A public-service sample selected 35 distinct posters from the first 12 Action, Romance and Music cards, using 12 parallel requests. The first pass measured 3.999 seconds median and 5.435 seconds maximum. The repeat pass measured 0.162 seconds median and 0.301 seconds maximum. Three titles used the existing original-image fallback. These observations include network/provider variability and are not a controlled universal performance guarantee.

Poster generation was doing intermediate JPEG and PNG encoding and used mozjpeg for the final JPEG. Title lookups and source-image downloads shared a three-slot queue, so image downloads could wait behind unrelated lookups. Finished images had a 16 MiB cache.

## Change and checks

- Composite and JPEG-encode once, using a raw trimmed logo. Remove mozjpeg settings in favor of the fast JPEG encoder. Sharp's [JPEG documentation](https://sharp.pixelplumbing.com/api-output/#jpeg) describes mozjpeg as the slower file-size optimization.
- A 20-iteration encoder-only probe using one real poster/logo pair measured 24.25 ms CPU per image with mozjpeg versus 4.65 ms without it (about 81% less CPU for that stage). This is an encoder microbenchmark on the local machine, not a claim about whole-request or hosted-server speed. The test JPEG sizes were 51,573 and 57,621 bytes respectively.
- Separate the three-slot TMDB API queue from a four-slot image-download queue. Keep at most two render jobs active and preserve bounded queues.
- Increase the bounded finished-poster cache to 32 MiB (maximum 512 entries); add an 8 MiB/256-entry validated source-image cache with deduplicated downloads. This reuses common logos and avoids redownloading sources when a finished poster is evicted. Invalid sources are cleared, and both input operations settle before fallback cleanup.
- Maintain 360×540 JPEGs below 100 KB, original-image fallback, the same logo layout, allowed-host checks, no redirects for backend downloads, 4 MiB source limits and 16-million-pixel limits.
- `npm test`: 51 passing tests. New checks cover source reuse after render eviction, image downloads while the API queue is blocked, image-size limits for noisy artwork, and recovery after corrupt source images.
- A temporary local HTTP server passed real eight-season/170-episode My Hero Academia checks, preserved video IDs, search exclusions, two full unique catalog pages and authenticated title-logo checks. Cowboy Bebop's JPEG measured 54,060 bytes and Princess Mononoke's 44,256 bytes. ETag/304 checks passed. The new Cowboy Bebop render was visually inspected and retained the centered logo/lower shading. Representative RSS after the checks was about 133 MiB, not a peak-memory guarantee.
- No new packages, runtime secrets, disk volumes, paid services or hosting-plan changes are required. `git diff --check` passes.

After approved deployment, repeat the public parallel-poster sample and the season/artwork smoke checks. First-time network lookups and very large bursts can still take time; cached repeats should not require re-rendering.
