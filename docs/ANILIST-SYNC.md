# AniList synchronisation

## Connecting

The dashboard starts AniList's [authorization code grant](https://anilist.gitbook.io/anilist-apiv2-docs/docs/guide/auth/authorization-code). The server creates a single-use, ten-minute `state` value bound to the signed-in user, and stores only its hash. The callback must present that state from the same user's session. The authorisation code is exchanged server-side with the client secret. AniList access tokens last one year and cannot be refreshed; they are encrypted with AES-256-GCM (key `TOKEN_ENCRYPTION_KEY`, bound to the user ID) and never returned to the browser. An expired or revoked token makes the next sync fail with a "reconnect" message.

One AniList account can be linked to only one shelf.

## Matching titles

Shelf entries are keyed by Kitsu ID. AniList media IDs are matched using the [Fribb anime-lists](https://github.com/Fribb/anime-lists) mapping that the add-on already downloads daily. Only **one-to-one** pairs are used: if an AniList ID maps to several Kitsu IDs, or the reverse, the title is reported as unmatched. Unmatched AniList titles are listed in the dashboard after each sync (up to 200), and nothing is guessed from similar names.

AniList tracks each season separately, so synced entries refer to individual Kitsu season entries. Their IDs remain valid in Stremio.

## What a sync does

On each run (the first starts automatically after connecting; afterwards **Sync now**, at most six times an hour):

1. Read the whole AniList anime list (custom lists are ignored; "Repeating" counts as Watching).
2. **AniList entry, nothing local:** import it.
3. **Both sides, same values:** nothing to do.
4. **Both sides, different values:** the side that changed since the last successful sync wins. If both changed, or this is the first sync, the more recently modified side wins (counted as a conflict in the summary).
5. **Local entry, not on AniList:** sent to AniList if it changed since the last sync (or on the first sync). If it did not change, it was presumably removed on AniList, so it is **not** re-created there.
6. Local writes are conditional on the revision read at the start of the sync, and each entry is re-read just before it is sent to AniList. A change made in the dashboard during a sync is neither overwritten here nor replaced on AniList by a stale copy; that entry is skipped and reconciled next time. Titles added in the dashboard during a sync are not overwritten by the import.

Only fields that actually differ are sent to AniList. Values the shelf does not model, such as AniList's Rewatching status, are preserved unless the status itself changes.

Values compared: status, episode progress and score. Scores use AniList's 0–100 raw scale (shown as 0–10 with one decimal); an unscored entry is `0` on AniList and empty on the shelf.

AniList allows roughly 30 requests per minute, so the client spaces requests about two seconds apart and honours `Retry-After`. If the shared AniList request queue is more than two minutes long, new requests are refused with "AniList is busy" instead of waiting indefinitely. AniList lists over 10,000 entries are not synced, because a partial list would make local titles look removed. A sync sends at most 200 changes; the summary then shows how many remain, and the next sync continues (the last-sync watermark is not advanced for a partial run).

## Automatic updates

With **Send dashboard changes to AniList immediately** on (the default), each dashboard edit is sent to AniList shortly afterwards, and removing a title from the shelf removes it from AniList. Only the fields you changed are sent (for example, changing progress does not touch the AniList score). Changes are queued per user, combined per title, and limited to 100 pending titles; anything dropped or failed is caught up by the next sync. Turning the option off leaves AniList untouched until you press **Sync now**.

## Disconnecting

**Disconnect** deletes the stored token and sync state. Shelf entries stay, and nothing is removed from AniList. To revoke the application's access entirely, also remove it under AniList's account settings (Apps).
