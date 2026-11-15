// Kitsu Anime Shelf 2.0 dashboard. Same-origin only; the session lives in an
// HttpOnly cookie that this script never sees. All text is inserted with
// textContent, never as HTML.
'use strict';

const $ = selector => document.querySelector(selector);
const STATUSES = [
  ['watching', 'Watching'], ['planning', 'Plan to watch'], ['completed', 'Completed'], ['on_hold', 'On hold'], ['dropped', 'Dropped']
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const FALLBACK_POSTER = '/logo.svg';
const state = { me: null, config: null, entries: [], filter: 'all', editing: null, recsLoaded: false, discoverLoaded: false, pollTimer: null,
  browse: { id: 'kitsu-popular', metas: [], shown: 0, skip: 0, more: false, controller: null } };
const BROWSE_STEP = 30;
const BROWSE_LISTS = [['kitsu-popular', 'Most popular'], ['kitsu-top-rated', 'Top rated'], ['kitsu-airing', 'Airing now'], ['kitsu-movies', 'Movies']];

// ---- Helpers ------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function poster(src, alt = '') {
  const image = el('img', { class: 'poster', alt, loading: 'lazy', src: src || FALLBACK_POSTER });
  image.addEventListener('error', () => { if (!image.src.endsWith(FALLBACK_POSTER)) image.src = FALLBACK_POSTER; }, { once: true });
  return image;
}

let toastTimer;
function toast(message, bad = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3800);
}

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const options = { method, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin' };
  if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  let response;
  try { response = await fetch(path, options); }
  catch { throw new ApiError(0, 'You appear to be offline. Check your connection.'); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && state.me && !path.startsWith('/api/v2/auth/')) { state.me = null; showSignedOut(); }
  if (!response.ok) throw new ApiError(response.status, data.error || `Request failed (${response.status}).`);
  return { data, response };
}

async function busy(button, task) {
  button.disabled = true;
  try { return await task(); }
  finally { button.disabled = false; }
}

const kitsuNumber = id => id.replace(/^kitsu:/, '');
const formatDate = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

// ---- Views ------------------------------------------------------------------------

function showView(name) {
  const views = ['library', 'discover', 'connections', 'account'];
  if (!views.includes(name)) name = 'library';
  for (const view of views) $(`#view-${view}`).hidden = view !== name;
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (name === 'discover' && !state.recsLoaded) loadRecommendations();
  if (name === 'discover' && !state.discoverLoaded) loadDiscover();
  if (name === 'connections') { loadTokens(); renderAnilist(); }
  if (name === 'account') loadSessions();
}

function showSignedOut() {
  for (const id of ['#nav', '#who', '#view-library', '#view-discover', '#view-connections', '#view-account']) $(id).hidden = true;
  $('#auth').hidden = false;
  clearInterval(state.pollTimer);
}

async function showSignedIn(me) {
  state.me = me;
  $('#auth').hidden = true;
  $('#nav').hidden = false;
  $('#who').hidden = false;
  $('#who-name').textContent = me.user.displayName || me.user.email;
  $('#account-email').textContent = me.user.email;
  $('#display-name').value = me.user.displayName || '';
  showView(location.hash.slice(1));
  await loadLibrary();
  const outcome = new URLSearchParams(location.search).get('anilist');
  if (outcome) {
    const messages = { connected: ['AniList connected. Your first sync has started.'], denied: ['AniList access was not granted.', true],
      invalid: ['That AniList sign-in link expired. Try connecting again.', true], 'in-use': ['That AniList account is linked to another shelf.', true],
      failed: ['Could not connect AniList. Try again later.', true], unavailable: ['AniList is not configured on this server.', true] };
    const [message, bad] = messages[outcome] || messages.failed;
    toast(message, bad);
    history.replaceState(null, '', `/dashboard#connections`);
    showView('connections');
  }
}

// ---- Authentication -------------------------------------------------------------------

function selectAuthTab(register) {
  $('#tab-login').setAttribute('aria-selected', String(!register));
  $('#tab-register').setAttribute('aria-selected', String(register));
  $('#login-form').hidden = register;
  $('#register-form').hidden = !register;
  $('#auth-error').textContent = '';
  (register ? $('#register-form') : $('#login-form')).querySelector('input').focus();
}

async function submitAuth(event, path) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  $('#auth-error').textContent = '';
  try {
    await busy(form.querySelector('button[type="submit"]'), () => api(path, { method: 'POST', body }));
    form.reset();
    const { data } = await api('/api/v2/me');
    await showSignedIn(data);
  } catch (error) {
    $('#auth-error').textContent = error.message;
  }
}

// ---- Library ------------------------------------------------------------------------

async function loadLibrary() {
  $('#library-status').textContent = 'Loading…';
  try {
    const { data } = await api('/api/v2/library');
    state.entries = data.entries;
    renderLibrary();
  } catch (error) {
    $('#library-status').textContent = error.message;
  }
}

function renderStats() {
  const count = status => state.entries.filter(entry => entry.status === status).length;
  const episodes = state.entries.reduce((sum, entry) => sum + entry.progress, 0);
  $('#stats').replaceChildren(...[['Watching', count('watching')], ['Plan to watch', count('planning')], ['Completed', count('completed')], ['Episodes watched', episodes]]
    .map(([label, value]) => el('div', {}, el('dt', { text: label }), el('dd', { text: value.toLocaleString() }))));
}

function renderFilters() {
  const counts = Object.fromEntries(STATUSES.map(([status]) => [status, state.entries.filter(entry => entry.status === status).length]));
  const chips = [['all', 'All', state.entries.length], ...STATUSES.map(([status, label]) => [status, label, counts[status]])];
  $('#status-filter').replaceChildren(...chips.map(([value, label, count]) => el('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(state.filter === value),
    onclick: () => { state.filter = value; renderLibrary(); }
  }, label, el('span', { class: 'count', text: count }))));
}

function progressText(entry) {
  const total = entry.anime.episodeCount;
  return total ? `${entry.progress} / ${total} ep` : `${entry.progress} ep`;
}

function meter(entry) {
  const bar = el('span');
  const total = entry.anime.episodeCount;
  bar.style.width = `${total ? Math.min(100, (entry.progress / total) * 100) : 0}%`;
  return el('div', { class: 'meter', 'aria-hidden': 'true' }, bar);
}

function renderContinue() {
  const watching = state.entries.filter(entry => entry.status === 'watching');
  $('#continue-wrap').hidden = !watching.length;
  $('#continue').replaceChildren(...watching.slice(0, 20).map(entry => {
    const total = entry.anime.episodeCount;
    const image = el('img', { alt: '', src: entry.anime.poster || FALLBACK_POSTER, loading: 'lazy' });
    image.addEventListener('error', () => { if (!image.src.endsWith(FALLBACK_POSTER)) image.src = FALLBACK_POSTER; }, { once: true });
    return el('article', { class: 'continue' },
      image,
      el('div', {},
        el('h3', { text: entry.anime.title, title: entry.anime.title }),
        meter(entry),
        el('div', { class: 'row' },
          el('span', { class: 'ep', text: progressText(entry) }),
          el('button', { class: 'button secondary icon', type: 'button', 'aria-label': `One episode fewer of ${entry.anime.title}`, disabled: entry.progress === 0,
            onclick: event => bump(entry, -1, event.currentTarget) }, '−'),
          el('button', { class: 'button primary icon', type: 'button', 'aria-label': `Mark next episode of ${entry.anime.title} watched`, disabled: Boolean(total && entry.progress >= total),
            onclick: event => bump(entry, 1, event.currentTarget) }, '+'))));
  }));
}

function renderLibrary() {
  renderStats();
  renderFilters();
  renderContinue();
  const query = $('#filter').value.trim().toLowerCase();
  const sort = $('#sort').value;
  const list = state.entries
    .filter(entry => state.filter === 'all' || entry.status === state.filter)
    .filter(entry => !query || entry.anime.title.toLowerCase().includes(query))
    .sort({
      updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      title: (a, b) => a.anime.title.localeCompare(b.anime.title),
      score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
      progress: (a, b) => b.progress - a.progress
    }[sort]);
  $('#library-status').textContent = state.entries.length
    ? `${list.length} of ${state.entries.length} titles`
    : 'Your shelf is empty. Use Add anime to find something, or connect AniList to import your list.';
  $('#library').replaceChildren(...list.map(entry => el('article', { class: 'card' },
    el('button', { class: 'open', type: 'button', 'aria-label': `Edit ${entry.anime.title}`, onclick: () => openEditor(entry) },
      poster(entry.anime.poster, ''),
      el('span', { class: 'badge', text: STATUS_LABEL[entry.status] }),
      el('h3', { text: entry.anime.title, title: entry.anime.title }),
      el('p', { text: `${progressText(entry)}${entry.score != null ? ` · ★ ${entry.score}` : ''}` }),
      meter(entry)))));
}

function replaceEntry(updated) {
  const index = state.entries.findIndex(entry => entry.animeId === updated.animeId);
  if (index >= 0) state.entries[index] = { ...state.entries[index], ...updated };
  renderLibrary();
}

async function saveEntry(entry, changes) {
  try {
    const { data } = await api(`/api/v2/library/${encodeURIComponent(entry.animeId)}`, {
      method: 'PATCH', body: changes, headers: entry.revision ? { 'If-Match': `"${entry.revision}"` } : {}
    });
    replaceEntry(data);
    return data;
  } catch (error) {
    if (error.status === 412) { toast('This title changed on another device. Reloaded the latest version.', true); await loadLibrary(); }
    else toast(error.message, true);
    throw error;
  }
}

async function bump(entry, delta, button) {
  const progress = Math.max(0, entry.progress + delta);
  const total = entry.anime.episodeCount;
  const changes = { progress };
  if (total && progress >= total) changes.status = 'completed';
  await busy(button, () => saveEntry(entry, changes)).then(() => {
    if (changes.status === 'completed') toast(`Finished ${entry.anime.title}. Moved to Completed.`);
  }).catch(() => {});
}

function openEditor(entry) {
  state.editing = entry;
  const form = $('#editor-form');
  $('#editor-title').textContent = entry.anime.title;
  $('#editor-meta').textContent = [entry.anime.subtype?.toUpperCase(), entry.anime.startYear, entry.anime.episodeCount ? `${entry.anime.episodeCount} episodes` : null].filter(Boolean).join(' · ');
  $('#editor-poster').src = entry.anime.poster || FALLBACK_POSTER;
  $('#editor-stremio').href = `stremio:///detail/series/${encodeURIComponent(entry.animeId)}`;
  form.status.value = entry.status;
  form.progress.value = entry.progress;
  form.progress.max = entry.anime.episodeCount || '';
  form.score.value = entry.score ?? '';
  $('#editor').showModal();
}

async function submitEditor(event) {
  const submitter = event.submitter;
  if (submitter?.value !== 'save') return; // Cancel closes the dialog.
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const entry = state.editing;
  const score = form.score.value === '' ? null : Math.round(Number(form.score.value) * 10) / 10;
  try {
    await busy(submitter, () => saveEntry(entry, { status: form.status.value, progress: Number(form.progress.value), score }));
    $('#editor').close();
    toast('Saved.');
  } catch { /* toast already shown */ }
}

async function removeEditing() {
  const entry = state.editing;
  if (!confirm(`Remove ${entry.anime.title} from your shelf?`)) return;
  try {
    await api(`/api/v2/library/${encodeURIComponent(entry.animeId)}`, { method: 'DELETE' });
    state.entries = state.entries.filter(item => item.animeId !== entry.animeId);
    $('#editor').close();
    renderLibrary();
    toast('Removed from your shelf.');
  } catch (error) { toast(error.message, true); }
}

// ---- Discover ------------------------------------------------------------------------

function discoverCard(meta, { rank } = {}) {
  const inLibrary = state.entries.find(entry => entry.animeId === meta.id);
  const button = el('button', { class: 'button secondary small add', type: 'button', disabled: Boolean(inLibrary), text: inLibrary ? STATUS_LABEL[inLibrary.status] : 'Add to plan' });
  button.addEventListener('click', async () => {
    try {
      await busy(button, () => api(`/api/v2/library/${encodeURIComponent(meta.id)}`, { method: 'PATCH', body: { status: 'planning' } }));
      button.textContent = 'Added';
      button.disabled = true;
      toast(`Added ${meta.name} to Plan to watch.`);
      loadLibrary();
    } catch (error) { toast(error.message, true); }
  });
  return el('article', { class: 'card' },
    el('a', { href: `stremio:///detail/series/${encodeURIComponent(meta.id)}`, 'aria-label': `${rank ? `Number ${rank}: ` : ''}Open ${meta.name} in Stremio` }, poster(meta.poster, '')),
    rank ? el('span', { class: 'rank', 'aria-hidden': 'true', text: rank }) : null,
    el('h3', { text: meta.name, title: meta.name }),
    el('p', { text: [meta.releaseInfo, meta.genres?.slice(0, 2).join(', ')].filter(Boolean).join(' · ') || ' ' }),
    meta.reason ? el('p', { class: 'reason', text: meta.reason }) : null,
    button);
}

function skeletons(target, count = 12) {
  target.replaceChildren(...Array.from({ length: count }, () => el('div', { class: 'skeleton', 'aria-hidden': 'true' })));
}

async function loadRecommendations() {
  state.recsLoaded = true;
  skeletons($('#recs'));
  $('#recs-status').textContent = 'Finding anime you might like…';
  try {
    const { data } = await api('/api/v2/recommendations');
    const cards = data.metas.map(meta => discoverCard(meta));
    cards.forEach((card, index) => { card.hidden = index >= 12; });
    $('#recs').replaceChildren(...cards);
    $('#recs-more').hidden = cards.length <= 12;
    $('#recs-status').textContent = data.metas.length
      ? (state.entries.length ? 'Based on the categories of titles you have watched and rated.' : 'Popular on Kitsu. Add and rate titles to personalise this list.')
      : 'No recommendations right now. Try again later.';
  } catch (error) {
    state.recsLoaded = false;
    $('#recs').replaceChildren();
    $('#recs-status').textContent = error.message;
  }
}

// ---- Top 10 and browsing (public Kitsu catalogs, cached by the add-on) --------

async function fetchCatalog(id, skip = 0, signal) {
  const path = `/catalog/series/${encodeURIComponent(id)}${skip ? `/skip=${skip}` : ''}.json`;
  const response = await fetch(path, { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not load this list from Kitsu.');
  return Array.isArray(data.metas) ? data.metas : [];
}

async function loadTop10() {
  $('#top10').replaceChildren(...Array.from({ length: 10 }, () => el('li', { 'aria-hidden': 'true' }, el('div', { class: 'skeleton' }))));
  try {
    let metas = (await fetchCatalog('kitsu-airing')).slice(0, 10);
    let label = 'The most popular anime airing now on Kitsu.';
    if (!metas.length) { metas = (await fetchCatalog('kitsu-popular')).slice(0, 10); label = 'The most popular anime on Kitsu.'; }
    $('#top10').replaceChildren(...metas.map((meta, index) => el('li', {}, discoverCard(meta, { rank: index + 1 }))));
    $('#top10-status').textContent = metas.length ? label : 'Nothing to show right now. Try again later.';
  } catch (error) {
    state.discoverLoaded = false;
    $('#top10').replaceChildren();
    $('#top10-status').textContent = error.message;
  }
}

async function loadBrowseChoices() {
  let genres = [];
  try {
    const manifest = await (await fetch('/manifest.json')).json();
    genres = manifest.catalogs.filter(catalog => catalog.id.startsWith('kitsu-category-')).map(catalog => [catalog.id, catalog.name]);
  } catch { /* the fixed lists still work */ }
  const choices = [...BROWSE_LISTS, ...genres];
  $('#browse-chips').replaceChildren(...choices.map(([id, name], index) => el('button', {
    class: `chip${index >= BROWSE_LISTS.length ? ' genre' : ''}`, type: 'button', 'data-id': id, 'aria-pressed': String(id === state.browse.id),
    onclick: () => browse(id, name)
  }, name)));
}

async function browse(id, name = BROWSE_LISTS.find(([key]) => key === id)?.[1] || id) {
  const current = state.browse;
  current.controller?.abort();
  Object.assign(current, { id, name, metas: [], shown: 0, skip: 0, more: false, controller: new AbortController() });
  for (const chip of document.querySelectorAll('#browse-chips .chip')) chip.setAttribute('aria-pressed', String(chip.dataset.id === id));
  skeletons($('#browse-results'), 12);
  $('#browse-more').hidden = true;
  $('#browse-status').textContent = `Loading ${name}…`;
  try {
    await loadMoreBrowse(true);
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('#browse-results').replaceChildren();
    $('#browse-status').textContent = error.message;
  }
}

async function loadMoreBrowse(first = false) {
  const current = state.browse;
  if (current.shown >= current.metas.length && (first || current.more)) {
    const page = await fetchCatalog(current.id, current.skip, current.controller.signal);
    const seen = new Set(current.metas.map(meta => meta.id));
    current.metas.push(...page.filter(meta => !seen.has(meta.id)));
    current.more = page.length >= 100;
    current.skip += page.length;
  }
  const next = current.metas.slice(current.shown, current.shown + BROWSE_STEP);
  if (first) $('#browse-results').replaceChildren();
  $('#browse-results').append(...next.map(meta => discoverCard(meta)));
  current.shown += next.length;
  $('#browse-more').hidden = !(current.shown < current.metas.length || current.more);
  $('#browse-status').textContent = current.shown ? `${current.name} · showing ${current.shown}` : `Nothing in ${current.name} right now.`;
}

function loadDiscover() {
  state.discoverLoaded = true;
  loadTop10();
  loadBrowseChoices();
  browse(state.browse.id);
}

let searchController;
async function search(event) {
  event.preventDefault();
  const query = $('#search').value.trim();
  if (!query) return;
  searchController?.abort();
  searchController = new AbortController();
  $('#search-wrap').hidden = false;
  skeletons($('#search-results'), 6);
  $('#search-status').textContent = 'Searching Kitsu…';
  try {
    const response = await fetch(`/catalog/series/kitsu-search/search=${encodeURIComponent(query)}.json`, { signal: searchController.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Search failed.');
    const metas = data.metas.slice(0, 30);
    $('#search-results').replaceChildren(...metas.map(discoverCard));
    $('#search-status').textContent = metas.length ? `${metas.length} result${metas.length === 1 ? '' : 's'} for “${query}”` : `Nothing found for “${query}”.`;
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('#search-results').replaceChildren();
    $('#search-status').textContent = error.message;
  }
}

// ---- Connections ------------------------------------------------------------------------

async function loadTokens() {
  try {
    const { data } = await api('/api/v2/stremio/tokens');
    $('#tokens').replaceChildren(...(data.tokens.length ? data.tokens.map(token => el('li', {},
      el('div', {}, el('strong', { text: token.label }), el('br'), el('span', { text: `Created ${formatDate(token.created_at)} · last used ${formatDate(token.last_used_at)}` })),
      el('button', { class: 'button danger ghost small', type: 'button', text: 'Revoke', onclick: async event => {
        if (!confirm(`Revoke "${token.label}"? Stremio on that device will stop showing your rows.`)) return;
        try { await busy(event.currentTarget, () => api(`/api/v2/stremio/tokens/${token.id}`, { method: 'DELETE' })); toast('Install link revoked.'); loadTokens(); }
        catch (error) { toast(error.message, true); }
      } })
    )) : [el('li', {}, el('span', { text: 'No install links yet.' }))]));
  } catch (error) { toast(error.message, true); }
}

async function createToken(event) {
  event.preventDefault();
  try {
    const { data } = await busy(event.submitter || event.currentTarget.querySelector('button'), () =>
      api('/api/v2/stremio/tokens', { method: 'POST', body: { label: $('#token-label').value } }));
    $('#new-token').hidden = false;
    $('#new-token-url').value = data.manifestUrl;
    $('#new-token-install').href = data.installUrl;
    $('#token-label').value = '';
    loadTokens();
  } catch (error) { toast(error.message, true); }
}

async function renderAnilist() {
  const root = $('#anilist');
  let status;
  try { status = (await api('/api/v2/anilist/status')).data; }
  catch (error) { root.replaceChildren(el('p', { class: 'muted', text: error.message })); return; }
  clearInterval(state.pollTimer);
  if (!status.available) {
    root.replaceChildren(el('p', { class: 'muted', text: 'AniList sync is not configured on this server.' }));
    return;
  }
  if (!status.connected) {
    const connect = el('button', { class: 'button primary', type: 'button', text: 'Connect AniList' });
    connect.addEventListener('click', () => busy(connect, async () => {
      try { location.assign((await api('/api/v2/anilist/connect', { method: 'POST' })).data.url); }
      catch (error) { toast(error.message, true); }
    }));
    root.replaceChildren(
      el('p', { class: 'muted', text: 'Import your AniList list and keep progress in sync both ways. Titles are matched through community-maintained ID mappings; anything that cannot be matched exactly is listed, never guessed.' }),
      connect);
    return;
  }
  const result = status.syncResult;
  const running = status.syncStatus === 'running';
  const summary = el('div', { class: 'sync-result' });
  if (running) summary.append(el('strong', { text: 'Syncing with AniList…' }));
  else if (result) {
    const failed = status.syncStatus === 'failed';
    summary.append(
      el('strong', { class: failed ? 'status-bad' : 'status-ok', text: failed ? result.error : `Last sync ${formatDate(result.finishedAt)}` }),
      el('p', { text: `Imported ${result.imported}, updated here ${result.updatedLocal}, sent to AniList ${result.exported + result.updatedRemote}, unchanged ${result.unchanged}${result.conflicts ? `, conflicts resolved ${result.conflicts}` : ''}${result.remaining ? `, ${result.remaining} still to send (sync again)` : ''}.` }));
    if (result.unresolved?.length) {
      summary.append(el('details', {}, el('summary', { text: `${result.unresolved.length} AniList title${result.unresolved.length === 1 ? '' : 's'} could not be matched` }),
        el('ul', {}, result.unresolved.map(item => el('li', { text: `${item.title} — ${item.reason}` })))));
    }
  } else summary.append(el('span', { text: 'Not synced yet.' }));

  const sync = el('button', { class: 'button primary', type: 'button', text: running ? 'Syncing…' : 'Sync now', disabled: running });
  sync.addEventListener('click', () => busy(sync, async () => {
    try { await api('/api/v2/anilist/sync', { method: 'POST' }); toast('Sync started.'); renderAnilist(); }
    catch (error) { toast(error.message, true); }
  }));
  const disconnect = el('button', { class: 'button danger ghost', type: 'button', text: 'Disconnect' });
  disconnect.addEventListener('click', async () => {
    if (!confirm('Disconnect AniList? Your shelf keeps its entries; nothing is deleted on AniList.')) return;
    try { await busy(disconnect, () => api('/api/v2/anilist', { method: 'DELETE' })); toast('AniList disconnected.'); renderAnilist(); }
    catch (error) { toast(error.message, true); }
  });
  const autoPush = el('input', { type: 'checkbox', checked: status.autoPush });
  autoPush.addEventListener('change', async () => {
    try { await api('/api/v2/anilist/settings', { method: 'PATCH', body: { autoPush: autoPush.checked } }); toast(autoPush.checked ? 'Changes will be sent to AniList automatically.' : 'Automatic AniList updates turned off.'); }
    catch (error) { autoPush.checked = !autoPush.checked; toast(error.message, true); }
  });
  root.replaceChildren(
    el('p', {}, 'Connected as ', el('strong', { text: status.username || 'AniList user' }), '.'),
    summary,
    el('label', { class: 'toggle' }, autoPush, 'Send dashboard changes to AniList immediately'),
    el('div', { class: 'actions' }, sync, disconnect));
  if (running) state.pollTimer = setInterval(async () => {
    const { data } = await api('/api/v2/anilist/status').catch(() => ({ data: null }));
    if (data?.syncStatus !== 'running') { clearInterval(state.pollTimer); renderAnilist(); loadLibrary(); state.recsLoaded = false; }
  }, 4000);
}

// ---- Account ------------------------------------------------------------------------

async function loadSessions() {
  try {
    const { data } = await api('/api/v2/me/sessions');
    const others = Math.max(0, data.sessions.length - 1);
    $('#session-count').textContent = others ? `You are also signed in on ${others} other device${others === 1 ? '' : 's'}.` : 'This is your only signed-in device.';
  } catch { /* non-essential */ }
}

function wireAccount() {
  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const { data } = await busy(event.submitter, () => api('/api/v2/me', { method: 'PATCH', body: { displayName: $('#display-name').value } }));
      state.me.user = data.user;
      $('#who-name').textContent = data.user.displayName || data.user.email;
      toast('Profile saved.');
    } catch (error) { toast(error.message, true); }
  });
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await busy(event.submitter, () => api('/api/v2/me/password', { method: 'POST', body: Object.fromEntries(new FormData(form)) }));
      form.reset();
      toast('Password changed. Other devices were signed out.');
    } catch (error) { toast(error.message, true); }
  });
  $('#revoke-sessions').addEventListener('click', async event => {
    try {
      const { data } = await busy(event.currentTarget, () => api('/api/v2/me/sessions/revoke-others', { method: 'POST' }));
      toast(`Signed out of ${data.revoked} other device${data.revoked === 1 ? '' : 's'}.`);
      loadSessions();
    } catch (error) { toast(error.message, true); }
  });
  $('#export').addEventListener('click', async event => {
    try {
      const { data } = await busy(event.currentTarget, () => api('/api/v2/me/export'));
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = el('a', { href: url, download: 'kitsu-anime-shelf-export.json' });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { toast(error.message, true); }
  });
  $('#delete-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!confirm('Permanently delete your account and shelf? This cannot be undone.')) return;
    try {
      await busy(event.submitter, () => api('/api/v2/me/delete', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) }));
      state.me = null;
      toast('Your account was deleted.');
      showSignedOut();
    } catch (error) { toast(error.message, true); }
  });
}

// ---- Start ------------------------------------------------------------------------

async function start() {
  $('#tab-login').addEventListener('click', () => selectAuthTab(false));
  $('#tab-register').addEventListener('click', () => selectAuthTab(true));
  $('#login-form').addEventListener('submit', event => submitAuth(event, '/api/v2/auth/login'));
  $('#register-form').addEventListener('submit', event => submitAuth(event, '/api/v2/auth/register'));
  $('#sign-out').addEventListener('click', async () => {
    await api('/api/v2/auth/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    state.entries = [];
    showSignedOut();
  });
  window.addEventListener('hashchange', () => state.me && showView(location.hash.slice(1)));
  for (const button of document.querySelectorAll('[data-goto]')) button.addEventListener('click', () => { location.hash = button.dataset.goto; });
  $('#filter').addEventListener('input', renderLibrary);
  $('#sort').addEventListener('change', renderLibrary);
  $('#editor-form').addEventListener('submit', submitEditor);
  $('#editor-remove').addEventListener('click', removeEditing);
  $('#search-form').addEventListener('submit', search);
  $('#recs-more').addEventListener('click', event => {
    for (const card of document.querySelectorAll('#recs .card[hidden]')) card.hidden = false;
    event.currentTarget.hidden = true;
  });
  $('#browse-more').addEventListener('click', event => busy(event.currentTarget, () => loadMoreBrowse().catch(error => toast(error.message, true))));
  $('#token-form').addEventListener('submit', createToken);
  $('#new-token-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#new-token-url').value); toast('Copied. Paste it into Stremio’s add-on URL field.'); }
    catch { $('#new-token-url').select(); toast('Select and copy the URL above.'); }
  });
  wireAccount();

  try {
    const { data: config } = await api('/api/v2/config');
    state.config = config;
    if (!config.registrationOpen) $('#tab-register').hidden = true;
  } catch {
    $('#boot').hidden = true;
    $('#unavailable').hidden = false;
    return;
  }
  $('#boot').hidden = true;
  try { await showSignedIn((await api('/api/v2/me')).data); }
  catch { showSignedOut(); }
}

start();
