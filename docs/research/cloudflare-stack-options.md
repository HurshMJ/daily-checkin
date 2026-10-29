# Cloudflare stack options for the app

Research for issue #2. Question: what are the realistic Cloudflare-native stack
options for the daily check-in app, and what does each cost and constrain?

Researched 2026-10-29 against Cloudflare's developer docs and framework docs.
Every limit below is quoted from the page cited next to it, as that page read on
that date. This file shortlists options; it does not pick one. The human picks
in the "Pick the stack" ticket.

## What the app needs from the stack

From the map issue (#1) and `GLOSSARY.md`:

- A web app with server-side logic: Groups, Members, Owners, Invites,
  Check-ins, Boards, History, the Game On Threshold.
- Relational data: a Member belongs to several Groups, and one Check-in shows
  on every Board the Member belongs to.
- Username + password login, sessions, Invite-only account creation, an email
  address for password reset.
- Three scheduled jobs at fixed app-wide times: the Reset (about 6 AM), the
  Reminder, and the Daily Summary.
- Notifications: browser push first, email opt-in.
- Scale: a few friend Groups. Small.
- Standing preference: streamlined; when two options both work, pick the
  simpler one.

## Hosting: Workers, not Pages

Cloudflare's Pages docs now say: "Start new projects with Workers." Workers "is
Cloudflare's primary platform for building applications" and "supports most
Pages use cases and offers a broader feature set."
([Pages overview](https://developers.cloudflare.com/pages/))

The deciding gap for this app: **Cron Triggers run on Workers, not on Pages.**
Durable Objects on Pages need a separate Worker as a workaround.
([Migrate from Pages to Workers, compatibility matrix](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/),
updated 2026-10-12)

Workers serve the front end as static assets from the same deployment.
"Requests to static assets are free and unlimited."
([Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/))

**Finding:** host on Workers with static assets. Pages is not a real option
here, because the Reset, Reminder, and Daily Summary need Cron Triggers.

### Workers limits that matter

From [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
(page dated 2026-10-29):

| Limit | Workers Free | Workers Paid |
|---|---|---|
| Requests per day | 100,000 | No limit |
| CPU time per HTTP request | 10 ms | 5 min (default 30 s) |
| CPU time per Cron Trigger | 10 ms | 30 s (interval < 1 h); 15 min (interval >= 1 h) |
| Memory | 128 MB per isolate | 128 MB per isolate |
| Subrequests (outbound `fetch`) | 50 per request | 10,000 per request |
| Cron Triggers per account | 5 | 250 |
| Worker size (uncompressed) | 64 MiB | 64 MiB |

CPU time counts only time running code, not time waiting on `fetch` or database
calls. Going over returns error 1102.
([Workers limits](https://developers.cloudflare.com/workers/platform/limits/))

Workers Paid costs a minimum of **$5 USD per month** per account, with 10
million requests and 30 million CPU ms included per month.
([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/))

## Web framework candidates

Cloudflare documents full-stack guides for, among others: React + Vite, Astro,
React Router, Next.js (OpenNext adapter), Vue, RedwoodSDK, TanStack Start,
SvelteKit, Vike, and, under "More guides", Hono, Nuxt, Qwik, Solid, and others.
The index page gives no support status per framework.
([Framework guides: web apps](https://developers.cloudflare.com/workers/framework-guides/web-apps/))

Three that fit a small app, from simplest up:

### Hono (plain server, small front end)

- Create: `npm create hono@latest my-app`, pick the `cloudflare-workers`
  template. Static assets are configured in `wrangler.jsonc`; bindings (such as
  D1) are on `c.env`.
  ([Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers))
- The Hono docs show the cron handler next to the app in one module:
  `export default { fetch: app.fetch, scheduled: async (batch, env) => {} }`.
  So HTTP routes and the Reset, Reminder, and Daily Summary jobs live in one
  Worker.
- Pages are server-rendered with Hono's JSX or plain HTML, or a small Vite
  front end is served as static assets.
- Trade-off: fewest moving parts and the smallest CPU cost per request. You
  write more UI wiring yourself; there is no built-in data-loading or form
  convention.

### React Router (framework mode)

- Cloudflare's guide now covers **React Router v8** with the Cloudflare Vite
  plugin. Create: `npm create cloudflare@latest -- my-react-router-app --framework=react-router`.
  ([React Router on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/))
- Bindings are on `context.cloudflare.env` in loaders and actions. The Worker
  entry (`workers/app.ts`) is yours, so other exports can be added. The guide
  names Durable Objects and Workflows and shows only `fetch`. A `scheduled`
  export in that same entry should work the same way, but the guide does not
  show it. **Verify before relying on it.**
- Trade-off: loaders, actions, and forms fit a Board-plus-Check-in app well,
  and the React ecosystem is large. It costs more dependencies and more CPU per
  server render than Hono. That matters only under the Free plan's 10 ms limit.

### SvelteKit or Astro

- Both have first-party Cloudflare guides on the same index page. They are
  similar in weight to React Router. They are listed for completeness, not
  researched in depth. Either works if the human prefers Svelte or Astro.

Not shortlisted: Next.js via OpenNext. It works, but it is the heaviest option.
A community report (anecdotal, not official) found an OpenNext route using
60 to 120 ms CPU, far over the Free plan's 10 ms. That goes against the
"simpler one" preference.

## Database for Groups, Members, Check-ins, and History

| Option | Model | Free plan | Fit |
|---|---|---|---|
| **D1** | Managed SQLite, SQL from the Worker | 10 DBs, 500 MB per DB, 5 GB per account; 5 M rows read and 100 k rows written per day | Best fit: relational data, joins, simple |
| Durable Objects (SQLite backend) | One object per key, each with private SQLite, single-threaded | 100 k requests per day, 13,000 GB-s per day; 5 M rows read and 100 k rows written per day; 5 GB | Strong consistency and WebSockets, but you shard data by hand. Over-built for this |
| Workers KV | Eventually consistent key-value | 100 k reads per day, **1,000 writes per day**, 1 GB | Wrong fit for Check-ins; changes "may take up to 60 seconds or more" to show in other locations |

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/),
[How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

D1 details that shape the design:

- Free plan: at most **50 queries per Worker invocation** (Paid: 1,000).
  ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/))
- Past the free daily read or write limit, "you will not be able to run
  queries against D1" until the reset. Durable Objects daily limits reset at
  00:00 UTC. ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
  [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/))
- `batch()` statements "are SQL transactions": a failing statement rolls back
  the whole batch. Use it for multi-row changes such as the Reset moving a Game
  Night to History. ([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/))
- Better Auth's docs say D1 does not support transactions, meaning interactive
  `BEGIN`/`COMMIT`. Use `batch()` instead.
- Time Travel (point-in-time restore): 7 days on Free, 30 days on Paid.

Free-tier headroom for a few friend Groups: say 5 Groups of 8 Members, each
Member opening the Board 20 times a day. That is 800 page loads a day, against
100 k Worker requests. Each Board load reads at most a few hundred rows. That
is well under 5 M reads a day, and writes (Check-ins, Reset) are in the
hundreds. History grows by a few KB per Game Night, far below 500 MB.
**Requests and storage are not a constraint on the Free plan at this scale.**

**Finding:** D1. Durable Objects and KV each solve a problem this app does not
have.

## Username + password auth on Workers

### Password hashing within CPU limits

This is the tightest constraint on the Free plan.

- **Web Crypto PBKDF2** is supported (`deriveBits`/`deriveKey`).
  ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/))
  Production Workers cap PBKDF2 at **100,000 iterations**. Issue
  [cloudflare/workerd#1346](https://github.com/cloudflare/workerd/issues/1346)
  asks to raise the cap. It is still open. A maintainer wrote (2024-01-03)
  that production "will remain for at least some period of time", and users
  still hit the cap in 2026. 100,000 is below current OWASP guidance for
  PBKDF2-SHA256, as that issue notes.
- **`node:crypto` with `nodejs_compat`**: "All `node:crypto` APIs are fully
  supported" except a short list. `scrypt` is not on that list, so it is
  available. **`argon2` and `argon2Sync` are not supported.**
  ([Node.js crypto in Workers](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/))
- **Better Auth** hashes with scrypt by default. You can plug in your own
  hash and verify functions, and a username plugin adds username login.
  ([Better Auth email and password](https://www.better-auth.com/docs/authentication/email-password))

**The 10 ms catch:** any password hash worth using is built to burn CPU. No
Cloudflare doc says a 100,000-iteration PBKDF2 or a standard scrypt fits inside
the Free plan's 10 ms per request. **This was not measured.** Logins and sign-ups
are rare, so an occasional overrun hurts less than it would on a hot path. But
error 1102 on login is a real failure. Two ways out:

1. **Workers Paid ($5 per month):** a 30 s default CPU limit removes the
   problem. Use PBKDF2 at the 100,000 cap, or `node:crypto` scrypt.
2. **Stay on Free:** measure first. Deploy a test Worker, hash at the chosen
   cost, and read CPU time in Workers metrics. Lower the work factor only if
   the security trade-off is written down. This belongs to the
   "Security hardening" item in #1.

### Sessions

- Simplest: a random session token in an `HttpOnly`, `Secure`, `SameSite`
  cookie, with a `sessions` table in D1 holding a hash of the token, the
  Member, and the expiry. Logout and revocation take effect at once, because D1
  is the source of truth.
- KV for sessions is not recommended. The Free plan allows 1,000 writes per
  day, and eventual consistency means a revoked session can work for up to
  about 60 s in other locations.
  ([KV limits](https://developers.cloudflare.com/kv/platform/limits/),
  [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/))
- Better Auth on D1 is the library route: it brings sessions, password reset
  flows, and username login. Hand-rolled sessions are a few small functions.
  Given the "simpler one" preference, decide this in the spec. Either works
  with D1.

## Scheduled jobs: Reset, Reminder, Daily Summary

From [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/):

- A `scheduled(controller, env, ctx)` export in the same Worker runs on
  five-field cron expressions.
- **"Cron Triggers execute on UTC time."** The app has one app-wide time zone.
  If that zone observes daylight saving time, a fixed UTC cron drifts by an
  hour twice a year. The simple fix: run one cron hourly (or every 15 minutes),
  and in code check the app-wide local time to decide whether the Reset,
  Reminder, or Daily Summary is due. That is one Cron Trigger instead of three,
  and 24 to 96 invocations a day.
- Timing is best effort: scheduled Workers "run on underutilized machines".
  "About 6 AM" fits that.
- Trigger changes take up to 15 minutes to propagate.
- Local test: request `/cdn-cgi/local/scheduled`.
- Free plan: 5 Cron Triggers per account, 10 ms CPU, and 50 subrequests per
  invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
  Each browser push is one outbound `fetch`. A Reminder to more than 50
  devices in one run would need batching (or Queues). That is far beyond a few
  friend Groups, but note it.
- Cron invocations count as requests (the pricing example counts an hourly
  cron as 720 requests a month).
  ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/))

## Notifications (cost and constraint only)

Notifications have their own design questions. These are the stack facts that
affect the pick:

- **Email:** Cloudflare Email Service sending is in **Beta**. Sending to
  arbitrary recipients **needs Workers Paid**: 3,000 emails a month included,
  then $0.35 per 1,000. On Workers Free, outbound sending is "Not available"
  except to verified destination addresses in your own account.
  ([Email Service](https://developers.cloudflare.com/email-service/),
  [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/))
  Password reset needs email, so **staying on Free means a third-party email
  API** (an outbound `fetch`). That provider was not researched here.
- **Browser push:** Cloudflare has no first-party Web Push service. Sending is
  an outbound `fetch` to each browser's push endpoint with VAPID signing.
  The Node `web-push` package depends on Node crypto shims. Web Crypto based
  libraries exist that target Workers (for example `@pushforge/builder`,
  `web-push-browser`, `@block65/webcrypto-web-push`). These are third-party,
  not Cloudflare-endorsed; check their maintenance before choosing one.

## Shortlist

All three share the same base: **Workers + static assets + D1 + Cron
Triggers**, one Worker, sessions in D1. They differ in framework and plan.

| | A. Hono + D1 | B. React Router v8 + D1 | C. Either, on Workers Paid |
|---|---|---|---|
| Framework | Hono, server-rendered JSX or a small Vite front end | React Router framework mode on the Cloudflare Vite plugin | A or B |
| Plan | Free | Free | Paid, $5 per month minimum |
| Simplicity | Simplest: one small Worker, few dependencies | More conventions and dependencies; nicer forms and data loading | Same as the chosen framework |
| 10 ms CPU risk | Lowest per request; password hashing still unmeasured | Higher (React server render); password hashing still unmeasured | Gone (30 s default) |
| Email (password reset) | Third-party email API needed | Third-party email API needed | Cloudflare Email Sending (Beta) works, 3,000 per month included |
| Cron in same Worker | Shown in Hono docs | Works through the custom entry; not shown in the guide, verify | Same |

Ruled out: Pages (no Cron Triggers), KV as the main store (1,000 writes a day,
eventual consistency), Durable Objects as the main store (over-built), and
Next.js/OpenNext (heaviest).

### Recommendation (for the human to decide)

The streamlined default is **A (Hono + D1)**. If the human wants React-style
UI conventions, **B** is the alternative.

The bigger choice is **Free versus Paid**, not the framework. Paid at $5 a
month removes the two real Free-plan risks: password hashing against the 10 ms
CPU limit, and the lack of email sending without a third party. If the human
wants to stay on Free, first measure password-hash CPU in a test Worker and
pick an email provider.

The human picks the stack in the "Pick the stack" ticket.

## Open items not verified here

- CPU time of PBKDF2 (100,000 iterations) and of `node:crypto` scrypt in a
  deployed Worker on the Free plan.
- A `scheduled` export in React Router v8's `workers/app.ts`.
- Choice and pricing of a third-party email API, if staying on Free.
- Maintenance status of the Web Push libraries named above.
