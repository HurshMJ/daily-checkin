import { describe, expect, it } from "vitest";

import { gameNightOf, zoneDayTime } from "~/game-night";

describe("gameNightOf", () => {
  it.each([
    // 06:00 UTC+4 is 02:00 UTC; the instant before it is still the previous night.
    ["2026-11-04T01:59:59.999Z", "2026-11-03"],
    ["2026-11-04T02:00:00.000Z", "2026-11-04"],
    // 02:00 UTC+4, late on the evening's session, belongs to the night that began at 06:00 the day before.
    ["2026-11-03T22:00:00.000Z", "2026-11-03"],
    // 07:00 UTC+4 is the new night.
    ["2026-11-04T03:00:00.000Z", "2026-11-04"],
    // Month and year boundaries.
    ["2026-12-01T01:00:00.000Z", "2026-11-30"],
    ["2027-01-01T01:00:00.000Z", "2026-12-31"],
    ["2027-01-01T02:00:00.000Z", "2027-01-01"],
  ])("puts %s in the Game Night of %s", (instant, night) => {
    expect(gameNightOf(new Date(instant))).toBe(night);
  });
});

describe("zoneDayTime", () => {
  it("shows the day, month and 24-hour time in UTC+4", () => {
    expect(zoneDayTime(new Date("2026-11-03T12:05:00Z"))).toBe("3 Nov, 16:05");
    expect(zoneDayTime(new Date("2026-11-03T00:00:00Z"))).toBe("3 Nov, 04:00");
  });

  it("moves to the next day and year at midnight UTC+4", () => {
    expect(zoneDayTime(new Date("2026-12-31T19:59:00Z"))).toBe("31 Dec, 23:59");
    expect(zoneDayTime(new Date("2026-12-31T20:00:00Z"))).toBe("1 Jan, 00:00");
  });
});
