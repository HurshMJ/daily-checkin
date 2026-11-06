import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { randomToken } from "~/auth/crypto";
import { isLinkPath } from "~/auth/request";
import { createInvites } from "~/invites";

import { createWorker } from "../workers/app";
import { APP_ORIGIN, fixedClock, recordingPushSender, startApp } from "./harness";

const PASSWORD = "correct horse battery";
const ATTRIBUTES = "Max-Age=3600; HttpOnly; Secure; SameSite=Lax; Path=/";

function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
}

/** Alice owns "Friday" and has made one Invite to it; `makeInvite` makes another. */
async function aliceInvite() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
  await alice.post("/groups/new", { name: "Friday" });
  const { id: aliceId } = (await env.DB.prepare("SELECT id FROM members WHERE username = 'Alice'").first<{ id: number }>())!;
  const { id: groupId } = (await env.DB.prepare("SELECT id FROM groups WHERE name = 'Friday'").first<{ id: number }>())!;
  async function makeInvite(): Promise<string> {
    const made = await createInvites({ env, clock: app.clock }).makeInvite(aliceId, groupId, "");
    if (!made.ok) throw new Error("make failed");
    return made.token;
  }
  return { app, alice, token: await makeInvite(), makeInvite };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opening a link moves its token into a cookie", () => {
  it.each([
    ["invite", "__Host-invite"],
    ["setup", "__Host-setup"],
    ["reset", "__Host-reset"],
  ])("GET /%s/<token> answers 303 to a URL with no token and sets %s", async (kind, cookie) => {
    const token = randomToken();
    const response = await startApp().fetch(`/${kind}/${token}`);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/${kind}`);
    expect(response.headers.getSetCookie()).toEqual([`${cookie}=${token}; ${ATTRIBUTES}`]);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["invite", "setup", "reset"])("sets no cookie for a token of the wrong shape on /%s", async (kind) => {
    const app = startApp();
    for (const bad of ["not-a-real-token", `${randomToken()}x`, `${randomToken().slice(1)}=`, "a".repeat(42)]) {
      const response = await app.fetch(`/${kind}/${encodeURIComponent(bad)}`);
      expect(response.status, bad).toBe(303);
      expect(response.headers.get("Location")).toBe(`/${kind}`);
      expect(response.headers.getSetCookie(), bad).toEqual([]);
    }
  });

  it.each(["invite", "setup", "reset"])("refuses any other method on /%s/<token> with 405", async (kind) => {
    const app = startApp();
    const browser = app.device();
    const response = await browser.post(`/${kind}/${randomToken()}`, { intent: "join" });
    expect(response.status).toBe(405);
    expect(browser.cookies.size).toBe(0);
  });

  it("reads no D1 and logs nothing on the link routes, even for a logged-in device", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const throwingDb = new Proxy({} as D1Database, {
      get() {
        throw new Error("the link route touched D1");
      },
    });
    const worker = createWorker({ clock: fixedClock("2026-11-03T12:00:00Z"), push: recordingPushSender() });

    const token = randomToken();
    const paths = [
      `/invite/${token}`,
      `/setup/${token}`,
      `/reset/${token}`,
      "/invite/not-a-real-token",
      // The router matches case-insensitively and on the decoded path.
      `/Invite/${token}`,
      `/SETUP/${token}`,
      `/Reset/${token}`,
      `/%69nvite/${token}`,
      `/invite/${token}/`,
      // Repeated trailing slashes and the single-fetch data suffixes.
      `/reset/${token}//`,
      `/reset/${token}/.data`,
      `/reset/${token}/_.data`,
      `/reset/${token}.data`,
      `/Invite/${token}.data`,
      `/invite/${token}///_.data`,
      `/setup/${token}.data`,
      `/SETUP/${token}/_.data`,
    ];
    for (const path of paths) {
      const ctx = createExecutionContext();
      const request = new Request(new URL(path, APP_ORIGIN), { headers: { Cookie: `__Host-session=${randomToken()}` } });
      const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, { ...env, DB: throwingDb }, ctx);
      await waitOnExecutionContext(ctx);
      // A single-fetch data request gets its redirect as a 202 data response.
      expect(response.status, path).toBe(path.endsWith(".data") ? 202 : 303);
      expect(response.headers.getSetCookie().some((c) => c.startsWith("__Host-session=")), path).toBe(false);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the session skip covers only the link routes", () => {
  const renewed = (response: Response) =>
    response.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-session="));

  it("matches the link routes as the router does and nothing else", () => {
    const token = randomToken();
    const matched = [
      `/invite/${token}`,
      `/Invite/${token}`,
      `/SETUP/${token}`,
      `/RESET/${token}`,
      `/%69nvite/${token}`,
      `/invite/${token}/`,
      "/invite/a%2Fb",
      // Any number of trailing slashes, and the single-fetch suffixes the router strips.
      `/reset/${token}//`,
      `/reset/${token}///`,
      `/reset/${token}/.data`,
      `/reset/${token}/_.data`,
      `/reset/${token}.data`,
      `/Invite/${token}.data`,
      `/invite/${token}//_.data`,
      `/setup/${token}.data`,
      `/setup/${token}/_.data`,
    ];
    for (const path of matched) {
      expect(isLinkPath(path), path).toBe(true);
    }
    const unmatched = [
      "/invites",
      "/invite",
      "/invite/",
      "/reset",
      "/resets/a",
      "/profile",
      "/profile.data",
      "/invite/a/b",
      "/invitex/a",
      "/resetx/a",
      `/resetx/${token}`,
      "/x/invite/a",
      "/%E0%A4%A/x",
      "/invite/%E0%A4%A",
      // A suffix alone is no token: the router sends these to the page routes.
      "/reset/.data",
      "/reset/_.data",
      "/invite//_.data",
      "/reset/a/b.data",
      "/reset/a/b/_.data",
      "/invite.data",
      "/_root.data",
    ];
    for (const path of unmatched) {
      expect(isLinkPath(path), path).toBe(false);
    }
  });

  it("still resolves and renews the session on /invite and /profile", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    for (const path of ["/invite", "/profile"]) {
      expect(renewed(await alice.get(path)), path).toBe(true);
    }
  });

  it("treats a malformed escape as no match and does not throw", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const response = await alice.get("/invite/%E0%A4%A");
    expect(response.status).toBe(303);
    expect(renewed(response)).toBe(true);
  });
});

describe("the link pages read the token from the cookie", () => {
  it("shows the Invite with the cookie and the 404 notice without it", async () => {
    const { app, token } = await aliceInvite();
    const withCookie = await app.deviceWithLink(`/invite/${token}`);
    const page = await withCookie.get("/invite");
    expect(page.status).toBe(200);
    expect(bodyOf(await page.text())).toContain("Alice invited you to</p><h1>Friday</h1>");

    const without = await app.device().get("/invite");
    expect(without.status).toBe(404);
    expect(bodyOf(await without.text())).toContain("This Invite has been used or cancelled.");
  });

  it("shows the Setup Link form with the cookie and the 404 notice without it", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    expect((await (await app.deviceWithLink(`/setup/${token}`)).get("/setup")).status).toBe(200);
    const without = await app.device().get("/setup");
    expect(without.status).toBe(404);
    expect(await without.text()).toContain("Ask the Operator for a new one.");
  });

  it("puts the token in no page, link, form or Location after the first request", async () => {
    const { app, token } = await aliceInvite();
    const bob = app.device();
    const responses = [await bob.get(`/invite/${token}`)];
    responses.push(await bob.get("/invite"), await bob.get("/invite?mode=create"));
    responses.push(await bob.post("/invite", { intent: "create", username: "Bob", password: "short", colour: "sky" }));
    responses.push(await bob.post("/invite", { intent: "create", username: "Bob", password: PASSWORD, colour: "sky" }));

    expect(responses.map((r) => r.status)).toEqual([303, 200, 200, 400, 302]);
    for (const response of responses.slice(1)) {
      expect(response.headers.get("Location") ?? "").not.toContain(token);
      expect(await response.text()).not.toContain(token);
    }

    const setupToken = await app.issueSetupLink("carol");
    const carol = app.device();
    const setupResponses = [await carol.get(`/setup/${setupToken}`), await carol.get("/setup")];
    setupResponses.push(await carol.post("/setup", { username: "Carol", password: PASSWORD, colour: "sky" }));
    expect(setupResponses.map((r) => r.status)).toEqual([303, 200, 302]);
    for (const response of setupResponses.slice(1)) {
      expect(response.headers.get("Location") ?? "").not.toContain(setupToken);
      expect(await response.text()).not.toContain(setupToken);
    }
  });
});

describe("a used link clears its cookie", () => {
  const cleared = (name: string) => `${name}=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`;

  it("clears the Setup cookie once the login is created", async () => {
    const app = startApp();
    const browser = await app.deviceWithLink(`/setup/${await app.issueSetupLink()}`);
    const response = await browser.post("/setup", { username: "Alice", password: PASSWORD, colour: "sky" });
    expect(response.status).toBe(302);
    expect(response.headers.getSetCookie()).toContain(cleared("__Host-setup"));
    expect(browser.cookies.has("__Host-setup")).toBe(false);
    expect(browser.cookies.has("__Host-session")).toBe(true);
  });

  it("clears the Invite cookie once a login is created, a Member joins, or a Member logs in and joins", async () => {
    const { app, token, makeInvite } = await aliceInvite();
    const bob = await app.deviceWithLink(`/invite/${token}`);
    const created = await bob.post("/invite", { intent: "create", username: "Bob", password: PASSWORD, colour: "sky" });
    expect(created.headers.getSetCookie()).toContain(cleared("__Host-invite"));
    expect(bob.cookies.has("__Host-invite")).toBe(false);

    const carol = await app.createLogin({ username: "Carol", password: PASSWORD });
    await carol.get(`/invite/${await makeInvite()}`);
    const joined = await carol.post("/invite", { intent: "join" });
    expect(joined.headers.get("Location")).toBe("/");
    expect(joined.headers.getSetCookie()).toContain(cleared("__Host-invite"));
    // The session is renewed alongside, as on any logged-in request.
    expect(joined.headers.getSetCookie().some((c) => c.startsWith("__Host-session="))).toBe(true);

    const dave = await app.createLogin({ username: "Dave", password: PASSWORD });
    await dave.post("/logout", {});
    await dave.get(`/invite/${await makeInvite()}`);
    const loggedIn = await dave.post("/invite", { intent: "login", username: "Dave", password: PASSWORD });
    expect(loggedIn.headers.get("Location")).toBe("/");
    expect(loggedIn.headers.getSetCookie()).toContain(cleared("__Host-invite"));
    expect(dave.cookies.has("__Host-invite")).toBe(false);
  });

  it("keeps the Invite cookie when the login lands on an unusable Invite", async () => {
    const { app, token } = await aliceInvite();
    const dave = await app.createLogin({ username: "Dave", password: PASSWORD });
    await dave.post("/logout", {});
    await env.DB.prepare("UPDATE invites SET cancelled_at = '2026-11-03T12:00:00.000Z'").run();
    await dave.get(`/invite/${token}`);
    const response = await dave.post("/invite", { intent: "login", username: "Dave", password: PASSWORD });
    expect(response.headers.get("Location")).toBe("/invite");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("__Host-invite="))).toBe(false);
  });
});
