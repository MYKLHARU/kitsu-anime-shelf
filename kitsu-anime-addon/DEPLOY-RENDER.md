# Deploy Kitsu Anime Shelf on Render

The add-on is ready for Render's **Free Web Service** plan. This guide publishes the 40 main category catalogs, four general catalogs, search, and episode metadata. No database or API key is required.

## 1. Put the files on GitHub

1. Sign in to [GitHub](https://github.com/) and [create a repository](https://github.com/new) named `kitsu-anime-shelf`. A private repository works when connected through Render's GitHub integration.
2. Extract the ZIP and open the `kitsu-anime-addon` folder.
3. In the repository, choose **uploading an existing file**, or **Add file → Upload files**.
4. Drag the **contents** of `kitsu-anime-addon` into the upload area, including `public`, `scripts`, `src`, `test`, `package.json`, `server.mjs`, and `render.yaml`. Commit the upload.

`package.json`, `server.mjs`, and `render.yaml` should be at the repository's top level. Upload the extracted files, rather than the ZIP file itself.

## 2. Create the web service

In the [Render dashboard](https://dashboard.render.com/), choose **New → Web Service**. Connect GitHub and select the repository you just uploaded.

Use these settings:

| Field | Value |
| --- | --- |
| Name | `kitsu-anime-shelf` (or another available name) |
| Language / Runtime | `Node` |
| Branch | `main`, or the branch containing your files |
| Root Directory | Leave empty when `package.json` is at the top level |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Environment variable `HOST` | `0.0.0.0` |
| Environment variable `NODE_VERSION` | `22` |
| Health Check Path, under Advanced | `/health` |

Render supplies `PORT` automatically. Leave its value managed by Render.

Select **Create Web Service / Deploy Web Service**, depending on the current dashboard label, and wait for the deployment to become **Live**.

Alternatively, Render's **New → Blueprint** workflow can read the included `render.yaml` from your connected repository. It contains the same commands, environment settings, health check, and `plan: free`. Use either the web-service workflow or the Blueprint workflow to create one service.

## 3. Install and share

Render displays your service's HTTPS address, such as `https://YOUR-SERVICE.onrender.com`.

1. Open that address. The installation page should display your anime catalog preview.
2. Choose **Install in Stremio**, or copy the manifest URL into Stremio's add-on URL field.
3. Share **`https://YOUR-SERVICE.onrender.com/manifest.json`** with other users.

If you previously installed the local version, remove that installation and install the hosted URL. Your computer no longer needs to run the local server for the hosted installation to work.

## Free-plan behavior

Render's free web services sleep after 15 minutes without incoming traffic. The next request wakes the service; startup can take about a minute. Monthly usage quotas apply. If a first catalog load stalls, open the hosted installation page, allow startup to finish, then retry in Stremio.

## Common deployment fixes

- **Cannot find `package.json`:** the files are inside an extra folder. Set Root Directory to that folder, or upload the folder's contents at the repository's top level.
- **Port or health-check failure:** ensure `HOST` is `0.0.0.0`, keep Start Command as `npm start`, and let Render supply `PORT`.
- **Node version error:** ensure `NODE_VERSION` is `22` or a newer supported Node version.
- **Page loads but anime do not:** check the Render service logs for a Kitsu.app request error and retry after any upstream outage.

Official references: [Render web services](https://render.com/docs/web-services), [Node version configuration](https://render.com/docs/node-version), [Free-plan limits](https://render.com/docs/free), [Blueprint specification](https://render.com/docs/blueprint-spec).
