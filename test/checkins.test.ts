import { describe, expect, it } from "vitest";

import { boardReachLine, type BoardRow, noteError, normaliseNote, pillFor, sortRows } from "~/checkins";

describe("pillFor", () => {
  it.each([
    [{ yes: 0, threshold: 3, wasOn: false }, { state: "needs", text: "Needs 3 more Yes" }],
    [{ yes: 2, threshold: 3, wasOn: false }, { state: "needs", text: "Needs 1 more Yes" }],
    [{ yes: 3, threshold: 3, wasOn: false }, { state: "on", text: "Game On" }],
    [{ yes: 4, threshold: 3, wasOn: true }, { state: "on", text: "Game On" }],
    [{ yes: 2, threshold: 3, wasOn: true }, { state: "off", text: "Game Off" }],
    [{ yes: 0, threshold: 1, wasOn: true }, { state: "off", text: "Game Off" }],
  ])("%o shows %o", (counts, pill) => {
    expect(pillFor(counts)).toEqual(pill);
  });
});

describe("sortRows", () => {
  const row = (username: string, availability: BoardRow["availability"]): BoardRow => ({
    memberId: 0,
    username,
    colour: "blue",
    availability,
    note: null,
  });

  it("orders Yes, Maybe, No, then no answer, by username within each", () => {
    const sorted = sortRows([
      row("zed", null),
      row("Bob", "no"),
      row("amy", "maybe"),
      row("Cat", "yes"),
      row("al", "no"),
      row("bea", "yes"),
      row("Ann", null),
    ]);
    expect(sorted.map((r) => r.username)).toEqual(["bea", "Cat", "amy", "al", "Bob", "Ann", "zed"]);
  });
});

describe("Note rule", () => {
  it("accepts 140 code points, emoji included", () => {
    expect(noteError(normaliseNote("x".repeat(140)))).toBeNull();
    expect(noteError(normaliseNote("🎮".repeat(140)))).toBeNull();
  });

  it("refuses 141 code points", () => {
    expect(noteError(normaliseNote("🎮".repeat(141)))).toBe("Use at most 140 characters.");
  });

  it("refuses control and invisible characters", () => {
    expect(noteError(normaliseNote("on\nafter 10"))).toBe("Remove tabs, line breaks and invisible characters.");
    expect(noteError(normaliseNote("on​after 10"))).toBe("Remove tabs, line breaks and invisible characters.");
  });

  it("stores an empty Note as no Note", () => {
    expect(normaliseNote("   ")).toBeNull();
    expect(normaliseNote("  on after 10 ")).toBe("on after 10");
    expect(noteError(null)).toBeNull();
  });
});

describe("boardReachLine", () => {
  it("counts the Boards the answer shows on", () => {
    expect(boardReachLine(1)).toBe("Your answer shows on your Board");
    expect(boardReachLine(2)).toBe("Your answer shows on all 2 of your Boards");
  });
});
