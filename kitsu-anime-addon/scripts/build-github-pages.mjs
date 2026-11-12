import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';

// GitHub Pages serves the website; the existing Node service supplies the API.
const addonOrigin = 'https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run';
const source = new URL('../public/', import.meta.url);
const output = new URL('../../docs/', import.meta.url);
await mkdir(output, { recursive: true });
const html = await readFile(new URL('index.html', source), 'utf8');
if (!html.includes('<html lang="en">')) throw new Error('Website template is missing its expected root element.');
await writeFile(new URL('index.html', output), html.replace('<html lang="en">', `<html lang="en" data-addon-origin="${addonOrigin}">`));
for (const name of ['app.css', 'app.js', 'logo.svg', 'tmdb.svg']) {
  await copyFile(new URL(name, source), new URL(name, output));
}
await writeFile(new URL('.nojekyll', output), '');
console.log('Built GitHub Pages website in docs/');
