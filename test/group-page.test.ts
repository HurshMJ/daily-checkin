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
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD, colour: "violet", canCreateGroups: true });
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
    expect(main).toMatch(/<input[^>]*id="group-name"[^>]*value="Friday"/);
    expect(main).toContain('<p class="stepper-value" role="status">3 Yes</p>');

    const tiles = [...main.matchAll(/<li class="list-tile">([\s\S]*?)<\/li>/g)].map(([, tile]) => tile);
    expect(tiles[0]).toContain('data-colour="violet"');
    expect(tiles[0]).toContain('<span class="list-tile-name">Alice</span><span class="list-tile-detail">@Alice</span>');
    expect(tiles[0]).toContain('<span class="list-tile-tag">Owner</span>');
    expect(tiles[0]).not.toContain("Manage");
    expect(tiles[1]).toMatch(/<span class="list-tile-name" id="member-\d+-name">Bob<\/span>/);
    expect(tiles[1]).not.toContain("list-tile-tag");
    expect(tiles[1]).toContain(">Manage</summary>");

    expect(main).toContain('<h2 id="invites-heading">Invites</h2>');
    expect(main).toMatch(/<label[^>]*for="invite-label"[^>]*>Who is it for\?<\/label>/);
    expect(main).toContain("Optional, only you see it.");
    expect(main).toMatch(/<button[^>]*type="submit"[^>]*>Make an Invite<\/button>/);
    expect(main).toContain("No pending Invites.");
  });

  it("shows each Member's Shown name in bold with @username below", async () => {
    const { alice, bob, page } = await setUp();
    await bob.post("/profile", { intent: "names", username: "Bob", displayName: "Zed 🎲", colour: "sky" });

    const main = mainOf(await (await alice.get(page)).text());
    const tiles = [...main.matchAll(/<li class="list-tile">([\s\S]*?)<\/li>/g)].map(([, tile]) => tile);

    expect(tiles[1]).toMatch(/<span class="list-tile-name" id="member-\d+-name">Zed 🎲<\/span><span class="list-tile-detail">@Bob<\/span>/);
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
    const invite = await app.device().open(new URL(link!).pathname);
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
    const invite = await app.device().open(link.pathname);
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
  it("gives each Tonight Board a Group link and a History link, described by its Group name", async () => {
    const { alice, friday } = await setUp();
    await alice.post("/groups/new", { name: "Sunday" });
    const sunday = await idOf("groups", "name", "Sunday");
    const main = mainOf(await (await alice.get("/")).text());

    const links = [
      ...main.matchAll(
        /<p class="board-links"><a aria-describedby="board-([0-9]+)" href="([^"]*)"[^>]*>Group<\/a><a aria-describedby="board-([0-9]+)" href="([^"]*)"[^>]*>History<\/a><\/p>/g,
      ),
    ];
    expect(links.map(([, board, group, historyBoard, history]) => [group, history, Number(board), Number(historyBoard)])).toEqual([
      [`/groups/${friday}`, `/groups/${friday}/history`, friday, friday],
      [`/groups/${sunday}`, `/groups/${sunday}/history`, sunday, sunday],
    ]);
  });
});

async function groupRow(groupId: number) {
  return env.DB.prepare("SELECT name, threshold, owner_id FROM groups WHERE id = ?1").bind(groupId).first<{
    name: string;
    threshold: number;
    owner_id: number;
  }>();
}

async function membersOf(groupId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?1").bind(groupId).first<{ n: number }>();
  return row!.n;
}

describe("Owner settings on the Group page", () => {
  it("gives the Owner the Basics, Members, Invites and Owner actions cards, in that order", async () => {
    const { alice, page } = await setUp();
    const main = mainOf(await (await alice.get(page)).text());
    const headings = [...main.matchAll(/<h2 id="[^"]*">([^<]*)<\/h2>/g)].map(([, text]) => text);
    expect(headings).toEqual(["Basics", "Members", "Invites", "Owner actions"]);
    expect(main).toMatch(/<button[^>]*class="btn-destructive"[^>]*>Delete Group<\/button>/);
    const stepper = main.match(/<form class="stepper"[\s\S]*?<\/form>/)![0];
    expect(stepper).toContain('<input type="hidden" name="intent" value="threshold"/>');
    expect(stepper).toMatch(/<button value="2" aria-label="Lower the threshold to 2 Yes" type="submit" class="stepper-btn" name="threshold">−<\/button>/);
    expect(stepper).toContain('<p class="stepper-value" role="status">3 Yes</p>');
    expect(stepper).toMatch(/<button value="4" aria-label="Raise the threshold to 4 Yes" type="submit" class="stepper-btn" name="threshold">\+<\/button>/);
  });

  it("shows a non-Owner no form, no Manage and no Owner actions", async () => {
    const { bob, page } = await setUp();
    const main = mainOf(await (await bob.get(page)).text());
    expect(main).not.toContain("<form");
    expect(main).not.toContain("Manage");
    expect(main).not.toContain("Owner actions");
    expect(main).not.toContain("stepper");
  });

  it("disables − at 1 and + at 99", async () => {
    const { alice, friday, page } = await setUp();
    await alice.post(page, { intent: "threshold", threshold: "1" });
    let main = mainOf(await (await alice.get(page)).text());
    expect(main).toMatch(/<button[^>]*value="0"[^>]*disabled=""[^>]*>−<\/button>/);
    expect(main).not.toMatch(/<button[^>]*value="2"[^>]*disabled=""/);

    await alice.post(page, { intent: "threshold", threshold: "99" });
    main = mainOf(await (await alice.get(page)).text());
    expect(main).toMatch(/<button[^>]*value="100"[^>]*disabled=""[^>]*>\+<\/button>/);
    expect((await groupRow(friday))?.threshold).toBe(99);
  });

  it("renames the Group and shows a bad name's error with the typed value kept", async () => {
    const { alice, friday, page } = await setUp();
    const renamed = await alice.post(page, { intent: "rename", name: " Saturday 🎲 " });
    expect(renamed.status).toBe(303);
    expect(renamed.headers.get("Location")).toBe(page);
    expect(mainOf(await (await alice.get(page)).text())).toContain("<h1>Saturday 🎲</h1>");

    const long = "x".repeat(41);
    const refused = await alice.post(page, { intent: "rename", name: long });
    const main = mainOf(await refused.text());
    expect(refused.status).toBe(400);
    const input = main.match(/<input[^>]*id="group-name"[^>]*>/)![0];
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain(`value="${long}"`);
    expect(main).toContain('<p id="group-name-help" class="field-error">Error: Use 1 to 40 characters.</p>');
    expect((await groupRow(friday))?.name).toBe("Saturday 🎲");
  });

  it("sets a typed threshold and shows a bad one's error with the typed value kept", async () => {
    const { alice, friday, page } = await setUp();
    expect((await alice.post(page, { intent: "threshold", typed: "yes", threshold: "5" })).status).toBe(303);
    expect((await groupRow(friday))?.threshold).toBe(5);

    const refused = await alice.post(page, { intent: "threshold", typed: "yes", threshold: "100" });
    const main = mainOf(await refused.text());
    expect(refused.status).toBe(400);
    const input = main.match(/<input[^>]*id="threshold"[^>]*>/)![0];
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('value="100"');
    expect(main).toContain('<p id="threshold-help" class="field-error">Error: Use a whole number from 1 to 99.</p>');
    expect((await groupRow(friday))?.threshold).toBe(5);
  });

  it("arms Make Owner on a first tap without the confirmation and hands over on the second", async () => {
    const { alice, bob, friday, page } = await setUp();
    const bobId = await idOf("members", "username", "Bob");
    const first = await alice.post(page, { intent: "hand-over", memberId: String(bobId) });
    const main = mainOf(await first.text());
    expect(first.status).toBe(200);
    expect(main).toMatch(/<details class="manage" open="">/);
    expect(main).toMatch(/<button[^>]*data-armed="true"[^>]*>Tap again to make Bob Owner<\/button>/);
    expect((await groupRow(friday))?.owner_id).not.toBe(bobId);

    const second = await alice.post(page, { intent: "hand-over", memberId: String(bobId), confirm: "yes" });
    expect(second.status).toBe(303);
    expect((await groupRow(friday))?.owner_id).toBe(bobId);
    // Alice is now an ordinary Member: read-only page, and her Owner posts are refused.
    expect(mainOf(await (await alice.get(page)).text())).not.toContain("<form");
    expect((await alice.post(page, { intent: "delete", confirm: "yes" })).status).toBe(403);
    expect(mainOf(await (await bob.get(page)).text())).toContain("Owner actions");
  });

  it("removes a Member only on the confirmed tap; the removed Member loses the page", async () => {
    const { alice, bob, friday, page } = await setUp();
    const bobId = String(await idOf("members", "username", "Bob"));
    const first = await alice.post(page, { intent: "remove", memberId: bobId });
    expect(mainOf(await first.text())).toMatch(/<button[^>]*data-armed="true"[^>]*>Tap again to remove Bob<\/button>/);
    expect(await membersOf(friday)).toBe(2);

    expect((await alice.post(page, { intent: "remove", memberId: bobId, confirm: "yes" })).status).toBe(303);
    expect(await membersOf(friday)).toBe(1);
    expect((await bob.get(page)).status).toBe(404);
    expect(mainOf(await (await bob.get("/")).text())).not.toContain("Friday");
  });

  it("deletes the Group only on the confirmed tap and lands on Tonight", async () => {
    const { alice, friday, page } = await setUp();
    const first = await alice.post(page, { intent: "delete" });
    expect(mainOf(await first.text())).toMatch(
      /<button[^>]*data-armed="true"[^>]*>Tap again to delete Friday for everyone<\/button>/,
    );
    expect(await groupRow(friday)).not.toBeNull();

    const second = await alice.post(page, { intent: "delete", confirm: "yes" });
    expect(second.status).toBe(303);
    expect(second.headers.get("Location")).toBe("/");
    expect(await groupRow(friday)).toBeNull();
    expect((await alice.get(page)).status).toBe(404);
  });

  it("refuses every Owner intent from a non-Owner with 403, from an outsider with 404, and an unknown intent with 400", async () => {
    const { alice, bob, carol, friday, page } = await setUp();
    const aliceId = String(await idOf("members", "username", "Alice"));
    const posts: Record<string, string>[] = [
      { intent: "rename", name: "Mine" },
      { intent: "threshold", threshold: "1" },
      { intent: "hand-over", memberId: aliceId, confirm: "yes" },
      { intent: "remove", memberId: aliceId, confirm: "yes" },
      { intent: "delete", confirm: "yes" },
    ];
    for (const form of posts) {
      expect((await bob.post(page, form)).status, form.intent).toBe(403);
      expect((await carol.post(page, form)).status, form.intent).toBe(404);
    }
    expect((await alice.post(page, { intent: "archive" })).status).toBe(400);
    expect(await groupRow(friday)).toMatchObject({ name: "Friday", threshold: 3, owner_id: Number(aliceId) });
    expect(await membersOf(friday)).toBe(2);
  });

  it("gives each Member's Manage, Make Owner and Remove a description naming that Member", async () => {
    const { alice, friday, page } = await setUp();
    const carolId = await idOf("members", "username", "Carol");
    await env.DB.prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, '2026-11-03T12:02:00.000Z')")
      .bind(friday, carolId)
      .run();
    const main = mainOf(await (await alice.get(page)).text());
    const summaries = [...main.matchAll(/<summary class="btn-small" aria-describedby="([^"]+)">Manage<\/summary>/g)].map(
      ([, id]) => id,
    );
    expect(summaries).toHaveLength(2);
    expect(new Set(summaries).size).toBe(2);
    for (const id of summaries) {
      expect(main).toMatch(new RegExp(`<span class="list-tile-name" id="${id}">(Bob|Carol)</span>`));
      expect([...main.matchAll(new RegExp(`<button[^>]*aria-describedby="${id}"[^>]*>(Make Owner|Remove)</button>`, "g"))]).toHaveLength(2);
    }
  });

  it("updates the Tonight pill after a threshold change", async () => {
    const { alice, bob, friday, page } = await setUp();
    await alice.post("/?index", { intent: "availability", groupId: String(friday), availability: "yes" });
    await bob.post("/?index", { intent: "availability", groupId: String(friday), availability: "yes" });
    expect(mainOf(await (await alice.get("/")).text())).toContain('<p class="board-pill">Needs 1 more Yes</p>');
    await alice.post(page, { intent: "threshold", threshold: "2" });
    expect(mainOf(await (await alice.get("/")).text())).toContain('<p class="board-pill">Game On</p>');
  });
});

describe("Password Reset Links on the Group page", () => {
  async function linkRows(): Promise<{ member_id: number; made_by: number | null; used_at: string | null; cancelled_at: string | null }[]> {
    const { results } = await env.DB.prepare("SELECT member_id, made_by, used_at, cancelled_at FROM password_reset_links").all<{
      member_id: number;
      made_by: number | null;
      used_at: string | null;
      cancelled_at: string | null;
    }>();
    return results;
  }

  it("offers Make Password Reset Link in each other Member's Manage, described by that Member", async () => {
    const { alice, bob, page } = await setUp();
    const bobId = await idOf("members", "username", "Bob");
    const main = mainOf(await (await alice.get(page)).text());
    expect(main).toMatch(
      new RegExp(`<button[^>]*aria-describedby="member-${bobId}-name"[^>]*>Make Password Reset Link</button>`),
    );
    expect(main.match(/Make Password Reset Link/g)).toHaveLength(1);
    expect(mainOf(await (await bob.get(page)).text())).not.toContain("Password Reset Link");
  });

  it("shows a new link once, open in Manage, then only when it stops working and a Cancel", async () => {
    const { app, alice, page } = await setUp();
    const bobId = await idOf("members", "username", "Bob");
    const made = await alice.post(page, { intent: "reset-link", memberId: String(bobId) });
    expect(made.status).toBe(200);
    expect(made.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(made.headers.get("Cache-Control")).toBe("no-store");
    const main = mainOf(await made.text());
    const link = main.match(/<input[^>]*id="reset-link-\d+"[^>]*value="([^"]*)"/)?.[1] ?? "";
    expect(link).toMatch(new RegExp(`^${APP_ORIGIN}/reset/[A-Za-z0-9_-]{43}$`));
    expect(main).toContain("New Password Reset Link for Bob");
    expect(main).toContain("It works once, for 1 hour.");
    expect(main).toMatch(/<details class="manage" open="">/);

    const token = link.slice(link.lastIndexOf("/") + 1);
    const later = mainOf(await (await alice.get(page)).text());
    expect(later).not.toContain(token);
    // Made at 12:01 UTC, so it works until 17:01 in UTC+4.
    expect(later).toContain(`Password Reset Link works until ${zoneDayTime(new Date("2026-11-03T13:01:00Z"))}`);
    expect(later).toMatch(/<button[^>]*>Cancel link<\/button>/);

    expect((await app.device().open(new URL(link).pathname)).status).toBe(200);
  });

  it("cancels the Owner's pending link: it drops out and stops working", async () => {
    const { app, alice, page } = await setUp();
    const bobId = await idOf("members", "username", "Bob");
    const made = mainOf(await (await alice.post(page, { intent: "reset-link", memberId: String(bobId) })).text());
    const path = new URL(made.match(/value="(https:[^"]+\/reset\/[^"]+)"/)![1]).pathname;

    const cancelled = await alice.post(page, { intent: "cancel-reset-link", memberId: String(bobId) });
    expect(cancelled.status).toBe(303);
    expect(mainOf(await (await alice.get(page)).text())).not.toContain("Cancel link");
    expect((await app.device().open(path)).status).toBe(404);
  });

  it("refuses a non-Owner with 403 and makes nothing for the Owner themselves", async () => {
    const { alice, bob, page } = await setUp();
    const aliceId = await idOf("members", "username", "Alice");
    const bobId = await idOf("members", "username", "Bob");
    expect((await bob.post(page, { intent: "reset-link", memberId: String(aliceId) })).status).toBe(403);
    expect((await bob.post(page, { intent: "cancel-reset-link", memberId: String(aliceId) })).status).toBe(403);
    expect((await alice.post(page, { intent: "reset-link", memberId: String(aliceId) })).status).toBe(303);
    expect((await alice.post(page, { intent: "reset-link", memberId: "x" })).status).toBe(400);
    expect(await linkRows()).toEqual([]);

    await alice.post(page, { intent: "reset-link", memberId: String(bobId) });
    expect(await linkRows()).toEqual([{ member_id: bobId, made_by: aliceId, used_at: null, cancelled_at: null }]);
  });
});
