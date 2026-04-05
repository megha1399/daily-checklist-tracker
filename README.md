# Daily Checklist Tracker

Angular app for a **weekly routine**, **daily checklist** (Today), and **progress** reports. With accounts enabled, data syncs to a **Node/Express** API backed by **PostgreSQL** (e.g. [Neon](https://neon.tech)).

## Stack

- **Frontend:** Angular 19 (`src/`)
- **API:** Express in `server/` (`index.mjs`), JWT auth, routine CRUD
- **Database:** PostgreSQL only (`DATABASE_URL`); schema is created on startup

## Prerequisites

- Node.js (LTS recommended)
- A PostgreSQL connection string for the API (`server/.env`)

## Local development

1. **API env** — copy `server/.env.example` to `server/.env` and set at least:

   - `DATABASE_URL` — Neon or any Postgres URL (often with `sslmode=require`)
   - `JWT_SECRET` — long random string

2. **Install dependencies**

   ```bash
   npm install
   npm install --prefix server
   ```

3. **Run app + API together** (recommended)

   ```bash
   npm run start:full
   ```

   Or in two terminals:

   ```bash
   npm run start:api    # Express on port 3456 (default)
   npm start            # Angular on http://localhost:4200
   ```

   The dev server proxies `/api` to the API via `proxy.conf.json`. `src/environments/environment.ts` uses `apiBaseUrl: '/api'`.

4. Open **http://localhost:4200**, register or log in, and use Routine / Today / Progress.

## Production build (single Node process)

Build the SPA, then run the server with `STATIC_DIR` so Express serves the Angular app and `/api` on the same origin:

```bash
npm run build
cd server
# In server/.env: STATIC_DIR=dist/habit-tracker/browser  (relative to repo root)
node index.mjs
```

See `server/.env.example` for `STATIC_DIR`, `HOST`, and `PORT`.

## Deploy to Render (free Web Service)

The repo includes **`render.yaml`** so Render can build the Angular app, install the API dependencies, and run **`node server/index.mjs`** with **`STATIC_DIR`** set. The site and **`/api`** share the same URL (same as local production).

### Steps

1. Push this project to **GitHub** (or GitLab / Bitbucket supported by Render).
2. Open [Render Dashboard](https://dashboard.render.com) → **New +** → **Blueprint**.
3. Connect the repository and select the branch. Render reads **`render.yaml`** and proposes a **Web Service** on the **Free** plan.
4. Before or after the first deploy, open the service → **Environment** and add:
   - **`DATABASE_URL`** — your Neon (or other Postgres) connection string.
   - **`JWT_SECRET`** — a long random secret (do not use the dev default).
   - **`FRONTEND_URL`** — public site URL with **no** trailing slash, e.g. `https://daily-checklist-tracker.onrender.com` (used in verification emails).
   - **SMTP** — `SMTP_HOST`, `SMTP_PORT` (often `587`), `SMTP_USER`, `SMTP_PASS`, and **`EMAIL_FROM`** (shown as the sender). Without these, **register returns 503** in production (`NODE_ENV=production`). See `server/.env.example` and the **Email verification** section below.

   `STATIC_DIR`, `HOST`, `NODE_VERSION`, and `NODE_ENV` are already defined in `render.yaml`. **Do not** set `PORT` manually — Render injects it.

5. Trigger a deploy. When it is green, open the **`.onrender.com` URL**. **Sign up** triggers a verification email; open the link to create the account, then use **Log in**.

### Email verification (register)

New accounts are **not** created until the user opens the link in the verification email (`POST /api/auth/verify-email`). Pending rows live in table **`pending_registrations`**.

- **Production** requires **`FRONTEND_URL`** + working **SMTP** (see `server/.env.example`). Providers such as [Resend](https://resend.com/docs/send-with-nodejs-smtp), SendGrid, or Mailgun expose SMTP credentials.
- **Local dev** (no `NODE_ENV=production`): registration still works; if SMTP is unset, the verification URL is **printed in the API server log** instead of emailed.

After pulling changes, run **`npm install --prefix server`** once so `nodemailer` is installed locally (Render’s build uses `npm install` for the server step).

### Free tier behavior

- The service **spins down after idle**; the next visit can take **~30–60 seconds** to wake up.
- Render’s policies (including whether a **payment method** is required on file for free services) can change — check [Render pricing](https://render.com/pricing) and signup flow.

### Manual setup (without Blueprint)

Create a **Web Service** from the repo and set:

| Setting | Value |
|--------|--------|
| **Root directory** | *(repo root, leave empty)* |
| **Build command** | `npm ci --include=dev && npm run build && npm install --omit=dev --prefix server` |
| **Start command** | `node server/index.mjs` |
| **Plan** | Free |

Add the same environment variables as above.

## Deploy to Google Cloud Run (one service: SPA + API)

The repo includes a **`Dockerfile`** that builds Angular, copies `dist/habit-tracker/browser` into the image, and runs `server/index.mjs` with `STATIC_DIR=/app/static`. **Neon** (or any Postgres) stays external via `DATABASE_URL`.

### Prerequisites

1. [Google Cloud account](https://cloud.google.com/) and a **project** with **billing** enabled (required for Cloud Run, even if usage stays in the free tier).
2. [Google Cloud SDK (`gcloud`)](https://cloud.google.com/sdk/docs/install) installed locally.
3. Enable APIs (once per project):

   ```bash
   gcloud config set project YOUR_PROJECT_ID
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
   ```

### Deploy from this directory

```bash
cd /path/to/daily-checklist-tracker

gcloud run deploy daily-checklist-tracker \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

Cloud Build detects the **Dockerfile** and uses it. When the command finishes, note the **Service URL** (HTTPS).

### Required environment variables

In [Cloud Run → your service → Edit & deploy new revision → Variables & secrets](https://console.cloud.google.com/run), add:

| Name | Value |
|------|--------|
| `DATABASE_URL` | Your Neon Postgres URL (`sslmode=require` if Neon expects it). |
| `JWT_SECRET` | Long random string (not the dev placeholder). |

Do **not** set `PORT` yourself — Cloud Run sets it. `STATIC_DIR` is already set in the image.

For sensitive values, prefer **Secret Manager** and mount them as secrets in Cloud Run (same names).

### Smoke test

Open the service URL, register a user, and confirm Routine/Today load. If the app shell loads but API calls fail, check Cloud Run **Logs** and that `DATABASE_URL` / `JWT_SECRET` are set on the **revision** you deployed.

### Local Docker check (optional)

```bash
docker build -t dct-local .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e DATABASE_URL="postgresql://..." \
  -e JWT_SECRET="your-secret" \
  dct-local
```

Then open `http://localhost:8080`.

## Scripts

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| `npm start`        | Angular dev server (`ng serve`)      |
| `npm run start:api`| API only (`server`)                  |
| `npm run start:full` | API + Angular (concurrently)       |
| `npm run build`    | Production build → `dist/habit-tracker/` |
| `npm test`         | Unit tests (Karma)                   |

## Project layout

- `src/app/` — routes, habit tracker UI, auth, `RoutineService`, `AuthService`
- `server/index.mjs` — HTTP API, Postgres access, optional static SPA

---

Generated with [Angular CLI](https://github.com/angular/angular-cli) 19.2.x. For Angular CLI help: `ng generate --help` and [Angular CLI docs](https://angular.dev/tools/cli).
