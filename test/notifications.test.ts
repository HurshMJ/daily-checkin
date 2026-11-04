import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInvites } from "~/invites";
import { createPush } from "~/push";
import { claimNight, encodePayload, MAX_PAYLOAD_BYTES, type Payload } from "~/notifications";

import { pushEndpoint, startApp } from "./harness";

const PASSWORD = "correct horse battery";
const NAMES = ["Alice", "Bob", "Carol", "Dave"] as const;
type Name = (typeof NAMES)[number];

/** The Reset that ends the Game Night of 3 November (06:00 UTC+4 on 4 November). */
const RESET_4_NOV = "2026-11-04T02:00:00Z";

afterEach(() => {
  vi.restoreAllMocks();
});

async function idOf(table: "members" | "groups", column: "username" | "name", value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${column} = ?1`).bind(value).first<{ id: number }>();
  return row!.id;
}

/** Each Member's phone endpoint: their name in lower case, so a push reads back as who got it. */
const endpointOf = (name: string) => pushEndpoint(name.toLowerCase());

/**
 * Alice, Bob, Carol and Dave each log in and turn push on. Alice owns
 * "Friday" (threshold 3) with Bob and Carol in it; Dave is in no Group.
 */
async function setUp(options: Parameters<typeof startApp>[0] = {}) {
  const app = startApp(options);
  const devices = {} as Record<Name, Awaited<ReturnType<typeof app.createLogin>>>;
  for (const name of NAMES) devices[name] = await app.createLogin({ username: name, password: PASSWORD });
  await devices.Alice.post("/groups/new", { name: "Friday" });
  const friday = await idOf("groups", "name", "Friday");
  for (const name of ["Bob", "Carol"] as const) await addMember(app, friday, name);
  for (const name of NAMES) await devices[name].subscribe(endpointOf(name));
  return { app, ...devices, friday };
}

/** Puts a Member in a Group with an Invite, without the route, so it sends nothing. */
async function addMember(app: ReturnType<typeof startApp>, groupId: number, name: string) {
  const invites = createInvites({ env, clock: app.clock });
  const owner = await env.DB.prepare("SELECT owner_id FROM groups WHERE id = ?1").bind(groupId).first<{ owner_id: number }>();
  const made = await invites.makeInvite(owner!.owner_id, groupId, "");
  if (!made.ok) throw new Error("make failed");
  if ((await invites.joinWithInvite(await idOf("members", "username", name), made.token)) !== "joined") {
    throw new Error("join failed");
  }
}

/** An Invite token for the Group, made by its Owner. */
async function inviteTo(app: ReturnType<typeof startApp>, groupId: number): Promise<string> {
  const owner = await env.DB.prepare("SELECT owner_id FROM groups WHERE id = ?1").bind(groupId).first<{ owner_id: number }>();
  const made = await createInvites({ env, clock: app.clock }).makeInvite(owner!.owner_id, groupId, "");
  if (!made.ok) throw new Error("make failed");
  return made.token;
}

/**
 * The pushes sent since the last call, as "recipient: title", sorted, and
 * forgets them. Every payload is checked to be JSON under the size limit.
 */
function take(app: ReturnType<typeof startApp>): string[] {
  const lines = app.push.sent.map(({ subscription, payload }) => {
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const { title } = JSON.parse(payload) as { title: string };
    return `${subscription.endpoint.split("/").pop()}: ${title}`;
  });
  app.push.sent.length = 0;
  return lines.sort();
}

type Device = Awaited<ReturnType<typeof setUp>>["Alice"];

async function answer(device: Device, availability: "yes" | "maybe" | "no") {
  const response = await device.post("/?index", { intent: "availability", availability });
  expect(response.status).toBe(303);
}

describe("someone said Yes", () => {
  it("goes once to the other Members of all the Member's Groups, never to the Member", async () => {
    const { app, Alice, friday } = await setUp();
    // Saturday: Alice and Bob again, plus Dave.
    await Alice.post("/groups/new", { name: "Saturday" });
    const saturday = await idOf("groups", "name", "Saturday");
    await addMember(app, saturday, "Bob");
    await addMember(app, saturday, "Dave");
    expect(friday).not.toBe(saturday);
    take(app);

    await answer(Alice, "yes");
    expect(take(app)).toEqual(["bob: Alice said Yes", "carol: Alice said Yes", "dave: Alice said Yes"]);
  });

  it("carries the payload the service worker shows", async () => {
    const { app, Alice } = await setUp();
    await answer(Alice, "yes");
    const payload = JSON.parse(app.push.sent[0].payload);
    expect(payload).toEqual({
      title: "Alice said Yes",
      body: "They are in for tonight. Open Tonight to see your Boards.",
      url: "/",
      tag: `said-yes-${await idOf("members", "username", "Alice")}-2026-11-03`,
    });
  });

  it("names the Member by their Display Name when they have one", async () => {
    const { app, Alice } = await setUp();
    await Alice.post("/profile", { intent: "names", username: "Alice", displayName: "Ace 🎯", colour: "blue" });

    await answer(Alice, "yes");

    expect(take(app)).toEqual(["bob: Ace 🎯 said Yes", "carol: Ace 🎯 said Yes"]);
  });

  it("is sent at most once per Member per Game Night, however the answer flips", async () => {
    const { app, Alice } = await setUp();
    await answer(Alice, "maybe");
    expect(take(app)).toEqual([]);
    await answer(Alice, "yes");
    expect(take(app)).toEqual(["bob: Alice said Yes", "carol: Alice said Yes"]);
    await answer(Alice, "no");
    await answer(Alice, "yes");
    await answer(Alice, "yes");
    expect(take(app)).toEqual([]);
  });

  it("is not sent for a Note-only edit", async () => {
    const { app, Alice } = await setUp();
    await answer(Alice, "maybe");
    expect((await Alice.post("/?index", { intent: "note", note: "on after 10" })).status).toBe(303);
    expect(take(app)).toEqual([]);
  });

  it("is not sent when a Member with a Yes joins a Group", async () => {
    const { app, Dave, friday } = await setUp();
    await answer(Dave, "yes");
    const token = await inviteTo(app, friday);
    await Dave.get(`/invite/${token}`);
    expect((await Dave.post("/invite", { intent: "join" })).status).toBe(302);
    expect(take(app)).toEqual([]);
  });
});

describe("Game On and Game Off from Check-ins", () => {
  it("sends both someone said Yes and Game On for the Yes that reaches the threshold, never to its Member", async () => {
    const { app, Alice, Bob, Carol, friday } = await setUp();
    await addMember(app, friday, "Dave");
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    take(app);

    await answer(Carol, "yes");
    expect(take(app)).toEqual([
      "alice: Carol said Yes",
      "alice: Game On: Friday",
      "bob: Carol said Yes",
      "bob: Game On: Friday",
      "dave: Carol said Yes",
      "dave: Game On: Friday",
    ]);
  });

  it("carries the Group's page and the Yes count in the Game On and Game Off payloads", async () => {
    const { app, Alice, Bob, Carol, friday } = await setUp();
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    take(app);
    await answer(Carol, "yes");
    const gameOn = app.push.sent.map(({ payload }) => JSON.parse(payload)).find(({ title }) => title.startsWith("Game On"));
    expect(gameOn).toEqual({
      title: "Game On: Friday",
      body: "3 said Yes, enough for tonight's game.",
      url: `/groups/${friday}`,
      tag: `game-on-${friday}-2026-11-03`,
    });
    take(app);

    await answer(Bob, "no");
    expect(JSON.parse(app.push.sent[0].payload)).toEqual({
      title: "Game Off: Friday",
      body: "Now 2 said Yes, fewer than the 3 needed.",
      url: `/groups/${friday}`,
      tag: `game-off-${friday}-2026-11-03`,
    });
  });

  it("sends Game Off only to the Members at Yes now, and each crossing only once per night", async () => {
    const { app, Alice, Bob, Carol, friday } = await setUp();
    await addMember(app, friday, "Dave");
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    await answer(Carol, "yes");
    take(app);

    // Dave never answered and Carol is the actor: neither gets Game Off.
    await answer(Carol, "maybe");
    expect(take(app)).toEqual(["alice: Game Off: Friday", "bob: Game Off: Friday"]);

    // Back on and off again: the Board flips, the pushes do not.
    await answer(Carol, "yes");
    await answer(Carol, "no");
    await answer(Carol, "yes");
    expect(take(app)).toEqual([]);
  });
});

describe("Game On and Game Off from threshold and membership changes", () => {
  it("sends Game On when the Owner lowers the threshold to the Yes count, and Game Off when they raise it", async () => {
    const { app, Alice, Bob, Carol, friday } = await setUp();
    await answer(Bob, "yes");
    await answer(Carol, "yes");
    take(app);

    expect((await Alice.post(`/groups/${friday}`, { intent: "threshold", threshold: "2" })).status).toBe(303);
    expect(take(app)).toEqual(["bob: Game On: Friday", "carol: Game On: Friday"]);

    expect((await Alice.post(`/groups/${friday}`, { intent: "threshold", threshold: "3" })).status).toBe(303);
    expect(take(app)).toEqual(["bob: Game Off: Friday", "carol: Game Off: Friday"]);

    expect((await Alice.post(`/groups/${friday}`, { intent: "threshold", threshold: "1" })).status).toBe(303);
    expect(take(app)).toEqual([]);
  });

  it("sends Game On to the others when a Member with a Yes joins and tips the Group", async () => {
    const { app, Alice, Bob, Dave, friday } = await setUp();
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    await answer(Dave, "yes");
    take(app);

    const token = await inviteTo(app, friday);
    await Dave.get(`/invite/${token}`);
    expect((await Dave.post("/invite", { intent: "join" })).status).toBe(302);
    expect(take(app)).toEqual(["alice: Game On: Friday", "bob: Game On: Friday", "carol: Game On: Friday"]);
  });

  it("sends Game Off to those still at Yes when a Member leaves and drops the Group below", async () => {
    const { app, Alice, Bob, Carol, friday } = await setUp();
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    await answer(Carol, "yes");
    take(app);

    expect((await Carol.post("/profile", { intent: "leave", groupId: String(friday), confirm: "yes" })).status).toBe(303);
    expect(take(app)).toEqual(["alice: Game Off: Friday", "bob: Game Off: Friday"]);
  });

  it("sends Game Off to those still at Yes, but not the Owner, when the Owner removes a Member", async () => {
    const { app, Alice, Bob, Carol, friday } = await setUp();
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    await answer(Carol, "yes");
    take(app);

    const carolId = await idOf("members", "username", "Carol");
    const response = await Alice.post(`/groups/${friday}`, { intent: "remove", memberId: String(carolId), confirm: "yes" });
    expect(response.status).toBe(303);
    expect(take(app)).toEqual(["bob: Game Off: Friday"]);
  });

  it("sends nothing when the Owner deletes the Group by leaving it last", async () => {
    const { app, Alice, Bob, Carol, friday } = await setUp();
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    await answer(Carol, "yes");
    for (const device of [Bob, Carol]) {
      await device.post("/profile", { intent: "leave", groupId: String(friday), confirm: "yes" });
    }
    take(app);
    expect((await Alice.post("/profile", { intent: "leave", groupId: String(friday), confirm: "yes" })).status).toBe(303);
    expect(take(app)).toEqual([]);
  });
});

describe("notification toggles and devices", () => {
  it("never sends a type to a Member who turned it off on the profile, and still sends it to the others", async () => {
    const { app, Alice, Bob, Carol } = await setUp();
    // Bob leaves only Game Off checked.
    expect((await Bob.post("/profile", { intent: "notifications", game_off: "on" })).status).toBe(200);
    await answer(Alice, "yes");
    await answer(Carol, "yes");
    take(app);
    await answer(Bob, "yes");
    expect(take(app)).toEqual(["alice: Bob said Yes", "alice: Game On: Friday", "carol: Bob said Yes", "carol: Game On: Friday"]);

    await answer(Alice, "yes");
    await answer(Carol, "no");
    expect(take(app)).toEqual(["alice: Game Off: Friday", "bob: Game Off: Friday"]);
  });

  it("sends one push to each device of a recipient, and none to a device that logged out", async () => {
    const { app, Alice, Bob } = await setUp();
    const laptop = app.device();
    await laptop.post("/login", { username: "Bob", password: PASSWORD });
    await laptop.subscribe(pushEndpoint("bob-laptop"));
    await answer(Alice, "yes");
    expect(take(app)).toEqual(["bob-laptop: Alice said Yes", "bob: Alice said Yes", "carol: Alice said Yes"]);

    // Bob logs his phone out; a new night lets Alice's Yes send again.
    await Bob.post("/logout", {});
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    await answer(Alice, "yes");
    expect(take(app)).toEqual(["bob-laptop: Alice said Yes", "carol: Alice said Yes"]);
  });

  it("deletes a subscription the push service answers 404 or 410 for", async () => {
    const { app, Alice, Bob } = await setUp({
      pushStatuses: { [endpointOf("Bob")]: 410, [endpointOf("Carol")]: 404 },
    });
    await answer(Alice, "yes");
    expect(take(app)).toEqual(["bob: Alice said Yes", "carol: Alice said Yes"]);

    await answer(Bob, "yes");
    expect(take(app)).toEqual(["alice: Bob said Yes"]);
  });

  it("keeps a subscription after a 500 or a failed send, never fails the request, and logs no endpoint", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, Alice, Bob } = await setUp({
      pushStatuses: {
        [endpointOf("Bob")]: 500,
        [endpointOf("Carol")]: new TypeError(`Fetch API cannot load: ${endpointOf("Carol")}`),
      },
    });
    await answer(Alice, "yes");
    expect(take(app)).toEqual(["bob: Alice said Yes", "carol: Alice said Yes"]);
    expect(errors).toHaveBeenCalledWith("Push said_yes: 2 of 2 not sent (status 500, TypeError)");

    await answer(Bob, "yes");
    expect(take(app)).toEqual(["alice: Bob said Yes", "carol: Bob said Yes"]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("fcm.googleapis.com");
  });
});

describe("a new Game Night", () => {
  it("sends afresh after the Reset", async () => {
    const { app, Alice, Bob, Carol } = await setUp();
    for (const device of [Alice, Bob, Carol]) await answer(device, "yes");
    take(app);

    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    await answer(Alice, "yes");
    await answer(Bob, "yes");
    expect(take(app)).toEqual(["alice: Bob said Yes", "bob: Alice said Yes", "carol: Alice said Yes", "carol: Bob said Yes"]);
    await answer(Carol, "yes");
    expect(take(app)).toEqual([
      "alice: Carol said Yes",
      "alice: Game On: Friday",
      "bob: Carol said Yes",
      "bob: Game On: Friday",
    ]);
  });
});

describe("payloads", () => {
  it("stay within the limit with the longest names", async () => {
    const app = startApp();
    const owner = await app.createLogin({ username: "Ł".repeat(32), password: PASSWORD });
    const other = await app.createLogin({ username: "Bob", password: PASSWORD });
    await owner.post("/groups/new", { name: "🎲".repeat(40) });
    await addMember(app, await idOf("groups", "name", "🎲".repeat(40)), "Bob");
    await other.subscribe(endpointOf("Bob"));
    await owner.post("/groups/" + (await idOf("groups", "name", "🎲".repeat(40))), { intent: "threshold", threshold: "1" });
    take(app);
    await answer(owner, "yes");
    expect(take(app)).toEqual([`bob: Game On: ${"🎲".repeat(40)}`, `bob: ${"Ł".repeat(32)} said Yes`]);
  });

  it("allow 3993 bytes of plaintext, the most RFC 8291 fits in a 4096-byte record, and refuse 3994", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(3993);
    /** A payload whose JSON is exactly `bytes` long. */
    const sized = (bytes: number) => {
      const empty = JSON.stringify({ title: "", body: "", url: "/", tag: "t" }).length;
      return { title: "x".repeat(bytes - empty), body: "", url: "/", tag: "t" };
    };
    expect(new TextEncoder().encode(encodePayload(sized(3993))).length).toBe(3993);
    expect(() => encodePayload(sized(3994))).toThrow("Push payload too large");
  });

  it("count UTF-8 bytes, not characters", () => {
    // 1331 three-byte characters are 3993 bytes on their own, so the JSON around them passes the limit.
    expect(() => encodePayload({ title: "€".repeat(1331), body: "", url: "/", tag: "t" })).toThrow(
      "Push payload too large",
    );
  });
});

describe("a night already on when migration 0007 is applied", () => {
  it("sends no stale Game On, Game Off or someone said Yes", async () => {
    // Start again with the schema as it was before 0007.
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((migration) => !migration.name.startsWith("0007")));
    const app = startApp();
    const devices = {} as Record<Name, Awaited<ReturnType<typeof app.createLogin>>>;
    for (const name of ["Alice", "Bob", "Carol"] as const) {
      devices[name] = await app.createLogin({ username: name, password: PASSWORD });
    }
    await devices.Alice.post("/groups/new", { name: "Friday" });
    const friday = await idOf("groups", "name", "Friday");
    const night = "2026-11-03";
    for (const name of ["Bob", "Carol"]) {
      await env.DB.prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, ?3)")
        .bind(friday, await idOf("members", "username", name), "2026-11-03T12:00:00.000Z")
        .run();
    }
    for (const name of ["Alice", "Bob", "Carol"]) {
      await env.DB.prepare(
        "INSERT INTO checkins (member_id, game_night, availability, updated_at) VALUES (?1, ?2, 'yes', ?3)",
      )
        .bind(await idOf("members", "username", name), night, "2026-11-03T12:00:00.000Z")
        .run();
    }
    await env.DB.prepare("INSERT INTO group_night_state (group_id, game_night, was_on) VALUES (?1, ?2, 1)")
      .bind(friday, night)
      .run();

    // Deploy: 0007 is applied with tonight already on.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    for (const name of ["Alice", "Bob", "Carol"] as const) await devices[name].subscribe(endpointOf(name));

    await answer(devices.Alice, "yes");
    await answer(devices.Carol, "no");
    await answer(devices.Carol, "yes");
    expect(take(app)).toEqual([]);
  });
});

describe("claiming a Game Night for a scheduled push", () => {
  /** The single scheduler_state row, or null before anything has claimed it. */
  async function state() {
    return env.DB.prepare(
      "SELECT last_reset_game_night, last_reminder_game_night, last_summary_game_night FROM scheduler_state WHERE id = 1",
    ).first();
  }

  it("claims a night once, and only a later night after it", async () => {
    expect(await claimNight(env.DB, "reminder", "2026-11-03")).toBe(true);
    expect(await claimNight(env.DB, "reminder", "2026-11-03")).toBe(false);
    expect(await claimNight(env.DB, "reminder", "2026-11-02")).toBe(false);
    expect(await claimNight(env.DB, "reminder", "2026-11-04")).toBe(true);
    expect(await state()).toEqual({
      last_reset_game_night: null,
      last_reminder_game_night: "2026-11-04",
      last_summary_game_night: null,
    });
  });

  it("claims the Reminder and the Daily Summary apart, keeping the Reset's night", async () => {
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-11-03')").run();
    expect(await claimNight(env.DB, "daily_summary", "2026-11-03")).toBe(true);
    expect(await claimNight(env.DB, "reminder", "2026-11-03")).toBe(true);
    expect(await claimNight(env.DB, "daily_summary", "2026-11-03")).toBe(false);
    expect(await state()).toEqual({
      last_reset_game_night: "2026-11-03",
      last_reminder_game_night: "2026-11-03",
      last_summary_game_night: "2026-11-03",
    });
  });
});

describe("migration 0008", () => {
  it("adds empty claim columns to a scheduler_state row that already exists", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((migration) => !migration.name.startsWith("0008")));
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-11-03')").run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(
      await env.DB.prepare(
        "SELECT last_reset_game_night, last_reminder_game_night, last_summary_game_night FROM scheduler_state",
      ).all(),
    ).toMatchObject({
      results: [{ last_reset_game_night: "2026-11-03", last_reminder_game_night: null, last_summary_game_night: null }],
    });
  });
});

/** 17:00 UTC+4 on 3 Nov 2026: the hourly run that sends the Reminder for Game Night 2026-11-03. */
const REMINDER_3_NOV = "2026-11-03T13:00:00Z";
/** 20:00 UTC+4 on 3 Nov 2026: the hourly run that sends the Daily Summary. */
const SUMMARY_3_NOV = "2026-11-03T16:00:00Z";

/** The pushes sent since the last call, sorted by recipient, with their whole payload, and forgets them. */
function takePayloads(app: ReturnType<typeof startApp>) {
  const pushes = app.push.sent.map(({ subscription, payload }) => {
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    return { to: subscription.endpoint.split("/").pop()!, ...(JSON.parse(payload) as Payload) };
  });
  app.push.sent.length = 0;
  return pushes.sort((a, b) => a.to.localeCompare(b.to));
}

/** Runs the hourly job at `iso`. */
async function runAt(app: ReturnType<typeof startApp>, iso: string) {
  app.clock.set(iso);
  await app.runScheduled();
}

describe("the Reminder", () => {
  it("goes at 17:00 UTC+4 to each device of a Member in a Group who has not answered tonight", async () => {
    const { app, Alice, Bob } = await setUp();
    await answer(Alice, "yes");
    await answer(Bob, "maybe");
    // Carol has a second device with push on; Dave, in no Group, never gets a Reminder.
    const laptop = app.device();
    await laptop.post("/login", { username: "Carol", password: PASSWORD });
    await laptop.subscribe(pushEndpoint("carol-laptop"));
    take(app);

    await runAt(app, REMINDER_3_NOV);
    expect(takePayloads(app)).toEqual([
      {
        to: "carol",
        title: "Are you in tonight?",
        body: "You have not answered for tonight yet. Open Tonight to say Yes, Maybe or No.",
        url: "/",
        tag: "reminder-2026-11-03",
      },
      expect.objectContaining({ to: "carol-laptop", title: "Are you in tonight?", tag: "reminder-2026-11-03" }),
    ]);
  });

  it.each(["yes", "maybe", "no"] as const)("does not go to a Member who answered %s", async (availability) => {
    const { app, Alice, Bob, Carol } = await setUp();
    await answer(Alice, "yes");
    await answer(Carol, "yes");
    await answer(Bob, availability);
    take(app);
    await runAt(app, REMINDER_3_NOV);
    expect(take(app)).toEqual([]);
  });

  it("goes only in the 17:00 UTC+4 run: a missed run is not caught up and a repeat sends nothing", async () => {
    const { app } = await setUp();
    take(app);
    for (const iso of ["2026-11-03T12:00:00Z", "2026-11-03T14:00:00Z", "2026-11-03T15:00:00Z"]) {
      await runAt(app, iso);
      expect(take(app), iso).toEqual([]);
    }

    // The next night's 17:00 run sends; running it again, or later that hour, does not.
    await runAt(app, "2026-11-04T13:00:00Z");
    expect(take(app)).toEqual(["alice: Are you in tonight?", "bob: Are you in tonight?", "carol: Are you in tonight?"]);
    await runAt(app, "2026-11-04T13:00:00Z");
    await runAt(app, "2026-11-04T13:30:00Z");
    expect(take(app)).toEqual([]);
  });

  it("skips a Member who turned the Reminder off and a device whose session has expired", async () => {
    const { app } = await setUp();
    await createPush({ env, clock: app.clock }).setPrefs(await idOf("members", "username", "Alice"), { reminder: false });
    await env.DB.prepare("UPDATE sessions SET expires_at = ?1 WHERE member_id = ?2")
      .bind("2026-11-03T12:30:00.000Z", await idOf("members", "username", "Bob"))
      .run();
    take(app);
    await runAt(app, REMINDER_3_NOV);
    expect(take(app)).toEqual(["carol: Are you in tonight?"]);
  });

  it("deletes a device the push service says is gone and logs failures as a count, never the endpoint", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = await setUp({
      pushStatuses: { [endpointOf("Alice")]: 410, [endpointOf("Bob")]: new TypeError("fetch failed") },
    });
    take(app);
    await runAt(app, REMINDER_3_NOV);
    expect(take(app)).toEqual(["alice: Are you in tonight?", "bob: Are you in tonight?", "carol: Are you in tonight?"]);
    const left = await env.DB.prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").all<{ endpoint: string }>();
    expect(left.results.map((row) => row.endpoint)).toEqual([endpointOf("Bob"), endpointOf("Carol"), endpointOf("Dave")]);
    expect(errors).toHaveBeenCalledWith("Push reminder: 1 of 3 not sent (TypeError)");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("fcm.googleapis.com");
  });
});

describe("the Daily Summary", () => {
  it("goes at 20:00 UTC+4 to every Member of a Group with a Check-in, naming each Member by Availability", async () => {
    const { app, Alice, Bob, Carol, Dave, friday } = await setUp();
    // Dave owns "Solo" and has not answered; Carol is in it too.
    await Dave.post("/groups/new", { name: "Solo" });
    await addMember(app, await idOf("groups", "name", "Solo"), "Carol");
    await answer(Bob, "yes");
    await answer(Alice, "maybe");
    await answer(Carol, "no");
    take(app);

    await runAt(app, SUMMARY_3_NOV);
    const summary = {
      title: "Friday: 1 Yes, 1 Maybe, 1 No",
      body: "Yes: Bob\nMaybe: Alice\nNo: Carol",
      url: `/groups/${friday}`,
      tag: `daily-summary-${friday}-2026-11-03`,
    };
    const solo = await idOf("groups", "name", "Solo");
    expect(takePayloads(app)).toEqual([
      { to: "alice", ...summary },
      { to: "bob", ...summary },
      { to: "carol", ...summary },
      {
        to: "carol",
        title: "Solo: 1 No, 1 no answer",
        body: "No: Carol\nNo answer: Dave",
        url: `/groups/${solo}`,
        tag: `daily-summary-${solo}-2026-11-03`,
      },
      {
        to: "dave",
        title: "Solo: 1 No, 1 no answer",
        body: "No: Carol\nNo answer: Dave",
        url: `/groups/${solo}`,
        tag: `daily-summary-${solo}-2026-11-03`,
      },
    ]);
  });

  it("does not go for a Group with no Check-in tonight", async () => {
    const { app } = await setUp();
    take(app);
    await runAt(app, SUMMARY_3_NOV);
    expect(take(app)).toEqual([]);
  });

  it("goes only in the 20:00 UTC+4 run: a missed run is not caught up and a repeat sends nothing", async () => {
    const { app, Alice } = await setUp();
    await answer(Alice, "yes");
    take(app);
    for (const iso of ["2026-11-03T15:00:00Z", "2026-11-03T17:00:00Z"]) {
      await runAt(app, iso);
      expect(take(app), iso).toEqual([]);
    }

    // The next night's 20:00 run sends; running it again, or later that hour, does not.
    app.clock.set("2026-11-04T12:00:00Z");
    await answer(Alice, "yes");
    take(app);
    await runAt(app, "2026-11-04T16:00:00Z");
    expect(take(app)).toEqual([
      "alice: Friday: 1 Yes, 2 no answer",
      "bob: Friday: 1 Yes, 2 no answer",
      "carol: Friday: 1 Yes, 2 no answer",
    ]);
    await runAt(app, "2026-11-04T16:00:00Z");
    await runAt(app, "2026-11-04T16:45:00Z");
    expect(take(app)).toEqual([]);
  });

  it("skips a Member who turned the Daily Summary off", async () => {
    const { app, Alice } = await setUp();
    await createPush({ env, clock: app.clock }).setPrefs(await idOf("members", "username", "Bob"), { daily_summary: false });
    await answer(Alice, "yes");
    take(app);
    await runAt(app, SUMMARY_3_NOV);
    expect(take(app)).toEqual([
      "alice: Friday: 1 Yes, 2 no answer",
      "carol: Friday: 1 Yes, 2 no answer",
    ]);
  });

  it("names each Member by Shown name, in Board order by Shown name", async () => {
    const { app, Alice, Bob, Carol } = await setUp();
    await Bob.post("/profile", { intent: "names", username: "Bob", displayName: "Zed 🎲", colour: "blue" });
    await answer(Alice, "maybe");
    await answer(Bob, "maybe");
    await answer(Carol, "maybe");
    take(app);

    await runAt(app, SUMMARY_3_NOV);

    expect(takePayloads(app)[0].body).toBe("Maybe: Alice, Carol, Zed 🎲");
  });

  it("fits a Group of 99 Members with the longest emoji Display Names, ending with how many more there are", async () => {
    const { app, Alice, friday } = await setUp();
    const now = app.clock.now().toISOString();
    // 96 more Members whose Display Names are 32 code points, 30 of them four-byte emoji, all Maybe.
    const statements = [];
    for (let i = 0; i < 96; i++) {
      const username = `member ${String(i).padStart(2, "0")}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO members (username, username_lower, display_name, colour, password_hash, password_salt, password_iterations, created_at)
           VALUES (?1, lower(?1), ?2, 'blue', 'x', 'x', 1, ?3)`,
        ).bind(username, `${"🎲".repeat(30)}${String(i).padStart(2, "0")}`, now),
        env.DB.prepare(
          "INSERT INTO memberships (group_id, member_id, joined_at) SELECT ?1, id, ?2 FROM members WHERE username = ?3",
        ).bind(friday, now, username),
        env.DB.prepare(
          "INSERT INTO checkins (member_id, game_night, availability, updated_at) SELECT id, '2026-11-03', 'maybe', ?1 FROM members WHERE username = ?2",
        ).bind(now, username),
      );
    }
    await env.DB.batch(statements);
    await answer(Alice, "yes");
    take(app);

    await runAt(app, SUMMARY_3_NOV);
    const [first] = takePayloads(app);
    const { to: _, ...payload } = first;
    const bytes = new TextEncoder().encode(encodePayload(payload)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    // Close to the limit: no room was left for another 122-byte name.
    expect(bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES - 130);
    const more = first.body.match(/ \+([0-9]+) more$/);
    expect(more, first.body).not.toBeNull();
    const shown = first.body.replace(/ \+[0-9]+ more$/, "").split("\n").flatMap((line) => line.replace(/^[^:]*: /, "").split(", "));
    expect(shown[0]).toBe("Alice");
    expect(shown[1]).toBe(`${"🎲".repeat(30)}00`);
    expect(shown.length + Number(more![1])).toBe(99);
  });

  it("fits a Group of 99 Members with the longest names, ending with how many more there are", async () => {
    const { app, Alice, friday } = await setUp();
    const now = app.clock.now().toISOString();
    // 96 more Members with 32-character names of two-byte letters, all Maybe.
    const statements = [];
    for (let i = 0; i < 96; i++) {
      const username = `${"Ł".repeat(30)}${String(i).padStart(2, "0")}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO members (username, username_lower, colour, password_hash, password_salt, password_iterations, created_at)
           VALUES (?1, lower(?1), 'blue', 'x', 'x', 1, ?2)`,
        ).bind(username, now),
        env.DB.prepare(
          "INSERT INTO memberships (group_id, member_id, joined_at) SELECT ?1, id, ?2 FROM members WHERE username = ?3",
        ).bind(friday, now, username),
        env.DB.prepare(
          "INSERT INTO checkins (member_id, game_night, availability, updated_at) SELECT id, '2026-11-03', 'maybe', ?1 FROM members WHERE username = ?2",
        ).bind(now, username),
      );
    }
    await env.DB.batch(statements);
    await answer(Alice, "yes");
    take(app);

    await runAt(app, SUMMARY_3_NOV);
    const [first] = takePayloads(app);
    expect(first.title).toBe("Friday: 1 Yes, 96 Maybe, 2 no answer");
    // Close to the limit: no room was left for another 64-byte name.
    const { to: _, ...payload } = first;
    expect(new TextEncoder().encode(encodePayload(payload)).length).toBeGreaterThan(MAX_PAYLOAD_BYTES - 70);
    const more = first.body.match(/ \+([0-9]+) more$/);
    expect(more, first.body).not.toBeNull();
    const shown = first.body.replace(/ \+[0-9]+ more$/, "").split("\n").flatMap((line) => line.replace(/^[^:]*: /, "").split(", "));
    expect(shown[0]).toBe("Alice");
    expect(shown.length + Number(more![1])).toBe(99);
  });
});

describe("the hourly run", () => {
  it("still runs the Reset when a scheduled push fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = await setUp();
    take(app);
    await env.DB.prepare("DROP TABLE push_subscriptions").run();
    await runAt(app, REMINDER_3_NOV);
    expect(errors).toHaveBeenCalledWith("Push reminder: delivery failed (Error)");
    const state = await env.DB.prepare("SELECT last_reset_game_night AS night FROM scheduler_state").first();
    expect(state).toEqual({ night: "2026-11-03" });
  });

  it("still sends the Reminder when the Reset fails, and reports the Reset's failure", async () => {
    const { app } = await setUp();
    take(app);
    await env.DB.batch([env.DB.prepare("DROP TABLE history_rows"), env.DB.prepare("DROP TABLE history_nights")]);
    app.clock.set(REMINDER_3_NOV);
    await expect(app.runScheduled()).rejects.toThrow();
    expect(take(app)).toEqual(["alice: Are you in tonight?", "bob: Are you in tonight?", "carol: Are you in tonight?"]);
  });
});
