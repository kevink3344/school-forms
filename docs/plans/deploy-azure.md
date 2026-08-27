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

> **Already done:** Azure's **Deployment Center** auto-added a GitHub Actions
> workflow (`.github/workflows/main_webform(sandbox).yml`) targeting app
> **`webform`**, slot **`sandbox`** with secret
> `AZUREAPPSERVICE_PUBLISHPROFILE_6C4AA924339D4DF8A231119473E59D55`. That
> secret already exists in your repo. Deployment triggers on any push to `main`.

### 1. Confirm the runtime stack
- Azure portal → your web app → **Settings → Configuration → General settings**
- **Stack**: `Node 22 LTS` (the auto workflow sets `node-version: '22.x'`).
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

### 3. Publish-profile secret (already present)
The Azure-generated workflow uses secret
`AZUREAPPSERVICE_PUBLISHPROFILE_6C4AA924339D4DF8A231119473E59D55`. It was
created when you wired up the Deployment Center, so no action needed.

### 4. Disable Oryx build (recommended)
The root `package.json` **build** script compiles both workspaces. To avoid Oryx
re-building (and tripping over the npm-workspaces monorepo), set an app setting:
- `SCM_DO_BUILD_DURING_DEPLOYMENT` = `false`

## Deploy

Push to `main` (or click **Run workflow** in the Actions tab). Azure's workflow:
1. `npm install`
2. `npm run build --if-present` (root **build** → server + client)
3. uploads the whole repo as an artifact
4. `azure/webapps-deploy@v3` deploys to app `webform`, slot `sandbox`

> The startup command must be `node server/dist/index.js` (set in the portal) so
> the compiled `server/dist/index.js` boots. The same server also serves the
> built React SPA from `client/dist`.

## Post-deploy
- Visit `https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net/`
  — should show the React login page.
- `https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net/api/health`
  — `{"ok":true,"dbReady":true}`.
- Update `API_BASE` in `docs/plans/google-script.md` to the slot URL above.
