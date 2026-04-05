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
