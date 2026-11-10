import { createAddonServer } from './src/addon.mjs';

const port = Number(process.env.PORT || 47861);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');

const server = createAddonServer();
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another PORT, or stop an earlier copy of this add-on.` : error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Kitsu Anime Shelf is running.\nSetup: http://127.0.0.1:${port}/\nManifest: http://127.0.0.1:${port}/manifest.json\nKeep this process running while using the add-on. Ctrl+C stops it.`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close();
  server.closeAllConnections();
});
