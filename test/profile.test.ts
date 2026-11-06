import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createInvites } from "~/invites";
import { LEFT_COOKIE } from "~/routes/profile";

import swSource from "../public/sw.js?raw";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

function mainOf(html: string): string {
  const body = html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
  return body.slice(body.indexOf("<main"), body.indexOf("</main>"));
}

async function idOf(table: "members" | "groups", column: "username" | "name", value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${column} = ?1`).bind(value).first<{ id: number }>();
  return row!.id;
}

async function groupExists(groupId: number): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM groups WHERE id = ?1").bind(groupId).first()) !== null;
}

async function isMember(groupId: number, username: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM memberships m JOIN members p ON p.id = m.member_id WHERE m.group_id = ?1 AND p.username = ?2",
  )
    .bind(groupId, username)
    .first();
  return row !== null;
}

/** The Groups card's inner HTML. */
function groupsCard(main: string): string {
  const card = main.match(/<section class="card" aria-labelledby="groups-heading">([\s\S]*?)<\/section>/);
  expect(card, "Groups card").not.toBeNull();
  return card![1];
}

/** Alice owns "Friday" with Bob in it. */
async function setUp() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
  await alice.post("/groups/new", { name: "Friday" });
  const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
  const friday = await idOf("groups", "name", "Friday");
  const invites = createInvites({ env, clock: app.clock });
  const made = await invites.makeInvite(await idOf("members", "username", "Alice"), friday, "");
  if (!made.ok) throw new Error("make failed");
  await invites.joinWithInvite(await idOf("members", "username", "Bob"), made.token);
  return { app, alice, bob, friday };
}

describe("the Groups card on the profile", () => {
  it("sits between the Password and Sessions cards", async () => {
    const { bob } = await setUp();
    const main = mainOf(await (await bob.get("/profile")).text());
    const headings = [...main.matchAll(/<h2 id="[^"]*">([^<]*)<\/h2>/g)].map(([, text]) => text);
    expect(headings).toEqual(["Name and colour", "Notifications", "Password", "Groups", "Sessions", "Delete login"]);
  });

  it("gives a Member a Leave button described by the Group's name", async () => {
    const { bob, friday } = await setUp();
    const card = groupsCard(mainOf(await (await bob.get("/profile")).text()));
    expect(card).toContain(`<span class="list-tile-name" id="group-${friday}-name">Friday</span>`);
    expect(card).toContain('<span class="list-tile-detail">2 Members</span>');
    const button = card.match(/<button[^>]*>Leave<\/button>/)![0];
    expect(button).toContain('class="btn-destructive"');
    expect(button).toContain(`aria-describedby="group-${friday}-name"`);
  });

  it("shows an Owner with other Members the hint and no Leave button", async () => {
    const { alice } = await setUp();
    const card = groupsCard(mainOf(await (await alice.get("/profile")).text()));
    expect(card).toContain('<span class="list-tile-detail">Owner · 2 Members</span>');
    expect(card).toContain('<span class="list-tile-detail">Make another Member Owner first</span>');
    expect(card).not.toContain("<form");
  });

  it("says so when the Member is in no Group", async () => {
    const browser = await startApp().createLogin({ username: "Alice", password: PASSWORD });
    expect(groupsCard(mainOf(await (await browser.get("/profile")).text()))).toContain("You are not in any Group.");
  });
});

describe("leaving a Group from the profile", () => {
  it("arms Leave on a first tap without the confirmation, changing nothing", async () => {
    const { bob, friday } = await setUp();
    const response = await bob.post("/profile", { intent: "leave", groupId: String(friday) });
    expect(response.status).toBe(200);
    expect(mainOf(await response.text())).toMatch(/<button[^>]*data-armed="true"[^>]*>Tap again to leave Friday<\/button>/);
    expect(await isMember(friday, "Bob")).toBe(true);
  });

  it("leaves on the confirmed tap, lands on the profile with a status line, and drops the Board", async () => {
    const { bob, friday } = await setUp();
    const response = await bob.post("/profile", { intent: "leave", groupId: String(friday), confirm: "yes" });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/profile");
    expect(response.headers.getSetCookie()).toContain(
      `${LEFT_COOKIE}=${encodeURIComponent(JSON.stringify({ name: "Friday", deleted: false }))}; Max-Age=60; HttpOnly; Secure; SameSite=Lax; Path=/`,
    );
    expect(await isMember(friday, "Bob")).toBe(false);

    const landed = await bob.get("/profile");
    expect(landed.headers.getSetCookie()).toContain(`${LEFT_COOKIE}=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`);
    const main = mainOf(await landed.text());
    expect(groupsCard(main)).toContain(
      '<div role="status"><div class="notice-info"><p class="notice-title">You left Friday</p><p>Its Board is off your Tonight.</p></div></div>',
    );
    expect(groupsCard(main)).toContain("You are not in any Group.");
    expect(mainOf(await (await bob.get("/")).text())).not.toContain("Friday");
  });

  it("shows the leave notice once: a reload after the cookie is cleared shows none", async () => {
    const { bob, friday } = await setUp();
    await bob.post("/profile", { intent: "leave", groupId: String(friday), confirm: "yes" });
    expect(mainOf(await (await bob.get("/profile")).text())).toContain('<p class="notice-title">You left Friday</p>');
    expect(bob.cookies.has(LEFT_COOKIE)).toBe(false);
    expect(mainOf(await (await bob.get("/profile")).text())).not.toContain("You left");
  });

  it("shows no notice for a crafted link without the cookie", async () => {
    const { bob } = await setUp();
    for (const path of ["/profile?left=Friday", "/profile?left=anything&deleted=1", "/profile?left=It%20was%20deleted"]) {
      const main = mainOf(await (await bob.get(path)).text());
      expect(main, path).not.toContain("You left");
      expect(main, path).not.toContain("notice-info");
    }
  });

  it("round-trips a Group name with ; , = and non-ASCII characters", async () => {
    const { alice } = await setUp();
    const name = "Ünï; a=b, «ゲーム» 🎲";
    await alice.post("/groups/new", { name });
    const groupId = await idOf("groups", "name", name);
    const response = await alice.post("/profile", { intent: "leave", groupId: String(groupId), confirm: "yes" });
    expect(response.status).toBe(303);
    const set = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${LEFT_COOKIE}=`))!;
    const value = set.split(";")[0].slice(`${LEFT_COOKIE}=`.length);
    expect(value).toMatch(/^[A-Za-z0-9%_.!~*'()-]+$/);
    const main = mainOf(await (await alice.get("/profile")).text());
    expect(main).toContain(`<p class="notice-title">You left and deleted ${name}</p>`);
  });

  it("shows no notice and does not throw for a cookie that does not decode", async () => {
    const { bob } = await setUp();
    for (const bad of ["%E0%A4%A", "not-json", encodeURIComponent(JSON.stringify({ name: 3, deleted: false })), encodeURIComponent("null")]) {
      bob.cookies.set(LEFT_COOKIE, bad);
      const response = await bob.get("/profile");
      expect(response.status, bad).toBe(200);
      expect(mainOf(await response.text()), bad).not.toContain("You left");
      expect(bob.cookies.has(LEFT_COOKIE), bad).toBe(false);
    }
  });

  it("deletes the Group when its Owner is the last Member", async () => {
    const { alice } = await setUp();
    await alice.post("/groups/new", { name: "Solo" });
    const solo = await idOf("groups", "name", "Solo");
    const first = await alice.post("/profile", { intent: "leave", groupId: String(solo) });
    expect(mainOf(await first.text())).toMatch(/<button[^>]*data-armed="true"[^>]*>Tap again to leave and delete Solo<\/button>/);

    const response = await alice.post("/profile", { intent: "leave", groupId: String(solo), confirm: "yes" });
    expect(response.headers.get("Location")).toBe("/profile");
    expect(await groupExists(solo)).toBe(false);
    const main = mainOf(await (await alice.get("/profile")).text());
    expect(main).toContain('<p class="notice-title">You left and deleted Solo</p><p>It was deleted for everyone.</p>');
  });

  it("refuses an Owner with other Members, and a Group the Member is not in, changing nothing", async () => {
    const { app, alice, friday } = await setUp();
    expect((await alice.post("/profile", { intent: "leave", groupId: String(friday), confirm: "yes" })).status).toBe(409);
    expect(await isMember(friday, "Alice")).toBe(true);

    const carol = await app.createLogin({ username: "Carol", password: PASSWORD });
    expect((await carol.post("/profile", { intent: "leave", groupId: String(friday), confirm: "yes" })).status).toBe(404);
    expect((await carol.post("/profile", { intent: "leave", groupId: "nope", confirm: "yes" })).status).toBe(400);
    expect(await groupExists(friday)).toBe(true);
  });

  it("refuses a cross-origin leave", async () => {
    const { bob, friday } = await setUp();
    const response = await bob.post(
      "/profile",
      { intent: "leave", groupId: String(friday), confirm: "yes" },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
    expect(await isMember(friday, "Bob")).toBe(true);
  });
});

/** The Notifications card's inner HTML. */
function notificationsCard(main: string): string {
  const card = main.match(/<section class="card" aria-labelledby="notifications-heading">([\s\S]*?)<\/section>/);
  expect(card, "Notifications card").not.toBeNull();
  return card![1];
}

/** Each toggle's name and whether its box is checked, in page order. */
function toggles(card: string): [string, boolean][] {
  return [...card.matchAll(/<span class="toggle-name"[^>]*>([^<]*)<\/span>[\s\S]*?<input([^>]*)>/g)].map(([, name, input]) => [
    name,
    /\schecked=""/.test(input),
  ]);
}

describe("the Notifications card on the profile", () => {
  it("comes first, with all five toggles on by default and words for every state", async () => {
    const { bob } = await setUp();
    const card = notificationsCard(mainOf(await (await bob.get("/profile")).text()));
    expect(toggles(card)).toEqual([
      ["Someone said Yes", true],
      ["Game On", true],
      ["Game Off", true],
      ["Reminder", true],
      ["Daily Summary", true],
    ]);
    // Each switch says On and Off in words; CSS shows the one that applies.
    expect(card.match(/<span class="toggle-switch" aria-hidden="true"><span class="toggle-on">On<\/span><span class="toggle-off">Off<\/span><\/span>/g)).toHaveLength(5);
    for (const input of card.match(/<input class="toggle-input"[^>]*>/g)!) {
      expect(input).toContain('type="checkbox"');
      expect(input).toContain('role="switch"');
    }
    expect(card).toContain(">Save notifications</button>");
  });

  it("names and describes the Reminder and Daily Summary switches for assistive technology", async () => {
    const { bob } = await setUp();
    const card = notificationsCard(mainOf(await (await bob.get("/profile")).text()));
    for (const [type, name, detail] of [
      ["reminder", "Reminder", "At 5 PM if one of your Groups has no answer from you tonight."],
      ["daily_summary", "Daily Summary", "At 8 PM, each of your Groups&#x27; answers for tonight."],
    ]) {
      expect(card).toContain(`<span class="toggle-name" id="toggle-${type}-name">${name}</span>`);
      expect(card).toContain(`<span class="toggle-detail" id="toggle-${type}-detail">${detail}</span>`);
      const input = card.match(new RegExp(`<input[^>]*name="${type}"[^>]*>`));
      expect(input, type).not.toBeNull();
      expect(input![0]).toContain(`aria-labelledby="toggle-${type}-name"`);
      expect(input![0]).toContain(`aria-describedby="toggle-${type}-detail"`);
    }
  });

  it("stops the Reminder for a Member who turns it off", async () => {
    const { app, alice, bob } = await setUp();
    await alice.subscribe("https://fcm.googleapis.com/fcm/send/alice");
    await bob.subscribe("https://fcm.googleapis.com/fcm/send/bob");
    await bob.post("/profile", { intent: "notifications", said_yes: "on", game_on: "on", game_off: "on", daily_summary: "on" });

    app.clock.set("2026-11-03T13:00:00Z");
    await app.runScheduled();
    expect(app.push.sent.map(({ subscription }) => subscription.endpoint)).toEqual([
      "https://fcm.googleapis.com/fcm/send/alice",
    ]);
  });

  it("says turning push on needs JavaScript until the page's script runs, and asks for no permission on load", async () => {
    const { bob } = await setUp();
    const card = notificationsCard(mainOf(await (await bob.get("/profile")).text()));
    expect(card).toContain("Turning on push on this device needs JavaScript.");
    expect(card).not.toContain("Turn on push</button>");
  });

  it("saves the toggles without JavaScript and shows them on the next visit", async () => {
    const { bob } = await setUp();
    const response = await bob.post("/profile", { intent: "notifications", said_yes: "on", game_off: "on" });
    expect(response.status).toBe(200);
    const saved = notificationsCard(mainOf(await response.text()));
    expect(saved).toContain("Notification settings saved.");
    expect(toggles(saved)).toEqual([
      ["Someone said Yes", true],
      ["Game On", false],
      ["Game Off", true],
      ["Reminder", false],
      ["Daily Summary", false],
    ]);

    const again = notificationsCard(mainOf(await (await bob.get("/profile")).text()));
    expect(again).not.toContain("Notification settings saved.");
    expect(toggles(again)).toEqual([
      ["Someone said Yes", true],
      ["Game On", false],
      ["Game Off", true],
      ["Reminder", false],
      ["Daily Summary", false],
    ]);

    await bob.post("/profile", {
      intent: "notifications",
      said_yes: "on",
      game_on: "on",
      game_off: "on",
      reminder: "on",
      daily_summary: "on",
    });
    expect(toggles(notificationsCard(mainOf(await (await bob.get("/profile")).text()))).every(([, on]) => on)).toBe(true);
  });

  it("changes nothing on a cross-origin save", async () => {
    const { bob } = await setUp();
    const response = await bob.post("/profile", { intent: "notifications" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(toggles(notificationsCard(mainOf(await (await bob.get("/profile")).text()))).every(([, on]) => on)).toBe(true);
  });
});

describe("the service worker in public/sw.js", () => {
  /** An open window of the app as `clients.matchAll` returns it. */
  interface FakeWindow {
    url: string;
    focus(): Promise<FakeWindow>;
    navigate(url: string): Promise<FakeWindow | null>;
  }

  /**
   * A fake open window at `url`. A controlled window navigates; an
   * uncontrolled one cannot, so its navigate rejects, as browsers do.
   */
  function fakeWindow(url: string, { controlled }: { controlled: boolean }) {
    const visited: string[] = [];
    const window: FakeWindow & { visited: string[]; focused: number } = {
      url,
      visited,
      focused: 0,
      async focus() {
        window.focused += 1;
        return window;
      },
      async navigate(to: string) {
        if (!controlled) throw new TypeError("This service worker is not the client's active service worker.");
        visited.push(to);
        return window;
      },
    };
    return window;
  }

  /** Runs the script against a fake service worker global and returns its handlers and what they did. */
  function load(windows: FakeWindow[] = []) {
    const handlers: Record<string, (event: unknown) => void> = {};
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const opened: string[] = [];
    const waits: Promise<unknown>[] = [];
    const self = {
      location: new URL("https://daily-checkin.test/sw.js"),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        handlers[type] = handler;
      },
      registration: {
        showNotification: async (title: string, options: Record<string, unknown>) => {
          shown.push({ title, options });
        },
      },
      clients: {
        matchAll: async () => windows,
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    };
    new Function("self", swSource)(self);
    const waitUntil = (promise: Promise<unknown>) => waits.push(promise);
    return {
      shown,
      opened,
      async push(data: string | null) {
        handlers.push({ data: data === null ? null : { json: () => JSON.parse(data) }, waitUntil });
        await Promise.all(waits);
      },
      async click(url: unknown) {
        handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil });
        await Promise.all(waits);
      },
    };
  }

  it("shows a notification for every push, even one it cannot read", async () => {
    const sw = load();
    await sw.push(JSON.stringify({ title: "Game On: Friday", body: "3 said Yes", url: "/groups/1", tag: "game-on-1" }));
    await sw.push("not json");
    await sw.push(null);
    expect(sw.shown.map(({ title }) => title)).toEqual(["Game On: Friday", "Daily Check-in", "Daily Check-in"]);
    expect(sw.shown[0].options).toMatchObject({ body: "3 said Yes", tag: "game-on-1", data: { url: "/groups/1" } });
  });

  it("opens the payload's page on a tap, and only pages of the app", async () => {
    const sw = load();
    await sw.click("/groups/1");
    await sw.click("https://evil.example/");
    expect(sw.opened).toEqual(["https://daily-checkin.test/groups/1", "https://daily-checkin.test/"]);
  });

  it("navigates an open window of the app it controls to the page, opening no other window", async () => {
    const open = fakeWindow("https://daily-checkin.test/profile", { controlled: true });
    const sw = load([open]);
    await sw.click("/groups/1");
    expect(open.focused).toBe(1);
    expect(open.visited).toEqual(["https://daily-checkin.test/groups/1"]);
    expect(sw.opened).toEqual([]);
  });

  it("opens the page in a new window when the open window is not controlled and cannot navigate", async () => {
    const open = fakeWindow("https://daily-checkin.test/profile", { controlled: false });
    const sw = load([open]);
    await sw.click("/groups/1");
    await sw.click("https://evil.example/");
    expect(sw.opened).toEqual(["https://daily-checkin.test/groups/1", "https://daily-checkin.test/"]);
  });

  it("opens the page in a new window when navigate gives no window back", async () => {
    const open = fakeWindow("https://daily-checkin.test/profile", { controlled: true });
    open.navigate = async () => null;
    const sw = load([open]);
    await sw.click("/groups/1");
    expect(sw.opened).toEqual(["https://daily-checkin.test/groups/1"]);
  });

  it("only focuses a window already on the page", async () => {
    const open = fakeWindow("https://daily-checkin.test/groups/1", { controlled: false });
    const sw = load([open]);
    await sw.click("/groups/1");
    expect(open.focused).toBe(1);
    expect(sw.opened).toEqual([]);
  });
});

/** The name and colour card's inner HTML. */
function namesCard(main: string): string {
  const card = main.match(/<section class="card" aria-labelledby="names-heading">([\s\S]*?)<\/section>/);
  expect(card, "Name and colour card").not.toBeNull();
  return card![1];
}

/** The profile header's inner HTML. */
function profileHeader(main: string): string {
  return main.match(/<header class="profile-header">([\s\S]*?)<\/header>/)![1];
}

describe("the name and colour card", () => {
  it("is the first card and holds username, Display Name, the picker and Save", async () => {
    const { bob } = await setUp();
    const main = mainOf(await (await bob.get("/profile")).text());
    const card = namesCard(main);

    expect(main.indexOf('aria-labelledby="names-heading"')).toBeLessThan(main.indexOf('aria-labelledby="notifications-heading"'));
    expect(card).toMatch(/<input[^>]*id="profile-username"[^>]*value="Bob"/);
    expect(card).toMatch(/<input[^>]*id="display-name"[^>]*value=""/);
    expect(card).toContain("Leave empty to show your username.");
    expect(card).toMatch(/<input[^>]*checked=""[^>]*value="blue"/);
    expect(card).toMatch(/<button[^>]*>Save<\/button>/);
  });

  it("saves without JavaScript and the header shows the Shown name and @username", async () => {
    const { bob } = await setUp();

    const saved = await bob.post("/profile", { intent: "names", username: "Bobby", displayName: " Bob 🎲 ", colour: "pink" });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("Location")).toBe("/profile?saved=1");

    const main = mainOf(await (await bob.get("/profile?saved=1")).text());
    const header = profileHeader(main);
    expect(header).toContain('data-colour="pink"');
    expect(header).toContain('<h1 class="profile-name">Bob 🎲</h1>');
    expect(header).toContain('<p class="profile-username">@Bobby</p>');
    expect(namesCard(main)).toContain("Profile saved");
    expect(namesCard(main)).toMatch(/<input[^>]*id="display-name"[^>]*value="Bob 🎲"/);
  });

  it("shows the username in the header when the Display Name is cleared", async () => {
    const { bob } = await setUp();
    await bob.post("/profile", { intent: "names", username: "Bob", displayName: "Bobby", colour: "blue" });
    await bob.post("/profile", { intent: "names", username: "Bob", displayName: "  ", colour: "blue" });

    const header = profileHeader(mainOf(await (await bob.get("/profile")).text()));
    expect(header).toContain('<h1 class="profile-name">Bob</h1>');
  });

  it("shows the new colour in the top bar on the next page", async () => {
    const { bob } = await setUp();
    await bob.post("/profile", { intent: "names", username: "Bob", displayName: "", colour: "violet" });

    const tonight = await (await bob.get("/")).text();
    expect(tonight).toMatch(/<a[^>]*class="top-bar-you"[^>]*><span class="avatar-dot" data-colour="violet"/);
  });

  it("puts a taken Display Name's error next to that field and keeps what was typed", async () => {
    const { bob } = await setUp();

    const refused = await bob.post("/profile", { intent: "names", username: "Bobby", displayName: "alice", colour: "pink" });
    expect(refused.status).toBe(400);
    const card = namesCard(mainOf(await refused.text()));

    expect(card).toMatch(/<input[^>]*id="display-name"[^>]*aria-invalid="true"[^>]*aria-describedby="display-name-help"[^>]*value="alice"/);
    expect(card).toContain('<p id="display-name-help" class="field-error">Error: That name is taken.</p>');
    expect(card).toMatch(/<input[^>]*id="profile-username"[^>]*value="Bobby"/);
    expect(card).toMatch(/<input[^>]*checked=""[^>]*value="pink"/);
    expect(await idOf("members", "username", "Bob")).toBeGreaterThan(0);
  });

  it("puts a username error next to the username field", async () => {
    const { bob } = await setUp();

    const asPassword = await bob.post("/profile", { intent: "names", username: PASSWORD, displayName: "", colour: "blue" });
    const tooShort = await bob.post("/profile", { intent: "names", username: "Bo", displayName: "", colour: "blue" });

    expect(asPassword.status).toBe(400);
    expect(namesCard(mainOf(await asPassword.text()))).toContain(
      '<p id="profile-username-help" class="field-error">Error: Choose a username that is not your password.</p>',
    );
    expect(namesCard(mainOf(await tooShort.text()))).toContain(
      '<p id="profile-username-help" class="field-error">Error: Use 3 to 32 characters.</p>',
    );
  });
});
