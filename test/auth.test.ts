import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { hashPassword } from "~/auth/crypto";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

/** Submits the create-login form on a fresh Setup Link and returns the response. */
async function submitSetup(form: Record<string, string>) {
  const app = startApp();
  const token = await app.issueSetupLink();
  const response = await app.device().post(`/setup/${token}`, form);
  return { app, response, html: response.status === 302 ? "" : await response.text() };
}

async function usernames(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT username FROM members ORDER BY id").all<{ username: string }>();
  return results.map((row) => row.username);
}

describe("migration 0002", () => {
  it("adds members, sessions and setup_links after 0001", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' AND name NOT LIKE 'd1_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual(["members", "scheduler_state", "sessions", "setup_links"]);
  });
});

describe("username rules", () => {
  it("refuses 2 characters and 33 code points", async () => {
    const short = await submitSetup({ username: "Al", password: PASSWORD, colour: "blue" });
    const long = await submitSetup({ username: "é".repeat(33), password: PASSWORD, colour: "blue" });

    expect(short.response.status).toBe(400);
    expect(short.html).toContain("Use 3 to 32 characters.");
    expect(long.response.status).toBe(400);
    expect(long.html).toContain("Use 3 to 32 characters.");
    expect(await usernames()).toEqual([]);
  });

  it("accepts 32 code points even when they take more UTF-16 units", async () => {
    const { response } = await submitSetup({ username: "🎮".repeat(32), password: PASSWORD, colour: "blue" });

    expect(response.status).toBe(302);
  });

  it("trims surrounding spaces and stores the name as typed", async () => {
    const { response } = await submitSetup({ username: "  Dark Knight  ", password: PASSWORD, colour: "blue" });

    expect(response.status).toBe(302);
    expect(await usernames()).toEqual(["Dark Knight"]);
  });

  it("refuses a zero-width space and a tab", async () => {
    const zeroWidth = await submitSetup({ username: "Ali​ce", password: PASSWORD, colour: "blue" });
    const tab = await submitSetup({ username: "Ali\tce", password: PASSWORD, colour: "blue" });

    expect(zeroWidth.response.status).toBe(400);
    expect(zeroWidth.html).toContain("invisible characters");
    expect(tab.response.status).toBe(400);
    expect(await usernames()).toEqual([]);
  });

  it("blocks Alice when alice exists, and keeps the link usable", async () => {
    const app = startApp();
    await app.createLogin({ username: "alice", password: PASSWORD });
    const token = await app.issueSetupLink("second");

    const taken = await app.device().post(`/setup/${token}`, { username: "Alice", password: PASSWORD, colour: "blue" });
    expect(taken.status).toBe(400);
    expect(await taken.text()).toContain("That username is taken.");

    const retry = await app.device().post(`/setup/${token}`, { username: "Bob", password: PASSWORD, colour: "blue" });
    expect(retry.status).toBe(302);
    expect(await usernames()).toEqual(["alice", "Bob"]);
  });
});

describe("password rules", () => {
  it("refuses 11 and 129 characters", async () => {
    const short = await submitSetup({ username: "Alice", password: "a".repeat(11), colour: "blue" });
    const long = await submitSetup({ username: "Alice", password: "a".repeat(129), colour: "blue" });

    expect(short.response.status).toBe(400);
    expect(short.html).toContain("Use 12 to 128 characters.");
    expect(long.response.status).toBe(400);
  });

  it("refuses the username in other casing", async () => {
    const { response, html } = await submitSetup({
      username: "Long Username",
      password: "LONG USERNAME",
      colour: "blue",
    });

    expect(response.status).toBe(400);
    expect(html).toContain("not your username");
  });

  it("accepts a 12-character phrase with spaces, untrimmed", async () => {
    const { app, response } = await submitSetup({ username: "Alice", password: " a b c d e f", colour: "blue" });
    expect(response.status).toBe(302);

    const trimmed = await app.device().post("/login", { username: "Alice", password: "a b c d e f" });
    const exact = await app.device().post("/login", { username: "Alice", password: " a b c d e f" });
    expect(trimmed.status).toBe(401);
    expect(exact.status).toBe(302);
  });

  it("never echoes the password back on an error", async () => {
    const { html } = await submitSetup({ username: "Al", password: "secret phrase here", colour: "blue" });

    expect(html).not.toContain("secret phrase here");
  });
});

describe("avatar colour", () => {
  it("must be one of the 8 palette colours", async () => {
    const none = await submitSetup({ username: "Alice", password: PASSWORD });
    const green = await submitSetup({ username: "Alice", password: PASSWORD, colour: "green" });

    expect(none.response.status).toBe(400);
    expect(none.html).toContain("Choose a colour.");
    expect(green.response.status).toBe(400);
    expect(await usernames()).toEqual([]);
  });
});

describe("stored secrets", () => {
  it("keeps only 64-character hex hashes of session and Setup Link tokens", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    const browser = app.device();
    await browser.post(`/setup/${token}`, { username: "Alice", password: PASSWORD, colour: "blue" });
    const sessionToken = browser.cookies.get("__Host-session");
    expect(sessionToken).toBeTruthy();

    const { results: sessions } = await env.DB.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    const { results: links } = await env.DB.prepare("SELECT token_hash FROM setup_links").all<{ token_hash: string }>();
    for (const { token_hash } of [...sessions, ...links]) expect(token_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM sessions, setup_links, members").all()).results,
    );
    expect(dump).not.toContain(sessionToken);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(PASSWORD);
  });

  it("stores the password as PBKDF2 hash, salt and the iteration count it used", async () => {
    const app = startApp();
    await app.createLogin({ username: "Alice", password: PASSWORD });
    await app.createLogin({ username: "Bob", password: PASSWORD });

    const { results } = await env.DB.prepare(
      "SELECT password_hash, password_salt, password_iterations FROM members",
    ).all<{ password_hash: string; password_salt: string; password_iterations: number }>();
    for (const row of results) {
      expect(row.password_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.password_salt).toMatch(/^[0-9a-f]{32}$/);
      expect(row.password_iterations).toBe(Number(env.PBKDF2_ITERATIONS));
    }
    expect(results[0].password_salt).not.toBe(results[1].password_salt);
    expect(results[0].password_hash).not.toBe(results[1].password_hash);
  });

  it("logs in a Member whose hash used a different iteration count than the current one", async () => {
    const app = startApp();
    const current = Number(env.PBKDF2_ITERATIONS);
    expect(current).toBeLessThan(100_000); // the test binding, not the production var
    const older = await hashPassword(PASSWORD, current * 2);
    await env.DB.prepare(
      `INSERT INTO members (username, username_lower, colour, password_hash, password_salt, password_iterations, created_at)
       VALUES ('Old Timer', 'old timer', 'slate', ?1, ?2, ?3, '2026-01-01T00:00:00.000Z')`,
    )
      .bind(older.hash, older.salt, older.iterations)
      .run();

    const response = await app.device().post("/login", { username: "old timer", password: PASSWORD });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });
});
