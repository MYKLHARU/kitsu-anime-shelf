import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnilistClient, fromAnilistStatus, toAnilistStatus } from '../src/anilist.mjs';
import { createAnilistSync } from '../src/anilist-sync.mjs';
import { buildAnilistIndex } from '../src/anime-store.mjs';
import { createFakeAnilist } from './helpers/fakes.mjs';

const config = { clientId: '12345', clientSecret: 'client-secret-value', redirectUri: 'https://shelf.example.org/api/v2/anilist/callback', minIntervalMs: 0 };

test('status mapping is complete and reversible', () => {
  for (const status of ['planning', 'watching', 'completed', 'on_hold', 'dropped']) assert.equal(fromAnilistStatus(toAnilistStatus(status)), status);
  assert.equal(fromAnilistStatus('REPEATING'), 'watching');
  assert.equal(fromAnilistStatus('UNKNOWN'), undefined);
});

test('AniList client: authorize URL, code exchange, list and mutations', async () => {
  assert.throws(() => createAnilistClient({ ...config, clientId: 'abc' }), TypeError);
  const fake = createFakeAnilist({ entries: [
    { mediaId: 1, status: 'watching', progress: 3, score: 7.5 },
    { mediaId: 2, status: 'REPEATING', progress: 1, score: 0 }
  ] });
  const client = createAnilistClient({ ...config, fetchImpl: fake.fetchImpl });
  const url = new URL(client.authorizeUrl('state-value'));
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: '12345', redirect_uri: config.redirectUri, response_type: 'code', state: 'state-value' });
  await assert.rejects(client.exchangeCode('bad code with spaces'), /Invalid authorisation code/);
  await assert.rejects(client.exchangeCode('wrong'), /did not accept/);
  const { accessToken, expiresAt } = await client.exchangeCode('good-code');
  assert.equal(accessToken, fake.state.token);
  assert.ok(expiresAt > new Date(Date.now() + 360 * 86400000));
  assert.deepEqual(await client.viewer(accessToken), { id: '4242', name: 'shelf_tester' });
  const list = await client.animeList(accessToken, '4242');
  assert.equal(list.length, 2, 'custom-list duplicates ignored');
  assert.deepEqual(list.map(entry => [entry.mediaId, entry.status, entry.progress, entry.score]), [[1, 'watching', 3, 7.5], [2, 'watching', 1, null]]);
  await client.saveEntry(accessToken, { mediaId: 3, status: 'on_hold', progress: 2, score: null });
  assert.deepEqual(fake.state.saves.at(-1), { mediaId: 3, status: 'PAUSED', progress: 2, scoreRaw: 0 });
  assert.equal(await client.deleteEntry(accessToken, '4242', 3), true);
  assert.equal(await client.deleteEntry(accessToken, '4242', 999), false);
  await assert.rejects(client.viewer('revoked-token'), error => error.unauthorized === true && error.status === 401);
});

test('AniList client retries once after HTTP 429', async () => {
  let calls = 0;
  const client = createAnilistClient({ ...config, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    return new Response(JSON.stringify({ data: { Viewer: { id: 1, name: 'x' } } }), { status: 200 });
  } });
  assert.deepEqual(await client.viewer('t'), { id: '1', name: 'x' });
  assert.equal(calls, 2);
});

test('AniList index uses only one-to-one mappings', () => {
  const index = buildAnilistIndex([
    { kitsu_id: 1, anilist_id: 10 }, { kitsu_id: 2, anilist_id: 20 }, { kitsu_id: 3, anilist_id: 20 },
    { kitsu_id: 4, anilist_id: 40 }, { kitsu_id: 4, anilist_id: 41 }, { kitsu_id: 5 }, { kitsu_id: 'x', anilist_id: 1 }
  ]);
  assert.deepEqual([...index.kitsuToAnilist], [['1', 10]]);
  assert.deepEqual([...index.anilistToKitsu], [[10, '1']]);
});

// Sync policy, with in-memory collaborators.
function harness({ local, remote, lastSync = null }) {
  const saved = [];
  const pushed = [];
  let finished;
  const entries = new Map(local.map(entry => [entry.animeId, { revision: 1, ...entry }]));
  const sync = createAnilistSync({
    anilist: {
      animeList: async () => remote,
      saveEntry: async (_token, entry) => { pushed.push(entry); }
    },
    accounts: {
      claimSync: async () => ({ sync_started_at: new Date('2026-06-01T00:00:00Z'), last_synced_at: lastSync }),
      getConnection: async () => ({ external_user_id: '1', access_token_enc: 'sealed', auto_push: true, sync_status: 'running' }),
      finishSync: async (_user, _provider, value) => { finished = value; }
    },
    library: {
      list: async () => [...entries.values()],
      get: async (_user, animeId) => entries.get(animeId) ?? null,
      save: async (_user, animeId, values, options = {}) => {
        const current = entries.get(animeId);
        if (options.expectedRevision !== undefined && current?.revision !== options.expectedRevision) throw Object.assign(new Error('conflict'), { status: 412 });
        saved.push({ animeId, ...values });
        entries.set(animeId, { ...current, animeId, ...values, revision: (current?.revision ?? 0) + 1 });
      }
    },
    animeStore: { ensureKitsu: async ids => new Map(ids.filter(id => id !== '99').map(id => [id, `uuid-${id}`])) },
    loadAnilistIndex: async () => buildAnilistIndex([1, 2, 3, 4, 5, 99].map(id => ({ kitsu_id: id, anilist_id: id + 100 }))),
    cipher: { decrypt: () => 'token' },
    logger: { error() {} }
  });
  return { sync, saved, pushed, entries, finished: () => finished };
}

const at = iso => new Date(iso);
test('sync: the side changed since the last sync wins; newest wins when both changed', async () => {
  const lastSync = at('2026-05-01T00:00:00Z');
  const { sync, saved, pushed } = harness({
    lastSync,
    local: [
      { animeId: 'kitsu:1', status: 'watching', progress: 5, score: null, updatedAt: at('2026-04-01T00:00:00Z') }, // remote changed
      { animeId: 'kitsu:2', status: 'watching', progress: 9, score: null, updatedAt: at('2026-05-10T00:00:00Z') }, // local changed
      { animeId: 'kitsu:3', status: 'watching', progress: 2, score: null, updatedAt: at('2026-05-20T00:00:00Z') }, // both: local newer
      { animeId: 'kitsu:4', status: 'planning', progress: 0, score: null, updatedAt: at('2026-04-01T00:00:00Z') }, // removed on AniList
      { animeId: 'kitsu:5', status: 'planning', progress: 0, score: null, updatedAt: at('2026-05-15T00:00:00Z') }  // new locally
    ],
    remote: [
      { mediaId: 101, status: 'watching', progress: 6, score: null, updatedAt: at('2026-05-05T00:00:00Z'), title: 'One' },
      { mediaId: 102, status: 'watching', progress: 7, score: null, updatedAt: at('2026-04-02T00:00:00Z'), title: 'Two' },
      { mediaId: 103, status: 'watching', progress: 1, score: null, updatedAt: at('2026-05-11T00:00:00Z'), title: 'Three' },
      { mediaId: 199, status: 'completed', progress: 1, score: 8, updatedAt: at('2026-05-11T00:00:00Z'), title: 'Gone from Kitsu' },
      { mediaId: 777, status: 'planning', progress: 0, score: null, updatedAt: at('2026-05-11T00:00:00Z'), title: 'No mapping' }
    ]
  });
  const result = await sync.run('user');
  assert.deepEqual(saved, [{ animeId: 'kitsu:1', status: 'watching', progress: 6, score: null }]);
  // Updates send only the differing fields; new AniList entries send all of them.
  assert.deepEqual(pushed, [
    { mediaId: 102, progress: 9 },
    { mediaId: 103, progress: 2 },
    { mediaId: 105, status: 'planning', progress: 0, score: null }
  ]);
  assert.equal(result.conflicts, 1);
  assert.equal(result.onlyHere, 1, 'kitsu:4 is not re-created on AniList');
  assert.deepEqual(result.unresolved.map(item => item.reason), ['No one-to-one Kitsu mapping', 'Not found on Kitsu']);
});

test('sync never overwrites a dashboard edit made during the run', async () => {
  // The library is listed at revision 1; the dashboard then saves revision 2,
  // so the sync's conditional write is refused and the entry is skipped.
  const listed = [{ animeId: 'kitsu:1', status: 'watching', progress: 5, score: null, revision: 1, updatedAt: at('2026-04-01T00:00:00Z') }];
  const sync = createAnilistSync({
    anilist: { animeList: async () => [{ mediaId: 101, status: 'completed', progress: 12, score: null, updatedAt: at('2026-05-05T00:00:00Z'), title: 'One' }], saveEntry: async () => {} },
    accounts: { claimSync: async () => ({ sync_started_at: new Date(), last_synced_at: at('2026-05-01T00:00:00Z') }), getConnection: async () => ({ external_user_id: '1', access_token_enc: 's' }), finishSync: async () => {} },
    library: { list: async () => listed, get: async () => listed[0], save: async () => { throw Object.assign(new Error('conflict'), { status: 412 }); } },
    animeStore: { ensureKitsu: async () => new Map() },
    loadAnilistIndex: async () => buildAnilistIndex([{ kitsu_id: 1, anilist_id: 101 }]),
    cipher: { decrypt: () => 'token' }, logger: { error() {} }
  });
  const result = await sync.run('user');
  assert.equal(result.skipped, 1);
  assert.equal(result.updatedLocal, 0);
});

test('sync reports reconnect when AniList rejects the token, and a running sync is not doubled', async () => {
  let finished;
  const sync = createAnilistSync({
    anilist: { animeList: async () => { throw Object.assign(new Error('AniList authorisation expired.'), { unauthorized: true, status: 401 }); } },
    accounts: { claimSync: async () => ({ sync_started_at: new Date(), last_synced_at: null }), getConnection: async () => ({ external_user_id: '1', access_token_enc: 's' }), finishSync: async (_u, _p, value) => { finished = value; } },
    library: { list: async () => [] }, animeStore: {}, loadAnilistIndex: async () => buildAnilistIndex([]), cipher: { decrypt: () => 't' }, logger: { error() {} }
  });
  const result = await sync.run('user');
  assert.equal(result.reconnect, true);
  assert.equal(finished.status, 'failed');
  const busy = createAnilistSync({ accounts: { claimSync: async () => null }, logger: {} });
  assert.deepEqual(await busy.run('user'), { alreadyRunning: true });
});

test('sync does not push a stale copy of an entry edited during the run', async () => {
  const h = harness({
    lastSync: null,
    local: [{ animeId: 'kitsu:1', status: 'watching', progress: 5, score: null, updatedAt: at('2026-05-10T00:00:00Z') }],
    remote: []
  });
  // The dashboard saves a new revision after the sync has listed the library.
  const original = h.entries.get('kitsu:1');
  const sync = createAnilistSync({
    anilist: { animeList: async () => [], saveEntry: async entry => { h.pushed.push(entry); } },
    accounts: { claimSync: async () => ({ sync_started_at: new Date(), last_synced_at: null }), getConnection: async () => ({ external_user_id: '1', access_token_enc: 's' }), finishSync: async () => {} },
    library: { list: async () => [original], get: async () => ({ ...original, progress: 6, revision: 2 }), save: async () => {} },
    animeStore: { ensureKitsu: async () => new Map() },
    loadAnilistIndex: async () => buildAnilistIndex([{ kitsu_id: 1, anilist_id: 101 }]),
    cipher: { decrypt: () => 'token' }, logger: { error() {} }
  });
  const result = await sync.run('user');
  assert.equal(h.pushed.length, 0);
  assert.equal(result.skipped, 1);
});

test('sync does not overwrite an entry created in the dashboard during the run', async () => {
  let saved = false;
  const sync = createAnilistSync({
    anilist: { animeList: async () => [{ mediaId: 101, status: 'completed', progress: 12, score: 9, updatedAt: new Date(), title: 'One' }], saveEntry: async () => {} },
    accounts: { claimSync: async () => ({ sync_started_at: new Date(), last_synced_at: null }), getConnection: async () => ({ external_user_id: '1', access_token_enc: 's' }), finishSync: async () => {} },
    library: { list: async () => [], get: async () => ({ animeId: 'kitsu:1', status: 'watching', progress: 1, score: null, revision: 1 }), save: async () => { saved = true; } },
    animeStore: { ensureKitsu: async () => new Map([['1', 'uuid']]) },
    loadAnilistIndex: async () => buildAnilistIndex([{ kitsu_id: 1, anilist_id: 101 }]),
    cipher: { decrypt: () => 'token' }, logger: { error() {} }
  });
  const result = await sync.run('user');
  assert.equal(saved, false);
  assert.equal(result.skipped, 1);
});

test('AniList client refuses truncated lists and an overlong queue', async () => {
  const endless = createAnilistClient({ ...config, fetchImpl: async () => new Response(JSON.stringify({ data: { MediaListCollection: { hasNextChunk: true, lists: [] } } }), { status: 200 }) });
  await assert.rejects(endless.animeList('t', '1'), /too large to sync/);
  const slow = createAnilistClient({ ...config, minIntervalMs: 60000, maxQueueMs: 1000,
    fetchImpl: async () => new Response(JSON.stringify({ data: { Viewer: { id: 1, name: 'x' } } }), { status: 200 }) });
  await slow.viewer('t');
  const queued = slow.viewer('t'); // waits one interval
  await assert.rejects(slow.viewer('t'), /busy/);
  queued.catch(() => {});
});
