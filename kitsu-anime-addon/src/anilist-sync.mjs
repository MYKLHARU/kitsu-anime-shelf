// Two-way AniList synchronisation.
//
// Policy (documented in docs/ANILIST-SYNC.md):
// - Entries are matched only through one-to-one Kitsu <-> AniList mappings.
//   Unmapped or ambiguous titles are reported, never guessed.
// - A side that changed since the last successful sync wins. If both changed
//   (or on the first sync), the more recent modification wins.
// - Entries missing on one side are copied to the other, except that an entry
//   removed on AniList after the last sync is not re-created there.
// - Local writes use the revision read at the start of the sync, and each push
//   re-reads the entry first, so an edit made in the dashboard during a sync
//   is neither overwritten locally nor replaced on AniList by a stale copy.
// - Only fields that differ are sent to AniList, so values the shelf does not
//   model (such as REPEATING) or did not change are preserved there.

const MAX_PUSHES_PER_RUN = 200;
const HEARTBEAT_MS = 60000;
const MAX_QUEUED_PER_USER = 100;
const MAX_QUEUED_USERS = 1000;
const FIELDS = ['status', 'progress', 'score'];
const sameScore = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.05);
const sameField = (field, a, b) => field === 'score' ? sameScore(a.score, b.score) : a[field] === b[field];
const sameValues = (local, remote) => FIELDS.every(field => sameField(field, local, remote));
const pick = (entry, fields) => Object.fromEntries(fields.map(field => [field, entry[field]]));

export function createAnilistSync({ anilist, accounts, library, animeStore, loadAnilistIndex, cipher, logger = console, now = () => new Date() }) {
  const tokenContext = userId => `anilist:${userId}`;

  async function credentials(userId) {
    const connection = await accounts.getConnection(userId, 'anilist');
    if (!connection) return null;
    return { connection, token: cipher.decrypt(connection.access_token_enc, tokenContext(userId)) };
  }

  async function run(userId) {
    const claim = await accounts.claimSync(userId, 'anilist');
    if (!claim) return { alreadyRunning: true };
    const lastSync = claim.last_synced_at;
    const result = { startedAt: claim.sync_started_at, imported: 0, updatedLocal: 0, exported: 0, updatedRemote: 0, unchanged: 0,
      conflicts: 0, skipped: 0, unresolved: [], onlyHere: 0, remaining: 0 };
    try {
      const { connection, token } = await credentials(userId) ?? {};
      if (!token) throw Object.assign(new Error('AniList is not connected'), { status: 404 });
      const [remote, index, localEntries] = await Promise.all([
        anilist.animeList(token, connection.external_user_id),
        loadAnilistIndex(),
        library.list(userId)
      ]);
      const local = new Map(localEntries.map(entry => [entry.animeId, entry]));
      const changedSince = date => !lastSync || (date && date > lastSync);

      // Resolve remote entries to Kitsu IDs and make sure canonical records exist.
      const mapped = [];
      for (const entry of remote) {
        const kitsuId = index.anilistToKitsu.get(entry.mediaId);
        if (kitsuId) mapped.push({ ...entry, animeId: `kitsu:${kitsuId}`, kitsuId });
        else result.unresolved.push({ anilistId: entry.mediaId, title: entry.title, reason: 'No one-to-one Kitsu mapping' });
      }
      const missing = mapped.filter(entry => !local.has(entry.animeId)).map(entry => entry.kitsuId);
      const known = missing.length ? await animeStore.ensureKitsu(missing) : new Map();

      const pushes = [];
      const seen = new Set();
      for (const entry of mapped) {
        seen.add(entry.animeId);
        const mine = local.get(entry.animeId);
        const values = { status: entry.status, progress: entry.progress, score: entry.score };
        if (!mine) {
          if (!known.has(entry.kitsuId)) {
            result.unresolved.push({ anilistId: entry.mediaId, title: entry.title, reason: 'Not found on Kitsu' });
            continue;
          }
          // Never overwrite an entry created in the dashboard during this run.
          if (await library.get(userId, entry.animeId)) { result.skipped += 1; continue; }
          await library.save(userId, entry.animeId, values);
          result.imported += 1;
          continue;
        }
        if (sameValues(mine, entry)) { result.unchanged += 1; continue; }
        const localChanged = changedSince(mine.updatedAt);
        const remoteChanged = changedSince(entry.updatedAt);
        let pull;
        if (remoteChanged && !localChanged) pull = true;
        else if (localChanged && !remoteChanged) pull = false;
        else {
          result.conflicts += 1;
          pull = (entry.updatedAt?.getTime() ?? 0) > (mine.updatedAt?.getTime() ?? 0);
        }
        if (pull) {
          try {
            await library.save(userId, entry.animeId, values, { expectedRevision: mine.revision });
            result.updatedLocal += 1;
          } catch (error) {
            if (error.status !== 412) throw error;
            result.skipped += 1; // Edited in the dashboard during this sync.
          }
        } else {
          pushes.push({ entry: mine, mediaId: entry.mediaId, update: true, fields: FIELDS.filter(field => !sameField(field, mine, entry)) });
        }
      }

      // Local entries absent from AniList.
      for (const entry of localEntries) {
        if (seen.has(entry.animeId)) continue;
        const mediaId = index.kitsuToAnilist.get(entry.animeId.slice('kitsu:'.length));
        if (!mediaId) { result.onlyHere += 1; continue; }
        if (changedSince(entry.updatedAt)) pushes.push({ entry, mediaId, update: false, fields: FIELDS });
        else result.onlyHere += 1; // Removed on AniList since the last sync; respect that.
      }

      let heartbeat = Date.now();
      for (const [i, push] of pushes.entries()) {
        if (i >= MAX_PUSHES_PER_RUN) { result.remaining = pushes.length - i; break; }
        if (Date.now() - heartbeat > HEARTBEAT_MS) { await accounts.heartbeatSync?.(userId, 'anilist'); heartbeat = Date.now(); }
        // Skip entries edited since they were read; the next sync sends the new values.
        const current = await library.get(userId, push.entry.animeId);
        if (!current || current.revision !== push.entry.revision) { result.skipped += 1; continue; }
        await anilist.saveEntry(token, { mediaId: push.mediaId, ...pick(current, push.fields) });
        result[push.update ? 'updatedRemote' : 'exported'] += 1;
      }
      result.unresolved = result.unresolved.slice(0, 200);
      result.finishedAt = now();
      // The watermark is the start time, so edits made during the run are
      // considered on the next sync. Partial runs keep the old watermark.
      await accounts.finishSync(userId, 'anilist', { status: 'succeeded', result, watermark: result.remaining ? lastSync : claim.sync_started_at });
      return result;
    } catch (error) {
      logger.error?.(`AniList sync failed: ${error.message}`);
      const failure = { ...result, error: error.unauthorized ? error.message : 'Sync failed. Try again later.', reconnect: Boolean(error.unauthorized), finishedAt: now() };
      await accounts.finishSync(userId, 'anilist', { status: 'failed', result: failure, watermark: null }).catch(() => {});
      return failure;
    }
  }

  const queues = new Map();
  async function drain(userId, queue) {
    queue.running = true;
    try {
      while (queue.changes.size) {
        const [animeId, change] = queue.changes.entries().next().value;
        queue.changes.delete(animeId);
        try {
          const creds = await credentials(userId);
          if (!creds?.connection.auto_push || creds.connection.sync_status === 'running') continue;
          const mediaId = (await loadAnilistIndex()).kitsuToAnilist.get(change.kitsuId);
          if (!mediaId) continue;
          if (change.entry) {
            if (change.fields.length) await anilist.saveEntry(creds.token, { mediaId, ...pick(change.entry, change.fields) });
          } else {
            await anilist.deleteEntry(creds.token, creds.connection.external_user_id, mediaId);
          }
        } catch (error) {
          logger.error?.(`AniList update failed: ${error.message}`);
        }
      }
    } finally {
      queue.running = false;
      if (queue.changes.size) drain(userId, queue);
      else queues.delete(userId);
    }
  }

  return Object.freeze({
    run,
    // Starts a sync in the background; status is read from the connection row.
    start(userId) {
      run(userId).catch(error => logger.error?.(`AniList sync crashed: ${error.message}`));
    },
    // Queue a dashboard change for AniList when auto-push is enabled. Changes
    // are coalesced per title and sent one user at a time, so one busy user
    // cannot flood the shared AniList rate limit. Dropped or failed changes
    // are caught up by the next sync (their local timestamp is newer).
    async pushChange(userId, animeId, entry, changes) {
      const kitsuId = /^kitsu:([1-9]\d*)$/.exec(animeId)?.[1];
      if (!kitsuId) return false;
      let queue = queues.get(userId);
      if (!queue) {
        if (queues.size >= MAX_QUEUED_USERS) return false;
        queue = { changes: new Map(), running: false };
        queues.set(userId, queue);
      }
      const previous = queue.changes.get(animeId);
      if (!previous && queue.changes.size >= MAX_QUEUED_PER_USER) return false;
      // A new local entry sends every field; an edit sends only what changed.
      const fields = !entry ? [] : entry.revision === 1 || !changes ? FIELDS : FIELDS.filter(field => Object.hasOwn(changes, field));
      const merged = new Set([...(previous?.fields ?? []), ...fields]);
      queue.changes.set(animeId, { kitsuId, entry, fields: entry ? [...merged] : [] });
      if (!queue.running) drain(userId, queue);
      return true;
    }
  });
}
