// AniList OAuth (authorization code grant) and GraphQL client.
// Access tokens are one-year JWTs without refresh tokens; they are stored
// encrypted by the caller and never sent to the browser.
import { setTimeout as delay } from 'node:timers/promises';

const AUTHORIZE_URL = 'https://anilist.co/api/v2/oauth/authorize';
const TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';
const GRAPHQL_URL = 'https://graphql.anilist.co';

export class AnilistError extends Error {
  constructor(message, { status = 502, unauthorized = false } = {}) {
    super(message);
    this.status = status;
    this.unauthorized = unauthorized;
  }
}

// Shelf status <-> AniList MediaListStatus.
const TO_ANILIST = { planning: 'PLANNING', watching: 'CURRENT', completed: 'COMPLETED', on_hold: 'PAUSED', dropped: 'DROPPED' };
const FROM_ANILIST = { PLANNING: 'planning', CURRENT: 'watching', REPEATING: 'watching', COMPLETED: 'completed', PAUSED: 'on_hold', DROPPED: 'dropped' };
export const toAnilistStatus = status => TO_ANILIST[status];
export const fromAnilistStatus = status => FROM_ANILIST[status];

const VIEWER = `query { Viewer { id name } }`;
const LIST = `query ($userId: Int, $chunk: Int) {
  MediaListCollection(userId: $userId, type: ANIME, chunk: $chunk, perChunk: 500, forceSingleCompletedList: true) {
    hasNextChunk
    lists { isCustomList entries { mediaId status progress score(format: POINT_10_DECIMAL) updatedAt media { episodes title { romaji english } } } }
  }
}`;
const SAVE = `mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $scoreRaw: Int) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, scoreRaw: $scoreRaw) { id status progress updatedAt }
}`;
const ENTRY = `query ($userId: Int, $mediaId: Int) { MediaList(userId: $userId, mediaId: $mediaId) { id } }`;
const DELETE = `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`;

export function createAnilistClient({ clientId, clientSecret, redirectUri, fetchImpl = fetch, timeoutMs = 15000, minIntervalMs = 2100, maxQueueMs = 120000 } = {}) {
  if (!/^\d{1,12}$/.test(String(clientId ?? ''))) throw new TypeError('ANILIST_CLIENT_ID must be numeric');
  if (typeof clientSecret !== 'string' || clientSecret.length < 8) throw new TypeError('ANILIST_CLIENT_SECRET is required');
  if (typeof redirectUri !== 'string' || !/^https?:\/\//.test(redirectUri)) throw new TypeError('An AniList redirect URI is required');

  // AniList allows about 30 requests per minute; space requests from this
  // process, and refuse work rather than queue it indefinitely.
  let nextSlot = 0;
  async function throttle() {
    const wait = nextSlot - Date.now();
    if (wait > maxQueueMs) throw new AnilistError('AniList is busy. Try again in a few minutes.', { status: 503 });
    nextSlot = Math.max(Date.now(), nextSlot) + minIntervalMs;
    if (wait > 0) await delay(wait);
  }

  async function graphql(token, query, variables = {}, attempt = 0) {
    await throttle();
    let response;
    try {
      response = await fetchImpl(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new AnilistError('Cannot reach AniList. Try again later.');
    }
    if (response.status === 429 && attempt < 2) {
      await response.body?.cancel();
      const seconds = Number(response.headers.get('retry-after'));
      await delay(Math.min(65000, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000));
      return graphql(token, query, variables, attempt + 1);
    }
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401 || response.status === 403 || body?.errors?.some(error => error.status === 401 || /invalid token/i.test(error.message))) {
      throw new AnilistError('AniList authorisation expired. Reconnect your AniList account.', { status: 401, unauthorized: true });
    }
    if (!response.ok || !body || body.errors) {
      const notFound = body?.errors?.some(error => error.status === 404);
      throw new AnilistError(notFound ? 'Not found on AniList' : `AniList returned HTTP ${response.status}`, { status: notFound ? 404 : 502 });
    }
    return body.data;
  }

  return Object.freeze({
    authorizeUrl(state) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_id', String(clientId));
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);
      return url.href;
    },
    async exchangeCode(code) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(code)) throw new AnilistError('Invalid authorisation code', { status: 400 });
      let response;
      try {
        response = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ grant_type: 'authorization_code', client_id: String(clientId), client_secret: clientSecret, redirect_uri: redirectUri, code }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch {
        throw new AnilistError('Cannot reach AniList. Try again later.');
      }
      const body = await response.json().catch(() => null);
      if (!response.ok || typeof body?.access_token !== 'string') throw new AnilistError('AniList did not accept the authorisation code', { status: 400 });
      const expiresIn = Number(body.expires_in);
      return { accessToken: body.access_token, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null };
    },
    async viewer(token) {
      const data = await graphql(token, VIEWER);
      if (!Number.isSafeInteger(data?.Viewer?.id)) throw new AnilistError('AniList did not return an account');
      return { id: String(data.Viewer.id), name: String(data.Viewer.name || '').slice(0, 64) };
    },
    // All anime list entries, de-duplicated by media ID (custom lists repeat entries).
    async animeList(token, userId) {
      const entries = new Map();
      for (let chunk = 1; chunk <= 20; chunk += 1) {
        const data = await graphql(token, LIST, { userId: Number(userId), chunk });
        const collection = data?.MediaListCollection;
        for (const list of collection?.lists || []) {
          if (list.isCustomList) continue;
          for (const entry of list.entries || []) {
            if (!Number.isSafeInteger(entry.mediaId) || entries.has(entry.mediaId)) continue;
            const status = fromAnilistStatus(entry.status);
            if (!status) continue;
            entries.set(entry.mediaId, {
              mediaId: entry.mediaId,
              status,
              progress: Number.isSafeInteger(entry.progress) && entry.progress >= 0 ? entry.progress : 0,
              score: Number.isFinite(entry.score) && entry.score > 0 ? Math.min(10, Math.round(entry.score * 10) / 10) : null,
              updatedAt: Number.isSafeInteger(entry.updatedAt) && entry.updatedAt > 0 ? new Date(entry.updatedAt * 1000) : null,
              title: entry.media?.title?.english || entry.media?.title?.romaji || `AniList ${entry.mediaId}`,
              episodes: entry.media?.episodes ?? null
            });
          }
        }
        if (!collection?.hasNextChunk) return [...entries.values()];
      }
      // Treating a truncated list as complete would make local entries look
      // missing on AniList, so refuse instead.
      throw new AnilistError('This AniList list is too large to sync (over 10,000 entries).', { status: 422 });
    },
    // Sends only the fields present in `entry`, so values set on AniList that
    // were not changed here (for example a score, or REPEATING) are kept.
    async saveEntry(token, entry) {
      const variables = { mediaId: entry.mediaId };
      if (Object.hasOwn(entry, 'status')) variables.status = toAnilistStatus(entry.status);
      if (Object.hasOwn(entry, 'progress')) variables.progress = entry.progress;
      // scoreRaw is 0-100 regardless of the user's display format; 0 clears it.
      if (Object.hasOwn(entry, 'score')) variables.scoreRaw = entry.score == null ? 0 : Math.round(entry.score * 10);
      const data = await graphql(token, SAVE, variables);
      return data?.SaveMediaListEntry;
    },
    async deleteEntry(token, userId, mediaId) {
      let id;
      try { id = (await graphql(token, ENTRY, { userId: Number(userId), mediaId }))?.MediaList?.id; }
      catch (error) { if (error.status === 404) return false; throw error; }
      if (!id) return false;
      return Boolean((await graphql(token, DELETE, { id }))?.DeleteMediaListEntry?.deleted);
    }
  });
}
