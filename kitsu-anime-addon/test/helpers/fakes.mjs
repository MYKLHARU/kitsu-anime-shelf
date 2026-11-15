// In-memory stand-ins for Kitsu, AniList and the Fribb mapping list.

export function kitsuAnime(id, { title = `Anime ${id}`, categories = ['action'], episodeCount = 12, subtype = 'TV', rating = '80.00', year = 2020 } = {}) {
  return { id: String(id), title, categories, episodeCount, subtype, rating, year };
}

// Implements the subset of Kitsu's JSON:API used by the add-on and 2.0.
export function createFakeKitsuApi(animeList) {
  const anime = new Map(animeList.map(item => [item.id, item]));
  const categoryIds = new Map();
  const categoryId = slug => {
    if (!categoryIds.has(slug)) categoryIds.set(slug, String(categoryIds.size + 1));
    return categoryIds.get(slug);
  };
  const resource = item => ({
    id: item.id, type: 'anime',
    attributes: {
      canonicalTitle: item.title, titles: { en: item.title }, subtype: item.subtype, episodeCount: item.episodeCount,
      startDate: `${item.year}-04-01`, status: 'finished', averageRating: item.rating, slug: `anime-${item.id}`,
      posterImage: { medium: `https://media.kitsu.app/anime/poster_images/${item.id}/medium.jpg` },
      coverImage: { large: `https://media.kitsu.app/anime/cover_images/${item.id}/large.jpg` }
    },
    relationships: { categories: { data: item.categories.map(slug => ({ type: 'categories', id: categoryId(slug) })) } }
  });
  const included = items => [...new Set(items.flatMap(item => item.categories))]
    .map(slug => ({ type: 'categories', id: categoryId(slug), attributes: { slug, title: slug.replace(/(^|-)(\w)/g, (_, dash, c) => `${dash ? ' ' : ''}${c.toUpperCase()}`) } }));
  const calls = [];
  return {
    calls,
    anime,
    async request(path, params = {}) {
      calls.push({ path, params });
      if (path === 'anime') {
        let items = [...anime.values()];
        if (params['filter[id]']) {
          const ids = String(params['filter[id]']).split(',');
          items = items.filter(item => ids.includes(item.id));
        }
        if (params['filter[categories]']) items = items.filter(item => item.categories.includes(params['filter[categories]']));
        if (params['filter[text]']) items = items.filter(item => item.title.toLowerCase().includes(String(params['filter[text]']).toLowerCase()));
        const size = Number(params['page[size]'] || params['page[limit]'] || 20);
        const page = Number(params['page[number]'] || 1);
        const slice = items.slice((page - 1) * size, page * size);
        return { data: slice.map(resource), included: included(slice), meta: { count: items.length }, links: {} };
      }
      const single = /^anime\/(\d+)$/.exec(path);
      if (single) {
        const item = anime.get(single[1]);
        if (!item) throw Object.assign(new Error('Anime not found.'), { status: 404 });
        return { data: resource(item), included: included([item]) };
      }
      const episodes = /^anime\/(\d+)\/episodes$/.exec(path);
      if (episodes) {
        const item = anime.get(episodes[1]);
        const count = item?.episodeCount ?? 0;
        const offset = Number(params['page[offset]'] || 0);
        const data = Array.from({ length: Math.max(0, Math.min(20, count - offset)) }, (_, i) => ({ id: `${item.id}${offset + i + 1}`, type: 'episodes', attributes: { number: offset + i + 1, canonicalTitle: `Episode ${offset + i + 1}` } }));
        return { data, meta: { count } };
      }
      throw Object.assign(new Error(`Unexpected Kitsu path ${path}`), { status: 404 });
    }
  };
}

// Fake AniList OAuth + GraphQL endpoint as a fetch implementation.
export function createFakeAnilist({ viewer = { id: 4242, name: 'shelf_tester' }, entries = [] } = {}) {
  const state = {
    viewer,
    token: 'anilist-access-token-plaintext-abc123',
    codes: new Set(['good-code']),
    entries: new Map(entries.map(entry => [entry.mediaId, { id: entry.mediaId * 10, updatedAt: Math.floor(Date.now() / 1000) - 3600, ...entry }])),
    saves: [],
    deletes: [],
    tokenRequests: []
  };
  async function fetchImpl(url, options = {}) {
    const target = String(url);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (target === 'https://anilist.co/api/v2/oauth/token') {
      const body = JSON.parse(options.body);
      state.tokenRequests.push(body);
      if (!state.codes.has(body.code)) return json(400, { error: 'invalid_grant' });
      return json(200, { token_type: 'Bearer', expires_in: 31536000, access_token: state.token });
    }
    if (target === 'https://graphql.anilist.co') {
      if (options.headers?.Authorization !== `Bearer ${state.token}`) return json(401, { errors: [{ message: 'Invalid token', status: 401 }] });
      const { query, variables } = JSON.parse(options.body);
      if (query.includes('Viewer')) return json(200, { data: { Viewer: state.viewer } });
      if (query.includes('MediaListCollection')) {
        const toStatus = { planning: 'PLANNING', watching: 'CURRENT', completed: 'COMPLETED', on_hold: 'PAUSED', dropped: 'DROPPED' };
        const list = [...state.entries.values()].map(entry => ({
          mediaId: entry.mediaId, status: toStatus[entry.status] ?? entry.status,
          progress: entry.progress, score: entry.score ?? 0, updatedAt: entry.updatedAt,
          media: { episodes: entry.episodes ?? null, title: { romaji: entry.title ?? `Media ${entry.mediaId}`, english: null } }
        }));
        // A custom list repeating the first entry must be ignored.
        const lists = [{ isCustomList: false, entries: list }, { isCustomList: true, entries: list.slice(0, 1) }];
        return json(200, { data: { MediaListCollection: { hasNextChunk: false, lists } } });
      }
      if (query.includes('SaveMediaListEntry')) {
        state.saves.push(variables);
        const fromStatus = { PLANNING: 'planning', CURRENT: 'watching', COMPLETED: 'completed', PAUSED: 'on_hold', DROPPED: 'dropped' };
        const updatedAt = Math.floor(Date.now() / 1000);
        // Like AniList, omitted fields keep their current values.
        const existing = state.entries.get(variables.mediaId) ?? { status: 'planning', progress: 0, score: 0 };
        state.entries.set(variables.mediaId, { ...existing, mediaId: variables.mediaId, id: variables.mediaId * 10,
          ...(variables.status ? { status: fromStatus[variables.status] } : {}),
          ...(variables.progress !== undefined ? { progress: variables.progress } : {}),
          ...(variables.scoreRaw !== undefined ? { score: variables.scoreRaw / 10 } : {}), updatedAt });
        return json(200, { data: { SaveMediaListEntry: { id: variables.mediaId * 10, status: variables.status, progress: variables.progress, updatedAt } } });
      }
      if (query.includes('DeleteMediaListEntry')) {
        state.deletes.push(variables.id);
        for (const [mediaId, entry] of state.entries) if (entry.id === variables.id) state.entries.delete(mediaId);
        return json(200, { data: { DeleteMediaListEntry: { deleted: true } } });
      }
      if (query.includes('MediaList(')) {
        const entry = state.entries.get(variables.mediaId);
        return entry ? json(200, { data: { MediaList: { id: entry.id } } }) : json(404, { errors: [{ message: 'Not Found.', status: 404 }] });
      }
    }
    throw new Error(`Unexpected request to ${target}`);
  }
  return { state, fetchImpl };
}

// A small cookie jar around fetch for one browser-like client.
export function createClient(base, { origin = base } = {}) {
  const cookies = new Map();
  return {
    cookies,
    async request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
      const finalHeaders = { Accept: 'application/json', ...headers };
      if (method !== 'GET' && method !== 'HEAD' && !('Origin' in headers) && origin) finalHeaders.Origin = origin;
      if (body !== undefined && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
      if (cookies.size) finalHeaders.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      for (const [name, value] of Object.entries(finalHeaders)) if (value === undefined) delete finalHeaders[name];
      const response = await fetch(new URL(path, base), {
        method, headers: finalHeaders, redirect: 'manual',
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        if (attributes.some(attribute => /max-age=0$/i.test(attribute.trim()))) cookies.delete(name);
        else cookies.set(name, value);
      }
      if (raw) return response;
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: response.status, headers: response.headers, body: data };
    }
  };
}
