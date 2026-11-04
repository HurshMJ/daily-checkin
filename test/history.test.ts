import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createCheckins, type Availability } from "~/checkins";
import { createGroups } from "~/groups";
import { createHistory, sortYesCounts, type YesCount } from "~/history";
import { createInvites } from "~/invites";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
}

/** The page's words, without the router's data. */
function mainOf(html: string): string {
  const body = bodyOf(html);
  return body.slice(body.indexOf("<main"), body.indexOf("</main>"));
}

async function memberId(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  return row!.id;
}

/** Each Yes-count line as "name: text", in page order. */
function yesCountLines(main: string): string[] {
  return [
    ...main.matchAll(
      /<li class="yes-count">[\s\S]*?<span class="yes-count-name">([^<]*)<\/span><span class="yes-count-number">([\s\S]*?)<\/span><svg/g,
    ),
  ].map(([, name, text]) => `${name}: ${text.replace(/<[^>]+>/g, "")}`);
}

/** Each past night tile as [href, date, count line, pill state, pill text], in page order. */
function tiles(main: string): string[][] {
  return [
    ...main.matchAll(
      /<a class="past-night" href="([^"]*)"[^>]*><span class="past-night-text"><span class="past-night-date">([^<]*)<\/span><span class="past-night-count">([^<]*)<\/span><\/span><span class="past-night-pill" data-state="([^"]*)">([^<]*)<\/span><\/a>/g,
    ),
  ].map(([, href, date, count, state, pill]) => [href, date, count, state, pill]);
}

/** Each frozen Board row as "name|answer|note", in page order. */
function boardRows(main: string): string[] {
  return [...main.matchAll(/<li class="board-row" data-availability="[^"]*">([\s\S]*?)<\/li>/g)].map(([, row]) => {
    const who = row.match(/<div class="board-row-who">([\s\S]*?)<\/div><span class="board-row-answer">/)![1];
    const name = who.match(/class="board-row-name">([^<]*)</)![1] + (who.match(/<span class="board-row-left">([^<]*)<\/span>/)?.[1] ?? "");
    const answer = row.match(/<span class="board-row-answer">([^<]*)<\/span>/)![1];
    const note = row.match(/<p class="board-row-note">([^<]*)<\/p>/)?.[1] ?? "";
    return `${name}|${answer}|${note}`;
  });
}

/**
 * Alice owns "Friday" and Bob joined it; Carol is in no Group. Answers given
 * on Game Night 2026-11-03 are frozen by the Reset at 06:00 UTC+4 on 4 Nov.
 */
async function setUp(now = "2026-11-03T12:00:00Z") {
  const app = startApp({ now });
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD, colour: "violet" });
  const bob = await app.createLogin({ username: "Bob", password: PASSWORD, colour: "sky" });
  const carol = await app.createLogin({ username: "Carol", password: PASSWORD });
  const ids = { alice: await memberId("Alice"), bob: await memberId("Bob"), carol: await memberId("Carol") };
  const groups = createGroups({ env, clock: app.clock });
  const created = await groups.createGroup(ids.alice, "Friday");
  if (!created.ok) throw new Error("createGroup failed");
  const friday = created.groupId;
  const invites = createInvites({ env, clock: app.clock });
  const join = async (member: number, group = friday, owner = ids.alice) => {
    const made = await invites.makeInvite(owner, group, "");
    if (!made.ok) throw new Error("makeInvite failed");
    await invites.joinWithInvite(member, made.token);
  };
  await join(ids.bob);
  const checkins = createCheckins({ env, clock: app.clock });
  const answer = (who: number, availability: Availability) => checkins.setAvailability(who, availability);
  return {
    app,
    alice,
    bob,
    carol,
    ids,
    groups,
    join,
    checkins,
    answer,
    friday,
    history: `/groups/${friday}/history`,
  };
}

const RESET_4_NOV = "2026-11-04T02:00:00Z";

describe("the History page", () => {
  it("shows the Group name, the Yes counts and the past nights, each linking to its page", async () => {
    const { app, alice, ids, answer, checkins, history, friday } = await setUp();
    await answer(ids.alice, "yes");
    await checkins.setNote(ids.alice, "bringing snacks");
    await answer(ids.bob, "maybe");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();

    const response = await alice.get(history);
    const html = await response.text();
    const main = mainOf(html);

    expect(response.status).toBe(200);
    expect(html).toContain("<title>History · Friday · Daily Check-in</title>");
    expect(html).not.toMatch(/\sstyle=/);
    expect(bodyOf(html)).toMatch(/<a class="top-bar-back" href="\/"[^>]*><span aria-hidden="true">‹<\/span> Tonight<\/a>/);
    expect(main).toContain('<header class="page-header"><p class="page-context">Friday</p><h1>History</h1></header>');
    expect(main).toContain('<h2 id="yes-counts-heading">Who usually shows up</h2>');
    expect(main).toContain("Yes answers over the last 30 nights, counting only nights each Member was in the Group.");
    expect(yesCountLines(main)).toEqual(["Alice: Yes 1 of 1", "Bob: Yes 0 of 1"]);
    // The bar is decorative: hidden from assistive technology, its share in a width.
    expect(main).toMatch(/<svg class="yes-count-bar"[^>]*aria-hidden="true"[^>]*><rect class="yes-count-fill" width="100" height="10"><\/rect><\/svg>/);
    expect(main).toContain('<h2 id="past-nights-heading">Past nights</h2>');
    expect(tiles(main)).toEqual([[`/groups/${friday}/history/2026-11-03`, "Tue 3 Nov", "1 Yes · Game On at 3", "never", "Never on"]]);
    expect(main).not.toContain("Show older nights");
  });

  it("shows Game On, Game Off and Nobody answered pills, newest first", async () => {
    const { app, alice, ids, answer, groups, friday, history } = await setUp("2026-11-01T12:00:00Z");
    // 1 Nov: nobody answers. 2 Nov: Game On at 1. 3 Nov: Game On, then Alice changes to No.
    expect(await groups.setThreshold(ids.alice, friday, "1")).toEqual({ ok: true });
    app.clock.set("2026-11-02T02:00:00Z");
    await app.runScheduled();
    await answer(ids.alice, "yes");
    app.clock.set("2026-11-03T02:00:00Z");
    await app.runScheduled();
    await answer(ids.alice, "yes");
    await answer(ids.alice, "no");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();

    const main = mainOf(await (await alice.get(history)).text());

    expect(tiles(main).map(([, date, count, state, pill]) => [date, count, state, pill])).toEqual([
      ["Tue 3 Nov", "0 Yes · Game On at 1", "off", "Game Off"],
      ["Mon 2 Nov", "1 Yes · Game On at 1", "on", "Game On"],
      ["Sun 1 Nov", "No Check-ins", "nobody", "Nobody answered"],
    ]);
  });

  it("says so when the Group has no past nights yet", async () => {
    const { alice, history } = await setUp();
    const main = mainOf(await (await alice.get(history)).text());

    expect(main).toContain("No past nights yet.");
    expect(yesCountLines(main)).toEqual(["Alice: No nights yet", "Bob: No nights yet"]);
    expect(main).toMatch(/<rect class="yes-count-fill" width="0" height="10">/);
  });

  it("shows a new Member the nights from before they joined, with no nights of their own yet", async () => {
    const { app, carol, ids, join, answer, history } = await setUp();
    await answer(ids.alice, "yes");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    await join(ids.carol);

    const main = mainOf(await (await carol.get(history)).text());

    expect(tiles(main)).toHaveLength(1);
    expect(yesCountLines(main)).toEqual(["Alice: Yes 1 of 1", "Bob: Yes 0 of 1", "Carol: No nights yet"]);
  });

  it("counts Yes only over nights each Member was in the Group, within the last 30 History nights", async () => {
    const { app, ids, join, answer, history, alice } = await setUp("2026-09-01T12:00:00Z");
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-10-01')").run();
    // Alice: Yes on 2 Oct, outside the last 30 nights, and on 3 Nov, inside them.
    app.clock.set("2026-10-02T12:00:00Z");
    await answer(ids.alice, "yes");
    // Carol joins during Game Night 15 Oct and says Yes on 20 Oct.
    app.clock.set("2026-10-15T12:00:00Z");
    await join(ids.carol);
    app.clock.set("2026-10-20T12:00:00Z");
    await answer(ids.carol, "yes");
    app.clock.set("2026-11-03T12:00:00Z");
    await answer(ids.alice, "yes");
    app.clock.set("2026-11-04T03:00:00Z");
    const reset = createHistory({ env, clock: app.clock });
    await reset.reset();
    await reset.reset();

    const main = mainOf(await (await alice.get(history)).text());

    // 34 nights, 1 Oct to 3 Nov; the last 30 are 5 Oct to 3 Nov. Carol was in for 15 Oct to 3 Nov.
    expect(yesCountLines(main)).toEqual(["Carol: Yes 1 of 20", "Alice: Yes 1 of 30", "Bob: Yes 0 of 30"]);
    expect(main).toMatch(/<span class="yes-count-name">Carol<\/span>[\s\S]*?<rect class="yes-count-fill" width="5" height="10">/);
  });

  it("pages 20 nights at a time, newest first, without gaps or repeats", async () => {
    const { app, alice, history, friday } = await setUp("2026-09-01T12:00:00Z");
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-10-01')").run();
    app.clock.set("2026-11-04T03:00:00Z");
    await app.runScheduled();
    app.clock.set("2026-11-04T04:00:00Z");
    await app.runScheduled();

    const first = mainOf(await (await alice.get(history)).text());
    const firstNights = tiles(first).map(([href]) => href.split("/").at(-1));
    expect(firstNights).toHaveLength(20);
    expect(firstNights[0]).toBe("2026-11-03");
    expect(firstNights.at(-1)).toBe("2026-10-15");
    // Without JavaScript the button is a plain GET form to the next page.
    expect(first).toMatch(
      new RegExp(
        `<form[^>]* action="/groups/${friday}/history" method="get"><input type="hidden" name="before" value="2026-10-15"/><button type="submit" class="btn-secondary">Show older nights</button></form>`,
      ),
    );

    const second = mainOf(await (await alice.get(`${history}?before=2026-10-15`)).text());
    const secondNights = tiles(second).map(([href]) => href.split("/").at(-1));
    expect(secondNights).toHaveLength(14);
    expect(secondNights[0]).toBe("2026-10-14");
    expect(secondNights.at(-1)).toBe("2026-10-01");
    expect(second).not.toContain("Show older nights");

    const all = [...firstNights, ...secondNights];
    expect(new Set(all).size).toBe(34);
    expect([...all].sort().reverse()).toEqual(all);
  });

  it("serves the next page's data to the in-place append", async () => {
    const { app, alice, history } = await setUp("2026-09-01T12:00:00Z");
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-10-01')").run();
    app.clock.set("2026-11-04T03:00:00Z");
    await app.runScheduled();
    app.clock.set("2026-11-04T04:00:00Z");
    await app.runScheduled();

    // useFetcher loads the route's data URL with the form's fields as the query.
    const response = await alice.get(`${history}.data?before=2026-10-15`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("2026-10-14");
    expect(text).toContain("2026-10-01");
    expect(text).not.toContain("2026-11-03");
  });
});

describe("a past night's page", () => {
  it("shows the frozen Board with names as they are now, No answer and the frozen line", async () => {
    const { app, bob, ids, join, answer, checkins, friday } = await setUp();
    await join(ids.carol);
    await answer(ids.alice, "yes");
    await checkins.setNote(ids.alice, "bringing snacks");
    await answer(ids.bob, "no");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    await env.DB.prepare("UPDATE members SET username = 'Alicia' WHERE id = ?1").bind(ids.alice).run();

    const response = await bob.get(`/groups/${friday}/history/2026-11-03`);
    const html = await response.text();
    const main = mainOf(html);

    expect(response.status).toBe(200);
    expect(html).toContain("<title>Tue 3 Nov · Friday · Daily Check-in</title>");
    expect(html).not.toMatch(/\sstyle=/);
    expect(bodyOf(html)).toMatch(
      new RegExp(`<a class="top-bar-back" href="/groups/${friday}/history"[^>]*><span aria-hidden="true">‹</span> History</a>`),
    );
    expect(main).toContain('<header class="page-header"><p class="page-context">Friday</p><h1 id="night-heading">Tue 3 Nov</h1></header>');
    expect(main).toContain(
      '<div class="board-banner" data-state="never"><p class="board-pill">Never on</p><p class="board-count">1 Yes · Game On at 3</p></div>',
    );
    expect(boardRows(main)).toEqual(["Alicia|Yes|bringing snacks", "You|No|", "Carol|No answer|"]);
    expect(main).not.toContain("Nobody answered");
    expect(main).toContain("Frozen as it stood at the Reset the next morning.");
  });

  it("shows a Display Name set after the Reset on the past night and in the Yes counts", async () => {
    const { app, alice, bob, ids, answer, history, friday } = await setUp();
    await answer(ids.bob, "yes");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    await bob.post("/profile", { intent: "names", username: "Bob", displayName: "Zed 🎲", colour: "sky" });

    const night = mainOf(await (await alice.get(`/groups/${friday}/history/2026-11-03`)).text());
    const page = mainOf(await (await alice.get(history)).text());

    expect(boardRows(night)).toEqual(["Zed 🎲|Yes|", "You|No answer|"]);
    expect(night).toContain(
      '<details class="board-row-reveal"><summary class="board-row-name">Zed 🎲</summary><span class="board-row-username">@Bob</span></details>',
    );
    // Every past-night row starts with the Member's avatar dot.
    expect(night.match(/<div class="board-row-who"><span class="avatar-dot" data-colour="[a-z]+"/g)).toHaveLength(2);
    expect(yesCountLines(page)).toEqual(["Zed 🎲: Yes 1 of 1", "Alice: Yes 0 of 1"]);
  });

  it("orders the Yes counts by Shown name", async () => {
    const { app, alice, bob, history } = await setUp();
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    expect(yesCountLines(mainOf(await (await alice.get(history)).text()))).toEqual(["Alice: Yes 0 of 1", "Bob: Yes 0 of 1"]);

    await bob.post("/profile", { intent: "names", username: "Bob", displayName: "Aaron", colour: "sky" });

    expect(yesCountLines(mainOf(await (await alice.get(history)).text()))).toEqual(["Aaron: Yes 0 of 1", "Alice: Yes 0 of 1"]);
  });

  it("keeps a Member who has left, marked (left the Group)", async () => {
    const { app, alice, ids, groups, answer, friday } = await setUp();
    await answer(ids.bob, "yes");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    expect(await groups.leave(ids.bob, friday)).toEqual({ ok: true, deleted: false });

    const main = mainOf(await (await alice.get(`/groups/${friday}/history/2026-11-03`)).text());

    expect(boardRows(main)).toEqual(["Bob (left the Group)|Yes|", "You|No answer|"]);
    expect(main).toContain('<span class="board-row-left"> (left the Group)</span>');
  });

  it("fills the banner for Game On and says when nobody answered", async () => {
    const { app, alice, ids, groups, answer, friday } = await setUp();
    expect(await groups.setThreshold(ids.alice, friday, "1")).toEqual({ ok: true });
    await answer(ids.alice, "yes");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    app.clock.set("2026-11-05T02:00:00Z");
    await app.runScheduled();

    const on = mainOf(await (await alice.get(`/groups/${friday}/history/2026-11-03`)).text());
    const nobody = mainOf(await (await alice.get(`/groups/${friday}/history/2026-11-04`)).text());

    expect(on).toContain('<div class="board-banner" data-state="on"><p class="board-pill">Game On</p><p class="board-count">1 Yes · Game On at 1</p></div>');
    expect(nobody).toContain('<p class="board-pill">Never on</p><p class="board-count">0 Yes · Game On at 1</p>');
    expect(nobody).toContain("Nobody answered that night.");
    // Rows sort by username, so Alice's own row ("You") comes before Bob's.
    expect(boardRows(nobody)).toEqual(["You|No answer|", "Bob|No answer|"]);
  });
});

describe("History access", () => {
  it("is a 404 for a former Member, a stranger, a bad Group id, a bad or unknown night and a bad cursor", async () => {
    const { app, alice, bob, carol, ids, groups, friday, history } = await setUp();
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    const night = `${history}/2026-11-03`;
    expect((await bob.get(history)).status).toBe(200);
    expect((await bob.get(night)).status).toBe(200);
    expect(await groups.leave(ids.bob, friday)).toEqual({ ok: true, deleted: false });

    for (const path of [history, night]) {
      expect((await bob.get(path)).status, path).toBe(404);
      expect((await carol.get(path)).status, path).toBe(404);
    }
    for (const path of [
      "/groups/999/history",
      "/groups/not-a-number/history",
      "/groups/0/history",
      `${history}/2026-11-02`,
      `${history}/2026-02-30`,
      `${history}/tonight`,
      `${history}?before=yesterday`,
    ]) {
      expect((await alice.get(path)).status, path).toBe(404);
    }
  });

  it("sends a logged-out visitor to the login", async () => {
    const { app, history } = await setUp();
    for (const path of [history, `${history}/2026-11-03`]) {
      const response = await app.device().get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/login");
    }
  });
});

describe("sortYesCounts", () => {
  const count = (username: string, yes: number, nights: number): YesCount => ({
    memberId: username.length,
    shownName: username,
    username,
    colour: "blue",
    yes,
    nights,
  });

  it("orders by share, then Yes count, then name, with no nights last", () => {
    const sorted = sortYesCounts([
      count("zed", 0, 0),
      count("amy", 1, 4),
      count("Bea", 2, 8),
      count("cat", 3, 4),
      count("abe", 2, 8),
      count("dan", 0, 30),
    ]);
    expect(sorted.map((row) => row.username)).toEqual(["cat", "abe", "Bea", "amy", "dan", "zed"]);
  });
});
