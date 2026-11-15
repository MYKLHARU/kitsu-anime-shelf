const $ = selector => document.querySelector(selector);
const addonOrigin = document.documentElement.dataset.addonOrigin || location.origin;
const addonUrl = new URL(addonOrigin);
const fallbackPoster = new URL('./logo.svg', document.baseURI).href;
// Rows chosen on this page are encoded in the install URL: /c/<keys>/manifest.json
const chosen = new Set((/^\/c\/([a-z0-9.-]+)\/configure\/?$/.exec(location.pathname)?.[1] || '').split('.').filter(Boolean));
let options = [];
let manifestUrl = '';
function updateInstall() {
  const keys = options.filter(option => chosen.has(option.key)).map(option => option.key);
  for (const chip of document.querySelectorAll('.choose-chip')) chip.setAttribute('aria-pressed', String(chosen.has(chip.dataset.key)));
  manifestUrl = keys.length ? new URL(`/c/${keys.join('.')}/manifest.json`, addonUrl).href : '';
  $('#manifest-url').value = manifestUrl;
  $('#install').href = keys.length ? manifestUrl.replace(/^https?:/, 'stremio:') : '#';
  $('#install').setAttribute('aria-disabled', String(!keys.length));
  $('#copy-status').textContent = keys.length ? `${keys.length} row${keys.length === 1 ? '' : 's'} chosen. Install, or copy the URL for another device.` : 'Choose at least one list or genre.';
}
function renderChoices() {
  const chip = option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choose-chip';
    button.dataset.key = option.key;
    button.textContent = option.name;
    button.addEventListener('click', () => { if (chosen.has(option.key)) chosen.delete(option.key); else chosen.add(option.key); updateInstall(); });
    return button;
  };
  $('#choose-lists').replaceChildren(...options.filter(option => option.group === 'list').map(chip));
  $('#choose-genres').replaceChildren(...options.filter(option => option.group === 'genre').map(chip));
  updateInstall();
}
$('#choose-all').addEventListener('click', () => { for (const option of options) if (option.group === 'genre') chosen.add(option.key); updateInstall(); });
$('#choose-none').addEventListener('click', () => { for (const option of options) if (option.group === 'genre') chosen.delete(option.key); updateInstall(); });
$('#install').addEventListener('click', event => {
  if (manifestUrl) return;
  event.preventDefault();
  $('#copy-status').textContent = 'Choose at least one list or genre first.';
  $('#choose').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
// Show the 2.0 dashboard link only when this server has accounts enabled.
fetch(new URL('/health', addonUrl)).then(response => response.json()).then(health => {
  if (!health.accounts) return;
  const link = $('#dashboard-link');
  link.href = new URL('/dashboard', addonUrl).href;
  link.hidden = false;
}).catch(() => {});
if (addonUrl.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(addonUrl.hostname)) {
  $('#hosting-note').textContent = 'This hosted add-on can be installed on other devices using the same manifest URL. Share the URL below to let other people install it.';
}
$('#copy').addEventListener('click', async () => {
  if (!manifestUrl) { $('#copy-status').textContent = 'Choose at least one list or genre first.'; return; }
  try {
    await navigator.clipboard.writeText(manifestUrl);
    $('#copy-status').textContent = 'Copied. Paste it into the add-on URL field in Stremio.';
  } catch {
    $('.install-help').open = true;
    $('#manifest-url').focus();
    $('#manifest-url').select();
    $('#copy-status').textContent = 'Select and copy the manifest URL below.';
  }
});

let controller;
let generation = 0;

async function browse() {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const query = $('#search').value.trim();
  const catalog = query ? 'kitsu-search' : $('#catalog').value;
  const params = [];
  if (query) params.push(`search=${encodeURIComponent(query)}`);
  const path = `/catalog/series/${catalog}${params.length ? `/${params.join('&')}` : ''}.json`;
  const cards = $('#cards');
  cards.replaceChildren(...Array.from({ length: 12 }, () => {
    const card = document.createElement('div');
    card.className = 'skeleton';
    card.setAttribute('aria-hidden', 'true');
    return card;
  }));
  cards.setAttribute('aria-busy', 'true');
  $('#results-status').textContent = 'Finding anime on Kitsu…';
  try {
    const response = await fetch(new URL(path, addonUrl), { signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load the catalog.');
    if (current !== generation) return;
    const metas = result.metas.slice(0, 12);
    cards.replaceChildren(...metas.map(meta => {
      const card = document.createElement('a');
      card.className = 'card';
      card.href = meta.links.find(link => link.name === 'View on Kitsu').url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      const poster = document.createElement('img');
      poster.className = 'poster';
      poster.alt = meta.name;
      poster.loading = 'lazy';
      poster.src = meta.poster || fallbackPoster;
      poster.addEventListener('error', () => { if (poster.src !== fallbackPoster) poster.src = fallbackPoster; }, { once: true });
      const name = document.createElement('h3');
      name.textContent = meta.name;
      name.title = meta.name;
      const year = document.createElement('p');
      year.textContent = meta.releaseInfo || 'Anime';
      card.append(poster, name, year);
      return card;
    }));
    $('#results-status').textContent = metas.length ? `Previewing ${metas.length} titles · Install to browse the full catalog in Stremio.` : 'No titles found. Try another title or category.';
  } catch (error) {
    if (error.name === 'AbortError' || current !== generation) return;
    cards.replaceChildren();
    $('#results-status').textContent = `${error.message} Use Browse to try again.`;
  } finally {
    if (current === generation) cards.setAttribute('aria-busy', 'false');
  }
}

$('#browse-form').addEventListener('submit', event => { event.preventDefault(); browse(); });
function updateCatalogButtons() {
  for (const button of document.querySelectorAll('.catalog-choice')) {
    button.setAttribute('aria-pressed', String(!$('#search').value.trim() && button.dataset.catalog === $('#catalog').value));
  }
}

$('#catalog').addEventListener('change', () => { $('#search').value = ''; updateCatalogButtons(); browse(); });
$('#search').addEventListener('input', updateCatalogButtons);

async function init() {
  try {
    const response = await fetch(new URL('/catalog-options.json', addonUrl));
    if (!response.ok) throw new Error('Catalog list unavailable. Refresh to try again.');
    options = (await response.json()).options;
    renderChoices();
    const catalogs = options.map(option => ({ id: option.id, name: option.name }));
    for (const catalog of catalogs) {
      const option = document.createElement('option');
      option.value = catalog.id;
      option.textContent = catalog.name;
      $('#catalog').append(option);
      if (catalog.id.startsWith('kitsu-category-')) {
        const button = document.createElement('button');
        button.className = 'catalog-choice';
        button.type = 'button';
        button.textContent = catalog.name;
        button.dataset.catalog = catalog.id;
        button.addEventListener('click', () => {
          $('#catalog').value = catalog.id;
          $('#search').value = '';
          updateCatalogButtons();
          browse();
        });
        $('#main-catalogs').append(button);
      }
    }
    updateCatalogButtons();
    await browse();
  } catch (error) {
    $('#results-status').textContent = error.message;
  }
}

init();
