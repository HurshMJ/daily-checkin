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
        name: row.match(/class="board-row-name">([^<]*)</)![1],
        answer: row.match(/<span class="board-row-answer">([^<]*)<\/span>/)![1],
        note: row.match(/<p class="board-row-note">([^<]*)<\/p>/)?.[1] ?? null,
      }),
    ),
    nobody: inner.includes("Nobody has answered yet tonight."),
  }));
}

/** Every Check-in, in every Group. */
async function checkins() {
  const { results } = await env.DB.prepare(
    "SELECT group_id, member_id, game_night, availability, note FROM group_checkins ORDER BY game_night, group_id, member_id",
  ).all();
  return results;
}

/** One Board's own section of the page, by Group name. */
function boardSection(body: string, name: string): string {
  const section = [...body.matchAll(/<section class="card board"[^>]*>[\s\S]*?<\/section>/g)]
    .map(([html]) => html)
    .find((html) => html.includes(`class="board-name">${name}</h2>`));
  if (!section) throw new Error(`No Board named ${name}`);
  return section;
}

/** Alice with one Group, "Friday", and a logged-in browser. */
async function aliceWithGroup(app = startApp()) {
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD, colour: "violet", canCreateGroups: true });
  await alice.post("/groups/new", { name: "Friday" });
  return { app, alice, friday: await groupId("Friday") };
}

const answer = (groupId: number, availability: string) => ({ intent: "availability", groupId: String(groupId), availability });
const note = (groupId: number, text: string) => ({ intent: "note", groupId: String(groupId), note: text });

describe("Tonight with a Group", () => {
  it("shows the heading and, on the Board, three tiles and a disabled Note before answering", async () => {
    const { alice, friday } = await aliceWithGroup();
    const html = await (await alice.get("/")).text();
    const body = bodyOf(html);

    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("Tonight</h1>");
    expect(body).not.toContain("Your answer shows");
    expect(body).not.toContain('aria-label="Your answer"');
    const board = boardSection(body, "Friday");
    const tiles = [...board.matchAll(/<button[^>]*name="availability"[^>]*>/g)].map(([tag]) => tag);
    expect(tiles).toHaveLength(3);
    expect(tiles.map((tag) => tag.match(/value="([^"]*)"/)![1])).toEqual(["yes", "maybe", "no"]);
    for (const tag of tiles) {
      expect(tag).toContain('aria-pressed="false"');
      expect(tag).toContain(`aria-describedby="board-${friday}"`);
    }
    expect(board.match(/<input type="hidden" name="groupId" value="(\d+)"\/>/g)).toEqual([
      `<input type="hidden" name="groupId" value="${friday}"/>`,
      `<input type="hidden" name="groupId" value="${friday}"/>`,
    ]);
    expect(board.match(new RegExp(`<input[^>]*id="note-${friday}"[^>]*>`))![0]).toContain("disabled");
    expect(body).toContain("Answer first, then add a Note.");
    expect(body).not.toContain("You&#x27;re not in a Group yet");
  });

  it("keeps one Check-in when the answer changes and presses the chosen tile", async () => {
    const { app, alice, friday } = await aliceWithGroup();
    expect((await alice.post("/?index", answer(friday, "yes"))).status).toBe(303);
    expect((await alice.post("/?index", answer(friday, "maybe"))).status).toBe(303);

    expect(await checkins()).toEqual([
      { group_id: friday, member_id: await memberId("Alice"), game_night: "2026-11-03", availability: "maybe", note: null },
    ]);
    const body = bodyOf(await (await alice.get("/")).text());
    expect(body).toMatch(/<button[^>]*value="maybe"[^>]*aria-pressed="true"/);
    expect(body).toMatch(/<button[^>]*value="yes"[^>]*aria-pressed="false"/);
    expect(body.match(new RegExp(`<input[^>]*id="note-${friday}"[^>]*>`))![0]).not.toContain("disabled");
    expect(app.clock.now().toISOString()).toBe("2026-11-03T12:00:00.000Z");
  });

  it("refuses an answer that is not Yes, Maybe or No, and offers no way to clear it", async () => {
    const { alice, friday } = await aliceWithGroup();
    await alice.post("/?index", answer(friday, "yes"));

    for (const value of ["", "none", "later"]) {
      expect((await alice.post("/?index", answer(friday, value))).status).toBe(400);
    }
    // An empty Note never clears the Availability.
    expect((await alice.post("/?index", note(friday, ""))).status).toBe(303);
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "yes", note: null })]);
  });

  it("refuses a Note before the Member answers", async () => {
    const { alice, friday } = await aliceWithGroup();
    const response = await alice.post("/?index", note(friday, "on after 10"));
    const body = bodyOf(await response.text());

    expect(response.status).toBe(400);
    expect(body).toContain("Error: Answer Yes, Maybe or No before adding a Note.");
    expect(await checkins()).toEqual([]);
  });

  it("saves a Note of 140 code points, refuses 141, and removes an empty one", async () => {
    const { alice, friday } = await aliceWithGroup();
    await alice.post("/?index", answer(friday, "yes"));

    expect((await alice.post("/?index", note(friday, "🎮".repeat(140)))).status).toBe(303);
    expect(await checkins()).toEqual([expect.objectContaining({ note: "🎮".repeat(140) })]);

    const refused = await alice.post("/?index", note(friday, "x".repeat(141)));
    const body = bodyOf(await refused.text());
    expect(refused.status).toBe(400);
    const input = body.match(new RegExp(`<input[^>]*id="note-${friday}"[^>]*>`))![0];
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain(`aria-describedby="note-help-${friday} board-${friday}"`);
    expect(body).toContain(`<p id="note-help-${friday}" class="field-error">Error: Use at most 140 characters.</p>`);
    expect(await checkins()).toEqual([expect.objectContaining({ note: "🎮".repeat(140) })]);

    await alice.post("/?index", note(friday, "   "));
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "yes", note: null })]);
  });

  it("answers each Board of a Member in two Groups separately, with its own Note", async () => {
    const { alice, friday } = await aliceWithGroup();
    await alice.post("/groups/new", { name: "Sunday" });
    const sunday = await groupId("Sunday");
    await alice.post("/?index", answer(friday, "yes"));
    await alice.post("/?index", answer(sunday, "no"));
    await alice.post("/?index", note(sunday, "busy"));

    const body = bodyOf(await (await alice.get("/")).text());
    const shown = boards(body);
    expect(shown.map((board) => board.name)).toEqual(["Friday", "Sunday"]);
    expect(shown[0].rows).toEqual([{ availability: "yes", name: "You", answer: "Yes", note: null }]);
    expect(shown[0].count).toBe("1 of 3 Yes so far");
    expect(shown[1].rows).toEqual([{ availability: "no", name: "You", answer: "No", note: "busy" }]);
    expect(shown[1].count).toBe("0 of 3 Yes so far");
    expect(boardSection(body, "Friday")).toMatch(/<button[^>]*value="yes"[^>]*aria-pressed="true"/);
    expect(boardSection(body, "Sunday")).toMatch(/<button[^>]*value="no"[^>]*aria-pressed="true"/);
    expect(boardSection(body, "Sunday")).toMatch(new RegExp(`<input[^>]*id="note-${sunday}"[^>]*value="busy"`));
    expect(await checkins()).toHaveLength(2);
  });

  it("gives every control its own id and names its Group, with two Boards on the page", async () => {
    const { alice, friday } = await aliceWithGroup();
    await alice.post("/groups/new", { name: "Sunday" });
    const sunday = await groupId("Sunday");
    const body = bodyOf(await (await alice.get("/")).text());

    const ids = [...body.matchAll(/\sid="([^"]*)"/g)].map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of [friday, sunday]) {
      expect(ids).toEqual(expect.arrayContaining([`board-${group}`, `note-${group}`, `note-help-${group}`]));
      expect(body).toContain(`<label class="field-label" for="note-${group}">`);
    }
    // Every Yes / Maybe / No tile and Save button is described by its Board's heading.
    const described = [...body.matchAll(/<button[^>]*type="submit"[^>]*>/g)].map(([tag]) => tag.match(/aria-describedby="([^"]*)"/)?.[1]);
    expect(described).toEqual([...Array(4).fill(`board-${friday}`), ...Array(4).fill(`board-${sunday}`)]);
  });

  it("refuses a missing or malformed groupId with 400 and a Group the Member is not in with 404", async () => {
    const { app, alice, friday } = await aliceWithGroup();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD, canCreateGroups: true });
    await bob.post("/groups/new", { name: "Bob's" });
    const bobs = await groupId("Bob's");

    expect((await alice.post("/?index", { intent: "availability", availability: "yes" })).status).toBe(400);
    for (const value of ["", "0", "-1", "1.5", "abc", "99999999999999999999"]) {
      expect((await alice.post("/?index", { intent: "availability", groupId: value, availability: "yes" })).status).toBe(400);
      expect((await alice.post("/?index", { intent: "note", groupId: value, note: "hi" })).status).toBe(400);
    }
    expect((await alice.post("/?index", answer(bobs, "yes"))).status).toBe(404);
    expect((await alice.post("/?index", note(bobs, "hi"))).status).toBe(404);
    expect((await alice.post("/?index", answer(friday + bobs + 100, "yes"))).status).toBe(404);
    expect(await checkins()).toEqual([]);
  });

  it("sorts rows Yes, Maybe, No, then no answer, and names the viewer You", async () => {
    const { app, alice, friday } = await aliceWithGroup();
    const browsers: Record<string, Awaited<ReturnType<typeof app.createLogin>>> = {};
    for (const username of ["Bob", "Cat", "Dan"]) {
      browsers[username] = await app.createLogin({ username, password: PASSWORD });
      await join(friday, username);
    }
    await browsers.Bob.post("/?index", answer(friday, "no"));
    await browsers.Cat.post("/?index", answer(friday, "yes"));
    await alice.post("/?index", answer(friday, "maybe"));

    const [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board.rows.map((row) => [row.name, row.availability, row.answer])).toEqual([
      ["Cat", "yes", "Yes"],
      ["You", "maybe", "Maybe"],
      ["Bob", "no", "No"],
      ["Dan", "none", "No answer yet"],
    ]);
    expect(board.nobody).toBe(false);
  });

  it("shows each row's dot and Shown name, reveals @username without JavaScript, and orders by Shown name", async () => {
    const { app, alice, friday } = await aliceWithGroup();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD, colour: "pink" });
    await app.createLogin({ username: "Carol", password: PASSWORD, colour: "sky" });
    await join(friday, "Bob");
    await join(friday, "Carol");

    let [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board.rows.map((row) => row.name)).toEqual(["You", "Bob", "Carol"]);

    await bob.post("/profile", { intent: "names", username: "Bob", displayName: "Zed 🎲", colour: "pink" });
    const body = bodyOf(await (await alice.get("/")).text());
    [board] = boards(body);

    expect(board.rows.map((row) => row.name)).toEqual(["You", "Carol", "Zed 🎲"]);
    const rows = [...body.matchAll(/<li class="board-row"[^>]*>([\s\S]*?)<\/li>/g)].map(([, row]) => row);
    expect(rows.map((row) => row.match(/^<div class="board-row-who"><span class="avatar-dot" data-colour="([a-z]+)"/)?.[1])).toEqual([
      "violet",
      "sky",
      "pink",
    ]);
    expect(rows[0]).toContain('<span class="board-row-name">You</span>');
    expect(rows[0]).not.toContain("<details");
    expect(rows[2]).toContain(
      '<details class="board-row-reveal"><summary class="board-row-name">Zed 🎲</summary><span class="board-row-username">@Bob</span></details>',
    );
    expect(rows[1]).toContain(
      '<details class="board-row-reveal"><summary class="board-row-name">Carol</summary><span class="board-row-username">@Carol</span></details>',
    );
  });

  it("moves the pill from Needs to Game On to Game Off, and leaves an unrelated Group alone", async () => {
    const { app, alice, friday } = await aliceWithGroup();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD, canCreateGroups: true });
    const cat = await app.createLogin({ username: "Cat", password: PASSWORD });
    await join(friday, "Bob");
    await join(friday, "Cat");
    // Bob's own Group, which Alice and Cat are not in.
    await bob.post("/groups/new", { name: "Bob's" });

    await alice.post("/?index", answer(friday, "yes"));
    let [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board).toMatchObject({ state: "needs", pill: "Needs 2 more Yes", count: "1 of 3 Yes so far" });

    await bob.post("/?index", answer(friday, "yes"));
    await cat.post("/?index", answer(friday, "yes"));
    [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board).toMatchObject({ state: "on", pill: "Game On", count: "3 of 3 Yes so far" });

    await cat.post("/?index", answer(friday, "no"));
    [board] = boards(bodyOf(await (await alice.get("/")).text()));
    expect(board).toMatchObject({ state: "off", pill: "Game Off", count: "2 of 3 Yes so far" });

    const bobsBoards = boards(bodyOf(await (await bob.get("/")).text()));
    // Bob's Yes was for Friday only, so his own Group has no Yes yet.
    expect(bobsBoards.find((b) => b.name === "Bob&#x27;s")).toMatchObject({ state: "needs", pill: "Needs 3 more Yes" });
    const { results } = await env.DB.prepare("SELECT group_id, game_night, was_on FROM group_night_state").all();
    expect(results).toEqual([{ group_id: friday, game_night: "2026-11-03", was_on: 1 }]);
  });

  it("starts a fresh Game Night at 06:00 UTC+4 and keeps last night's Check-in", async () => {
    const { app, alice, friday } = await aliceWithGroup(startApp({ now: "2026-11-04T01:59:00Z" }));
    await alice.post("/?index", answer(friday, "yes"));
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
    await alice.post("/?index", answer(friday, "no"));
    // Make one Yes reach Game On, then make that Game On step fail, so the
    // batch fails after its Check-in upsert ran.
    await env.DB.prepare("UPDATE groups SET threshold = 1 WHERE id = ?1").bind(friday).run();
    await env.DB.prepare(
      "CREATE TRIGGER fail_game_on BEFORE INSERT ON group_night_state BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();

    const response = await alice.post("/?index", answer(friday, "yes"));
    const body = bodyOf(await response.text());

    expect(response.status).toBe(503);
    expect(body).toMatch(/<div class="notice-error" role="alert"><p class="notice-title">Can&#x27;t save your answer<\/p>/);
    expect(body).toContain('<button type="button" class="btn-secondary">Try again</button>');
    // The batch is one transaction: the Check-in keeps the last saved answer.
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "no" })]);
  });

  it("shows a failed Note save with Try again, keeps the typed Note and writes nothing", async () => {
    const { alice, friday } = await aliceWithGroup();
    await alice.post("/?index", answer(friday, "yes"));
    await alice.post("/?index", note(friday, "busy"));
    await env.DB.prepare(
      "CREATE TRIGGER fail_note BEFORE UPDATE OF note ON group_checkins BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    ).run();

    const response = await alice.post("/?index", note(friday, "on after 10"));
    const body = bodyOf(await response.text());

    expect(response.status).toBe(503);
    expect(body).toMatch(/<div class="notice-error" role="alert"><p class="notice-title">Can&#x27;t save your Note<\/p>/);
    expect(body.match(/role="alert"/g)).toHaveLength(1);
    expect(body).toContain('<button type="button" class="btn-secondary">Try again</button>');
    expect(body.match(new RegExp(`<input[^>]*id="note-${friday}"[^>]*>`))![0]).toContain('value="on after 10"');
    expect(await checkins()).toEqual([expect.objectContaining({ availability: "yes", note: "busy" })]);
  });

  it("shows a failed save only on the Board it was posted from", async () => {
    const { alice, friday } = await aliceWithGroup();
    await alice.post("/groups/new", { name: "Sunday" });
    await env.DB.prepare(
      `CREATE TRIGGER fail_friday BEFORE INSERT ON group_checkins WHEN NEW.group_id = ${friday}
       BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
    ).run();

    const response = await alice.post("/?index", answer(friday, "yes"));
    const body = bodyOf(await response.text());

    expect(response.status).toBe(503);
    expect(body.match(/role="alert"/g)).toHaveLength(1);
    expect(boardSection(body, "Friday")).toContain("Can&#x27;t save your answer");
    expect(boardSection(body, "Sunday")).not.toContain('role="alert"');
    expect(await checkins()).toEqual([]);
  });

  it("refuses an unknown or missing intent and writes nothing", async () => {
    const { alice, friday } = await aliceWithGroup();
    const group = String(friday);

    expect((await alice.post("/?index", { intent: "foo", groupId: group, availability: "yes" })).status).toBe(400);
    expect((await alice.post("/?index", { groupId: group, availability: "yes" })).status).toBe(400);
    expect(await checkins()).toEqual([]);
  });

  it("refuses a cross-origin Check-in", async () => {
    const { alice, friday } = await aliceWithGroup();
    const response = await alice.post("/?index", answer(friday, "yes"), { origin: "https://evil.test" });

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
