// Assembles the optional 2.0 application from environment variables.
// With ACCOUNTS_ENABLED unset the service behaves exactly like 1.x.
import { createPool } from './pg-client.mjs';
import { migrate, pendingMigrations } from './migrate.mjs';
import { createAccountStore } from './account-store.mjs';
import { createAnimeStore, createAnilistIndexLoader } from './anime-store.mjs';
import { createPostgresLibraryAdapter } from './postgres-library-adapter.mjs';
import { createLibraryService } from './library-store.mjs';
import { createRecommender } from './recommendations.mjs';
import { createAnilistClient } from './anilist.mjs';
import { createAnilistSync } from './anilist-sync.mjs';
import { createTokenCipher, parseEncryptionKey } from './security.mjs';
import { isAllowedOriginSetting } from './library-api.mjs';
import { createV2App } from './v2-app.mjs';
import { createCatalogStore } from './catalog-store.mjs';

export function readV2Config(env = process.env) {
  if (env.ACCOUNTS_ENABLED !== 'true') return { enabled: false };
  const errors = [];
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  let origin;
  try { origin = new URL(publicUrl).origin; } catch { /* reported below */ }
  if (!origin || origin !== publicUrl || !isAllowedOriginSetting(origin)) {
    errors.push('PUBLIC_URL must be the exact HTTPS origin of this service (http://localhost is allowed for development).');
  }
  if (!env.DATABASE_URL) errors.push('DATABASE_URL is required.');
  let encryptionKey;
  try { encryptionKey = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY); } catch (error) { errors.push(error.message); }
  const hops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 5) errors.push('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  const anilistConfigured = Boolean(env.ANILIST_CLIENT_ID || env.ANILIST_CLIENT_SECRET);
  if (anilistConfigured && !(env.ANILIST_CLIENT_ID && env.ANILIST_CLIENT_SECRET)) errors.push('Set both ANILIST_CLIENT_ID and ANILIST_CLIENT_SECRET, or neither.');
  const poolMax = Number(env.DATABASE_POOL_MAX ?? 10);
  if (!Number.isSafeInteger(poolMax) || poolMax < 1 || poolMax > 100) errors.push('DATABASE_POOL_MAX must be between 1 and 100.');
  return {
    enabled: true, errors, publicUrl: origin, databaseUrl: env.DATABASE_URL, encryptionKey, trustProxyHops: hops, poolMax,
    registrationOpen: env.REGISTRATION_OPEN !== 'false',
    runMigrations: env.RUN_MIGRATIONS_ON_START === 'true',
    anilist: anilistConfigured ? { clientId: env.ANILIST_CLIENT_ID, clientSecret: env.ANILIST_CLIENT_SECRET, redirectUri: `${origin}/api/v2/anilist/callback` } : null
  };
}

// Returns a factory for createAddonServer, or undefined when 2.0 is disabled or
// cannot start safely (the public add-on keeps running in that case).
export async function prepareV2({ env = process.env, logger = console, version, db: injectedDb, fetchImpl, anilistMinIntervalMs } = {}) {
  const config = readV2Config(env);
  if (!config.enabled) return undefined;
  if (config.errors.length) {
    logger.error(`Accounts are disabled because the configuration is incomplete:\n- ${config.errors.join('\n- ')}`);
    return undefined;
  }
  const db = injectedDb ?? createPool(config.databaseUrl, { max: config.poolMax, logger });
  try {
    if (config.runMigrations) await migrate(db, { logger });
    const pending = await pendingMigrations(db);
    if (pending.length) {
      logger.error(`Accounts are disabled until the database is migrated. Pending: ${pending.join(', ')}. Run "npm run migrate".`);
      if (!injectedDb) await db.end();
      return undefined;
    }
  } catch (error) {
    logger.error(`Accounts are disabled because the database is unavailable: ${error.message}`);
    if (!injectedDb) await db.end();
    return undefined;
  }

  const factory = ({ api, service, artwork, loadMappings, seasonGroups }) => {
    const accounts = createAccountStore(db);
    const loadAnilistIndex = createAnilistIndexLoader(loadMappings);
    const animeStore = createAnimeStore(db, { api, loadAnilistIndex });
    const library = createLibraryService(createPostgresLibraryAdapter(db));
    const recommender = createRecommender({ api, seasonGroups, artwork });
    const cipher = createTokenCipher(config.encryptionKey);
    const anilist = config.anilist ? createAnilistClient({ ...config.anilist, ...(fetchImpl ? { fetchImpl } : {}), ...(anilistMinIntervalMs !== undefined ? { minIntervalMs: anilistMinIntervalMs } : {}) }) : undefined;
    const anilistSync = anilist ? createAnilistSync({ anilist, accounts, library, animeStore, loadAnilistIndex, cipher, logger }) : undefined;
    const maintenance = setInterval(() => accounts.cleanup().catch(error => logger.error(`Maintenance failed: ${error.message}`)), 6 * 3600000);
    maintenance.unref();
    accounts.cleanup().catch(() => {});
    const handle = createV2App({
      accounts, library, animeStore, recommender, anilist, anilistSync, cipher, service, artwork,
      publicUrl: config.publicUrl, version, trustProxyHops: config.trustProxyHops, registrationOpen: config.registrationOpen, logger
    });
    return { handle, catalogStore: createCatalogStore(db), close: async () => { clearInterval(maintenance); if (!injectedDb) await db.end(); }, capabilities: { accounts: true, anilist: Boolean(anilist) } };
  };
  return factory;
}
