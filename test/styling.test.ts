import { describe, expect, it } from "vitest";

import { startApp } from "./harness";

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
    const response = await app.fetch(`/setup/${token}`);
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
    const response = await startApp().fetch("/setup/not-a-real-token");
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain("This Setup Link does not work.");
  });
});

describe("styled Tonight and profile", () => {
  async function newMember() {
    const app = startApp();
    const browser = await app.createLogin({ username: "Alice", password: "correct horse battery", colour: "pink" });
    return browser;
  }

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
    expect(body).toMatch(/<button[^>]*type="button"[^>]*>Create a Group<\/button>/);

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
    expect(linksTo(body, "/")).toEqual(["‹ Tonight"]);
    expect(linksTo(body, "/profile")).toEqual([]);
  });
});
