import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInvites } from "~/invites";
import { encodePayload, MAX_PAYLOAD_BYTES } from "~/notifications";
import { createPush } from "~/push";

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
    expect(new TextEncoder().encode(payload).length).toBeLessThan(MAX_PAYLOAD_BYTES);
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
  it("never sends a type to a Member who turned it off, and still sends it to the others", async () => {
    const { app, Alice, Bob, Carol } = await setUp();
    await createPush({ env, clock: app.clock }).setPrefs(await idOf("members", "username", "Bob"), {
      said_yes: false,
      game_on: false,
    });
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
  it("stay under 4 KB with the longest names", async () => {
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

  it("refuses a payload of 4 KB or more", () => {
    expect(() => encodePayload({ title: "x".repeat(MAX_PAYLOAD_BYTES), body: "", url: "/", tag: "t" })).toThrow(
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
