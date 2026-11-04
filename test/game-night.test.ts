import { describe, expect, it } from "vitest";

import { addNights, gameNightOf, isGameNight, nightEnd, nightLabel, zoneDayTime, zoneHour } from "~/game-night";

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

describe("zoneHour", () => {
  it.each([
    // 13:00 UTC is 17:00 UTC+4, the Reminder's hour; the minute before is still 16.
    ["2026-11-03T12:59:59.999Z", 16],
    ["2026-11-03T13:00:00.000Z", 17],
    // 16:00 UTC is 20:00 UTC+4, the Daily Summary's hour.
    ["2026-11-03T16:00:00.000Z", 20],
    // Past midnight UTC+4 the hour starts again at 0.
    ["2026-11-03T20:00:00.000Z", 0],
    ["2026-11-03T19:59:00.000Z", 23],
  ])("puts %s in UTC+4 hour %i", (instant, hour) => {
    expect(zoneHour(new Date(instant))).toBe(hour);
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

describe("Game Night dates", () => {
  it("ends a Game Night at 06:00 UTC+4 the next day, where the next night starts", () => {
    expect(nightEnd("2026-11-03").toISOString()).toBe("2026-11-04T02:00:00.000Z");
    expect(nightEnd("2026-12-31").toISOString()).toBe("2027-01-01T02:00:00.000Z");
    expect(gameNightOf(nightEnd("2026-11-03"))).toBe("2026-11-04");
    expect(gameNightOf(new Date(nightEnd("2026-11-03").getTime() - 1))).toBe("2026-11-03");
  });

  it("steps between nights across month and year ends", () => {
    expect(addNights("2026-10-31", 1)).toBe("2026-11-01");
    expect(addNights("2027-01-01", -1)).toBe("2026-12-31");
    expect(addNights("2026-11-03", 0)).toBe("2026-11-03");
  });

  it("names a night by weekday, day and month", () => {
    expect(nightLabel("2026-11-01")).toBe("Sun 1 Nov");
    expect(nightLabel("2026-11-03")).toBe("Tue 3 Nov");
    expect(nightLabel("2027-01-01")).toBe("Fri 1 Jan");
  });

  it.each(["2026-11-03", "2028-02-29"])("accepts %s as a Game Night", (night) => {
    expect(isGameNight(night)).toBe(true);
  });

  it.each(["2026-02-30", "2027-02-29", "2026-13-01", "2026-11-3", "20261103", "2026-11-03x", ""])(
    "rejects %j as a Game Night",
    (night) => {
      expect(isGameNight(night)).toBe(false);
    },
  );
});
