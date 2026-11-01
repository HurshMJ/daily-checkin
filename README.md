# daily-checkin

A private, invite-only web app where a group of friends says whether they will
be online for tonight's game session. The product spec is
[issue #14](https://github.com/HurshMJ/daily-checkin/issues/14); the vocabulary
is in [`GLOSSARY.md`](GLOSSARY.md).

## Stack

- One Cloudflare Worker with static assets, on Workers Free at
  `daily-checkin.<subdomain>.workers.dev`.
- React Router v8 in framework mode with server rendering, in TypeScript, built
  with Cloudflare's Vite plugin.
- D1 through plain SQL prepared statements; schema changes are numbered SQL
  files in `migrations/`, applied with `wrangler d1 migrations`.
- Vitest with `@cloudflare/vitest-plugin`, which runs tests inside the Workers
  runtime. It is the renamed successor of `@cloudflare/vitest-pool-workers`,
  which the spec names; that package is deprecated.

## Layout

| Path | What lives there |
|------|------------------|
| `workers/app.ts` | The Worker entry: `fetch` (the app) and `scheduled` (the hourly Cron Trigger) |
| `app/` | React Router app: `root.tsx`, `routes.ts`, and route modules in `app/routes/` |
| `app/services.ts` | The Clock and Push sender interfaces and their production versions |
| `migrations/` | Numbered D1 migrations. Add new files only; never edit or drop an applied one |
| `test/` | Tests and the test harness |
| `scripts/operator-setup.sh` | One-time Operator setup wizard |
| `.github/workflows/deploy.yml` | Deploy pipeline |

## Local development

Requires Node 22.22 or later.

```sh
npm ci
npm run db:migrate:local   # apply migrations to the local D1 in .wrangler/state
npm run dev                # Vite dev server with the Worker runtime, http://localhost:5173
```

To run the production build in `wrangler dev` instead:

```sh
npm run build
npx wrangler dev           # serves build/server with the same local D1
```

`GET /healthz` returns `{"ok":true,"now":"..."}` once the Worker can reach D1
with the migrations applied.

## Tests

```sh
npm run typecheck
npm test
```

Tests drive the app through the Worker's real `fetch` and `scheduled` entry
points, inside the Workers runtime, against a real local D1. Before every test
the database is wiped and all migrations are applied again, so each test starts
clean.

### Injected services: Clock and Push sender

Two things are swapped out at the Worker boundary, and nothing else:

- **Clock** (`now()`): production reads the system time; tests set the time.
- **Push sender** (`send(subscription, payload)`): production delivery is not
  built yet and throws `Push sender not configured`; tests use a fake that
  records every send.

The mechanism is one function. `createWorker(services)` in `workers/app.ts`
returns the Worker's handlers, and the default export is
`createWorker(productionServices)`. Each request puts the services, `env` and
the execution context into React Router's context under `appContext`, so a
loader or action reads them with `context.get(appContext)`. The `scheduled`
handler receives the same services directly.

Tests build the Worker through `startApp()` in `test/harness.ts`:

```ts
const app = startApp({ now: "2026-11-03T12:59:00Z" });
const response = await app.fetch("/healthz");
app.clock.set("2026-11-03T13:00:00Z");
await app.runScheduled();
expect(app.push.sent).toEqual([]);
```

## Deploying

Every push to `main`, and every manual **Run workflow** on the Deploy workflow,
runs these steps in order; a failure at any step stops the run:

1. `npm ci`
2. typecheck
3. tests
4. build
5. a check that both Cloudflare secrets are set
6. `wrangler d1 migrations apply DB --remote`
7. `wrangler deploy`

GitHub Secrets hold only `CLOUDFLARE_API_TOKEN`, scoped to Workers Scripts and
D1 edit, and `CLOUDFLARE_ACCOUNT_ID`. Only the last three steps receive them.

### One-time setup

The Operator runs the setup wizard once, before the first deploy:

```sh
./scripts/operator-setup.sh
```

It walks through logging wrangler in, checking the `workers.dev` subdomain,
creating the D1 database and writing its id into `wrangler.jsonc`, and storing
the account ID and a scoped API token in GitHub Secrets. Commit the
`database_id` change afterwards; until then `wrangler.jsonc` holds a placeholder
id and the remote steps fail.

### Rolling back

Undo a bad deploy with `npx wrangler rollback`. Migrations are never rolled
back; they only add tables and columns.
