# How React Router v8 on Workers can load styles

Research for [issue #30](https://github.com/HurshMJ/daily-checkin/issues/30),
part of the [Styling Daily Check-in map](https://github.com/HurshMJ/daily-checkin/issues/28).
Researched 2026-11-01. This note compares options and records trade-offs. It
does not pick one; that decision belongs to the later grilling ticket.

## Setup this applies to

From `package.json`, `vite.config.ts`, `react-router.config.ts` and
`wrangler.jsonc` on `origin/main`:

- `react-router` and `@react-router/dev` 8.5.1, framework mode, `ssr: true`.
- `vite` 8.3.5 (Rolldown), `@cloudflare/vite-plugin` 1.66.0 configured as
  `cloudflare({ viteEnvironment: { name: "ssr" } })` before `reactRouter()`.
- Workers Free: 10 ms CPU per request, shared with PBKDF2 password hashing.
- `app/root.tsx` already renders `<Links />` in `<head>`. No CSS exists yet.
- Dark theme only, phone first.

## Summary

| | Plain CSS + custom properties | CSS Modules | Tailwind CSS v4 |
|---|---|---|---|
| New dependency | None | None (built into Vite) | `tailwindcss` + `@tailwindcss/vite` (dev only) |
| Wiring | `import "./app.css"` in `root.tsx`, or `?url` + `links` | `import styles from "./x.module.css"` | Add `tailwindcss()` to Vite plugins; `@import "tailwindcss"` in `app.css` |
| Server CPU at runtime | Renders `<link>` tags only | Same, plus reading class-name strings from a constant object | Same as plain CSS; all CSS is generated at build time |
| Who serves the CSS | Workers Static Assets, not the Worker | Same | Same |
| CSS shipped to the phone | Exactly what is written, minified by Lightning CSS | Same, with hashed class names | Preflight reset + only the utilities found in source + used theme variables |
| Browser floor added | None beyond Vite's default target | None | Safari/iOS 16.4, Chrome 111, Firefox 128 |
| Known problem in this stack | None found specific to it | None found specific to it | Cosmetic `SOURCEMAP_BROKEN` warning under Vite 8 (open, exact versions) |

All three end the same way: the build writes hashed `.css` files to
`build/client/assets/`, the server bundle holds only their URLs, and SSR emits
`<link rel="stylesheet">` tags. Their real differences are authoring model,
build-time dependencies, and the browser floor, not runtime cost.

## How React Router 8.5.1 turns CSS into `<link>` tags

React Router's own docs say framework mode has no CSS pipeline of its own:
"Framework mode uses the React Router Vite plugin, so the styling story is
mostly just Vite's styling story." It lists three patterns: side-effect CSS
imports, the route `links` export, and a React 19 `<link>` rendered in a
component. For CSS Modules and Tailwind it says to "use the normal Vite setup
for those tools" ([Styling, bundled docs in react-router 8.5.1][rr-styling]).

The installed source confirms how side-effect imports reach the page:

- `@react-router/dev` 8.5.1 (`dist/vite.js`, region `vite/styles.ts` and the
  manifest builder) collects each route chunk's `css` list from the Vite
  manifest into the route manifest (`css: dedupe([... chunks.flatMap((e) =>
  e.css ?? []) ...])`). Imports with `?url`, `?inline`, `?raw` or
  `?inline-css` are treated as "without side effects" and are not added.
- `react-router` 8.5.1 (`dist/development/lib/dom/ssr/links.js`,
  `getKeyedLinksForMatches`) turns every matched route's `route.css` entries
  into `{ rel: "stylesheet", href }` and merges them with the route's own
  `links()` result. `<Links />` (`components.js`) renders them.
- On client navigation, `prefetchStyleLinks` in the same file preloads the next
  route's `css` and `links()` stylesheets before the route renders.
- In dev only, the plugin serves an extra `@react-router/critical.css` link
  (`unstable_getCriticalCss`, emitted only when `viteCommand === "serve"`) so
  that dev SSR pages are styled before Vite's client JS runs.

### Experiment in this repo

A throwaway copy of `origin/main` (not committed) was built with
`react-router build`, using the installed dependencies. It added three files:
`app/app.css` with custom properties imported as a side effect in `root.tsx`,
`app/routes/home.module.css` used through `styles.title`, and
`app/routes/profile.css` loaded through `?url` and `links`. Observed:

- `build/client/assets/` held `root-<hash>.css` (227 B, 194 B gzip),
  `home-<hash>.css` (130 B) and `profile-<hash>.css` (55 B), all minified.
- The route manifest listed `css: ["/assets/root-<hash>.css"]` on `root` and
  `css: ["/assets/home-<hash>.css"]` on `routes/home`. `routes/profile` had
  `css: []`; its file was reachable only through its `links()` export.
- The server bundle held the CSS only as URL strings
  (`var profile_default$1 = "/assets/profile-<hash>.css"`) and the CSS Modules
  map as a constant object (`dot: "_dot_1ss8p_1", title: "_title_1ss8p_2"`).
- `vite preview` (workerd) returned `/login` with
  `<link rel="stylesheet" href="/assets/root-<hash>.css"/>` as the last element
  in `<head>`. A request for that file returned `200`, `content-type:
  text/css; charset=utf-8`, `cache-control: public, max-age=0,
  must-revalidate` and an `etag`.
- Lightning CSS rewrote `:root { color-scheme: dark }` to also set
  `--lightningcss-light: ;--lightningcss-dark:initial;`. That is a few bytes of
  its `light-dark()` support and is harmless.
- The build printed `[plugin vite:css-post] SOURCEMAP_BROKEN` for the SSR
  build even with plain CSS only. It is a warning; the build succeeded.

## Server runtime CPU: why it is near zero for all three

- **The CSS file itself costs no Worker CPU.** The Cloudflare Vite plugin
  writes a `wrangler.json` whose `assets.directory` is the client build output
  ([Vite plugin: static assets][cf-vite-assets]); the experiment's generated
  file had `assets: { directory: "../client" }`. Cloudflare "will first attempt
  to serve static assets if one matches the incoming request" and invokes the
  Worker only when none matches ([Workers static assets routing][cf-routing]).
  "Requests to static assets are free and unlimited"
  ([Static assets billing][cf-billing]). `wrangler.jsonc` sets no
  `run_worker_first`, so this default applies.
- **The SSR page pays only for the `<link>` tags.** `<Links />` maps a short
  array of hrefs to `<link>` elements. CSS Modules add a property read per
  `className` from a constant object. Tailwind adds nothing at runtime: the
  plugin generates CSS during `vite build`, and the page carries plain class
  strings.
- **Inlining CSS into the HTML is the one variant that adds per-request work.**
  Vite's `?inline` returns the CSS as a string
  ([Vite CSS features][vite-css]), which a route could put in a `<style>`
  tag. Every SSR response would then carry those bytes, and the browser could
  not cache them separately. The cost is mostly response size, not CPU.

## Option 1: plain CSS files with custom properties

**Wiring.** Two equivalent routes, both documented
([React Router Styling][rr-styling]):

```tsx
// app/root.tsx: side-effect import, picked up through route.css
import "./app.css";
```

```tsx
// any route: explicit URL, rendered through links()
import appHref from "./app.css?url";
export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: appHref },
];
```

The side-effect import needs no `links` code and also gets the dev-only
critical CSS handling. `?url` gives an explicit `<link>` with no manifest
involvement. React 19 can also render
`<link rel="stylesheet" href={appHref} precedence="default" />` inside a
component and hoist it to `<head>`.

Custom properties are plain CSS. A dark-only theme can define its tokens on
`:root` alongside `color-scheme: dark`, as the experiment did.

**CSS shipped.** Exactly what is written. Vite minifies it with Lightning CSS
by default (`build.cssMinify` default `'lightningcss'`) and splits it per
route chunk (`build.cssCodeSplit` default `true`)
([Vite build options][vite-build]). Vite also inlines `@import` and runs any
PostCSS config it finds ([Vite CSS features][vite-css]).

**Known problems.** None found that are specific to this stack. The open
React Router CSS issues below apply to every option.

## Option 2: CSS Modules

**Wiring.** Built into Vite: "Any CSS file ending with `.module.css` is
considered a CSS modules file", and importing it returns the class-name map
([Vite CSS features][vite-css]). React Router's plugin recognises the same
pattern (`cssModulesRegExp` in `dist/vite.js`). The import is a side-effect
import, so the file lands in the route's `css` list like Option 1.

```tsx
import styles from "./home.module.css";
<h1 className={styles.title}>Tonight</h1>
```

`css.modules` options (such as `localsConvention` and `generateScopedName`)
are passed to `postcss-modules` and have no effect when `css.transformer` is
`lightningcss` ([Vite shared options][vite-shared]). The default transformer
is `postcss`.

**Server CPU.** The class-name map is a constant object in the server bundle,
as the experiment showed. Reading it is negligible.

**CSS shipped.** Same as Option 1, with scoped class names such as
`._title_1ss8p_2`. Global tokens (custom properties on `:root`) still live in a
plain global CSS file; modules read them with `var(--token)`.

**Known problems.** None found that are specific to this stack. React Router
issue #14413 (open, `feat:css`) reports route CSS, shown with CSS Modules,
being removed as soon as navigation starts in production, which breaks exit
animations. It affects any per-route CSS, not only modules.

## Option 3: Tailwind CSS v4 with its Vite plugin

**Wiring.** Tailwind's React Router guide: `npm install tailwindcss
@tailwindcss/vite`, add `tailwindcss()` to the Vite plugins, and put
`@import "tailwindcss";` in `app/app.css`
([Tailwind: React Router guide][tw-rr]). Cloudflare's own React Router
starter shows the plugin order with the Cloudflare plugin:
`cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), reactRouter()`,
and imports `./app.css` in `root.tsx` ([cloudflare/templates
react-router-starter-template][cf-template]). That template pins React Router
7.9.6 and Vite 7, not 8.

`@tailwindcss/vite` 4.3.3 (latest on npm) declares peer `vite: "^5.2.0 || ^6
|| ^7 || ^8"`. It depends on `@tailwindcss/oxide`, a native scanner with
per-platform optional packages; that runs at build time only.

**Server CPU.** None at runtime. Tailwind "treats all of your source files as
plain text" and generates CSS for the tokens it finds
([Tailwind: detecting classes][tw-detect]). The result is a static stylesheet
like Option 1.

**CSS shipped.**

- Preflight, Tailwind's base reset, is injected by `@import "tailwindcss"`;
  omitting its layer import disables it ([Tailwind: Preflight][tw-preflight]).
  Its source file at `v4.3.3` is 8,489 bytes before minification and
  compression.
- Only utilities whose names appear in scanned files. Class names built by
  string concatenation are not detected ([Tailwind: detecting
  classes][tw-detect]). Files in `.gitignore` and `node_modules` are skipped.
- "By default only used CSS variables will be generated"; `@theme static`
  forces all of them. Theme values become plain custom properties usable from
  any CSS, and `--color-*: initial` removes the default palette
  ([Tailwind: theme][tw-theme]).
- `dark:` uses `prefers-color-scheme` by default
  ([Tailwind: dark mode][tw-dark]). A dark-only app can write dark values as
  the base styles and never use the variant.

**Browser floor.** Tailwind v4 "specifically depends on" Chrome 111,
Safari 16.4 and Firefox 128 ([Tailwind: compatibility][tw-compat]). Vite 8's
default `build.target` is already `['chrome111', 'edge111', 'firefox114',
'safari16.4', 'ios16.4']` ([Vite build options][vite-build]). Tailwind's
floor therefore matches Vite's default on iOS Safari and Chrome. It is higher
only on Firefox: 128 against 114.

**Mixing with CSS Modules.** Tailwind says "we don't recommend using CSS
modules and Tailwind together": each module is processed separately, so
Tailwind runs once per module, and `@apply` inside a module needs
`@reference "../app.css"` ([Tailwind: compatibility][tw-compat]).

**Known problems.**

- [tailwindlabs/tailwindcss#20622][tw-20622] (open, 2026-10-27): with exact
  versions `tailwindcss` 4.3.3, `@tailwindcss/vite` 4.3.3 and Vite 8.3.5, and a
  Cloudflare Worker environment with source maps on, Rolldown warns
  `SOURCEMAP_BROKEN` for the Tailwind stylesheet. It is a build warning, not
  a failure. The experiment saw the same warning from Vite's own
  `vite:css-post` with plain CSS.
- [tailwindlabs/tailwindcss#19888][tw-19888] (closed): client and SSR builds
  produced different CSS filenames in a Docker build. The cause was a missing
  `.gitignore` in the build context, which changes what Tailwind scans. A CI
  or deploy build that omits `.gitignore` could hit the same mismatch.
- [tailwindlabs/tailwindcss#19853][tw-19853] (closed without a fix for lack
  of a repro): a duplicate unlayered Preflight in production with
  `@cloudflare/vite-plugin` 1.30.0 and Vite 8.0.1. That setup used `vinext`
  with an `rsc` environment, not React Router; treat it as unconfirmed here.
- [cloudflare/workers-sdk#8629][cf-8629] (closed): CSS built outside Vite, with
  the Tailwind CLI, was not deployed. The maintainer's answer was to build the
  CSS in Vite. The Vite plugin avoids this.
- [cloudflare/workers-sdk#9379][cf-9379] (closed): a Tailwind build error with
  the Cloudflare plugin, traced to a misconfigured Worker `main`, not to
  Tailwind.

## Problems that apply to every option

Open React Router issues labelled `feat:css`:

- [#14164][rr-14164]: CSS flash when middleware throws a response while the
  root route has a loader. This repo's root route has `sessionMiddleware` but
  no loader today. The reported workaround is
  `<link rel="stylesheet" href={href} precedence="high" />` in `root.tsx`; a
  commenter notes that `precedence` also stops hydration mismatches when
  Cloudflare or third parties inject tags into `<head>`.
- [#14413][rr-14413]: per-route CSS is removed as navigation starts, which
  breaks exit transitions. A single global stylesheet on `root` avoids it.
- [#14754][rr-14754]: duplicated stylesheet download with suspended
  components shared across routes, since 7.9.5.
- [#14087][rr-14087]: CSS order differs between dev and production.

On caching, the default static asset header is `public, max-age=0,
must-revalidate` with an ETag, so phones revalidate each stylesheet. A
`public/_headers` file can set longer caching for the hashed files under
`/assets/*` ([Static assets headers][cf-headers]; [Vite plugin: static
assets][cf-vite-assets]). Cloudflare compresses `text/css` by default, with
Zstandard on the Free plan for browsers that support it
([Cloudflare compression][cf-compression]). That page does not say whether
this covers `workers.dev`.

## Trade-offs for the grilling ticket

- **Runtime cost is not a deciding factor.** All three serve CSS as static
  assets outside the Worker's 10 ms budget; SSR adds only `<link>` tags.
- **Dependencies.** Plain CSS and CSS Modules add none. Tailwind adds two dev
  dependencies, a native build-time binary, and one more Vite plugin in front
  of `reactRouter()`.
- **Bytes on the phone.** Plain CSS and CSS Modules ship only what is
  written. Tailwind ships Preflight (or not, if disabled) plus the utilities
  in use; it grows with the variety of utilities, not with page count.
- **Scoping.** CSS Modules scope class names per file. Plain CSS relies on
  naming discipline. Tailwind avoids most custom class names.
- **Tokens.** All three can use CSS custom properties for the dark theme.
  Tailwind's `@theme` also turns tokens into utilities.
- **One file or per-route files.** One global stylesheet on `root` sidesteps
  #14413 and #14754. Per-route CSS, which CSS Modules produce, lowers first-load
  bytes but is exposed to them.
- **Browser floor.** Tailwind v4 needs iOS Safari 16.4+, which Vite 8's
  default target already assumes.

## Sources

Primary documentation:

- React Router 8.5.1 docs, `explanation/styling.md`, bundled in
  `node_modules/react-router/docs/` and published at
  <https://reactrouter.com/explanation/styling>
- React Router 8.5.1 docs, `start/framework/route-module.md` (`links`),
  bundled in the same package
- React Router 8.5.1 source: `@react-router/dev/dist/vite.js`,
  `react-router/dist/development/lib/dom/ssr/links.js` and `components.js`
- <https://vite.dev/guide/features.html#css>
- <https://vite.dev/config/build-options.html> (page shows
  v8.3.4)
- <https://vite.dev/config/shared-options.html>
- <https://developers.cloudflare.com/workers/static-assets/routing/worker-script/>
- <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>
- <https://developers.cloudflare.com/workers/static-assets/headers/>
- <https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/>
- <https://developers.cloudflare.com/speed/optimization/content/compression/>
- <https://github.com/cloudflare/templates/tree/main/react-router-starter-template>
- <https://tailwindcss.com/docs/installation/framework-guides/react-router>
- <https://tailwindcss.com/docs/detecting-classes-in-source-files>
- <https://tailwindcss.com/docs/theme>
- <https://tailwindcss.com/docs/preflight>
- <https://tailwindcss.com/docs/dark-mode>
- <https://tailwindcss.com/docs/compatibility>
- npm registry: `npm view @tailwindcss/vite@4.3.3 peerDependencies dependencies`

Issues:

- <https://github.com/remix-run/react-router/issues/14164>
- <https://github.com/remix-run/react-router/issues/14413>
- <https://github.com/remix-run/react-router/issues/14754>
- <https://github.com/remix-run/react-router/issues/14087>
- <https://github.com/tailwindlabs/tailwindcss/issues/20622>
- <https://github.com/tailwindlabs/tailwindcss/issues/19888>
- <https://github.com/tailwindlabs/tailwindcss/issues/19853>
- <https://github.com/cloudflare/workers-sdk/issues/8629>
- <https://github.com/cloudflare/workers-sdk/issues/9379>

[rr-styling]: https://reactrouter.com/explanation/styling
[vite-css]: https://vite.dev/guide/features.html#css
[vite-build]: https://vite.dev/config/build-options.html
[vite-shared]: https://vite.dev/config/shared-options.html
[cf-routing]: https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
[cf-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[cf-headers]: https://developers.cloudflare.com/workers/static-assets/headers/
[cf-vite-assets]: https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/
[cf-compression]: https://developers.cloudflare.com/speed/optimization/content/compression/
[cf-template]: https://github.com/cloudflare/templates/tree/main/react-router-starter-template
[tw-rr]: https://tailwindcss.com/docs/installation/framework-guides/react-router
[tw-detect]: https://tailwindcss.com/docs/detecting-classes-in-source-files
[tw-theme]: https://tailwindcss.com/docs/theme
[tw-preflight]: https://tailwindcss.com/docs/preflight
[tw-dark]: https://tailwindcss.com/docs/dark-mode
[tw-compat]: https://tailwindcss.com/docs/compatibility
[rr-14164]: https://github.com/remix-run/react-router/issues/14164
[rr-14413]: https://github.com/remix-run/react-router/issues/14413
[rr-14754]: https://github.com/remix-run/react-router/issues/14754
[rr-14087]: https://github.com/remix-run/react-router/issues/14087
[tw-20622]: https://github.com/tailwindlabs/tailwindcss/issues/20622
[tw-19888]: https://github.com/tailwindlabs/tailwindcss/issues/19888
[tw-19853]: https://github.com/tailwindlabs/tailwindcss/issues/19853
[cf-8629]: https://github.com/cloudflare/workers-sdk/issues/8629
[cf-9379]: https://github.com/cloudflare/workers-sdk/issues/9379
