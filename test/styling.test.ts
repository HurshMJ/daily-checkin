import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import appCss from "~/styles/app.css?raw";

import { startApp } from "./harness";
import { tokens } from "./tokens";

const LATIN_FONTS = [
  "/fonts/fredoka-600-latin.woff2",
  "/fonts/nunito-sans-400-latin.woff2",
  "/fonts/nunito-sans-700-latin.woff2",
];

async function loginPage() {
  const response = await startApp().fetch("/login");
  expect(response.status).toBe(200);
  const html = await response.text();
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  const body = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
  return { html, head, body };
}

describe("styled login page", () => {
  it("links one stylesheet in the head", async () => {
    const { html, head } = await loginPage();

    // The dev server adds its own critical-CSS link; production has only ours.
    const stylesheets = (html.match(/<link[^>]*rel="stylesheet"[^>]*>/g) ?? []).filter(
      (link) => !link.includes("data-react-router-critical-css"),
    );
    expect(stylesheets).toHaveLength(1);
    expect(head).toContain(stylesheets[0]);
    expect(stylesheets[0]).toMatch(/href="[^"]*app[^"]*\.css(\?[^"]*)?"/);
  });

  it("preloads only the three latin font files in the head", async () => {
    const { html, head } = await loginPage();

    const preloads = html.match(/<link[^>]*rel="preload"[^>]*as="font"[^>]*>/g) ?? [];
    expect(preloads).toHaveLength(3);
    for (const [index, href] of LATIN_FONTS.entries()) {
      const tag = preloads.find((link) => link.includes(`href="${href}"`));
      expect(tag, href).toBeDefined();
      expect(tag).toContain('type="font/woff2"');
      expect(tag).toContain('crossorigin="anonymous"');
      expect(head).toContain(preloads[index]);
    }
  });

  it("shows the login screen's words with no inline styles", async () => {
    const { html, body } = await loginPage();

    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("<h1");
    expect(body).toContain("Daily Check-in</h1>");
    expect(body).toContain("Who&#x27;s on tonight?");
    expect(body).toMatch(/<label[^>]*for="username"[^>]*>Username<\/label>/);
    expect(body).toMatch(/<label[^>]*for="password"[^>]*>Password<\/label>/);
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*>Log in<\/button>/);
    expect(body).toContain("Ask a friend in your Group for an Invite.");
  });

  it("shows a failed login as an error notice with no inline styles", async () => {
    const response = await startApp().device().post("/login", { username: "nobody", password: "wrong password!" });
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toMatch(/<div[^>]*role="alert"[^>]*>/);
    expect(html).toContain("That username and password do not match.");
  });
});

const PALETTE = ["blue", "sky", "cyan", "indigo", "violet", "purple", "pink", "slate"];
const LABELS = ["Blue", "Sky", "Cyan", "Indigo", "Violet", "Purple", "Pink", "Slate"];

/** The data-colour of every avatar dot, rendered as a span, in page order. */
function avatarDots(html: string): string[] {
  return [...html.matchAll(/<span[^>]*\sdata-colour="([^"]*)"[^>]*>/g)].map((match) => match[1]);
}

/** The inner HTML of every link to `href`. */
function linksTo(html: string, href: string): string[] {
  const links = html.matchAll(/<a\s[^>]*>[\s\S]*?<\/a>/g);
  return [...links]
    .map((match) => match[0])
    .filter((link) => link.slice(0, link.indexOf(">")).includes(` href="${href}"`))
    .map((link) => link.slice(link.indexOf(">") + 1, -"</a>".length));
}

function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>"));
}

describe("styled Setup Link page", () => {
  it("shows one avatar dot per palette colour, each with its label, and no top bar", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    const response = await app.device().open(`/setup/${token}`);
    const html = await response.text();
    const body = bodyOf(html);

    expect(response.status).toBe(200);
    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("Create your login</h1>");
    expect(body).toContain("This link works once and expires an hour after it was made.");
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*>Create login<\/button>/);

    const dots = avatarDots(body);
    expect(dots).toHaveLength(8);
    expect([...dots].sort()).toEqual([...PALETTE].sort());

    const tiles = [...body.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((match) => match[1]);
    for (const [index, name] of PALETTE.entries()) {
      const tile = tiles.find((inner) => inner.includes(`data-colour="${name}"`));
      expect(tile, name).toBeDefined();
      expect(tile).toContain(`value="${name}"`);
      expect(tile).toContain(LABELS[index]);
    }

    expect(linksTo(body, "/profile")).toEqual([]);
    expect(linksTo(body, "/")).toEqual([]);
  });

  it("shows an unusable link with no inline styles", async () => {
    const response = await startApp().device().open("/setup/not-a-real-token");
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toMatch(/<div[^>]*role="alert"[^>]*><p class="notice-title">Can&#x27;t use this link<\/p>/);
    expect(html).toContain("This Setup Link does not work.");
  });
});

describe("styled Tonight and profile", () => {
  async function newMember(canCreateGroups = true) {
    const app = startApp();
    const browser = await app.createLogin({
      username: "Alice",
      password: "correct horse battery",
      colour: "pink",
      canCreateGroups,
    });
    return browser;
  }

  it("shows a Member who cannot create Groups an empty Tonight that says to ask an Owner for an Invite", async () => {
    const browser = await newMember(false);
    const html = await (await browser.get("/")).text();
    const body = bodyOf(html);

    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("You&#x27;re not in a Group yet");
    expect(body).toContain(
      "<p class=\"empty-hint\">Ask a Group&#x27;s Owner for an Invite, then open the Invite link they send you.</p>",
    );
    expect(body).not.toContain("Create one and invite your friends");
    expect(linksTo(body, "/groups/new")).toEqual([]);
  });

  it("shows the empty Tonight with the You pill in the Member's colour", async () => {
    const browser = await newMember();
    const response = await browser.get("/");
    const html = await response.text();
    const body = bodyOf(html);

    expect(response.status).toBe(200);
    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("Tonight</h1>");
    expect(body).toContain("You&#x27;re not in a Group yet");
    expect(body).toContain("Create one and invite your friends, or open an Invite link a friend sent you.");
    expect(linksTo(body, "/groups/new")).toEqual(["Create a Group"]);

    const pills = linksTo(body, "/profile");
    expect(pills).toHaveLength(1);
    expect(avatarDots(pills[0])).toEqual(["pink"]);
    expect(pills[0]).toContain("You");
    expect(avatarDots(body)).toEqual(["pink"]);
  });

  it("shows the profile with a way back to Tonight and no link to itself", async () => {
    const browser = await newMember();
    const response = await browser.get("/profile");
    const html = await response.text();
    const body = bodyOf(html);

    expect(response.status).toBe(200);
    expect(html).not.toMatch(/\sstyle=/);
    // The glyph is hidden from screen readers, so the link's name is just "Tonight".
    expect(linksTo(body, "/")).toEqual(['<span aria-hidden="true">‹</span> Tonight']);
    expect(linksTo(body, "/profile")).toEqual([]);
  });

  it("heads the profile with the large dot, the name and @username, then the cards with Sessions", async () => {
    const browser = await newMember();
    const html = await (await browser.get("/profile")).text();
    const body = bodyOf(html).replaceAll("<!-- -->", "");

    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain('<span class="avatar-dot avatar-dot-large" data-colour="pink" aria-hidden="true"></span>');
    // The header holds one dot; the name and colour card's picker holds one per colour.
    const header = body.match(/<header class="profile-header">([\s\S]*?)<\/header>/)![1];
    expect(avatarDots(header)).toEqual(["pink"]);
    expect(body).toMatch(/<h1[^>]*>Alice<\/h1><p class="profile-username">@Alice<\/p>/);
    expect(body).not.toContain("Logged in as");

    const card = body.match(/<section class="card" aria-labelledby="sessions-heading">([\s\S]*?)<\/section>/);
    expect(card, "Sessions card").not.toBeNull();
    expect(card![1]).toMatch(/^<h2[^>]*>Sessions<\/h2>/);
    expect(card![1]).toMatch(
      /<form[^>]*action="\/logout"[\s\S]*>Log out<\/button>[\s\S]*<form[^>]*action="\/logout-everywhere"[\s\S]*>Log out everywhere<\/button>/,
    );
  });
});

/** The <head> of a page. */
function headOf(html: string): string {
  return html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
}

/** The one tag in `head` that matches `pattern`. */
function oneTag(head: string, pattern: RegExp): string {
  const tags = head.match(new RegExp(pattern, "g")) ?? [];
  expect(tags, String(pattern)).toHaveLength(1);
  return tags[0] ?? "";
}

describe("installed look in every page head", () => {
  async function pages() {
    const login = await (await startApp().fetch("/login")).text();
    const browser = await startApp().createLogin({ username: "Alice", password: "correct horse battery", colour: "pink" });
    const tonight = await (await browser.get("/")).text();
    return { login, tonight };
  }

  it("links the manifest and icons and sets the theme colour to --bg", async () => {
    for (const [name, html] of Object.entries(await pages())) {
      const head = headOf(html);

      const manifest = oneTag(head, /<link[^>]*rel="manifest"[^>]*>/);
      expect(manifest, name).toContain('href="/manifest.webmanifest"');

      const icon = oneTag(head, /<link[^>]*rel="icon"[^>]*>/);
      expect(icon, name).toContain('href="/favicon.svg"');
      expect(icon, name).toContain('type="image/svg+xml"');

      const touchIcon = oneTag(head, /<link[^>]*rel="apple-touch-icon"[^>]*>/);
      expect(touchIcon, name).toContain('href="/apple-touch-icon.png"');

      const themeColour = oneTag(head, /<meta[^>]*name="theme-color"[^>]*>/);
      expect(themeColour, name).toContain(`content="${tokens.get("--bg")}"`);
    }
  });

  it("adds no Apple launch images or standalone meta", async () => {
    for (const [name, html] of Object.entries(await pages())) {
      expect(html, name).not.toContain("apple-mobile-web-app-capable");
      expect(html, name).not.toContain("apple-touch-startup-image");
    }
  });
});

/** The declarations of the one rule in app.css whose selector is exactly `selector`. */
function ruleOf(selector: string): string {
  const css = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors.trim() === selector);
  expect(rules, selector).toHaveLength(1);
  return rules[0][2];
}

describe("Check-in live region", () => {
  it("is never hidden from assistive tech, so Saving your answer… is announced", () => {
    const css = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors.includes(".checkin-status"));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selectors, declarations] of rules) {
      expect(declarations, selectors.trim()).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden/);
    }
  });
});

describe("styled Group page", () => {
  async function ownerPage() {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: "correct horse battery", colour: "pink", canCreateGroups: true });
    await alice.post("/groups/new", { name: "Friday" });
    const group = await env.DB.prepare("SELECT id FROM groups").first<{ id: number }>();
    const html = await (await alice.post(`/groups/${group!.id}`, { intent: "make", label: "for Sam" })).text();
    return bodyOf(html);
  }

  it("draws the copy box and the list tiles from tokens only, with no inline styles", async () => {
    const body = await ownerPage();
    expect(body).not.toMatch(/\sstyle=/);
    expect(body).toMatch(/<div class="copy-box"><label[^>]*for="invite-link"/);
    expect(body).toMatch(/<li class="list-tile">[\s\S]*?<span class="list-tile-tag">Owner<\/span><\/li>/);
    expect(body).toMatch(/<li class="list-tile"><span class="list-tile-text"><span class="list-tile-name" id="invite-\d+-name">for Sam<\/span>/);

    for (const selector of [".copy-box", ".copy-box-status", ".list-tile", ".list-tile-tag", ".btn-small"]) {
      const declarations = ruleOf(selector);
      // Every colour comes from a token: no hex, rgb or named colour literals.
      expect(declarations, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      for (const [, value] of declarations.matchAll(/(?:^|;)\s*(?:color|background|border(?:-[a-z-]+)?)\s*:\s*([^;]+)/g)) {
        if (/^(transparent|none|0)$/.test(value.trim())) continue;
        expect(value, selector).toMatch(/var\(--/);
      }
    }
    expect(ruleOf(".copy-box")).toMatch(/border: var\(--border-width\) dashed var\(--accent\)/);
  });

  it("uses no modifier classes: list tiles and buttons carry one class each", async () => {
    const body = await ownerPage();
    for (const [, classes] of body.matchAll(/class="((?:list-tile|btn-small|copy-box)[^"]*)"/g)) {
      expect(classes.split(" "), classes).toHaveLength(1);
    }
  });
});

describe("styled Group settings and the profile Groups card", () => {
  it("draws the stepper, Manage and the tile action from tokens only, with no inline styles", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: "correct horse battery", colour: "pink", canCreateGroups: true });
    await alice.post("/groups/new", { name: "Friday" });
    const group = await env.DB.prepare("SELECT id FROM groups").first<{ id: number }>();
    const page = bodyOf(await (await alice.get(`/groups/${group!.id}`)).text());
    const profile = bodyOf(await (await alice.get("/profile")).text());
    expect(page).not.toMatch(/\sstyle=/);
    expect(profile).not.toMatch(/\sstyle=/);
    expect(page).toContain('<form class="stepper"');
    expect(profile).toContain('<form class="list-tile-action"');

    for (const selector of [".stepper", ".stepper-btn", ".stepper-value", ".manage", ".manage-actions", ".list-tile-action"]) {
      const declarations = ruleOf(selector);
      expect(declarations, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      for (const [, value] of declarations.matchAll(/(?:^|;)\s*(?:color|background|border(?:-[a-z-]+)?)\s*:\s*([^;]+)/g)) {
        if (/^(transparent|none|0)$/.test(value.trim())) continue;
        expect(value, selector).toMatch(/var\(--/);
      }
    }
    // Round buttons the height of every other control, outlined like secondary controls.
    expect(ruleOf(".stepper-btn")).toMatch(/width: var\(--control-height\);\s*height: var\(--control-height\);/);
    expect(ruleOf(".stepper-btn")).toMatch(/border-radius: var\(--radius-pill\)/);
    expect(ruleOf(".stepper-btn")).toMatch(/border: var\(--border-width\) solid var\(--control-border\)/);
  });
});

describe("styled History", () => {
  const TOKEN_ONLY = [
    ".page-context",
    ".board-row-left",
    ".yes-count",
    ".yes-count-name",
    ".yes-count-of",
    ".yes-count-bar",
    ".yes-count-fill",
    ".past-night",
    ".past-night-count",
    ".past-night-pill",
    '.past-night-pill[data-state="on"]',
    '.past-night-pill[data-state="off"]',
    '.past-night-pill[data-state="never"]',
    '.past-night-pill[data-state="nobody"]',
  ];

  it("draws the bar list, the tiles and the pills from tokens only", () => {
    for (const selector of TOKEN_ONLY) {
      const declarations = ruleOf(selector);
      expect(declarations, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      for (const [, value] of declarations.matchAll(/(?:^|;)\s*(?:color|background|fill|border(?:-[a-z-]+)?)\s*:\s*([^;]+)/g)) {
        if (/^(transparent|none|0|solid|dashed)$/.test(value.trim())) continue;
        expect(value, selector).toMatch(/var\(--/);
      }
    }
  });

  it("fills Game On and Game Off pills, outlines Never on and dashes Nobody answered, as issue 42 sets out", () => {
    expect(ruleOf('.past-night-pill[data-state="on"]')).toMatch(/background: var\(--yes\);\s*color: var\(--on-fill\);/);
    expect(ruleOf('.past-night-pill[data-state="off"]')).toMatch(/background: var\(--no\);\s*color: var\(--on-fill\);/);
    expect(ruleOf('.past-night-pill[data-state="never"]')).toMatch(/border-color: var\(--control-border\)/);
    expect(ruleOf('.past-night-pill[data-state="nobody"]')).toMatch(/border-style: dashed;\s*border-color: var\(--no-answer\);/);
  });

  it("lets long names and narrow screens wrap instead of scrolling sideways", () => {
    expect(ruleOf(".yes-count")).toMatch(/flex-wrap: wrap/);
    expect(ruleOf(".yes-count-name")).toMatch(/min-width: 0;[\s\S]*overflow-wrap: anywhere/);
    expect(ruleOf(".yes-count-bar")).toMatch(/flex: 1 0 100%/);
    expect(ruleOf(".past-night")).toMatch(/flex-wrap: wrap/);
    expect(ruleOf(".past-night")).toMatch(/min-height: var\(--past-night-height\)/);
    expect(ruleOf(".past-night-text")).toMatch(/min-width: 0/);
    for (const selector of [".yes-count", ".yes-count-number", ".past-night", ".past-night-pill"]) {
      expect(ruleOf(selector), selector).not.toMatch(/white-space: nowrap|overflow-x|width: \d+px/);
    }
  });

  it("uses no modifier classes on the History page", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: "correct horse battery", colour: "pink", canCreateGroups: true });
    await alice.post("/groups/new", { name: "Friday" });
    const group = await env.DB.prepare("SELECT id FROM groups").first<{ id: number }>();
    app.clock.set("2026-11-04T02:00:00Z");
    await app.runScheduled();
    const body = bodyOf(await (await alice.get(`/groups/${group!.id}/history`)).text());

    expect(body).not.toMatch(/\sstyle=/);
    expect(body).toContain('class="past-night"');
    for (const [, classes] of body.matchAll(/class="((?:yes-count|past-night|page-)[^"]*)"/g)) {
      expect(classes.split(" "), classes).toHaveLength(1);
    }
  });
});
