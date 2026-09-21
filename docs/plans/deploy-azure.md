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
| `NODE_ENV` | `production` — **also affects the Azure build; see §4** |
| `PORT` | (leave blank / omit — Azure injects `8080`) |
| `CLIENT_URL` | `https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net` |
| `API_BASE_URL` | `https://webform-sandbox-addph8hsd9feghdp.eastus2-01.azurewebsites.net` |
| `PUBLIC_BASE_URL` | same as above |
| `DEFAULT_ORG_REGISTRATION` | `academics` — the org slug new self-registrations land in (blank ⇒ `academics`) |
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

### 4. Let the Oryx build install devDependencies (required)

`webapps-deploy` uploads the repo as a package, so App Service runs **Oryx**, which
runs `npm install` and `npm run build` a **second** time inside Azure — after the
GitHub Actions build has already done both. On a fresh deployment that second build
fails with:

```
Running 'npm run build'...
> school-forms@1.0.0 build
> npm-run-all build:server build:client
sh: 1: npm-run-all: not found
```

**Cause: `NODE_ENV=production` from §2 is read by npm itself.** npm's `omit` config
defaults to `dev` whenever `NODE_ENV=production`, so Oryx's flagless `npm install`
skips *every* devDependency. (The Azure docs say Oryx installs devDependencies —
true only when `NODE_ENV` is not `production`.) Measured against this lockfile:

| `NODE_ENV` | `npm config get omit` | `npm install --dry-run` |
|---|---|---|
| unset | *(empty)* | added **712** packages |
| `production` | **`dev`** | added **374** packages |

The Azure log's own `added 375 packages` is that production-only tree. `npm-run-all`,
`typescript`, `tsx` and `vite` are **all** devDependencies, so `npm-run-all` is only
the *first* binary missing — `tsc` and `vite` would fail next. Note the Oryx summary
still prints `Found 0 issue(s)`, so the failure is **not** reported as an error at the
end of the log; read the `npm run build` section instead.

**Fix — add one App Setting** (**Settings → Configuration → Application settings**):

| Name | Value | Why |
|---|---|---|
| `NPM_CONFIG_INCLUDE=dev` | `dev` | install devDependencies even though `NODE_ENV=production` |

```bash
az webapp config appsettings set -g <resource-group> -n webform --slot sandbox \
  --settings NPM_CONFIG_INCLUDE=dev
```

- `NPM_CONFIG_PRODUCTION=false` works identically, but npm 11 warns *"Use `--omit=dev`
  instead"*, so prefer `NPM_CONFIG_INCLUDE=dev`.
- An **empty** `NPM_CONFIG_OMIT=` does **not** work — `NODE_ENV` still wins (verified).

**Alternative — skip the second build entirely.** The GitHub Actions job already
installs and builds and uploads the whole repo (including `node_modules/` and
`dist/`), so the Oryx build is redundant:
- `SCM_DO_BUILD_DURING_DEPLOYMENT` = `false`

This is faster, but it makes the deployment depend on the artifact continuing to
carry `node_modules/` + `dist/`. Trim the artifact later (e.g. to stop shipping
`node_modules`) and the app boots with `Cannot find module 'express'`.
`NPM_CONFIG_INCLUDE=dev` keeps the deploy self-contained, which is why it is the
recommended fix.

> This is **not** a npm-workspaces problem — the root `build` script never got as far
> as a workspace. Rewriting `npm-run-all` out of the root `build` script does **not**
> fix it, because `tsc` and `vite` are missing for the same reason.

### 5. Staging slot (optional)

A deployment slot is a **separate app with its own settings**. Nothing is shared, and
the clone offered in the *Add Slot* dialog is a **one-off snapshot, not a link** — a
setting added to `sandbox` afterwards does **not** appear on the new slot.

**Set these on the new slot** (Configuration → Application settings):

| Name | Value | Notes |
|---|---|---|
| `NPM_CONFIG_INCLUDE` | `dev` | see §4 — Oryx builds **in the slot you deploy to** |
| `NODE_ENV` | `production` | |
| `DB_MODE` | `sqlserver` | blank/unset also means `sqlserver` |
| `DB_SERVER` `DB_DATABASE` `DB_USER` `DB_PASSWORD` | production's values | **required** in `sqlserver` mode |
| `JWT_ACCESS_SECRET` `JWT_REFRESH_SECRET` | production's values | **required** — boot throws without them |
| `CLIENT_URL` `API_BASE_URL` `PUBLIC_BASE_URL` | the slot's own URL | tick **Deployment slot setting** |
| Startup command | `node server/dist/index.js` | General settings, per slot |

Boot-blocking variables in `sqlserver` mode are exactly the six above plus the JWT
pair — `server/src/config/env.ts` `required()` / `requiredForSqlServer()` throw
otherwise. Every other variable has a default.

**Tick *Deployment slot setting* on the three URL variables.** App settings **swap by
default**, so without the tick a swap carries the staging hostname into production and
every absolute URL (Google/webhook callbacks) points at the wrong host. The rule to
follow: *the same setting **name** must exist in every slot involved in a swap,* even
where the **value** differs.

#### ⚠ Sharing the production database means staging deploys migrate production

`SQLSERVER_DDL_STATEMENTS` is "a cumulative migration ladder, executed once at
startup" (`server/src/db/schema.ts`), and `initDb()` runs on **every boot**
(`server/src/index.ts`, after `app.listen`). The guards are
`IF OBJECT_ID(...) IS NULL` for tables and `IF COL_LENGTH(...) IS NULL` for columns —
create-if-missing, so re-running is safe.

With `DB_MODE=sqlserver` and `DB_*` pointing at the shared database, **booting the
staging slot applies that ladder to production** — before any swap, and whether or not
a swap ever happens. Push a branch that adds a column, deploy it to staging, and the
production schema changes on the slot's first request.

That is acceptable only while every change stays backward compatible (new nullable
columns, new tables). A rename, a type change, or a dropped column needs a separate
database for staging. A second Turso DB is the cheap fix: `DB_MODE=turso` needs only
`TURSO_DB_URL` + `TURSO_DB_APIKEY` and **no** SQL Server credentials.

#### Shared secrets have shared side effects

With production's values on staging, staging actions are real:
- `SLACK_WEBHOOK_URL` — staging submissions post into the real admin channel.
- `GOOGLE_REFRESH_TOKEN` / `GOOGLE_DOC_FOLDER_ID` — staging-generated documents land
  in the real Drive folder.
- `users` / `forms` / `submissions` are the production rows (this is the shared-DB
  choice, restated).

Blank `SLACK_WEBHOOK_URL` disables the notifier; blank `GOOGLE_DOC_FOLDER_ID` falls
back to the Drive root.

#### Networking

Outbound IPs are assigned per **deployment unit**, and every app and slot in the same
App Service plan shares them — so the SQL firewall allowlist from §2 already covers the
new slot. Verify rather than assume:

```bash
az webapp show -g <resource-group> -n webform --slot <slot-name> \
  --query outboundIpAddresses -o tsv
```

#### Deploying to the slot

Publishing endpoints are **slot-specific and are not swapped**, so the new slot needs
its **own** publish profile: open the slot → *Get publish profile*, add it as a new
repo secret, and point a workflow at it.
`.github/workflows/main_webform(sandbox).yml:53` hard-codes `slot-name: 'sandbox'`, so
it will never deploy to another slot.

`.github/workflows/main_webform(staging).yml` targets this slot. It needs one secret:

| Secret | Where to get it |
|---|---|
| `AZUREAPPSERVICE_PUBLISHPROFILE_STAGING` | staging slot → **Get publish profile** (the `.PublishSettings` XML, pasted whole) |

Both workflows trigger on `push: main`, so a push to `main` now deploys to `sandbox`
**and** `staging`. To make staging manual-only, delete the `push:` block from the
staging file and keep `workflow_dispatch:`.

Two things that surprise people: the new slot has **no content** even when its settings
were cloned, and its **Traffic % starts at 0** — the slot's own URL works as soon as you
deploy to it, but no customer traffic reaches it until you swap or raise that value.

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
