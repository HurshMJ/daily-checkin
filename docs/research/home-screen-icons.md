# Research: home-screen icon and splash requirements on iPhone and Android

Ticket: [#31 Home-screen icon and splash requirements on iPhone and Android](https://github.com/HurshMJ/daily-checkin/issues/31)
Map: [#28 Styling Daily Check-in](https://github.com/HurshMJ/daily-checkin/issues/28)
Researched: 2026-11-01. Each claim names the source that owns it. Platform
behavior changes with OS releases, so the dates below matter.

## Question

What does an installable web app need to look right on an iPhone and an
Android home screen today? This covers icon files and sizes, `theme_color` and
`background_color`, the iPhone launch screen, and the status bar in
`display: standalone`.

## Context from this app

- Installable web app with manifest `display: standalone`. iPhone Web Push
  needs it: since iOS 16.4 a site must serve a manifest "with its display
  member set to standalone or fullscreen" and be added to the Home Screen
  ([WebKit, Web Push for Web Apps on iOS and iPadOS, 2023-02-16](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- Served by one Cloudflare Worker with static assets on workers.dev.
- Dark theme only, phone-first.

## Short answer

1. Ship a manifest with `name`, `short_name`, `start_url`, `display:
   "standalone"`, `background_color`, `theme_color`, and three PNG icons:
   192x192 `any`, 512x512 `any`, and 512x512 `maskable`.
2. Add one 180x180 opaque `apple-touch-icon.png` and a favicon.
3. Use one dark color for `background_color`, `theme_color`, the
   `<meta name="theme-color">` tag, and the CSS `html`/`body` background.
   Android builds its splash screen from the manifest. iPhone ignores the
   manifest colors for its launch screen, so the page's own first paint must
   already be dark.
4. Skip `apple-touch-startup-image` for now. It needs one exact image per
   device screen size. It is the only documented way to set a custom iPhone
   launch image.
5. Skip `apple-mobile-web-app-capable`. web.dev says not to use it, and since
   iOS 26 every site added to the Home Screen opens as a web app by default.

## 1. Icons

### Manifest `icons`

- The spec defines three purposes: `any` (the default), `maskable`, and
  `monochrome`. User agents "SHOULD NOT use an icon other than for its stated
  icon purpose". An icon whose purposes are all unrecognized "is totally
  ignored"
  ([W3C Web Application Manifest, Working Draft 2026-10-26, §1.7, §2.1](https://www.w3.org/TR/appmanifest/)).
  The draft warns that "this specification is not stable".
- Each icon object needs only `src`. `sizes` and `type` are optional, but
  "specifying the exact available sizes is recommended" for PNG, and setting
  `type` lets browsers skip unsupported formats
  ([MDN, icons, modified 2025-06-23](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons)).
- Chrome's install criteria require icons that "must include a 192px and a
  512px icon"
  ([web.dev, What does it take to be installable?, updated 2024-09-19](https://web.dev/articles/install-criteria)).
  "For Chromium, you must provide at least a 192x192 pixel icon and a 512x512
  pixel icon"
  ([web.dev, Add a web app manifest, updated 2024-09-18](https://web.dev/articles/add-manifest)).
- "If you need to pick only one icon size, it should be 512 by 512 pixels."
  The legacy Android sizes 48, 72, 96, 144, 168 and 256 "are no longer
  necessary"
  ([web.dev Learn PWA, Web app manifest, updated 2024-12-09](https://web.dev/learn/pwa/web-app-manifest)).
- Use a square, opaque icon. iOS, iPadOS and Android 8+ fill transparent areas
  with a background color you do not control
  ([web.dev Learn PWA, Web app manifest](https://web.dev/learn/pwa/web-app-manifest)).
- SVG icons work in Chromium, but they are rasterized at install time. Keep a
  PNG fallback
  ([web.dev, Add a web app manifest](https://web.dev/articles/add-manifest)).

### Maskable icons (Android)

- Android 8.0 introduced adaptive icons. Chrome 79 added maskable icons for
  installed web apps on Android O or later
  ([Chrome, New in Chrome 79, 2019-12-10](https://developer.chrome.com/blog/new-in-chrome-79)).
- Safe zone: "a circle with center point in the center of the icon and with a
  radius of 2/5 (40%)" of the icon size
  ([W3C manifest §2.3](https://www.w3.org/TR/appmanifest/)). web.dev adds:
  "The outer 10% edge might be cropped on some platforms"
  ([web.dev, Maskable icons, 2019-12-19](https://web.dev/articles/maskable-icon)).
- Without a maskable icon, Android shows icons on a white background, and
  "transparent icons appear inside white circles"
  ([web.dev, Maskable icons](https://web.dev/articles/maskable-icon)).
- "Maskable icons should be 512 by 512 at least"
  ([web.dev Learn PWA](https://web.dev/learn/pwa/web-app-manifest)).
- Ship the maskable icon as its own entry with `"purpose": "maskable"`. Do not
  combine it as `"any maskable"`. Using a maskable icon as `any` "adds
  unnecessary padding"
  ([web.dev, Maskable icons](https://web.dev/articles/maskable-icon)). Note the
  conflict: the older web.dev
  [Add a web app manifest](https://web.dev/articles/add-manifest) page still
  shows `"any maskable"`. The spec allows both forms. Separate entries give
  each platform the right art.
- Chrome DevTools, Application panel, Icons section, can show only the safe
  zone to check the art
  ([web.dev, Maskable icons](https://web.dev/articles/maskable-icon)).

### `apple-touch-icon` (iPhone)

- iOS uses manifest icons only since Safari 15.4 (2022-03-14), and only "when
  no `apple-touch-icon` is present" and the icon's `purpose` is omitted or
  `any`. "Defining icons by using apple-touch-icon takes precedence over
  manifest-declared icons"
  ([WebKit, New WebKit Features in Safari 15.4, 2022-03-14](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/);
  [MDN browser-compat-data, manifests/webapp/icons](https://raw.githubusercontent.com/mdn/browser-compat-data/main/manifests/webapp/icons.json)).
  iOS therefore never uses the maskable icon.
- If a site has no icon at all, iOS 16.4+ generates a monogram from the first
  letter of the site name
  ([WebKit, 2023-02-16](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)).
- Apple's archived guide shows `<link rel="apple-touch-icon"
  sizes="180x180" href="touch-icon-iphone-retina.png">` for current iPhones.
  With no `<link>`, iOS searches the site root for files named
  `apple-touch-icon...`, such as `/apple-touch-icon.png`. iOS 7 and later add
  no effects to the icon
  ([Apple, Configuring Web Applications, archived, updated 2016-12-12](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)).
  That guide points to the Human Interface Guidelines for current sizes. No
  current Apple page states a web-clip size, so 180x180 rests on that
  archived example.
- Supply a square, full-bleed, opaque image. The transparency rule above
  applies
  ([web.dev Learn PWA](https://web.dev/learn/pwa/web-app-manifest)).
- Safari 26.0 (2025-09-15) "now supports the SVG file format for icons
  everyplace there are icons in the interface", including Home Screen web
  apps and favicons. Data URL icons also work
  ([WebKit, WebKit Features in Safari 26.0, 2025-09-15](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).
  Older iOS versions need PNG, so keep PNG as the baseline.

### Favicon

- `<link rel="icon">` sets the tab and bookmark icon. With several icons, the
  browser picks by `media`, `type` and `sizes`, and falls back to the next one
  if a format is unsupported. Do not use `rel="shortcut icon"`: it "is
  non-conforming, ignored"
  ([MDN, rel attribute, modified 2026-10-07](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel)).
- MDN also notes that iOS does not use `rel="icon"` for the Web Clip. It uses
  `apple-touch-icon` instead
  ([MDN, rel attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel)).

## 2. `theme_color` and `background_color`

### What the spec says

- `theme_color` is the default theme color. The user agent "MAY override the
  default theme color" with an in-scope `<meta name="theme-color">`, and MAY
  override it for `prefers-color-scheme`
  ([W3C manifest §1.12](https://www.w3.org/TR/appmanifest/)).
- `background_color` is "only meant to improve the user experience while a
  web application is loading". It "MUST NOT be used by the user agent as the
  background color when the web application's stylesheet is available"
  ([W3C manifest §1.13](https://www.w3.org/TR/appmanifest/)).
- MDN recommends that `background_color` match the stylesheet's
  `background-color`
  ([MDN, background_color, modified 2025-12-18](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/background_color)).
  Use opaque colors only. `theme_color` "cannot be transparent" in most
  environments
  ([MDN, theme_color, modified 2025-12-18](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/theme_color)).
- The manifest cannot hold light and dark variants. The `<meta
  name="theme-color" media="(prefers-color-scheme: dark)">` tag can
  ([web.dev, Add a web app manifest](https://web.dev/articles/add-manifest)).
  This app is dark only, so one value is enough.

### Android (Chrome)

- Chrome builds the splash screen "from the `name`, `background_color`, and
  `icons`". It picks the icon closest to the device resolution, and 192px plus
  512px cover most cases. Match `background_color` to the first page's color
  for a smooth handoff
  ([web.dev, Add a web app manifest](https://web.dev/articles/add-manifest)).
- web.dev Learn PWA says Android uses `theme_color`, `background_color` and
  the icon for the splash
  ([web.dev Learn PWA](https://web.dev/learn/pwa/web-app-manifest)). The older
  Lighthouse audit listed the full conditions: `name`, a valid
  `background_color`, a valid `theme_color`, and a PNG icon of at least
  512x512. That audit is deprecated: "PWA testing in Lighthouse is deprecated"
  ([Chrome Lighthouse, splash-screen, updated 2024-04-16](https://developer.chrome.com/docs/lighthouse/pwa/splash-screen)).
- `theme_color` "sets the color of the tool bar" and should match the meta
  theme color
  ([web.dev, Add a web app manifest](https://web.dev/articles/add-manifest)).
  On mobile it colors the status bar
  ([web.dev Learn PWA, App design, updated 2024-09-20](https://web.dev/learn/pwa/app-design)).
- Chrome for Android 39-91 ignored `theme-color` on devices in native dark
  mode, except for installed web apps. Full support starts in Chrome 92
  ([MDN browser-compat-data, html/elements/meta](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/meta.json)).
- Chrome installs the app as a WebAPK. When it detects a manifest change it
  generates a new APK, and frequent changes slow installs
  ([web.dev, WebAPKs on Android, 2017-05-21](https://web.dev/articles/webapks)).
  Pick the icons and colors before Members install.

### iPhone (Safari)

- "Safari on iOS and iPadOS and most desktop browsers currently ignore"
  `background_color`
  ([web.dev Learn PWA](https://web.dev/learn/pwa/web-app-manifest)). MDN's
  compatibility data agrees: Safari has no support, and iOS mirrors it
  ([MDN browser-compat-data, manifests/webapp/background_color](https://raw.githubusercontent.com/mdn/browser-compat-data/main/manifests/webapp/background_color.json)).
- `<meta name="theme-color">` has worked since Safari 15. "From Safari 26, the
  theme color is only used for installed web apps"
  ([MDN browser-compat-data, html/elements/meta](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/meta.json)).
  In a Safari tab, iOS 26 tints the top bar from the page background instead.
  A WebKit engineer said the tint extension applies to fixed or sticky
  elements near an edge
  ([WebKit bug 301756, filed 2025-10-31](https://bugs.webkit.org/show_bug.cgi?id=301756)).
  So the CSS page background now matters as much as the meta tag.
- MDN data lists manifest `theme_color` as supported from iOS Safari 15
  ([MDN browser-compat-data, manifests/webapp/theme_color](https://raw.githubusercontent.com/mdn/browser-compat-data/main/manifests/webapp/theme_color.json)).
  Set the meta tag too, so both paths give the same color.

## 3. iPhone launch screen

- Android generates a splash from the manifest. iOS does not: it "uses an
  image from a proprietary `<link>` element" instead
  ([web.dev Learn PWA](https://web.dev/learn/pwa/web-app-manifest)). MDN names
  it: iOS uses `apple-touch-startup-image`, not `rel="icon"`
  ([MDN, rel attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel)).
- Apple documents only `<link rel="apple-touch-startup-image"
  href="/launch.png">`. It says "By default, a screenshot of the web
  application the last time it was launched is used", and gives no pixel
  sizes
  ([Apple, Configuring Web Applications, archived 2016-12-12](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html)).
  No current Apple page describes the launch screen, so the 2016 default may
  be out of date.
- Developer reports on Apple's forums say the image must match each device's
  exact screen resolution, and one says it stopped working on iOS 16.4
  ([Apple Developer Forums, iOS web app splash screens, 2023](https://developer.apple.com/forums/thread/733490)).
  These are user reports, not Apple statements.
- Open WebKit bug 311569 (filed 2026-04-06, iOS 26) reports one or more white
  frames on a cold start of a dark Home Screen web app. The reporter tried
  dark manifest colors, inline `html`/`body` backgrounds, and `color-scheme:
  dark`, and none removed it. It is linked to Apple's internal tracker, with
  no fix yet
  ([WebKit bug 311569](https://bugs.webkit.org/show_bug.cgi?id=311569)). A
  dark-only app may see this flash whatever it ships.

**Implication.** A custom iPhone launch image means one PNG per supported
iPhone screen size, each behind a device media query. The cheaper path
is to make the very first paint dark: an inline `<style>` on `html` with the
dark background and `color-scheme: dark`. Then accept whatever system screen
iOS shows. Whether to ship startup images is a product call for the human.

## 4. Status bar in standalone mode

### iPhone

- `apple-mobile-web-app-status-bar-style` takes `default`, `black`, or
  `black-translucent`. With `default` or `black`, content sits below the
  status bar. With `black-translucent`, "the web content is displayed on the
  entire screen, partially obscured by the status bar". The default is
  `default`
  ([Apple, Supported Meta Tags, archived 2014-07-15](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)).
  The archived text says the tag needs the standalone opt-in. A manifest with
  `display: standalone` gives that opt-in today.
- web.dev says not to use the legacy `apple-mobile-web-app-capable` tag: "it's
  no longer recommended"
  ([web.dev Learn PWA](https://web.dev/learn/pwa/web-app-manifest)). Since iOS
  26, "By default, every website added to the Home Screen opens as a web
  app", and Safari has "zero requirements for 'installability'"
  ([WebKit, Safari 26.0, 2025-09-15](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).
  Keep the manifest anyway, because Web Push still relies on it.
- To draw under the status bar with `black-translucent`, add
  `viewport-fit=cover` to the viewport meta tag and pad with
  `env(safe-area-inset-*)`, because content can now render "behind rounded
  corners and notches"
  ([web.dev Learn PWA, App design](https://web.dev/learn/pwa/app-design)).
- Risk: WebKit bug 301994 reports that content no longer extends under the
  status bar in iOS 26.1, and that `env(safe-area-inset-top)` returned 0.
  Reporters said iOS 26.2 fixed it. A WebKit engineer reopened it on
  2026-08-04 after it came back in iOS 26.5.2 and the iOS 27 beta. One report
  says a system-drawn bottom gap takes its color from the page background,
  cached until relaunch
  ([WebKit bug 301994](https://bugs.webkit.org/show_bug.cgi?id=301994)).
  Edge-to-edge layout is therefore fragile on current iOS.
- Recommendation for a dark-only app: do not use `black-translucent`. Leave
  the status bar style at its default and set `<meta name="theme-color">` and
  the page background to the app's dark color, so content stays below the
  bar. Check the status bar text contrast on a real iPhone. No primary
  source states how iOS 26 picks light or dark status bar text in standalone
  mode.

### Android

- A standalone app "will create a standard screen that keeps the status bar
  visible". The theme color sets "the color of the status bar on mobile
  devices"
  ([web.dev Learn PWA, App design](https://web.dev/learn/pwa/app-design)).
  Nothing else is needed.

## 5. Minimum file set

| File | Size | Purpose | Used by |
|------|------|---------|---------|
| `manifest.webmanifest` | - | `name`, `short_name`, `start_url`, `display: "standalone"`, `background_color`, `theme_color`, `icons` | Android install and splash; iPhone icons fallback, Web Push |
| `icon-192.png` | 192x192 | `any`, opaque | Chrome install criteria, Android splash |
| `icon-512.png` | 512x512 | `any`, opaque | Chrome install criteria, Android splash |
| `icon-maskable-512.png` | 512x512 | `maskable`, art inside the 40% radius circle | Android adaptive launcher icon |
| `apple-touch-icon.png` | 180x180 | opaque, square, served at the site root | iPhone Home Screen (takes precedence over manifest icons) |
| `favicon.ico` or `favicon.svg` | 32x32 or vector | tab icon | Browsers |

The `<head>` of every page then needs:

```html
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#DARK">
<meta name="viewport" content="width=device-width, initial-scale=1">
```

`#DARK` stands for the app's one dark color. Use the same value for
`theme_color`, `background_color`, and the `html` background in CSS.
`<link rel="manifest">` goes on every page the app can be installed from
([web.dev Learn PWA](https://web.dev/learn/pwa/web-app-manifest)). A
cross-origin manifest needs CORS
([MDN, rel attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel)).
This app serves everything from one origin, so that does not apply.

Optional, not in the minimum: an SVG favicon (Safari 26+ and Chromium), a
`monochrome` icon, and `apple-touch-startup-image` launch images.

## 6. What changed, by date

| Date | Change | Source |
|------|--------|--------|
| 2019-12-10 | Chrome 79 supports maskable icons on Android O+ | [Chrome](https://developer.chrome.com/blog/new-in-chrome-79) |
| 2021 (Chrome 92) | `theme-color` honored on Android in native dark mode | [MDN BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/meta.json) |
| 2021 (Safari 15) | `theme-color` meta supported in Safari | [MDN BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/meta.json) |
| 2022-03-14 | Safari 15.4: manifest icons used on iOS; `apple-touch-icon` wins | [WebKit](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/) |
| 2023-03-27 | iOS 16.4: Web Push and Badging for Home Screen web apps, manifest `id`, monogram icon fallback | [WebKit](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/), [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) |
| 2024-04-16 | Lighthouse PWA audits deprecated | [Chrome](https://developer.chrome.com/docs/lighthouse/pwa/splash-screen) |
| 2025-09-15 | Safari 26 / iOS 26: Home Screen sites open as web apps by default; SVG and data URL icons; `theme-color` used only for installed web apps | [WebKit](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [MDN BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/meta.json) |
| 2025-11 to 2026-08 | WebKit bug 301994: status bar and safe-area regression in iOS 26.1, fixed in 26.2, back in 26.5.2 and iOS 27 beta (reopened) | [WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=301994) |
| 2026-04-06 | WebKit bug 311569: white flash on cold start of dark Home Screen apps, open | [WebKit bug](https://bugs.webkit.org/show_bug.cgi?id=311569) |
| 2026-10-26 | Latest W3C Web Application Manifest Working Draft | [W3C](https://www.w3.org/TR/appmanifest/) |

## Gaps and open points

- No current Apple page documents web-clip icon sizes, the launch screen, or
  status bar text color in iOS 26 standalone mode. The Apple pages cited are
  archived (2014 and 2016). Check on a real iPhone before calling it done.
- Whether to ship `apple-touch-startup-image` launch images is a product
  choice for the human: per-device images versus a plain dark first paint.
- The web.dev pages disagree on `"any maskable"`. This file follows the
  dedicated Maskable icons article, which explains why: use separate
  entries.
