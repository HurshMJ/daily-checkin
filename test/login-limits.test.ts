import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "~/auth/auth";

import { startApp } from "./harness";

const START = "2026-11-03T12:00:00.000Z";
const IP = "198.51.100.7";
const OTHER_IP = "203.0.113.9";
const alice = { username: "Alice", password: "correct horse battery" };
const WRONG = "not the password at all";

/** The instant `minutes` (and `seconds`) after START, as the clock takes it. */
function at(minutes: number, seconds = 0): string {
  return new Date(new Date(START).getTime() + (minutes * 60 + seconds) * 1000).toISOString();
}

/** A clock, Alice's login, and the Auth module on the same D1 and clock. */
async function setup() {
  const app = startApp({ now: START });
  await app.createLogin(alice);
  const auth = createAuth({ env, clock: app.clock });
  return { clock: app.clock, auth };
}

async function failureRows(kind: "username" | "ip", key: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT failed_at FROM login_failures WHERE kind = ?1 AND key = ?2 ORDER BY failed_at",
  )
    .bind(kind, key)
    .all<{ failed_at: string }>();
  return results.map((row) => row.failed_at);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migration 0004", () => {
  it("adds login_failures and accepts only the two kinds", async () => {
    await env.DB.prepare("INSERT INTO login_failures (kind, key, failed_at) VALUES ('ip', 'x', ?1)")
      .bind(START)
      .run();

    await expect(
      env.DB.prepare("INSERT INTO login_failures (kind, key, failed_at) VALUES ('other', 'x', ?1)").bind(START).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("username lock", () => {
  it("locks a username for 15 minutes from the 5th failure in 15 minutes, refusing the correct password", async () => {
    const { clock, auth } = await setup();
    for (const minute of [0, 1, 2, 3, 4]) {
      clock.set(at(minute));
      expect(await auth.logIn("Alice", WRONG, IP)).toBeNull();
    }

    clock.set(at(4, 1));
    expect(await auth.logIn("alice", alice.password, IP)).toBeNull();
    clock.set(at(18, 59));
    expect(await auth.logIn("Alice", alice.password, OTHER_IP)).toBeNull();
    clock.set(at(19));
    expect(await auth.logIn("Alice", alice.password, IP)).toEqual(expect.any(String));
  });

  it("never locks on failures more than 15 minutes apart", async () => {
    const { clock, auth } = await setup();
    for (let i = 0; i < 4; i++) expect(await auth.logIn("Alice", WRONG, IP)).toBeNull();

    clock.set(at(15));
    expect(await auth.logIn("Alice", WRONG, IP)).toBeNull();

    expect(await auth.logIn("Alice", alice.password, IP)).toEqual(expect.any(String));
  });

  it("is not extended by attempts during the lock, which record an IP failure only", async () => {
    const { clock, auth } = await setup();
    for (const minute of [0, 1, 2, 3, 4]) {
      clock.set(at(minute));
      await auth.logIn("Alice", WRONG, IP);
    }

    for (const minute of [10, 18]) {
      clock.set(at(minute));
      expect(await auth.logIn("Alice", WRONG, IP)).toBeNull();
      expect(await auth.logIn("Alice", alice.password, IP)).toBeNull();
    }
    expect(await failureRows("username", "alice")).toHaveLength(5);
    expect(await failureRows("ip", IP)).toHaveLength(9);

    clock.set(at(19));
    expect(await auth.logIn("Alice", alice.password, IP)).toEqual(expect.any(String));
  });

  it("counts an unknown username like a known one, under its lower-case key", async () => {
    const { auth } = await setup();
    for (let i = 0; i < 6; i++) expect(await auth.logIn(" Nobody ", WRONG, IP)).toBeNull();

    // The 6th attempt hit the lock: an IP failure, no username failure.
    expect(await failureRows("username", "nobody")).toHaveLength(5);
    expect(await failureRows("ip", IP)).toHaveLength(6);
  });

  it("counts a password over 128 code points as a failure", async () => {
    const { auth } = await setup();
    for (let i = 0; i < 5; i++) expect(await auth.logIn("Alice", "a".repeat(129), IP)).toBeNull();

    expect(await auth.logIn("Alice", alice.password, IP)).toBeNull();
  });

  it("is cleared by a successful login, while the IP's failures stay", async () => {
    const { auth } = await setup();
    for (let i = 0; i < 4; i++) await auth.logIn("Alice", WRONG, IP);

    expect(await auth.logIn("Alice", alice.password, IP)).toEqual(expect.any(String));

    expect(await failureRows("username", "alice")).toEqual([]);
    expect(await failureRows("ip", IP)).toHaveLength(4);
    // The cleared count starts again: four more failures do not lock.
    for (let i = 0; i < 4; i++) await auth.logIn("Alice", WRONG, IP);
    expect(await auth.logIn("Alice", alice.password, IP)).toEqual(expect.any(String));
  });
});

describe("IP limit", () => {
  it("refuses the 21st attempt in an hour, correct password included, until the oldest failure is an hour old", async () => {
    const { clock, auth } = await setup();
    for (let i = 0; i < 20; i++) {
      clock.set(at(i));
      expect(await auth.logIn(`guess ${i}`, WRONG, IP)).toBeNull();
    }

    clock.set(at(20));
    expect(await auth.logIn("Alice", alice.password, IP)).toBeNull();
    clock.set(at(59, 59));
    expect(await auth.logIn("Alice", alice.password, IP)).toBeNull();
    // Refused attempts recorded nothing.
    expect(await failureRows("ip", IP)).toHaveLength(20);
    expect(await failureRows("username", "alice")).toEqual([]);
    // Another IP is limited on its own count.
    expect(await auth.logIn("Alice", alice.password, OTHER_IP)).toEqual(expect.any(String));

    clock.set(at(60));
    expect(await auth.logIn("Alice", alice.password, IP)).toEqual(expect.any(String));
  });
});

describe("failure rows", () => {
  it("are pruned once they are an hour old, when a failure is recorded", async () => {
    const { clock, auth } = await setup();
    await auth.logIn("Alice", WRONG, IP);
    clock.set(at(30));
    await auth.logIn("Alice", WRONG, OTHER_IP);

    clock.set(at(60));
    await auth.logIn("Bob", WRONG, OTHER_IP);

    expect(await failureRows("username", "alice")).toEqual([at(30)]);
    expect(await failureRows("ip", IP)).toEqual([]);
    expect(await failureRows("ip", OTHER_IP)).toEqual([at(30), at(60)]);
  });
});

describe("PBKDF2 work", () => {
  it("runs for an unknown username, but not for a locked username, a limited IP or an over-long password", async () => {
    const { auth } = await setup();
    for (let i = 0; i < 5; i++) await auth.logIn("Alice", WRONG, IP);
    for (let i = 0; i < 15; i++) await auth.logIn(`guess ${i}`, WRONG, IP);
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");

    await auth.logIn("Nobody", WRONG, OTHER_IP);
    expect(deriveBits).toHaveBeenCalledTimes(1);

    deriveBits.mockClear();
    await auth.logIn("Alice", alice.password, OTHER_IP);
    await auth.logIn("Carol", alice.password, IP);
    await auth.logIn("Dave", "a".repeat(129), OTHER_IP);
    expect(deriveBits).not.toHaveBeenCalled();
  });
});
