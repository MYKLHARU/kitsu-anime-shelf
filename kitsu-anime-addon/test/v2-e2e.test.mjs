// End-to-end tests for Kitsu Anime Shelf 2.0: the real HTTP server and
// PostgreSQL, with Kitsu, AniList and the mapping list replaced by fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAddonServer, manifest as publicManifest, VERSION } from '../src/addon.mjs';
import { prepareV2 } from '../src/v2.mjs';
import { createClient, createFakeAnilist, createFakeKitsuApi, kitsuAnime } from './helpers/fakes.mjs';
import { createTestDatabase, dbSkip } from './helpers/db.mjs';

const quiet = { log() {}, error() {}, warn() {} };
const KEY = 'a'.repeat(64);

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startServer({ db, anilist, extraEnv = {} }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const kitsu = createFakeKitsuApi([
    kitsuAnime(1, { title: 'Sword Saga', categories: ['action', 'fantasy', 'japan'], episodeCount: 12 }),
    kitsuAnime(2, { title: 'Isekai Days', categories: ['isekai', 'fantasy'], episodeCount: 24 }),
    kitsuAnime(3, { title: 'Mecha Storm', categories: ['mecha', 'action'], episodeCount: 26 }),
    kitsuAnime(4, { title: 'Quiet Romance', categories: ['romance', 'school-life'], episodeCount: 13 }),
    kitsuAnime(5, { title: 'Dragon Isekai', categories: ['isekai', 'fantasy', 'action'], episodeCount: 12, rating: '85.00' }),
    kitsuAnime(6, { title: 'Fantasy Quest', categories: ['fantasy', 'adventure'], episodeCount: 25 }),
    kitsuAnime(7, { title: 'Song Clip', categories: ['fantasy', 'music'], episodeCount: 1, subtype: 'music' }),
    kitsuAnime(8, { title: 'Unmapped Show', categories: ['comedy'], episodeCount: 10 })
  ]);
  const mappings = [1, 2, 3, 4, 5, 6].map(id => ({ kitsu_id: id, anilist_id: 100 + id, type: 'TV' }))
    // Ambiguous: AniList 900 maps to two Kitsu entries and must not be used.
    .concat([{ kitsu_id: 8, anilist_id: 900 }, { kitsu_id: 9, anilist_id: 900 }]);
  const v2 = await prepareV2({
    env: { ACCOUNTS_ENABLED: 'true', PUBLIC_URL: base, DATABASE_URL: 'postgres://unused', TOKEN_ENCRYPTION_KEY: KEY, TRUST_PROXY_HOPS: '1',
      ANILIST_CLIENT_ID: '12345', ANILIST_CLIENT_SECRET: 'client-secret-value', ...extraEnv },
    version: VERSION, db: db.pool, fetchImpl: anilist.fetchImpl, anilistMinIntervalMs: 0, logger: quiet
  });
  assert.ok(v2, '2.0 should start with a complete configuration');
  const server = createAddonServer({ v2, api: kitsu, loadMappings: async () => mappings, logger: quiet, token: '', apiKey: '' });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base, server, kitsu, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

let ipCounter = 0;
const client = (base, options = {}) => {
  const c = createClient(base, options);
  const ip = `203.0.113.${++ipCounter}`;
  const request = c.request;
  c.request = (path, opts = {}) => request(path, { ...opts, headers: { 'X-Forwarded-For': ip, ...opts.headers } });
  return c;
};
const until = async (check, timeout = 5000) => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

test('Kitsu Anime Shelf 2.0 end to end', { skip: dbSkip, timeout: 120000 }, async t => {
  const db = await createTestDatabase();
  const anilist = createFakeAnilist({ entries: [
    { mediaId: 102, status: 'watching', progress: 5, score: 8.5, title: 'Isekai Days' },
    { mediaId: 103, status: 'completed', progress: 26, score: 9, title: 'Mecha Storm' },
    { mediaId: 555, status: 'planning', progress: 0, title: 'No Mapping Show' },
    { mediaId: 900, status: 'planning', progress: 0, title: 'Ambiguous Show' }
  ] });
  const app = await startServer({ db, anilist });
  t.after(async () => { await app.close(); await db.drop(); });
  const { base } = app;
  const alice = client(base);
  const bob = client(base);

  await t.test('public add-on is unchanged and reports 2.0 capabilities', async () => {
    const manifest = await alice.request('/manifest.json');
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.id, 'personal.kitsu.anime.shelf');
    assert.deepEqual(manifest.body.idPrefixes, ['kitsu:']);
    assert.equal(manifest.body.catalogs.length, publicManifest.catalogs.length);
    assert.equal(manifest.body.behaviorHints.configurationRequired, true, 'plain install shows no rows');
    const configured = await alice.request('/c/trending.isekai/manifest.json');
    assert.deepEqual(configured.body.catalogs.map(catalog => catalog.id), ['kitsu-trending', 'kitsu-category-isekai', 'kitsu-search']);
    const trending = await alice.request('/c/trending.isekai/catalog/series/kitsu-trending.json');
    assert.deepEqual(trending.body.metas.slice(0, 2).map(meta => meta.id), ['kitsu:5', 'kitsu:2'], 'Kitsu trending order');
    assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
    const health = await alice.request('/health');
    assert.equal(health.body.accounts, true);
    assert.equal(health.body.anilist, true);
    const meta = await alice.request('/meta/series/kitsu:1.json');
    assert.equal(meta.body.meta.id, 'kitsu:1');
    assert.equal(meta.body.meta.videos[0].id, 'kitsu:1:1');
    const dashboard = await alice.request('/dashboard', { raw: true });
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(dashboard.headers.get('x-frame-options'), 'DENY');
  });

  await t.test('registration validates input and sets a hardened session cookie', async () => {
    assert.equal((await alice.request('/api/v2/auth/register', { method: 'POST', body: { email: 'not-an-email', password: 'long enough password' } })).status, 400);
    assert.equal((await alice.request('/api/v2/auth/register', { method: 'POST', body: { email: 'alice@example.com', password: 'short' } })).status, 400);
    const created = await alice.request('/api/v2/auth/register', { method: 'POST', body: { email: 'Alice@Example.com', password: 'correct horse battery', displayName: 'Alice' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, 'alice@example.com');
    assert.equal(created.body.user.password_hash, undefined);
    const cookie = created.headers.getSetCookie()[0];
    assert.match(cookie, /^kas_session=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Lax; Max-Age=\d+; HttpOnly$/);
    const duplicate = await bob.request('/api/v2/auth/register', { method: 'POST', body: { email: 'alice@example.com', password: 'another long password' } });
    assert.equal(duplicate.status, 409);
    assert.equal((await bob.request('/api/v2/auth/register', { method: 'POST', body: { email: 'bob@example.com', password: 'bob has a long password' } })).status, 201);
    const me = await alice.request('/api/v2/me');
    assert.equal(me.body.user.displayName, 'Alice');
    assert.equal(me.body.anilist.connected, false);
  });

  await t.test('rejects cross-site and malformed state-changing requests', async () => {
    const path = '/api/v2/library/kitsu%3A1';
    assert.equal((await alice.request(path, { method: 'PATCH', body: { progress: 1 }, headers: { Origin: undefined } })).status, 403);
    assert.equal((await alice.request(path, { method: 'PATCH', body: { progress: 1 }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await alice.request(path, { method: 'PATCH', body: { progress: 1 }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await alice.request(path, { method: 'PATCH', body: '{"progress":1}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await alice.request('/api/v2/me/sessions/revoke-others', { method: 'POST', headers: { Origin: 'null' } })).status, 403);
    assert.equal((await alice.request('/api/v2/me', { headers: { Origin: 'https://evil.example' } })).status, 403);
    const anonymous = client(base);
    assert.equal((await anonymous.request('/api/v2/library')).status, 401);
    assert.equal((await anonymous.request('/api/v2/me', { headers: { Cookie: 'kas_session=forged-token-value' } })).status, 401);
  });

  await t.test('login is generic on failure and rate limited', async () => {
    const attacker = client(base);
    const wrong = await attacker.request('/api/v2/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'wrong password!' } });
    const unknown = await attacker.request('/api/v2/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong password!' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    let last;
    for (let i = 0; i < 10; i += 1) last = await attacker.request('/api/v2/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: `guess ${i} guess` } });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    const second = client(base);
    const login = await second.request('/api/v2/auth/login', { method: 'POST', body: { email: 'ALICE@example.com', password: 'correct horse battery' } });
    assert.equal(login.status, 200);
    assert.equal((await second.request('/api/v2/me/sessions')).body.sessions.length, 2);
  });

  await t.test('library CRUD with canonical records, validation and optimistic concurrency', async () => {
    const add = await alice.request('/api/v2/library/kitsu%3A1', { method: 'PATCH', body: { status: 'watching', progress: 3 } });
    assert.equal(add.status, 200);
    assert.equal(add.body.revision, 1);
    assert.equal(add.headers.get('etag'), '"1"');
    assert.equal((await alice.request('/api/v2/library/kitsu%3A1', { method: 'PATCH', body: { progress: 13 } })).status, 400, 'beyond episode count');
    assert.equal((await alice.request('/api/v2/library/kitsu%3A999', { method: 'PATCH', body: { status: 'planning' } })).status, 404, 'unknown on Kitsu');
    assert.equal((await alice.request('/api/v2/library/anilist%3A1', { method: 'PATCH', body: { status: 'planning' } })).status, 400, 'non-Kitsu ID');
    assert.equal((await alice.request('/api/v2/library/kitsu%3A1', { method: 'PATCH', body: { status: 'binge' } })).status, 400);
    const updated = await alice.request('/api/v2/library/kitsu%3A1', { method: 'PATCH', body: { score: 9 }, headers: { 'If-Match': '"1"' } });
    assert.equal(updated.status, 200);
    assert.deepEqual([updated.body.status, updated.body.progress, updated.body.score, updated.body.revision], ['watching', 3, 9, 2]);
    const stale = await alice.request('/api/v2/library/kitsu%3A1', { method: 'PATCH', body: { progress: 4 }, headers: { 'If-Match': '"1"' } });
    assert.equal(stale.status, 412);
    await alice.request('/api/v2/library/kitsu%3A5', { method: 'PATCH', body: { status: 'completed', progress: 12, score: 10 } });
    await alice.request('/api/v2/library/kitsu%3A4', { method: 'PATCH', body: { status: 'dropped', progress: 2 } });
    const list = await alice.request('/api/v2/library');
    assert.equal(list.body.entries.length, 3);
    const sword = list.body.entries.find(entry => entry.animeId === 'kitsu:1');
    assert.equal(sword.anime.title, 'Sword Saga');
    assert.equal(sword.anime.episodeCount, 12);
    assert.deepEqual(sword.anime.categories.sort(), ['action', 'fantasy', 'japan']);
    assert.equal((await alice.request('/api/v2/library?status=watching')).body.entries.length, 1);
    assert.equal((await alice.request('/api/v2/library?status=nope')).status, 400);
    // Isolation: Bob sees none of Alice's entries.
    assert.equal((await bob.request('/api/v2/library')).body.entries.length, 0);
    assert.equal((await bob.request('/api/v2/library/kitsu%3A1')).status, 404);
    assert.equal((await bob.request('/api/v2/library/kitsu%3A1', { method: 'DELETE' })).status, 404);
    // Delete and re-add.
    assert.equal((await alice.request('/api/v2/library/kitsu%3A4', { method: 'DELETE' })).status, 200);
    assert.equal((await alice.request('/api/v2/library')).body.entries.length, 2);
  });

  await t.test('recommendations follow taste and exclude the library', async () => {
    const recs = await alice.request('/api/v2/recommendations');
    assert.equal(recs.status, 200);
    const ids = recs.body.metas.map(meta => meta.id);
    assert.ok(ids.length > 0);
    assert.ok(!ids.includes('kitsu:1') && !ids.includes('kitsu:5'), 'library titles excluded');
    assert.ok(!ids.includes('kitsu:7'), 'music videos excluded');
    assert.ok(recs.body.metas.every(meta => typeof meta.reason === 'string' && meta.type === 'series'));
    // Alice likes isekai/fantasy/action; Isekai Days should beat Quiet Romance.
    assert.ok(ids.indexOf('kitsu:2') >= 0 && (ids.indexOf('kitsu:4') === -1 || ids.indexOf('kitsu:2') < ids.indexOf('kitsu:4')));
    const cold = await bob.request('/api/v2/recommendations');
    assert.ok(cold.body.metas.every(meta => meta.reason === 'Popular on Kitsu'));
  });

  await t.test('personal Stremio catalogs via revocable install tokens', async () => {
    const created = await alice.request('/api/v2/stremio/tokens', { method: 'POST', body: { label: 'TV' } });
    assert.equal(created.status, 201);
    const manifestUrl = new URL(created.body.manifestUrl);
    assert.equal(manifestUrl.origin, base);
    assert.match(created.body.installUrl, /^stremio:\/\/127\.0\.0\.1:\d+\/u\/[A-Za-z0-9_-]{43}\/manifest\.json$/);
    const stremio = client(base, { origin: null });
    const manifest = await stremio.request(manifestUrl.pathname);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.body.id, 'personal.kitsu.anime.shelf.mine');
    assert.deepEqual(manifest.body.idPrefixes, ['kitsu:']);
    assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
    const prefix = manifestUrl.pathname.replace('/manifest.json', '');
    const watching = await stremio.request(`${prefix}/catalog/series/shelf-watching.json`);
    assert.deepEqual(watching.body.metas.map(meta => meta.id), ['kitsu:1']);
    assert.equal(watching.body.metas[0].type, 'series');
    assert.match(watching.body.metas[0].description, /Watched 3 of 12 episodes/);
    const completed = await stremio.request(`${prefix}/catalog/series/shelf-completed/skip=0.json`);
    assert.deepEqual(completed.body.metas.map(meta => meta.id), ['kitsu:5']);
    const forYou = await stremio.request(`${prefix}/catalog/series/shelf-for-you.json`);
    assert.ok(forYou.body.metas.length > 0);
    // Only shelf rows (plus search) until lists and genres are chosen.
    assert.deepEqual(manifest.body.catalogs.map(catalog => catalog.id),
      ['shelf-watching', 'shelf-for-you', 'shelf-planning', 'shelf-on-hold', 'shelf-completed', 'kitsu-search']);
    assert.equal(manifest.body.behaviorHints.configurable, true);
    assert.equal((await alice.request('/api/v2/stremio/catalogs')).body.catalogs.length, 0);
    assert.equal((await alice.request('/api/v2/stremio/catalogs', { method: 'PUT', body: { catalogs: ['kitsu-category-nope'] } })).status, 400);
    assert.equal((await alice.request('/api/v2/stremio/catalogs', { method: 'PUT', body: { catalogs: ['kitsu-popular'] }, headers: { Origin: 'https://evil.example' } })).status, 403);
    const saved = await alice.request('/api/v2/stremio/catalogs', { method: 'PUT', body: { catalogs: ['kitsu-category-isekai', 'kitsu-trending', 'kitsu-top10'] } });
    assert.deepEqual(saved.body.catalogs, ['kitsu-trending', 'kitsu-category-isekai'], 'canonical order; retired rows dropped');
    const chosenManifest = await stremio.request(manifestUrl.pathname);
    assert.deepEqual(chosenManifest.body.catalogs.slice(5).map(catalog => catalog.id), ['kitsu-trending', 'kitsu-category-isekai', 'kitsu-search']);
    const isekaiRow = await stremio.request(`${prefix}/catalog/series/kitsu-category-isekai.json`);
    assert.deepEqual(isekaiRow.body.metas.map(meta => meta.id).sort(), ['kitsu:2', 'kitsu:5']);
    assert.equal((await stremio.request(`${prefix}/catalog/series/kitsu-category-mecha.json`)).status, 404, 'unchosen rows are not served');
    assert.ok((await stremio.request(`${prefix}/catalog/series/kitsu-search/search=sword.json`)).body.metas.some(meta => meta.id === 'kitsu:1'));
    assert.equal((await bob.request('/api/v2/stremio/catalogs')).body.catalogs.length, 0, 'choices are per user');
    const configure = await stremio.request(`${prefix}/configure`, { raw: true });
    assert.equal(configure.status, 302);
    assert.equal(configure.headers.get('location'), '/dashboard#connections');
    const meta = await stremio.request(`${prefix}/meta/series/kitsu:1.json`);
    const publicMeta = await stremio.request('/meta/series/kitsu:1.json');
    assert.deepEqual(meta.body, publicMeta.body, 'personal metadata matches public metadata and video IDs');
    // The install token cannot be used as a session.
    const token = manifestUrl.pathname.split('/')[2];
    assert.equal((await stremio.request('/api/v2/me', { headers: { Cookie: `kas_session=${token}` } })).status, 401);
    const tokens = await alice.request('/api/v2/stremio/tokens');
    assert.equal(tokens.body.tokens.length, 1);
    assert.equal(JSON.stringify(tokens.body).includes(token), false, 'token is never listed again');
    assert.equal((await bob.request(`/api/v2/stremio/tokens/${created.body.id}`, { method: 'DELETE' })).status, 404, 'cannot revoke another user\'s link');
    assert.equal((await alice.request(`/api/v2/stremio/tokens/${created.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await stremio.request(manifestUrl.pathname)).status, 404);
    assert.equal((await stremio.request('/u/not-a-token/manifest.json')).status, 404);
  });

  await t.test('AniList OAuth binds state to the user and stores the token encrypted', async () => {
    const start = await alice.request('/api/v2/anilist/connect', { method: 'POST' });
    assert.equal(start.status, 200);
    const authorize = new URL(start.body.url);
    assert.equal(authorize.origin + authorize.pathname, 'https://anilist.co/api/v2/oauth/authorize');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${base}/api/v2/anilist/callback`);
    const state = authorize.searchParams.get('state');
    // Bob cannot complete Alice's flow, and the state is consumed by the attempt.
    const stolen = await bob.request(`/api/v2/anilist/callback?code=good-code&state=${state}`);
    assert.equal(stolen.status, 303);
    assert.equal(stolen.headers.get('location'), '/dashboard?anilist=invalid');
    const reused = await alice.request(`/api/v2/anilist/callback?code=good-code&state=${state}`);
    assert.equal(reused.headers.get('location'), '/dashboard?anilist=invalid');

    // Alice adds an entry that only exists locally before connecting.
    await alice.request('/api/v2/library/kitsu%3A6', { method: 'PATCH', body: { status: 'planning' } });
    const fresh = new URL((await alice.request('/api/v2/anilist/connect', { method: 'POST' })).body.url).searchParams.get('state');
    const denied = await alice.request(`/api/v2/anilist/callback?code=bad-code&state=${fresh}`);
    assert.equal(denied.headers.get('location'), '/dashboard?anilist=failed');
    const ok = new URL((await alice.request('/api/v2/anilist/connect', { method: 'POST' })).body.url).searchParams.get('state');
    const connected = await alice.request(`/api/v2/anilist/callback?code=good-code&state=${ok}`);
    assert.equal(connected.headers.get('location'), '/dashboard?anilist=connected');
    assert.equal(anilist.state.tokenRequests.at(-1).client_secret, 'client-secret-value');
    const stored = await db.pool.query('SELECT access_token_enc FROM shelf_provider_connections');
    assert.equal(stored.rows.length, 1);
    assert.ok(!stored.rows[0].access_token_enc.includes(anilist.state.token), 'token is encrypted at rest');
    assert.match(stored.rows[0].access_token_enc, /^v1\./);
    // Bob cannot link the same AniList account.
    const bobState = new URL((await bob.request('/api/v2/anilist/connect', { method: 'POST' })).body.url).searchParams.get('state');
    assert.equal((await bob.request(`/api/v2/anilist/callback?code=good-code&state=${bobState}`)).headers.get('location'), '/dashboard?anilist=in-use');
  });

  await t.test('initial AniList sync imports, exports and reports unmatched titles', async () => {
    const status = await until(async () => {
      const current = (await alice.request('/api/v2/anilist/status')).body;
      return current.syncStatus === 'succeeded' || current.syncStatus === 'failed' ? current : null;
    });
    assert.equal(status.syncStatus, 'succeeded', JSON.stringify(status.syncResult));
    const result = status.syncResult;
    assert.equal(result.imported, 2, 'Isekai Days and Mecha Storm imported');
    assert.deepEqual(result.unresolved.map(item => item.anilistId).sort(), [555, 900]);
    assert.equal(result.exported, 3, 'Sword Saga, Dragon Isekai and Fantasy Quest pushed');
    const library = (await alice.request('/api/v2/library')).body.entries;
    const isekai = library.find(entry => entry.animeId === 'kitsu:2');
    assert.deepEqual([isekai.status, isekai.progress, isekai.score], ['watching', 5, 8.5]);
    assert.equal(anilist.state.entries.get(101).status, 'watching');
    assert.equal(anilist.state.entries.get(101).progress, 3);
    assert.equal(anilist.state.entries.get(105).score, 10);
    // The access token is never returned to the browser.
    assert.equal(JSON.stringify(status).includes(anilist.state.token), false);
  });

  await t.test('dashboard edits are pushed to AniList and later remote edits are pulled', async () => {
    const before = anilist.state.saves.length;
    await alice.request('/api/v2/library/kitsu%3A2', { method: 'PATCH', body: { progress: 7 } });
    await until(() => anilist.state.saves.length > before);
    // Only the changed field is sent, so AniList keeps its own score and status.
    assert.deepEqual(anilist.state.saves.at(-1), { mediaId: 102, progress: 7 });
    assert.equal(anilist.state.entries.get(102).score, 8.5);
    // A later change on AniList is pulled on the next sync.
    const remote = anilist.state.entries.get(103);
    anilist.state.entries.set(103, { ...remote, progress: 26, score: 7, updatedAt: Math.floor(Date.now() / 1000) + 5 });
    assert.equal((await alice.request('/api/v2/anilist/sync', { method: 'POST' })).status, 202);
    const done = await until(async () => {
      const current = (await alice.request('/api/v2/anilist/status')).body;
      return current.syncStatus !== 'running' && current.syncResult?.updatedLocal >= 1 ? current : null;
    });
    assert.equal(done.syncStatus, 'succeeded');
    const mecha = (await alice.request('/api/v2/library/kitsu%3A3')).body;
    assert.equal(mecha.score, 7);
    // Removing locally removes on AniList when auto-push is on.
    await alice.request('/api/v2/library/kitsu%3A6', { method: 'DELETE' });
    await until(() => !anilist.state.entries.has(106));
    // Auto-push can be turned off.
    assert.equal((await alice.request('/api/v2/anilist/settings', { method: 'PATCH', body: { autoPush: false } })).body.autoPush, false);
    const saves = anilist.state.saves.length;
    await alice.request('/api/v2/library/kitsu%3A2', { method: 'PATCH', body: { progress: 8 } });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(anilist.state.saves.length, saves);
  });

  await t.test('password change, export, disconnect and account deletion', async () => {
    const other = client(base);
    await other.request('/api/v2/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'correct horse battery' } });
    assert.equal((await other.request('/api/v2/me')).status, 200);
    assert.equal((await alice.request('/api/v2/me/password', { method: 'POST', body: { currentPassword: 'nope nope nope', newPassword: 'a brand new passphrase' } })).status, 403);
    assert.equal((await alice.request('/api/v2/me/password', { method: 'POST', body: { currentPassword: 'correct horse battery', newPassword: 'a brand new passphrase' } })).status, 200);
    assert.equal((await other.request('/api/v2/me')).status, 401, 'other sessions are revoked');
    assert.equal((await alice.request('/api/v2/me')).status, 200, 'current session survives');

    const exported = await alice.request('/api/v2/me/export');
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /attachment/);
    assert.equal(exported.body.account.email, 'alice@example.com');
    assert.deepEqual(exported.body.account.stremio_catalogs, ['kitsu-trending', 'kitsu-category-isekai']);
    assert.ok(exported.body.library.length >= 4);
    assert.equal(JSON.stringify(exported.body).includes('password_hash'), false);
    assert.equal(JSON.stringify(exported.body).includes('access_token'), false);
    assert.ok(exported.body.securityLog.some(event => event.action === 'password.changed'));

    assert.equal((await alice.request('/api/v2/anilist', { method: 'DELETE' })).body.disconnected, true);
    assert.equal((await alice.request('/api/v2/me/delete', { method: 'POST', body: { password: 'wrong' } })).status, 403);
    const deleted = await alice.request('/api/v2/me/delete', { method: 'POST', body: { password: 'a brand new passphrase' } });
    assert.equal(deleted.status, 200);
    assert.equal((await alice.request('/api/v2/me')).status, 401);
    const rows = await db.pool.query(`SELECT
      (SELECT count(*)::int FROM shelf_users WHERE email = 'alice@example.com') AS users,
      (SELECT count(*)::int FROM shelf_library_entries l JOIN shelf_users u ON u.id = l.user_id WHERE u.email = 'bob@example.com') AS bob_entries,
      (SELECT count(*)::int FROM shelf_library_entries) AS entries,
      (SELECT count(*)::int FROM shelf_sessions s LEFT JOIN shelf_users u ON u.id = s.user_id WHERE u.id IS NULL) AS orphans`);
    assert.deepEqual(rows.rows[0], { users: 0, bob_entries: 0, entries: 0, orphans: 0 });
    // Bob's account is unaffected.
    assert.equal((await bob.request('/api/v2/me')).status, 200);
  });

  await t.test('input with control characters is rejected, not stored', async () => {
    assert.equal((await bob.request('/api/v2/me', { method: 'PATCH', body: { displayName: 'x\u0000y' } })).status, 400);
    assert.equal((await bob.request('/api/v2/stremio/tokens', { method: 'POST', body: { label: 'tv\u0000' } })).status, 400);
    assert.equal((await bob.request('/api/v2/auth/login', { method: 'POST', body: { email: 'bob\u0000@example.com', password: 'x' } })).status, 401);
    assert.equal((await bob.request('/api/v2/library', { method: 'HEAD', raw: true })).status, 200);
  });

  await t.test('random install tokens are limited per address and cannot flush login limits', async () => {
    const flooder = client(base, { origin: null });
    let limited;
    for (let i = 0; i < 305 && !limited; i += 1) {
      const response = await flooder.request(`/u/${'A'.repeat(42)}${String.fromCharCode(65 + (i % 26))}/manifest.json`);
      if (response.status === 429) limited = i;
    }
    assert.equal(limited, 300, 'per-address limit applies before any token lookup');
  });

  await t.test('catalog rows are saved in PostgreSQL and served after a restart', async () => {
    await alice.request('/c/isekai/catalog/series/kitsu-category-isekai.json');
    const stored = await until(async () => (await db.pool.query(`SELECT value FROM shelf_catalog_cache WHERE key = 'kitsu-category-isekai'`)).rows[0]);
    assert.ok(stored.value.metas.some(meta => meta.id === 'kitsu:2'));
    // A second server on the same database, whose Kitsu is unreachable.
    const port = await freePort();
    const v2 = await prepareV2({ env: { ACCOUNTS_ENABLED: 'true', PUBLIC_URL: `http://127.0.0.1:${port}`, DATABASE_URL: 'postgres://unused', TOKEN_ENCRYPTION_KEY: KEY },
      version: VERSION, db: db.pool, logger: quiet });
    const offline = { request: async () => { throw Object.assign(new Error('Kitsu is down'), { status: 502 }); } };
    const restarted = createAddonServer({ v2, api: offline, loadMappings: async () => [], logger: quiet, token: '', apiKey: '', warmCatalogs: false });
    await new Promise(resolve => restarted.listen(port, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/c/isekai/catalog/series/kitsu-category-isekai.json`);
      assert.equal(response.status, 200);
      assert.ok((await response.json()).metas.some(meta => meta.id === 'kitsu:2'), 'served from the saved row');
    } finally {
      restarted.closeAllConnections();
      await new Promise(resolve => restarted.close(resolve));
    }
  });

  await t.test('logout clears the session', async () => {
    assert.equal((await bob.request('/api/v2/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await bob.request('/api/v2/me')).status, 401);
  });
});

test('closed registration and AniList-free configuration', { skip: dbSkip, timeout: 60000 }, async t => {
  const db = await createTestDatabase();
  const anilist = createFakeAnilist();
  const app = await startServer({ db, anilist, extraEnv: { REGISTRATION_OPEN: 'false', ANILIST_CLIENT_ID: '', ANILIST_CLIENT_SECRET: '' } });
  t.after(async () => { await app.close(); await db.drop(); });
  const visitor = client(app.base);
  const config = await visitor.request('/api/v2/config');
  assert.deepEqual(config.body, { accounts: true, registrationOpen: false, anilist: false, version: VERSION });
  assert.equal((await visitor.request('/api/v2/auth/register', { method: 'POST', body: { email: 'x@example.com', password: 'long enough password' } })).status, 403);
  assert.equal((await visitor.request('/health')).body.anilist, false);
});

test('2.0 stays disabled unless fully configured and migrated', { skip: dbSkip }, async () => {
  const errors = [];
  const logger = { error: message => errors.push(message), log() {} };
  assert.equal(await prepareV2({ env: {}, logger }), undefined);
  assert.equal(await prepareV2({ env: { ACCOUNTS_ENABLED: 'true', PUBLIC_URL: 'http://example.com', DATABASE_URL: 'postgres://x', TOKEN_ENCRYPTION_KEY: 'short' }, logger }), undefined);
  assert.match(errors.at(-1), /PUBLIC_URL must be the exact HTTPS origin/);
  assert.match(errors.at(-1), /TOKEN_ENCRYPTION_KEY/);
  const unmigrated = await createTestDatabase({ migrated: false });
  try {
    const env = { ACCOUNTS_ENABLED: 'true', PUBLIC_URL: 'https://shelf.example.org', DATABASE_URL: 'postgres://unused', TOKEN_ENCRYPTION_KEY: KEY };
    assert.equal(await prepareV2({ env, logger, db: unmigrated.pool }), undefined);
    assert.match(errors.at(-1), /Pending: 001_personal_library\.sql, 002_accounts_sync_catalogs\.sql, 003_stremio_catalog_choices\.sql, 004_catalog_cache\.sql/);
    const factory = await prepareV2({ env: { ...env, RUN_MIGRATIONS_ON_START: 'true' }, logger, db: unmigrated.pool });
    assert.equal(typeof factory, 'function');
  } finally {
    await unmigrated.drop();
  }
  // Public add-on without 2.0 rejects API paths exactly as before.
  const server = createAddonServer({ service: { catalog: async () => ({ metas: [] }), metadata: async () => ({ meta: {} }) }, logger: quiet });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/v2/config`)).status, 404);
    assert.equal((await fetch(`${base}/api/v2/auth/login`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/dashboard`)).status, 200, 'dashboard page explains accounts are off');
    assert.equal((await (await fetch(`${base}/health`)).json()).accounts, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
