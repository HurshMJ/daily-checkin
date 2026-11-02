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
