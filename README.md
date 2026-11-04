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
| `app/game-night.ts` | `gameNightOf()`: the Game Night of an instant, the UTC+4 date of the most recent 06:00 UTC+4; `zoneDayTime()` shows a time in that zone |
| `app/groups.ts`, `app/checkins.ts` | Groups (create, name rule, the Group page read) and Check-ins (Availability, Note, the Game On statement, tonight's Boards) |
| `app/invites.ts` | Invites: the label rule, Owner-only make, list and cancel, and joining a Group with an Invite |
| `app/push.ts` | Push subscriptions (the endpoint check at the trust boundary, save and delete) and notification toggles |
| `app/notifications.ts` | Notification rules: the "someone said Yes" claim, recipients, payloads, delivery after the response, and the scheduled Reminder and Daily Summary |
| `app/web-push.ts` | Web Push on WebCrypto: aes128gcm payload encryption and the VAPID ES256 token |
| `public/sw.js` | The service worker: shows each push and opens its page on a tap |
| `app/text-rules.ts` | The one counting rule for usernames, Group names and Notes: trimmed, NFC, code points, no invisible characters |
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

## Icons

`public/favicon.svg` is the one source of the app icon art and is also the
favicon. The PNG icons in `public/` (`icon-192.png`, `icon-512.png` for both
the `any` and `maskable` manifest entries, and the 180x180
`apple-touch-icon.png`) are rendered from it once and committed. After changing
the SVG, regenerate them from the repository root:

```sh
node --input-type=module -e 'import sharp from "sharp"; for (const [n, f] of [[192, "icon-192.png"], [512, "icon-512.png"], [180, "apple-touch-icon.png"]]) await sharp("public/favicon.svg", { density: 72 * n / 512 * 4 }).resize(n, n).flatten({ background: "#1a1220" }).removeAlpha().png().toFile("public/" + f);'
```

`sharp` is not a project dependency; today it is installed as a dependency of
wrangler's miniflare. If `npm ls sharp` finds nothing, run
`npm install --no-save sharp` first. The PNGs must stay opaque RGB with no
alpha channel. `test/installed-look.test.ts` checks their sizes and colour
type and that the manifest colours equal `--bg` in `app/styles/tokens.css`;
`test/styling.test.ts` checks the same for the `theme-color` meta.

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
Opening it moves the token into a short-lived cookie (`__Host-setup`, one
hour) and redirects to `/setup`, so no later URL or log line carries it.

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

### Login limits

Wrong passwords are limited, with no Operator command needed to clear them:

- **5 wrong passwords for one username within 15 minutes** lock that username
  for 15 minutes from the 5th. During the lock every login, the correct
  password included, is refused; attempts during the lock do not extend it.
  A successful login clears the username's count.
- **20 wrong passwords from one IP within an hour** refuse every login from
  that IP, the correct password included, until the oldest of those failures
  is an hour old. The IP is Cloudflare's `CF-Connecting-IP`.
- An IPv6 client is counted by its /64 prefix, so rotating addresses inside one
  network shares one count; IPv4 addresses are counted one by one.
- Unknown usernames count like real ones, and a wrong current password on the
  profile's Change password form counts too; the same limits block it. A
  successful password change clears the username's count, like a login.
- A typed username longer than 32 characters cannot belong to anyone: it is
  refused at once and counts for the IP only.
- The login page shows one message for every refusal, "That username and
  password do not match.", so it never tells whether a username exists or a
  limit applied.

The failures live in the `login_failures` table (migration 0004); rows older
than an hour are deleted whenever a new failure is recorded. Two attempts at
the same instant can both pass a limit check, so a burst may get one or two
attempts past a limit.

## Invites

A Group's Owner invites friends from the Group page (`/groups/<id>`, linked
from each Board on Tonight):

- **Make an Invite** shows a new link, `/invite/<token>`, once, with a Copy
  button. The token is never stored, only its SHA-256, so the link cannot be
  shown again; the pending list names each Invite by its optional label ("Who
  is it for?", up to 40 characters, seen only by the Owner) or by when it was
  made, in UTC+4.
- Opening the link moves its token into a short-lived cookie (`__Host-invite`,
  one hour) and redirects to `/invite`, so no later URL or log line carries it.
- Each Invite works **once** and **never expires**. The Owner can cancel a
  pending Invite; a used, cancelled or unknown link shows one warning, "This
  Invite has been used or cancelled."
- Only the Group's current Owner can make, list and cancel its Invites. Other
  Members see the Group's name, threshold and Members; anyone else gets 404.
- Opening a link logged out offers **Create a login** or **Log in**; either one
  joins the Group at once and lands on Tonight. A logged-in Member taps
  **Join**. A Member who is already in the Group is told so, and the Invite
  stays unused.
- Joining counts the Member's Yes for tonight at once, so the Group can reach
  Game On the moment they join.

Invites live in the `invites` table (migration 0005). Treat a pending link
like a password: anyone holding it can join the Group until it is used or
cancelled. The Invite and Group pages send `Referrer-Policy: no-referrer`, so
the link never leaks to another site.

## Group settings

The Owner runs the Group from its page (`/groups/<id>`):

- **Basics:** rename the Group (1 to 40 characters, like a new Group's name)
  and set the Game On Threshold, a whole number from 1 to 99, with the − and +
  buttons or by typing it.
- **Members:** **Manage** on each other Member offers **Make Owner**, which
  hands the Group over (pending Invites stay valid), and **Remove**.
- **Owner actions:** **Delete Group** deletes the Group, its Board and its
  night state for everyone. Each Member's Check-ins stay.

Make Owner, Remove and Delete Group need a second tap within 4 seconds. Any
other Member sees the page read-only and gets 403 for every Owner action.

Any Member leaves a Group from the **Groups** card on their profile. The Owner
cannot leave while other Members remain and is told to make another Member
Owner first; an Owner who is the last Member deletes the Group by leaving.
No push says that someone left, was removed or that a Group was deleted.

Every threshold or membership change re-checks tonight's Game On in the same
D1 batch. A Group that drops below its threshold after Game On reads Game Off,
and the crossing sends Game On or Game Off like a Check-in would (see
*Push notifications*).

## Push notifications

A Member turns push on from the **Notifications** card on their profile. The
browser asks for permission only after a tap on **Turn on push**, and the
device's subscription is stored for that login session, one per session. On iPhone, push works
only in the app added to the Home Screen, so Safari outside it shows "Add to
Home Screen first" instead of the button. **Turn off on this device** forgets
the device; logging the device out does too, and Log out everywhere and a
password change forget the other devices.

Five types, each with a switch on the card, all on by default:

| Type | Sent when | To |
|------|-----------|----|
| Someone said Yes | a Member's Availability becomes Yes, once per Member per Game Night | the other Members of all their Groups, once each |
| Game On | a Group first reaches its threshold in a Game Night | every Member of the Group |
| Game Off | a Group that was Game On first drops below it | the Group's Members at Yes now |
| Reminder | the 17:00 UTC+4 hourly run, once per Game Night | each Member in at least one Group with no Check-in tonight |
| Daily Summary | the 20:00 UTC+4 hourly run, once per Group per Game Night, for each Group with a Check-in tonight | every Member of the Group |

Game On and Game Off fire the same way for a Check-in, a threshold change, a
join, a leave or a removal, at most once each per Group per night. Nobody is
sent a push about their own action. A Note edit or a join never sends
"someone said Yes". There are no quiet hours. Each send is claimed in the same D1
batch as the change, so two racing requests never both send it.

The Daily Summary's title gives the Group's counts, such as "Friday: 3 Yes,
1 Maybe, 2 no answer", and its body names the Members by Availability in Board
order, without Notes. When the whole list would not fit the 3993-byte push
payload limit, it names as many as fit and ends with "+N more". A tap opens the
Group page; a tap on the Reminder opens Tonight.

The Reminder and the Daily Summary go out only in their own hourly run: a
missed run is skipped, never caught up. Each claims tonight in
`scheduler_state` before it sends, so a repeated run sends nothing, and a run
that fails after its claim loses that night's pushes rather than sending them
late.

Event pushes go out after the response (`ctx.waitUntil`), so a push service
never slows or fails a Member's request; scheduled pushes are awaited inside
the hourly run. A 404 or 410 deletes that subscription;
other failures are logged once per event, never with the endpoint. Each push
is one subrequest, so Workers Free (50 subrequests per invocation) bounds how
many devices one change, or one hourly run, can reach; sends past it fail and
are logged as a count.

The server accepts a subscription only with an `https` endpoint of at most 2048
characters on a known push service (`fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`)
and base64url keys of the right length.

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
- **Push sender** (`send(subscription, payload)`): production sends Web Push
  (aes128gcm and VAPID, on WebCrypto in `app/web-push.ts`) and returns the
  push service's status; without the `VAPID_PRIVATE_KEY` secret it sends
  nothing. Tests use a fake that records every send and can answer 404, 410,
  any other status, or throw.

The mechanism is one function. `createWorker(services)` in `workers/app.ts`
returns the Worker's handlers; it also takes a function that builds the
services from `env`, and the default export is
`createWorker(productionServices)`, whose push sender reads its key from
`env`. Each request puts the services, `env` and
the execution context into React Router's context under `appContext`, so a
loader or action reads them with `context.get(appContext)`. The `scheduled`
handler receives the same services directly. Each hourly run calls the Reset,
`createHistory().reset()` in `app/history.ts`, which freezes any ended Game
Night into History and does nothing until a new Game Night has started, then
the scheduled pushes, `createNotifications().sendScheduled()` in
`app/notifications.ts`, which send the Reminder or the Daily Summary when the
run's UTC+4 hour is theirs. The pushes run even when the Reset fails.

Every Game Night comes from `gameNightOf(clock.now())`, so moving the test
clock across 02:00 UTC (06:00 UTC+4) starts a new night.

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
reaches `curl` on standard input and is never printed. The login request is
tried up to 3 times, 5 seconds apart, while it gets no response or a 5xx,
because the new version can take a few seconds to reach every edge location;
any other answer, such as a 401 for a wrong password, fails at once, and the
other requests are tried once. Any failure fails the run.

A wrong `SMOKE_PASSWORD` therefore costs one failed login per run. Five runs
within 15 minutes lock the smoke login (see *Login limits*); the lock clears
itself 15 minutes after the 5th failure, so fix the secret and rerun then.

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
creating the D1 database and writing its id into `wrangler.jsonc`, storing
the account ID and a scoped API token in GitHub Secrets, and setting up the
Web Push keys. Commit the `database_id` change afterwards; until then
`wrangler.jsonc` holds a placeholder id and the remote steps fail.

### Web Push keys

Push needs a VAPID key pair. Its private key is the Worker secret
`VAPID_PRIVATE_KEY` (a JWK JSON string), never stored in the repository, in
GitHub Secrets or in any log; its public key is `vars.VAPID_PUBLIC_KEY` in
`wrangler.jsonc`, and `vars.VAPID_SUBJECT` is the app's https URL. To set them
up, or later to rotate them, run only that stage:

```sh
./scripts/operator-setup.sh vapid
```

It generates a pair (or takes an existing private key you paste), sets the
secret with `wrangler secret put`, and writes the public key into
`wrangler.jsonc`. Commit that change and let it deploy. Re-running keeps the
existing pair unless you choose to rotate it. While `VAPID_PUBLIC_KEY` is
empty the profile says push is not set up, and while the secret is missing no
push is sent and each attempt is logged. Rotating, or losing the private key,
makes every subscription invalid: the push services answer 403 or 410, and
Members turn push on again.

### Rolling back

Undo a bad deploy with `npx wrangler rollback`. Migrations are never rolled
back; they only add tables and columns.
