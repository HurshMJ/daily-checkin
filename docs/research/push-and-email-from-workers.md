# Research: web push and email sending from Cloudflare Workers

Ticket: [#3 Web push and email sending from Workers](https://github.com/HurshMJ/daily-checkin/issues/3)
Map: [#1 Daily check-in app: full product spec](https://github.com/HurshMJ/daily-checkin/issues/1)
Researched: 2026-10-29. Prices, limits, and versions below were read from the
owning source on that date and will drift.

## Question

How can a Cloudflare Worker send browser push notifications and transactional
email, and what limits apply? This file gives a shortlist with trade-offs. It
does not pick: the human picks in the "Pick the stack" ticket.

## What the app needs from this

From the map's settled requirements:

- Five notification types: Reminder, someone said Yes, Game On, Game Off, and
  Daily Summary.
- Browser push first; email is opt-in per Member and per type.
- Reminder and Daily Summary go out at fixed app-wide times, so a scheduled
  Worker (Cron Trigger) sends them. The other three are sent when a Check-in
  changes.
- An email address is required at sign-up for password reset. Password reset
  email is therefore not optional: some email sending path must exist even if
  no Member opts in to email notifications.
- Invite-only friend group: volume is tiny (tens of Members, a handful of
  messages per Member per Game Night).

## Part 1: Web Push from a Worker

### How it works (standards)

Web Push is three IETF standards:

- [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030) "Generic Event Delivery
  Using HTTP Push": the server POSTs a message to the subscription's endpoint
  URL, which belongs to the browser vendor's push service.
- [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) "Message Encryption for Web
  Push": the payload is encrypted (`aes128gcm`) to the subscription's keys,
  using ECDH P-256, HKDF and AES-GCM.
- [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292) "VAPID": the server signs
  a JWT (ES256) with its own key pair so the push service knows who is sending.
  No vendor account is needed; one VAPID key pair works for Chrome, Firefox,
  Edge and Safari.

The browser side is a service worker that calls `pushManager.subscribe()` with
the VAPID public key; the app stores the returned endpoint and keys against the
Member.

### Workers runtime fit

Everything above is plain `fetch` plus Web Crypto. The Workers Web Crypto API
lists ECDH (`deriveBits`), ECDSA (`sign`), AES-GCM (`encrypt`) and HKDF
(`deriveBits`) as supported
([Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)).
So no paid service is needed for push: the Worker talks to the browser vendors'
push services directly and push costs nothing beyond Worker invocations.

### Libraries that run on Workers

Versions from the npm registry (`npm view`) on 2026-10-29.

| Package | Version (last publish) | License | Runtime claim | Notes |
|---|---|---|---|---|
| [`@pushforge/builder`](https://github.com/draphy/pushforge) | 2.0.5 (2026-04-23) | MIT | README lists Cloudflare Workers as supported | Zero dependencies. `buildPushHTTPRequest({ privateJWK, subscription, message })` returns `{ endpoint, headers, body }` that you pass to `fetch`. VAPID keys from `npx @pushforge/builder vapid`. About 66 GitHub stars. |
| [`@block65/webcrypto-web-push`](https://github.com/block65/webcrypto-web-push) | 2.0.0 (2026-09-15) | MIT | Repo description: "compatible with Node, Cloudflare Workers, Bun and Deno" | One small dependency (`uint8array-extras`). Ships an `examples/cloudflare-workers` Hono + D1 example. About 48 stars. |
| [`web-push-neo`](https://github.com/ryoppippi/web-push-neo) | 0.1.2 (2026-03-27) | MPL-2.0 | Web Crypto + `fetch` fork of `web-push` | `aes128gcm` only; depends on `jose`. Pre-1.0. |
| [`web-push-browser`](https://github.com/colecrouter/web-push-browser) | 1.4.2 (2025-08-18) | ISC | ESM, zero dependencies | Least recently published of the four. |
| [`web-push`](https://github.com/web-push-libs/web-push) (the classic Node library) | 3.6.7 (2024-01-16) | MPL-2.0 | Node only | Depends on `https-proxy-agent`, `asn1.js`, `http_ece`; not designed for the Workers runtime. Not recommended here. |

All four Workers-capable libraries are small, low-adoption projects. The
protocol is small enough (about 150 lines of Web Crypto) that hand-rolling it
is also viable, but a library avoids getting the encryption details wrong.

### iPhone constraints (Apple primary sources)

From Apple's
[Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
and WebKit's
[Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/):

- **iOS / iPadOS 16.4 or later.**
- **Home Screen install required.** Only "a web app that has been added to the
  Home Screen can request permission to receive push notifications". A Board
  opened in a Safari tab on an iPhone cannot get push. The manifest needs
  `display` set to `standalone` or `fullscreen`.
- **Permission needs a user gesture.** Ask from a button tap and call the
  subscribe method immediately in that tap's handler; asking on page load fails.
- **No Apple Developer Program membership needed.** Same VAPID keys as other
  browsers.
- **No silent pushes.** "Safari doesn't support invisible push notifications."
  The service worker must show a notification for every push it receives, or
  "Safari revokes the push notification permission for your site." Every one of
  the five notification types is user-visible, so this fits, but the app must
  never use push as a background data sync.
- **Payload limit 4 KB** (`PayloadTooLarge`). A Daily Summary for a large Group
  should send a short text and link to the Board, not the full list.
- **TTL** up to 30 days of storage while the device is offline; set a short
  TTL for Reminder and Game On so stale ones do not arrive tomorrow.
- **`Topic` header** (max 32 base64url characters) coalesces notifications:
  useful so a Game On / Game Off flip-flop replaces rather than stacks.
- **Do not refresh the VAPID JWT more than once per hour**, and its expiry must
  be no more than one day ahead.
- **Expired subscriptions return 410**; the app should delete that
  subscription. Endpoints are on `*.push.apple.com`.
- **Badging:** `navigator.setAppBadge()` works on Home Screen web apps, which
  could show "not checked in yet" on the icon.
- **Declarative Web Push** (iOS / iPadOS 18.4+, Home Screen web apps) can show
  a notification from a JSON payload without a service worker
  ([Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/),
  [Safari 18.4 features](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)).
  It is Safari-only, so standard Web Push with a service worker is still the
  one path that covers every browser.

The practical consequence for the spec: iPhone Members must "Add to Home
Screen" before they can turn push on, and the app should explain that in the
UI. Members who do not install it fall back to email (if they opt in) or to
just opening the Board.

## Part 2: Transactional email from a Worker

### Option A: Cloudflare Email Service (Email Sending)

- **Status: public beta.** Announced in the changelog on 2026-04-16 ("Email
  Sending now in public beta"); no GA announcement in the changelog as of
  2026-10-29 (latest entry 2026-09-25)
  ([changelog](https://developers.cloudflare.com/changelog/product/email-service/index.md)).
- **Call from a Worker:** a `send_email` binding, then
  `env.EMAIL.send({ to, from, subject, text })`. No API key to store. REST API
  and authenticated SMTP (beta since 2026-06-08) also exist
  ([Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)).
- **Pricing:** Workers Free: "Not available". Workers Paid: "3,000 included per
  month, then $0.35 per 1,000 emails", per account
  ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/)).
  Workers Paid has a $5/month minimum
  ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
  Sends to verified destination addresses are free on any plan, but those are
  addresses you confirm by hand in Email Routing, so they cannot cover
  arbitrary Members.
- **Limits:** new accounts start with "a conservative daily quota" that grows
  with good sending; 50 recipients per email; 5 MiB message size
  ([limits](https://developers.cloudflare.com/email-service/platform/limits/)).
- **Domain:** "You must be using Cloudflare DNS to use Email Service." The
  domain must be onboarded; Cloudflare adds SPF, DKIM and bounce MX records on a
  `cf-bounce` subdomain plus a DMARC record. You can only send from onboarded
  domains, so a `workers.dev` address cannot be the sender
  ([send emails guide](https://developers.cloudflare.com/email-service/get-started/send-emails/)).

### Option B: Resend

- **Call from a Worker:** HTTPS API with an API key stored as a Worker secret;
  official SDK `resend` (6.35.0, published 2026-10-27) and a documented
  Cloudflare Workers guide
  ([Send with Cloudflare Workers](https://resend.com/docs/send-with-cloudflare-workers)).
  A plain `fetch` to the REST API also works and avoids the dependency.
- **Free plan:** 3,000 emails per month and 100 per day, 3 domains, 30-day
  data retention. Pro is $20/month for 50,000
  ([pricing](https://resend.com/pricing)). All accounts start at 10 API
  requests per second
  ([quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)).
- **Domain:** must add and verify a domain; any DNS provider works. Resend
  recommends a subdomain such as `updates.example.com`
  ([domains](https://resend.com/docs/dashboard/domains/introduction)). Without
  a verified domain, the `resend.dev` sender can only send to the account
  owner's own address (403 otherwise)
  ([403 error](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)).

### Others considered

- **Brevo:** free plan of 300 emails per day, API and SMTP included; sending
  starts only after Brevo approves the account; paid from $9/month
  ([email API](https://www.brevo.com/features/email-api/)). Figures are from
  Brevo's marketing pages; its pricing page did not render for this research.
- **Postmark:** free Developer plan of 100 emails per month, no expiry; Basic is
  $15/month for 10,000 ([pricing](https://postmarkapp.com/pricing)). Strong
  deliverability, but 100/month is too tight for daily Reminders.
- **MailChannels:** the old free Workers integration ended on 2024-08-31
  ([end of life notice](https://support.mailchannels.com/hc/en-us/articles/26814255454093-End-of-Life-Notice-Cloudflare-Workers)).
  Its replacement free plan is 100 per day. Old tutorials that send email
  "free from Workers via MailChannels" are out of date.

### Volume check

Upper bound per Game Night if every Member opts in to every email type: one
Reminder, one Daily Summary per Group, plus a few Yes / Game On / Game Off
messages. For 10 Members in one or two Groups that is roughly 50 emails a day,
or about 1,500 a month. Both shortlisted options' 3,000/month allowance covers
that. Resend's 100/day cap is the first limit a busy night could hit; since
push is first and email is opt-in, real volume should be far lower.

## Part 3: Workers plan limits that touch notifications

From [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [pricing](https://developers.cloudflare.com/workers/platform/pricing/):

| Limit | Workers Free | Workers Paid ($5/month minimum) |
|---|---|---|
| Cron Triggers per account | 5 | 250 |
| Subrequests per invocation | 50 | 10,000 |
| CPU time per invocation | 10 ms | 30 s default, up to 5 min |
| Requests | 100,000 per day | 10 million per month included |
| Queues | 10,000 operations per day | 1 million per month included |

Each push or email is one subrequest, so a single Cron Trigger invocation on
the Free plan can send at most 50 notifications. Two Cron Triggers (Reminder
and Daily Summary) fit within 5. If a fan-out ever exceeds 50, a Queue
([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/),
available on Free) can split it into one message per notification. The 10 ms
CPU budget should cover VAPID signing and payload encryption for a small
batch, because Web Crypto runs natively, but this is unmeasured: a prototype
should confirm it.

## Shortlist

The real decision is the email provider, and it is coupled to the Workers plan
and the domain. Push is the same in every option.

1. **Web Push direct with a Workers-native library + Cloudflare Email
   Service.**
   - For: everything in one Cloudflare account and bill; no third-party API
     key; email is a binding.
   - Against: requires Workers Paid ($5/month minimum); Email Sending is still
     beta; requires a custom domain on Cloudflare DNS.
2. **Web Push direct with a Workers-native library + Resend free.**
   - For: stays on Workers Free ($0); 3,000/month is enough; any DNS provider;
     mature product with a Workers guide.
   - Against: a second vendor and an API key secret; 100/day cap; still needs a
     custom domain verified in Resend (a `workers.dev`-only deployment cannot
     email arbitrary Members with either option).
3. **Fallback providers for email:** Brevo (300/day free, account approval
   required) if Resend's daily cap ever bites; Postmark only on a paid plan.

For the push library, the two strongest candidates are `@pushforge/builder`
(zero dependencies, request-builder shape that fits `fetch`) and
`@block65/webcrypto-web-push` (most recently published, ships a Workers + D1
example). Either is a two-way door: swapping one for the other touches only the
send function.

## Constraints the spec must carry, whichever option is picked

- **A custom domain is needed for email.** Both shortlisted email options
  refuse arbitrary recipients without an onboarded or verified sending domain.
  This links to the map's open "Deployment: domain (workers.dev or custom)"
  item: password reset email forces "custom", at least for the sending domain.
- **iPhone push only after Add to Home Screen** (iOS 16.4+), permission asked
  from a button tap, and every push must show a notification.
- **Store push subscriptions per device**, delete them on 410, and keep the
  VAPID private key as a Worker secret.
- **Keep push payloads under 4 KB** and use `Topic` and short TTLs so stale
  Reminders and Game On / Game Off flips do not pile up.

## Open questions for the human

- Is a $5/month Workers Paid plan acceptable? It decides between options 1
  and 2.
- Is a custom domain available, and is (or can) its DNS be on Cloudflare?
- Is depending on a beta Cloudflare product acceptable for password reset email?
