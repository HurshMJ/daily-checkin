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
| `app/auth/` | Auth: passwords, sessions, Setup Links, username and password rules, the avatar palette, the `Origin` check |
| `migrations/` | Numbered D1 migrations. Add new files only; never edit or drop an applied one |
| `test/` | Tests and the test harness |
| `scripts/operator-setup.sh` | One-time Operator setup wizard |
| `scripts/setup-link.ts` | Operator command that prints a Setup Link |
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

To log in locally, print a Setup Link for the local D1 and open it while
`npm run dev` runs:

```sh
npm run operator:setup-link -- me --local   # prints http://localhost:5173/setup/<token>
```

The session cookie is `Secure` with the `__Host-` prefix. Browsers that treat
`http://localhost` as a secure origin, such as current Chrome and Firefox, keep
it. If a login does not stick locally, the browser dropped the cookie; use one
of those browsers.

## Operator commands

Operator commands run on the Operator's machine with wrangler logged in. They
make a random token locally, store only its SHA-256 in D1 with
`wrangler d1 execute --remote`, and print a link. No password is ever passed on
the command line.

### Setup Link

```sh
npm run operator:setup-link -- <label>
```

Prints `https://daily-checkin.hurshm05.workers.dev/setup/<token>`. Opening it
lets one person create a login (username, password and avatar colour) without
joining any Group; it is how the very first Member gets in.

- The link works once and expires 1 hour after it is printed.
- Rerunning the command with the same label cancels that label's older unused
  link, so only the newest one works. Links with other labels are untouched.
- The label is only for the Operator's bookkeeping, such as `alice` or `smoke`:
  1 to 40 letters, digits, spaces, dashes or underscores. Anything else is
  refused before wrangler runs.
- `--local` targets the local D1 and prints a `http://localhost:5173` link.
- Only the link goes to standard output; wrangler's messages go to standard
  error. The command exits non-zero, printing no link, when wrangler fails.

Treat the link like a password until it is used: anyone holding it can create
a login.

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
8. a smoke login on the deployed Worker

GitHub Secrets hold exactly four values:

| Secret | What it is | Steps that receive it |
|--------|------------|-----------------------|
| `CLOUDFLARE_API_TOKEN` | API token scoped to Workers Scripts and D1 edit | steps 5 to 7 |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account ID | steps 5 to 7 |
| `SMOKE_USERNAME` | the smoke-test login's username | step 8 only |
| `SMOKE_PASSWORD` | the smoke-test login's password | step 8 only |

### Smoke login

The last step logs in as a dedicated smoke-test login that belongs to no Group:
it posts the credentials to `/login`, opens Tonight with the new session and
expects the empty state with "Create a Group", then logs out. The password
reaches `curl` on standard input and is never printed. Any failure fails the
run.

The smoke step runs after Deploy, so **a red Smoke login after a green Deploy
means the new code is already live**. Roll back with `npx wrangler rollback`
or fix forward. A CPU-limit error (Cloudflare error 1102) at login means
PBKDF2 is too slow for Workers Free: lower `vars.PBKDF2_ITERATIONS` in
`wrangler.jsonc` in a follow-up change; existing passwords keep working because
each hash stores its own iteration count.

### One-time smoke login bootstrap

The smoke login cannot exist before the code that creates logins is deployed,
so the first Deploy run after that code merges fails at Smoke login, by
design, with an error naming the missing secret. Then the Operator:

1. Prints a Setup Link: `npm run operator:setup-link -- smoke`.
2. Opens it and creates the smoke login with a long random password, for
   example from `openssl rand -base64 24`. Do not create a Group with it.
3. Stores the credentials (each command prompts for the value, so it stays
   out of shell history):

   ```sh
   gh secret set SMOKE_USERNAME
   gh secret set SMOKE_PASSWORD
   ```

4. Reruns the failed Deploy workflow (**Re-run jobs** on the run, or
   **Run workflow**). It now passes, including Smoke login.

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
