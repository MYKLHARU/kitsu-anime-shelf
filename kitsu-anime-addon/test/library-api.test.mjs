import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLibraryApiHandler } from '../src/library-api.mjs';
import { createLibraryService, createMemoryLibraryAdapter } from '../src/library-store.mjs';

const user = 'd6a1cbf8-56df-4c2e-9b0e-2242e8297642';
const origin = 'https://dashboard.example.org';

async function invoke(handler, { method = 'GET', path = '/api/v2/library/kitsu%3A1', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = path;
  req.headers = headers;
  const response = { status: null, headers: null, data: '',
    writeHead(status, values) { this.status = status; this.headers = values; },
    end(data) { this.data = data; }
  };
  await handler(req, response);
  return { status: response.status, headers: response.headers, body: JSON.parse(response.data) };
}

test('rejects unauthenticated library access', async () => {
  const handler = createLibraryApiHandler({
    library: createLibraryService(createMemoryLibraryAdapter()),
    authenticate: async () => null,
    allowedOrigin: origin
  });
  assert.equal((await invoke(handler)).status, 401);
});

test('authenticates and updates an isolated watchlist entry', async () => {
  const library = createLibraryService(createMemoryLibraryAdapter());
  const handler = createLibraryApiHandler({ library, authenticate: async () => user, allowedOrigin: origin });
  const update = await invoke(handler, { method: 'PATCH',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'watching', progress: 3 })
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.progress, 3);
  const read = await invoke(handler);
  assert.equal(read.status, 200);
  assert.equal(read.body.status, 'watching');
  assert.equal(read.headers['Cache-Control'], 'no-store');
});

test('rejects wrong origin, unknown fields and malformed data', async () => {
  const handler = createLibraryApiHandler({
    library: createLibraryService(createMemoryLibraryAdapter()),
    authenticate: async () => user,
    allowedOrigin: origin
  });
  assert.equal((await invoke(handler, { method: 'PATCH', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await invoke(handler, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await invoke(handler, { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: '{"admin":true}' })).status, 400);
  assert.equal((await invoke(handler, { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: '{"progress":-1}' })).status, 400);
  assert.equal((await invoke(handler, { method: 'POST' })).status, 405);
});
