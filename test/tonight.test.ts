import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CheckinTiles } from "~/components/checkin-tiles";
import { Notice } from "~/components/notice";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

/** The page body, with React's text-node markers dropped. */
function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
}

async function memberId(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  return row!.id;
}

/** Adds a Member to a Group directly in D1, since Invites arrive in a later ticket. */
async function join(groupId: number, username: string) {
  await env.DB.prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, '2026-11-03T12:00:00.000Z')")
    .bind(groupId, await memberId(username))
    .run();
}

async function groupId(name: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM groups WHERE name = ?1").bind(name).first<{ id: number }>();
  return row!.id;
}

/** Every Board on the page, by Group name: its banner state, pill, count line and rows. */
function boards(body: string) {
  return [...body.matchAll(/<section class="card board"[^>]*>([\s\S]*?)<\/section>/g)].map(([, inner]) => ({
    state: inner.match(/class="board-banner" data-state="([^"]*)"/)![1],
    pill: inner.match(/<p class="board-pill">([^<]*)<\/p>/)![1],
    count: inner.match(/<p class="board-count">([^<]*)<\/p>/)![1],
    name: inner.match(/<h2[^>]*class="board-name">([^<]*)<\/h2>/)![1],
    rows: [...inner.matchAll(/<li class="board-row" data-availability="([^"]*)">([\s\S]*?)<\/li>/g)].map(
      ([, availability, row]) => ({
        availability,
        name: row.match(/<span class="board-row-name">([^<]*)<\/span>/)![1],
        answer: row.match(/<span class="board-row-answer">([^<]*)<\/span>/)![1],
        note: row.match(/<p class="board-row-note">([^<]*)<\/p>/)?.[1] ?? null,
      }),
    ),
    nobody: inner.includes("Nobody has answered yet tonight."),
  }));
}

async function checkins() {
  const { results } = await env.DB.prepare(
    "SELECT member_id, game_night, availability, note FROM checkins ORDER BY game_night, member_id",
  ).all();
  return results;
}

/** Alice with one Group, "Friday", and a logged-in browser. */
async function aliceWithGroup(app = startApp()) {
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD, colour: "violet" });
  await alice.post("/groups/new", { name: "Friday" });
  return { app, alice, friday: await groupId("Friday") };
}

const answer = (availability: string) => ({ intent: "availability", availability });
const note = (text: string) => ({ intent: "note", note: text });

describe("Tonight with a Group", () => {
  it("shows the heading, the reach line, three tiles and a disabled Note before answering", async () => {
    const { alice } = await aliceWithGroup();
    const html = await (await alice.get("/")).text();
    const body = bodyOf(html);

    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("Tonight</h1>");
    expect(body).toContain("Your answer shows on your Board");
    const tiles = [...body.matchAll(/<button[^>]*name="availability"[^>]*>/g)].map(([tag]) => tag);
    expect(tiles).toHaveLength(3);
    expect(tiles.map((tag) => tag.match(/value="([^"]*)"/)![1])).toEqual(["yes", "maybe", "no"]);
    for (const tag of tiles) expect(tag).toContain('aria-pressed="false"');
    expect(body.match(/<input[^>]*id="note"[^>]*>/)![0]).toContain("disabled");
    expect(body).toContain("Answer first, then add a Note.");
    expect(body).not.toContain("You&#x27;re not in a Group yet");
  });

  it("keeps one Check-in when the answer changes and presses the chosen tile", async () => {
    const { app, alice } = await aliceWithGroup();
    expect((await alice.post("/?index", answer("yes"))).status).toBe(303);
    expect((await alice.post("/?index", answer("maybe"))).status).toBe(303);

    expect(await checkins()).toEqual([
      { member_id: await memberId("Alice"), game_night: "2026-11-03", availability: "maybe", note: null },
    ]);
    const body = bodyOf(await (await alice.get("/")).text());
    expect(body).toMatch(/<button[^>]*value="maybe"[^>]*aria-pressed="true"/);
    expect(body).toMatch(/<button[^>]*value="yes"[^>]*aria-pressed="false"/);
    expect(body.match(/<input[^>]*id="note"[^>]*>/)![0]).not.toContain("disabled");
    expect(app.clock.now().toISOString()).toBe("2026-11-03T12:00:00.000Z");
  });

  it("refuses an answer that is not Yes, Maybe or No, and offers no way to clear it", async () => {
    const { alice } = await aliceWithGroup();
    await alice.post("/?index", answer("yes"));

    for (const value of ["", "none", "later"]) {
      expect((await alice.post("/?index", answer(value))).status).toBe(400);
    }
    // An empty Note never clears the Availability.
    expect((await alice.post("/?index", note(""))).status).toBe(303);
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "yes", note: null })]);
  });

  it("refuses a Note before the Member answers", async () => {
    const { alice } = await aliceWithGroup();
    const response = await alice.post("/?index", note("on after 10"));
    const body = bodyOf(await response.text());

    expect(response.status).toBe(400);
    expect(body).toContain("Error: Answer Yes, Maybe or No before adding a Note.");
    expect(await checkins()).toEqual([]);
  });

  it("saves a Note of 140 code points, refuses 141, and removes an empty one", async () => {
    const { alice } = await aliceWithGroup();
    await alice.post("/?index", answer("yes"));

    expect((await alice.post("/?index", note("🎮".repeat(140)))).status).toBe(303);
    expect(await checkins()).toEqual([expect.objectContaining({ note: "🎮".repeat(140) })]);

    const refused = await alice.post("/?index", note("x".repeat(141)));
    const body = bodyOf(await refused.text());
    expect(refused.status).toBe(400);
    const input = body.match(/<input[^>]*id="note"[^>]*>/)![0];
    expect(input).toContain('aria-invalid="true"');
    expect(body).toMatch(/<p id="note-help" class="field-error">Error: Use at most 140 characters.<\/p>/);
    expect(await checkins()).toEqual([expect.objectContaining({ note: "🎮".repeat(140) })]);

    await alice.post("/?index", note("   "));
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "yes", note: null })]);
  });

  it("shows one Check-in on every Board of a Member in two Groups", async () => {
    const { alice } = await aliceWithGroup();
    await alice.post("/groups/new", { name: "Sunday" });
    await alice.post("/?index", answer("no"));
    await alice.post("/?index", note("busy"));

    const body = bodyOf(await (await alice.get("/")).text());
    expect(body).toContain("Your answer shows on all 2 of your Boards");
    const shown = boards(body);
    expect(shown.map((board) => board.name)).toEqual(["Friday", "Sunday"]);
    for (const board of shown) {
      expect(board.rows).toEqual([{ availability: "no", name: "You", answer: "No", note: "busy" }]);
    }
    expect(await checkins()).toHaveLength(1);
  });

  it("sorts rows Yes, Maybe, No, then no answer, and names the viewer You", async () => {
    const { app, alice, friday } = await aliceWithGroup();
    const browsers: Record<string, Awaited<ReturnType<typeof app.createLogin>>> = {};
    for (const username of ["Bob", "Cat", "Dan"]) {
      browsers[username] = await app.createLogin({ username, password: PASSWORD });
      await join(friday, username);
    }
    await browsers.Bob.post("/?index", answer("no"));
    await browsers.Cat.post("/?index", answer("yes"));
    await alice.post("/?index", answer("maybe"));

    const [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board.rows.map((row) => [row.name, row.availability, row.answer])).toEqual([
      ["Cat", "yes", "Yes"],
      ["You", "maybe", "Maybe"],
      ["Bob", "no", "No"],
      ["Dan", "none", "No answer yet"],
    ]);
    expect(board.nobody).toBe(false);
  });

  it("moves the pill from Needs to Game On to Game Off, and leaves an unrelated Group alone", async () => {
    const { app, alice, friday } = await aliceWithGroup();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    const cat = await app.createLogin({ username: "Cat", password: PASSWORD });
    await join(friday, "Bob");
    await join(friday, "Cat");
    // Bob's own Group, which Alice and Cat are not in.
    await bob.post("/groups/new", { name: "Bob's" });

    await alice.post("/?index", answer("yes"));
    let [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board).toMatchObject({ state: "needs", pill: "Needs 2 more Yes", count: "1 of 3 Yes so far" });

    await bob.post("/?index", answer("yes"));
    await cat.post("/?index", answer("yes"));
    [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board).toMatchObject({ state: "on", pill: "Game On", count: "3 of 3 Yes so far" });

    await cat.post("/?index", answer("no"));
    [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board).toMatchObject({ state: "off", pill: "Game Off", count: "2 of 3 Yes so far" });

    const bobsBoards = boards(bodyOf(await (await bob.get("/")).text()));
    expect(bobsBoards.find((b) => b.name === "Bob&#x27;s")).toMatchObject({ state: "needs", pill: "Needs 2 more Yes" });
    const { results } = await env.DB.prepare("SELECT group_id, game_night, was_on FROM group_night_state").all();
    expect(results).toEqual([{ group_id: friday, game_night: "2026-11-03", was_on: 1 }]);
  });

  it("starts a fresh Game Night at 06:00 UTC+4 and keeps last night's Check-in", async () => {
    const { app, alice } = await aliceWithGroup(startApp({ now: "2026-11-04T01:59:00Z" }));
    await alice.post("/?index", answer("yes"));
    // Just before 06:00 UTC+4 the answer counts for the night of 2026-11-03.
    expect(await checkins()).toEqual([expect.objectContaining({ game_night: "2026-11-03", availability: "yes" })]);

    app.clock.set("2026-11-04T02:00:00Z");
    const body = bodyOf(await (await alice.get("/")).text());
    const [board] = boards(body);
    expect(board.rows).toEqual([{ availability: "none", name: "You", answer: "No answer yet", note: null }]);
    expect(board).toMatchObject({ state: "needs", pill: "Needs 3 more Yes", count: "0 of 3 Yes so far", nobody: true });
    expect(body).toMatch(/<button[^>]*value="yes"[^>]*aria-pressed="false"/);
    expect(await checkins()).toHaveLength(1);
  });

  it("shows a failed save with Try again and writes nothing when part of the save fails", async () => {
    const { alice, friday } = await aliceWithGroup();
    await alice.post("/?index", answer("no"));
    // Make one Yes reach Game On, then make that Game On step fail, so the
    // batch fails after its Check-in upsert ran.
    await env.DB.prepare("UPDATE groups SET threshold = 1 WHERE id = ?1").bind(friday).run();
    await env.DB.prepare(
      "CREATE TRIGGER fail_game_on BEFORE INSERT ON group_night_state BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();

    const response = await alice.post("/?index", answer("yes"));
    const body = bodyOf(await response.text());

    expect(response.status).toBe(503);
    expect(body).toMatch(/<div class="notice-error" role="alert"><p class="notice-title">Can&#x27;t save your answer<\/p>/);
    expect(body).toContain('<button type="button" class="btn-secondary">Try again</button>');
    // The batch is one transaction: the Check-in keeps the last saved answer.
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "no" })]);
  });

  it("shows a failed Note save with Try again, keeps the typed Note and writes nothing", async () => {
    const { alice } = await aliceWithGroup();
    await alice.post("/?index", answer("yes"));
    await alice.post("/?index", note("busy"));
    await env.DB.prepare(
      "CREATE TRIGGER fail_note BEFORE UPDATE OF note ON checkins BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();

    const response = await alice.post("/?index", note("on after 10"));
    const body = bodyOf(await response.text());

    expect(response.status).toBe(503);
    expect(body).toMatch(/<div class="notice-error" role="alert"><p class="notice-title">Can&#x27;t save your Note<\/p>/);
    expect(body.match(/role="alert"/g)).toHaveLength(1);
    expect(body).toContain('<button type="button" class="btn-secondary">Try again</button>');
    expect(body.match(/<input[^>]*id="note"[^>]*>/)![0]).toContain('value="on after 10"');
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "yes", note: "busy" })]);
  });

  it("refuses an unknown or missing intent and writes nothing", async () => {
    const { alice } = await aliceWithGroup();

    expect((await alice.post("/?index", { intent: "foo", availability: "yes" })).status).toBe(400);
    expect((await alice.post("/?index", { availability: "yes" })).status).toBe(400);
    expect(await checkins()).toEqual([]);
  });

  it("refuses a cross-origin Check-in", async () => {
    const { alice } = await aliceWithGroup();
    const response = await alice.post("/?index", answer("yes"), { origin: "https://evil.test" });

    expect(response.status).toBe(403);
    expect(await checkins()).toEqual([]);
  });
});

describe("check-in states", () => {
  it("dims the tapped tile and says Saving your answer… while the saved answer stays pressed", () => {
    const html = renderToString(createElement(CheckinTiles, { chosen: "no", pending: "yes" }));

    expect(html).toMatch(/<button[^>]*value="yes"[^>]*aria-pressed="false"[^>]*aria-busy="true"/);
    expect(html).toMatch(/<button[^>]*value="no"[^>]*aria-pressed="true"/);
    expect(html).not.toMatch(/<button[^>]*value="no"[^>]*aria-busy/);
    expect(html).toContain('<p class="checkin-status" role="status">Saving your answer…</p>');
  });

  it("keeps an empty live region while idle", () => {
    const html = renderToString(createElement(CheckinTiles, { chosen: null, pending: null }));

    expect(html).not.toContain("aria-busy");
    expect(html).toContain('<p class="checkin-status" role="status"></p>');
  });

  it("shows a failed save as an alert with Try again", () => {
    const html = renderToString(
      createElement(Notice, {
        tone: "error",
        title: "Can't save your answer",
        retry: () => {},
        children: "Your answer did not save.",
      }),
    );

    expect(html).toMatch(/^<div class="notice-error" role="alert">/);
    expect(html).toContain('<button type="button" class="btn-secondary">Try again</button>');
  });
});
