import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createAuth } from "~/auth/auth";

import { startApp } from "./harness";

const SESSION_COOKIE = "__Host-session";
const alice = { username: "Alice", password: "correct horse battery" };
const NEW_PASSWORD = "a brand new passphrase";
const IP = "198.51.100.7";

/** Alice logged in on a phone and a laptop: two sessions of one Member. */
async function twoDevices() {
  const app = startApp();
  const phone = await app.createLogin(alice);
  const laptop = app.device();
  expect((await laptop.post("/login", alice)).status).toBe(302);
  return { app, phone, laptop };
}

function change(current: string, next: string) {
  return { currentPassword: current, newPassword: next };
}

/** The page's HTML without the <!-- --> markers React puts between adjacent text nodes. */
async function pageText(response: Response): Promise<string> {
  return (await response.text()).replaceAll("<!-- -->", "");
}

/** The <input> tag of the field with this name. */
function inputTag(html: string, name: string): string {
  return html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
}

async function storedHash(): Promise<string> {
  const row = await env.DB.prepare("SELECT password_hash FROM members").first<{ password_hash: string }>();
  return row?.password_hash ?? "";
}

describe("Password card", () => {
  it("sits before Sessions with the two password fields and no inline styles", async () => {
    const { phone } = await twoDevices();

    const html = await pageText(await phone.get("/profile"));

    expect(html.indexOf("Password</h2>")).toBeGreaterThan(-1);
    expect(html.indexOf("Password</h2>")).toBeLessThan(html.indexOf("Sessions</h2>"));
    expect(inputTag(html, "currentPassword")).toContain('autoComplete="current-password"');
    expect(inputTag(html, "newPassword")).toContain('autoComplete="new-password"');
    expect(html).toContain("Use 12 to 128 characters.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Change password<\/button>/);
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe("Changing the password", () => {
  it("stores the new password and logs out every other device, keeping this one", async () => {
    const { app, phone, laptop } = await twoDevices();

    const response = await phone.post("/profile", change(alice.password, NEW_PASSWORD));

    expect(response.status).toBe(200);
    const html = await pageText(response);
    expect(html).toContain("Password changed");
    expect(html).toContain("Your other devices are logged out.");
    expect(html).not.toContain(NEW_PASSWORD);
    expect((await phone.get("/profile")).status).toBe(200);
    expect((await laptop.get("/profile")).headers.get("Location")).toBe("/login");
    expect((await app.device().post("/login", alice)).status).toBe(401);
    expect((await app.device().post("/login", { username: "Alice", password: NEW_PASSWORD })).status).toBe(302);
  });

  it("refuses a wrong current password and counts it as a failed login", async () => {
    const { app, phone, laptop } = await twoDevices();
    const before = await storedHash();

    const response = await phone.post("/profile", change("not my password", NEW_PASSWORD));

    expect(response.status).toBe(400);
    const html = await pageText(response);
    expect(html).toContain("Error: That is not your current password.");
    expect(inputTag(html, "currentPassword")).toContain('aria-invalid="true"');
    expect(html).not.toContain("not my password");
    expect(html).not.toContain(NEW_PASSWORD);
    expect(await storedHash()).toBe(before);
    expect((await laptop.get("/profile")).status).toBe(200);

    // Four more wrong tries make five: the username is locked for login too.
    for (let i = 0; i < 4; i++) await phone.post("/profile", change("not my password", NEW_PASSWORD));
    expect((await app.device().post("/login", alice)).status).toBe(401);
  });

  it("refuses the correct current password while the username is locked", async () => {
    const { app, phone } = await twoDevices();
    for (let i = 0; i < 5; i++) await app.device().post("/login", { username: "alice", password: "wrong guess" });
    const before = await storedHash();

    const response = await phone.post("/profile", change(alice.password, NEW_PASSWORD));

    expect(response.status).toBe(429);
    const html = await pageText(response);
    expect(html).toContain("Error: Too many wrong passwords. Try again later.");
    expect(inputTag(html, "currentPassword")).toContain('aria-invalid="true"');
    expect(await storedHash()).toBe(before);
  });

  it("refuses a new password that breaks the rules and changes nothing", async () => {
    const { phone, laptop } = await twoDevices();
    const before = await storedHash();

    const short = await phone.post("/profile", change(alice.password, "eleven char"));

    expect(short.status).toBe(400);
    const shortHtml = await pageText(short);
    expect(shortHtml).toContain("Error: Use 12 to 128 characters.");
    expect(inputTag(shortHtml, "newPassword")).toContain('aria-invalid="true"');
    expect(await storedHash()).toBe(before);
    expect((await laptop.get("/profile")).status).toBe(200);
  });

  it("refuses a new password equal to the username ignoring case", async () => {
    const app = startApp();
    const phone = await app.createLogin({ username: "Long Username Here", password: alice.password });

    const response = await phone.post("/profile", change(alice.password, "LONG USERNAME HERE"));

    expect(response.status).toBe(400);
    expect(await pageText(response)).toContain("Error: Choose a password that is not your username.");
  });

  it("redirects a logged-out POST to /login and refuses a cross-origin one", async () => {
    const { app, phone } = await twoDevices();
    const before = await storedHash();

    const loggedOut = await app.device().post("/profile", change(alice.password, NEW_PASSWORD));
    const forged = await phone.post("/profile", change(alice.password, NEW_PASSWORD), {
      origin: "https://evil.example",
    });

    expect(loggedOut.status).toBe(302);
    expect(loggedOut.headers.get("Location")).toBe("/login");
    expect(forged.status).toBe(403);
    expect(await storedHash()).toBe(before);
  });
});

describe("changePassword", () => {
  async function setup() {
    const app = startApp();
    await app.createLogin(alice);
    const auth = createAuth({ env, clock: app.clock });
    const token = (await auth.logIn("Alice", alice.password, IP)) ?? "";
    const member = await auth.resolveSession(token);
    if (!member) throw new Error("no session");
    return { app, auth, token, member };
  }

  it("is refused while the IP is limited, recording nothing", async () => {
    const { auth, token, member } = await setup();
    for (let i = 0; i < 20; i++) await auth.logIn(`guess ${i}`, "x", IP);

    expect(await auth.changePassword(member, token, alice.password, NEW_PASSWORD, IP)).toEqual({
      ok: false,
      reason: "limited",
    });
    const { results } = await env.DB.prepare(
      "SELECT 1 FROM login_failures WHERE kind = 'username' AND key = 'alice'",
    ).all();
    expect(results).toEqual([]);
  });

  it("keeps the given session and ends the others", async () => {
    const { auth, token, member } = await setup();
    const other = (await auth.logIn("Alice", alice.password, IP)) ?? "";

    expect(await auth.changePassword(member, token, alice.password, NEW_PASSWORD, IP)).toEqual({ ok: true });

    expect(await auth.resolveSession(token)).toEqual(member);
    expect(await auth.resolveSession(other)).toBeNull();
  });
});

describe("endOtherSessions", () => {
  it("ends every session of the Member but the given one", async () => {
    const { phone, laptop } = await twoDevices();
    const auth = createAuth({ env, clock: startApp().clock });
    const token = phone.cookies.get(SESSION_COOKIE) ?? "";
    const member = await auth.resolveSession(token);

    await auth.endOtherSessions(member?.id ?? 0, token);

    expect((await phone.get("/profile")).status).toBe(200);
    expect((await laptop.get("/profile")).headers.get("Location")).toBe("/login");
  });
});
