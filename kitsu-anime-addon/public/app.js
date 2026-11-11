const $ = selector => document.querySelector(selector);
const manifestUrl = `${location.origin}/manifest.json`;
$('#install').href = `stremio://${location.host}/manifest.json`;
$('#manifest-url').value = manifestUrl;
if (location.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  $('#hosting-note').textContent = 'This hosted add-on can be installed on other devices using the same manifest URL. Share the URL below to let other people install it.';
}
$('#copy').addEventListener('click', async () => {
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
    const response = await fetch(path, { signal: controller.signal });
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
      poster.src = meta.poster || '/logo.svg';
      poster.addEventListener('error', () => { if (!poster.src.endsWith('/logo.svg')) poster.src = '/logo.svg'; }, { once: true });
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
    const response = await fetch('/manifest.json');
    if (!response.ok) throw new Error('Manifest unavailable. Refresh to try again.');
    const manifest = await response.json();
    const catalogs = manifest.catalogs.filter(catalog => !catalog.extra.some(extra => extra.name === 'search' && extra.isRequired));
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
