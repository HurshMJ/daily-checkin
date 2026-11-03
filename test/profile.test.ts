import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createInvites } from "~/invites";

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
    expect(headings).toEqual(["Password", "Groups", "Sessions"]);
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
    expect(response.headers.get("Location")).toBe("/profile?left=Friday");
    expect(await isMember(friday, "Bob")).toBe(false);

    const main = mainOf(await (await bob.get("/profile?left=Friday")).text());
    expect(groupsCard(main)).toContain(
      '<div role="status"><div class="notice-info"><p class="notice-title">You left Friday</p><p>Its Board is off your Tonight.</p></div></div>',
    );
    expect(groupsCard(main)).toContain("You are not in any Group.");
    expect(mainOf(await (await bob.get("/")).text())).not.toContain("Friday");
  });

  it("deletes the Group when its Owner is the last Member", async () => {
    const { alice } = await setUp();
    await alice.post("/groups/new", { name: "Solo" });
    const solo = await idOf("groups", "name", "Solo");
    const first = await alice.post("/profile", { intent: "leave", groupId: String(solo) });
    expect(mainOf(await first.text())).toMatch(/<button[^>]*data-armed="true"[^>]*>Tap again to leave and delete Solo<\/button>/);

    const response = await alice.post("/profile", { intent: "leave", groupId: String(solo), confirm: "yes" });
    expect(response.headers.get("Location")).toBe("/profile?left=Solo&deleted=1");
    expect(await groupExists(solo)).toBe(false);
    const main = mainOf(await (await alice.get("/profile?left=Solo&deleted=1")).text());
    expect(main).toContain('<p class="notice-title">You left and deleted Solo</p>');
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
