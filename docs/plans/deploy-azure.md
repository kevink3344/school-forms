# Deploy School Forms to Azure App Service (Linux / Node)

This guide deploys the **whole app** (Express API + built React client) to a single
Azure App Service. It's the production replacement for the ephemeral `localtunnel`
URL that Google Apps Script currently calls.

## Architecture

```
https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net
  ├─ /api/*      → Express API routes (auth, forms, submissions, webhook, health)
  └─ /*          → Built React SPA (served by Express static + SPA fallback)
```

The React client calls **relative** `/api/...` paths because it shares the same
origin as the API, so no CORS is needed in production.

## One-time Azure setup

### 1. Confirm the runtime stack
- Azure portal → your web app → **Settings → Configuration → General settings**
- **Stack**: `Node 20 LTS` (the app already shows "Built with NodeJS").
- **Startup command**: `node server/dist/index.js`

### 2. Set the app environment variables (App settings)
Under **Settings → Configuration → Application settings**, add (mirroring your
`.env`, but real values):

| Name | Example value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | (leave blank / omit — Azure injects `8080`) |
| `CLIENT_URL` | `https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net` |
| `API_BASE_URL` | `https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net` |
| `PUBLIC_BASE_URL` | same as above |
| `DB_SERVER` | `wcpss-sql-serverless-freetier.database.windows.net` |
| `DB_PORT` | `1433` |
| `DB_DATABASE` | `school-form-data` |
| `DB_USER` | `wcpss-sql-admin` |
| `DB_PASSWORD` | your DB password |
| `JWT_ACCESS_SECRET` | a real 64-char random hex |
| `JWT_REFRESH_SECRET` | a real 64-char random hex |
| `GOOGLE_FORMS_WEBHOOK_SECRET` | must match the Apps Script `WEBHOOK_SECRET` |

> **Note:** the SQL Server is behind Azure **Serverless** — add `public` firewall
> rule in the SQL server portal to allow the App Service's outbound IP, or better,
> use a **Private/firewall allowlist** for the web app's outbound IP.

### 3. Add the publish profile GitHub secret
1. Azure portal → web app → **Overview → Get publish profile** → download
   `webform-sandbox-addph8hsd9feghdp.PublishSettings`.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**.
3. Name: `AZURE_WEBAPP_PUBLISH_PROFILE`, value = whole file contents.

### 4. (Optional) Disable Oryx build
The workflow ships `node_modules` already built, so set an app setting to skip
Azure's build (avoids Oryx tripping over the npm-workspaces monorepo):
- `SCM_DO_BUILD_DURING_DEPLOYMENT` = `false`

## Deploy

Push to `main` (or run the workflow manually from the Actions tab). The workflow:
1. `npm ci`
2. `npm run build` (`server` + `client` compiled)
3. zips `server/dist`, `client/dist`, `node_modules`
4. deploys the zip to the App Service via `azure/webapps-deploy@v3`

## Post-deploy
- Visit `https://<app>.azurewebsites.net/` — should show the React login page.
- `https://<app>.azurewebsites.net/api/health` — `{"ok":true,"dbReady":true}`.
- Update `API_BASE` in `docs/plans/google-script.md` to the new Azure URL.
