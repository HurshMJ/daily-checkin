import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { zoneDayTime } from "~/game-night";
import { createInvites } from "~/invites";

import { APP_ORIGIN, startApp } from "./harness";

const PASSWORD = "correct horse battery";

function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
}

/** The page's words, without the router's data. */
function mainOf(html: string): string {
  const body = bodyOf(html);
  return body.slice(body.indexOf("<main"), body.indexOf("</main>"));
}

async function idOf(table: "members" | "groups", column: "username" | "name", value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${column} = ?1`).bind(value).first<{ id: number }>();
  return row!.id;
}

/** The text of every pending Invite tile, in page order. */
function pendingTiles(main: string): string[] {
  const list = main.match(/<ul class="list" aria-label="Pending Invites">([\s\S]*?)<\/ul>/);
  if (!list) return [];
  return [...list[1].matchAll(/<span class="list-tile-name"[^>]*>([^<]*)<\/span>/g)].map(([, text]) => text);
}

/** Alice owns "Friday"; Bob is a Member through an Invite; Carol is in no Group. */
async function setUp() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD, colour: "violet" });
  await alice.post("/groups/new", { name: "Friday" });
  const bob = await app.createLogin({ username: "Bob", password: PASSWORD, colour: "sky" });
  const carol = await app.createLogin({ username: "Carol", password: PASSWORD });
  const friday = await idOf("groups", "name", "Friday");
  const invites = createInvites({ env, clock: app.clock });
  const made = await invites.makeInvite(await idOf("members", "username", "Alice"), friday, "");
  if (!made.ok) throw new Error("make failed");
  app.clock.set("2026-11-03T12:01:00Z");
  await invites.joinWithInvite(await idOf("members", "username", "Bob"), made.token);
  return { app, alice, bob, carol, friday, page: `/groups/${friday}` };
}

async function pendingCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND cancelled_at IS NULL").first<{
    n: number;
  }>();
  return row!.n;
}

describe("the Group page", () => {
  it("shows the Owner the header, Basics, Members and the Invites card", async () => {
    const { alice, page } = await setUp();
    const response = await alice.get(page);
    const html = await response.text();
    const main = mainOf(html);

    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html).not.toMatch(/\sstyle=/);
    expect(bodyOf(html)).toMatch(/<a class="top-bar-back" href="\/"[^>]*><span aria-hidden="true">‹<\/span> Tonight<\/a>/);
    expect(main).toContain("<h1>Friday</h1><p class=\"group-count\">2 Members</p>");
    expect(main).toContain("<dt>Name</dt><dd>Friday</dd>");
    expect(main).toContain("<dd>Game On at 3 Yes</dd>");

    const tiles = [...main.matchAll(/<li class="list-tile">([\s\S]*?)<\/li>/g)].map(([, tile]) => tile);
    expect(tiles[0]).toContain('data-colour="violet"');
    expect(tiles[0]).toContain('<span class="list-tile-name">Alice</span><span class="list-tile-detail">@Alice</span>');
    expect(tiles[0]).toContain('<span class="list-tile-tag">Owner</span>');
    expect(tiles[1]).toContain('<span class="list-tile-name">Bob</span>');
    expect(tiles[1]).not.toContain("Owner");

    expect(main).toContain('<h2 id="invites-heading">Invites</h2>');
    expect(main).toMatch(/<label[^>]*for="invite-label"[^>]*>Who is it for\?<\/label>/);
    expect(main).toContain("Optional, only you see it.");
    expect(main).toMatch(/<button[^>]*type="submit"[^>]*>Make an Invite<\/button>/);
    expect(main).toContain("No pending Invites.");
  });

  it("shows a non-Owner Member the name, threshold and Members only", async () => {
    const { bob, page } = await setUp();
    const response = await bob.get(page);
    const main = mainOf(await response.text());

    expect(response.status).toBe(200);
    expect(main).toContain("<dd>Game On at 3 Yes</dd>");
    expect(main).toContain('<h2 id="members-heading">Members</h2>');
    expect(main).not.toContain("Invites");
    expect(main).not.toContain("<form");
  });

  it("is a 404 for anyone who is not a Member, and for a Group that does not exist", async () => {
    const { carol, page } = await setUp();
    expect((await carol.get(page)).status).toBe(404);
    expect((await carol.get("/groups/999")).status).toBe(404);
    expect((await carol.get("/groups/not-a-number")).status).toBe(404);
  });

  it("sends a logged-out visitor to the login", async () => {
    const { app, page } = await setUp();
    const response = await app.device().get(page);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });
});

describe("making and cancelling Invites on the Group page", () => {
  it("shows a new link once, and afterwards only its label or time in the pending list", async () => {
    const { app, alice, page } = await setUp();
    const response = await alice.post(page, { intent: "make", label: "for Sam" });
    const main = mainOf(await response.text());

    expect(response.status).toBe(200);
    const link = main.match(/<input[^>]*id="invite-link"[^>]*value="([^"]*)"/)?.[1];
    expect(link).toMatch(new RegExp(`^${APP_ORIGIN}/invite/[A-Za-z0-9_-]{43}$`));
    expect(main.match(/<input[^>]*id="invite-link"[^>]*>/)![0]).toMatch(/readOnly=""/);
    expect(main).toMatch(/<button type="button" class="btn-small">Copy<\/button>/);
    expect(main).toContain('<p role="status" class="copy-box-status"></p>');
    expect(pendingTiles(main)).toEqual(["for Sam"]);

    app.clock.set("2026-11-03T12:30:00Z");
    await alice.post(page, { intent: "make", label: "" });
    const reloaded = mainOf(await (await alice.get(page)).text());
    expect(reloaded).not.toContain("copy-box");
    expect(reloaded).not.toContain("/invite/");
    expect(pendingTiles(reloaded)).toEqual([`Made ${zoneDayTime(new Date("2026-11-03T12:30:00Z"))}`, "for Sam"]);
    expect(pendingTiles(reloaded)[0]).toBe("Made 3 Nov, 16:30");

    // The new link works for someone with no login.
    const invite = await app.fetch(new URL(link!).pathname);
    expect(invite.status).toBe(200);
  });

  it("names each pending Invite's Cancel button by that Invite's label or time", async () => {
    const { alice, page } = await setUp();
    await alice.post(page, { intent: "make", label: "for Sam" });
    await alice.post(page, { intent: "make", label: "for Kim" });
    const main = mainOf(await (await alice.get(page)).text());
    const list = main.match(/<ul class="list" aria-label="Pending Invites">([\s\S]*?)<\/ul>/)![1];

    const tiles = [...list.matchAll(/<li class="list-tile">([\s\S]*?)<\/li>/g)].map(([, tile]) => tile);
    expect(tiles).toHaveLength(2);
    const ids = tiles.map((tile) => {
      const describedBy = tile.match(/<button[^>]*aria-describedby="([^"]+)"[^>]*>Cancel<\/button>/)![1];
      expect(tile).toMatch(new RegExp(`<span class="list-tile-name" id="${describedBy}">for (Sam|Kim)</span>`));
      return describedBy;
    });
    expect(new Set(ids).size).toBe(2);
  });

  it("shows a bad label's error and keeps what was typed", async () => {
    const { alice, page } = await setUp();
    const response = await alice.post(page, { intent: "make", label: "x".repeat(41) });
    const main = mainOf(await response.text());
    expect(response.status).toBe(400);
    expect(main).toContain("Error: Use at most 40 characters.");
    expect(main).toMatch(/<input[^>]*id="invite-label"[^>]*aria-invalid="true"/);
    expect(await pendingCount()).toBe(0);
  });

  it("cancels an Invite: it leaves the list and its link shows the warning", async () => {
    const { app, alice, page } = await setUp();
    const made = mainOf(await (await alice.post(page, { intent: "make", label: "for Sam" })).text());
    const link = new URL(made.match(/id="invite-link"[^>]*value="([^"]*)"/)![1]);
    const inviteId = made.match(/name="inviteId" value="([0-9]+)"/)![1];

    const response = await alice.post(page, { intent: "cancel", inviteId });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(page);
    expect(pendingTiles(mainOf(await (await alice.get(page)).text()))).toEqual([]);
    const invite = await app.fetch(link.pathname);
    expect(invite.status).toBe(404);
    expect(await invite.text()).toContain("This Invite has been used or cancelled.");
  });

  it("refuses a non-Owner's make or cancel with 403 and changes nothing", async () => {
    const { alice, bob, carol, page } = await setUp();
    const made = mainOf(await (await alice.post(page, { intent: "make", label: "" })).text());
    const inviteId = made.match(/name="inviteId" value="([0-9]+)"/)![1];

    expect((await bob.post(page, { intent: "make", label: "" })).status).toBe(403);
    expect((await bob.post(page, { intent: "cancel", inviteId })).status).toBe(403);
    expect((await carol.post(page, { intent: "make", label: "" })).status).toBe(404);
    expect(await pendingCount()).toBe(1);
  });

  it("refuses a cross-origin POST", async () => {
    const { alice, page } = await setUp();
    expect((await alice.post(page, { intent: "make", label: "" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await pendingCount()).toBe(0);
  });
});

describe("Board links", () => {
  it("gives each Tonight Board a Group link to its Group page", async () => {
    const { alice, friday } = await setUp();
    await alice.post("/groups/new", { name: "Sunday" });
    const sunday = await idOf("groups", "name", "Sunday");
    const main = mainOf(await (await alice.get("/")).text());

    const links = [...main.matchAll(/<p class="board-links"><a aria-describedby="board-([0-9]+)" href="([^"]*)"[^>]*>Group<\/a><\/p>/g)];
    expect(links.map(([, board, href]) => [href, Number(board)])).toEqual([
      [`/groups/${friday}`, friday],
      [`/groups/${sunday}`, sunday],
    ]);
  });
});
