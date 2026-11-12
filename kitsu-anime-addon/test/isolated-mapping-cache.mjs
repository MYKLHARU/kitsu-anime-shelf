// Point default mapping loaders at a private, per-process cache file so tests
// never read or leave behind the real system-wide cache in os.tmpdir().
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kitsu-test-mappings-'));
process.env.ANIME_MAPPING_CACHE_PATH = join(dir, 'mappings.json');
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
