# Deploying Kitsu Anime Shelf 2.0 (release candidate)

**Do not deploy until the release candidate is approved.** These steps add accounts to the existing Northflank service without affecting the public add-on. Every step can be undone by setting `ACCOUNTS_ENABLED=false`.

## 1. Provision PostgreSQL

Create a PostgreSQL 13+ database (Northflank addon, or any managed PostgreSQL). Enable backups. Note its connection string, for example:

```text
postgres://shelf_app:PASSWORD@HOST:5432/shelf?sslmode=verify-full
```

Use `sslmode=require` only if the provider cannot supply a verifiable certificate; add `&sslrootcert=/path/to/ca.pem` for a private CA.

## 2. Apply migrations

From a trusted machine with access to the database (or a one-off Northflank job):

```text
cd kitsu-anime-addon
npm ci
DATABASE_URL='postgres://…' npm run migrate
DATABASE_URL='postgres://…' npm run migrate -- --status   # "Database schema is up to date."
```

Alternatively set `RUN_MIGRATIONS_ON_START=true` for the first deployment and remove it afterwards. The service refuses to enable accounts while migrations are pending.

## 3. Register an AniList application (optional)

At [AniList → Settings → Developer](https://anilist.co/settings/developer), create a client with the redirect URL:

```text
https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run/api/v2/anilist/callback
```

Copy the client ID and secret. Without them, everything except AniList sync works.

## 4. Configure runtime secrets

| Variable | Value |
| --- | --- |
| `ACCOUNTS_ENABLED` | `true` |
| `PUBLIC_URL` | `https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run` (already set for artwork; must be the exact origin, no path) |
| `DATABASE_URL` | Connection string from step 1 (secret) |
| `TOKEN_ENCRYPTION_KEY` | Output of `openssl rand -hex 32` (secret; keep a copy in your password manager) |
| `TRUST_PROXY_HOPS` | `1` |
| `ANILIST_CLIENT_ID`, `ANILIST_CLIENT_SECRET` | From step 3 (secret) |
| `REGISTRATION_OPEN` | `false` for a private shelf; omit to allow sign-ups |
| `DATABASE_POOL_MAX` | Optional, default `10` |

Keep the existing `HOST`, `PORT`, TMDB and mapping settings. Run **one** instance.

## 5. Deploy and verify

Deploying from `main` happens only after the PR is merged. After deployment:

1. `/manifest.json` reports `2.0.0-rc.1` and the same catalogs as before. `/health` reports `"accounts": true` (and `"anilist": true` if configured). If `accounts` is `false`, the service log explains why.
2. Run the existing live checks:
   ```text
   npm run test:seasons -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run
   npm run test:artwork -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run
   npm run test:hero -- https://site--kitsu-anime-addon--zmzjxk5mn92q.code.run
   ```
3. Open `/dashboard`, create your account (then set `REGISTRATION_OPEN=false` if desired), add a title, change its progress, and connect AniList. The first sync starts automatically; review unmatched titles in Connections.
4. Under Connections, create a Stremio install link and install it. The **My Shelf** rows should appear next to the existing Kitsu catalogs, and opening a title should play through your usual stream add-on.
5. Check that playback of a title from the public catalogs is unchanged.

## Rollback

- **Disable 2.0:** set `ACCOUNTS_ENABLED=false` and restart. The public add-on continues as in 1.4.3; data remains in the database.
- **Full rollback:** redeploy the 1.4.3 build. The 1.x code ignores the database entirely. Do not drop the tables unless you intend to delete all accounts.
- **Key compromise:** rotate `TOKEN_ENCRYPTION_KEY`. Existing AniList connections then fail to decrypt; users reconnect AniList. Rotate `ANILIST_CLIENT_SECRET` in AniList at the same time.
