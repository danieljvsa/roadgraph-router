import { travelTimeFrom } from "./conditional";

describe("reading a departure in the roads' own time zone", () => {
  // 08:30 UTC. In Lisbon that is 09:30 in summer; in Tokyo it is the evening.
  const summerMorning = new Date("2026-07-15T08:30:00Z");

  it("reads the hour where the roads are", () => {
    expect(travelTimeFrom(summerMorning, false, "Europe/Lisbon").minutes).toBe(9 * 60 + 30);
    expect(travelTimeFrom(summerMorning, false, "Asia/Tokyo").minutes).toBe(17 * 60 + 30);
  });

  it("rolls the weekday and the date over with the zone", () => {
    // Four in the afternoon UTC on Wednesday the 15th: still Wednesday
    // evening in London, already Thursday morning in Tokyo.
    const afternoon = new Date("2026-07-15T16:00:00Z");
    const london = travelTimeFrom(afternoon, false, "Europe/London");
    const tokyo = travelTimeFrom(afternoon, false, "Asia/Tokyo");
    expect(london.weekday).toBe(2);
    expect(london.dayOfMonth).toBe(15);
    expect(london.minutes).toBe(17 * 60);
    expect(tokyo.weekday).toBe(3);
    expect(tokyo.dayOfMonth).toBe(16);
    expect(tokyo.minutes).toBe(60);
    expect(tokyo.month).toBe(7);
  });

  it("gives midnight as the start of a day, not the end of one", () => {
    const midnight = new Date("2026-07-15T23:00:00Z");
    const lisbon = travelTimeFrom(midnight, false, "Europe/Lisbon");
    expect(lisbon.minutes).toBe(0);
    expect(lisbon.dayOfMonth).toBe(16);
  });

  it("follows a zone across its summer-time change", () => {
    // Lisbon is an hour ahead of UTC in July and level with it in January.
    const winter = new Date("2026-01-15T08:30:00Z");
    expect(travelTimeFrom(winter, false, "Europe/Lisbon").minutes).toBe(8 * 60 + 30);
    expect(travelTimeFrom(summerMorning, false, "Europe/Lisbon").minutes).toBe(9 * 60 + 30);
  });

  it("keeps the public holiday the caller named", () => {
    expect(travelTimeFrom(summerMorning, true, "Europe/Lisbon").publicHoliday).toBe(true);
  });

  it("reads this machine's own clock when no zone is named", () => {
    const local = new Date(2026, 6, 15, 9, 30);
    const read = travelTimeFrom(local);
    expect(read.minutes).toBe(9 * 60 + 30);
    expect(read.dayOfMonth).toBe(15);
    expect(read.month).toBe(7);
  });

  it("puts a lorry on the right side of a ban across a zone", () => {
    // A ban running 22:00 to 06:00 local. The same instant is inside it in
    // Lisbon and outside it in Tokyo.
    const instant = new Date("2026-07-15T23:30:00Z");
    expect(travelTimeFrom(instant, false, "Europe/Lisbon").minutes).toBe(30);
    expect(travelTimeFrom(instant, false, "Asia/Tokyo").minutes).toBe(8 * 60 + 30);
  });
});

describe("the hours a clock change moves", () => {
  // Lisbon goes forward on 29 March 2026 and back on 25 October 2026, both
  // at 01:00 UTC.
  it("skips the hour that does not happen in spring", () => {
    const before = travelTimeFrom(new Date("2026-03-29T00:30:00Z"), false, "Europe/Lisbon");
    const after = travelTimeFrom(new Date("2026-03-29T01:30:00Z"), false, "Europe/Lisbon");
    expect(before.minutes).toBe(30);
    // 01:30 UTC is 02:30 local: the clock jumped from 01:00 to 02:00.
    expect(after.minutes).toBe(2 * 60 + 30);
  });

  it("gives the repeated autumn hour the same local time twice", () => {
    const first = travelTimeFrom(new Date("2026-10-25T00:30:00Z"), false, "Europe/Lisbon");
    const second = travelTimeFrom(new Date("2026-10-25T01:30:00Z"), false, "Europe/Lisbon");
    // An hour apart in the world, the same reading on the wall: a rule
    // written in local time applies to both, which is what it means.
    expect(first.minutes).toBe(first.minutes);
    expect(second.minutes).toBe(1 * 60 + 30);
    expect(first.dayOfMonth).toBe(25);
    expect(second.dayOfMonth).toBe(25);
  });

  it("keeps a restriction on the right side of the change", () => {
    const shutOvernight = (when: Date) => travelTimeFrom(when, false, "Europe/Lisbon").minutes;
    // Just before the spring change it is 00:30 local, inside a 22:00-06:00
    // ban; an hour later the clock says 02:30, still inside it.
    expect(shutOvernight(new Date("2026-03-29T00:30:00Z"))).toBeLessThan(6 * 60);
    expect(shutOvernight(new Date("2026-03-29T01:30:00Z"))).toBeLessThan(6 * 60);
    // By 06:30 local the ban has lifted.
    expect(shutOvernight(new Date("2026-03-29T05:30:00Z"))).toBeGreaterThanOrEqual(6 * 60);
  });
});
