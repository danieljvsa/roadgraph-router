import {
  conditionalValue,
  conditionHolds,
  parseConditional,
  travelTimeFrom,
  unreadableConditions,
  type TravelTime,
} from "./conditional";

/** Monday 09:00 in March unless a test says otherwise. */
const at = (over: Partial<TravelTime> = {}): TravelTime => ({ weekday: 0, minutes: 540, month: 3, ...over });

const valueAt = (tag: string, when: TravelTime, vehicle?: Parameters<typeof conditionalValue>[2]) =>
  conditionalValue(parseConditional(tag), when, vehicle);

describe("reading a conditional value", () => {
  it("reads a single rule", () => {
    const rules = parseConditional("no @ (Mo-Fr 07:00-19:00)");
    expect(rules).toHaveLength(1);
    expect(rules[0].value).toBe("no");
    expect(rules[0].conditions[0].days).toEqual([{ from: 0, to: 4 }]);
    expect(rules[0].conditions[0].times).toEqual([{ from: 420, to: 1140 }]);
  });

  it("ignores a value that is not conditional at all", () => {
    expect(parseConditional("no")).toEqual([]);
    expect(parseConditional(undefined)).toEqual([]);
    expect(parseConditional("")).toEqual([]);
  });

  it("keeps a semicolon that belongs to the condition rather than splitting on it", () => {
    const rules = parseConditional("no @ (Mo-Fr 07:00-19:00; Sa 08:00-12:00)");
    expect(rules).toHaveLength(1);
  });

  it("splits the rules a semicolon does separate", () => {
    const rules = parseConditional("120 @ (06:00-20:00); 80 @ (22:00-06:00)");
    expect(rules.map((rule) => rule.value)).toEqual(["120", "80"]);
  });

  it("survives a malformed rule without throwing", () => {
    expect(() => parseConditional("no @")).not.toThrow();
    expect(parseConditional("no @")).toEqual([]);
    expect(parseConditional("@ (Mo)")).toEqual([]);
  });
});

describe("the last matching rule wins", () => {
  // The convention OpenStreetMap documents: general first, specific last.
  const tag = "120 @ (06:00-20:00); 80 @ (Mo-Fr 07:00-09:00)";

  it("takes the later rule when both match", () => {
    expect(valueAt(tag, at({ minutes: 480 }))).toBe("80");
  });

  it("takes the earlier rule when only it matches", () => {
    expect(valueAt(tag, at({ minutes: 660 }))).toBe("120");
  });

  it("gives nothing when neither matches", () => {
    expect(valueAt(tag, at({ minutes: 1320 }))).toBeNull();
  });
});

describe("times of day", () => {
  it("treats the end of a span as the moment it stops applying", () => {
    expect(valueAt("no @ (07:00-19:00)", at({ minutes: 7 * 60 }))).toBe("no");
    expect(valueAt("no @ (07:00-19:00)", at({ minutes: 19 * 60 - 1 }))).toBe("no");
    expect(valueAt("no @ (07:00-19:00)", at({ minutes: 19 * 60 }))).toBeNull();
  });

  it("carries a span over midnight", () => {
    const tag = "no @ (22:00-06:00)";
    expect(valueAt(tag, at({ minutes: 23 * 60 }))).toBe("no");
    expect(valueAt(tag, at({ minutes: 2 * 60 }))).toBe("no");
    expect(valueAt(tag, at({ minutes: 12 * 60 }))).toBeNull();
  });

  it("reads 24/7 as always", () => {
    expect(valueAt("no @ 24/7", at({ minutes: 0 }))).toBe("no");
    expect(valueAt("no @ 24/7", at({ minutes: 1439 }))).toBe("no");
  });

  it("takes several spans in one condition", () => {
    const tag = "no @ (Mo-Fr 08:00-10:00,16:00-18:00)";
    expect(valueAt(tag, at({ minutes: 9 * 60 }))).toBe("no");
    expect(valueAt(tag, at({ minutes: 17 * 60 }))).toBe("no");
    expect(valueAt(tag, at({ minutes: 12 * 60 }))).toBeNull();
  });
});

describe("days and months", () => {
  it("reads a weekday range", () => {
    const tag = "no @ (Mo-Fr)";
    expect(valueAt(tag, at({ weekday: 0 }))).toBe("no");
    expect(valueAt(tag, at({ weekday: 4 }))).toBe("no");
    expect(valueAt(tag, at({ weekday: 5 }))).toBeNull();
  });

  it("carries a weekday range over the end of the week", () => {
    const tag = "no @ (Fr-Mo)";
    expect(valueAt(tag, at({ weekday: 6 }))).toBe("no");
    expect(valueAt(tag, at({ weekday: 0 }))).toBe("no");
    expect(valueAt(tag, at({ weekday: 2 }))).toBeNull();
  });

  it("reads a season, including one spanning the new year", () => {
    expect(valueAt("no @ (Nov-Feb)", at({ month: 12 }))).toBe("no");
    expect(valueAt("no @ (Nov-Feb)", at({ month: 1 }))).toBe("no");
    expect(valueAt("no @ (Nov-Feb)", at({ month: 7 }))).toBeNull();
  });

  it("asks the caller about a public holiday instead of guessing", () => {
    const tag = "no @ (PH)";
    expect(valueAt(tag, at({ publicHoliday: true }))).toBe("no");
    expect(valueAt(tag, at())).toBeNull();
  });
});

describe("the vehicle itself", () => {
  const lorry = { heightMeters: 4.0, widthMeters: 2.55, lengthMeters: 16.5, weightTonnes: 40 };
  const van = { heightMeters: 2.6, widthMeters: 2.1, lengthMeters: 6.0, weightTonnes: 3.5 };

  it("compares a weight", () => {
    expect(valueAt("no @ (weight>7.5)", at(), lorry)).toBe("no");
    expect(valueAt("no @ (weight>7.5)", at(), van)).toBeNull();
  });

  it("compares a height and a length", () => {
    expect(valueAt("no @ (height>3.5)", at(), lorry)).toBe("no");
    expect(valueAt("no @ (length>12)", at(), van)).toBeNull();
  });

  it("needs every part of a combined condition to hold", () => {
    const tag = "no @ (Mo-Fr 07:00-19:00 AND weight>7.5)";
    expect(valueAt(tag, at(), lorry)).toBe("no");
    expect(valueAt(tag, at(), van)).toBeNull();
    expect(valueAt(tag, at({ weekday: 6 }), lorry)).toBeNull();
  });

  it("does not match a vehicle test when no vehicle is given", () => {
    expect(valueAt("no @ (weight>7.5)", at())).toBeNull();
  });
});

describe("conditions this parser cannot read", () => {
  it("never treats an unreadable condition as holding", () => {
    expect(valueAt("no @ (wet)", at())).toBeNull();
    expect(valueAt("no @ (stay>2 hours)", at())).toBeNull();
  });

  it("counts them so they can be reported rather than passed over in silence", () => {
    expect(unreadableConditions(parseConditional("no @ (wet)"))).toBe(1);
    expect(unreadableConditions(parseConditional("no @ (Mo-Fr 07:00-19:00)"))).toBe(0);
    expect(unreadableConditions(parseConditional("80 @ (wet); 60 @ (snow)"))).toBe(2);
  });

  it("still applies the readable rule beside an unreadable one", () => {
    expect(valueAt("60 @ (wet); 80 @ (Mo-Fr)", at())).toBe("80");
  });

  it("does not let an unreadable later rule undo an earlier match", () => {
    expect(valueAt("80 @ (Mo-Fr); 60 @ (wet)", at())).toBe("80");
  });
});

describe("the moment a journey is travelled", () => {
  it("counts Monday as nought and Sunday as six", () => {
    expect(travelTimeFrom(new Date(2026, 9, 12, 9, 30)).weekday).toBe(0);
    expect(travelTimeFrom(new Date(2026, 9, 18, 9, 30)).weekday).toBe(6);
  });

  it("carries the minute and the month across", () => {
    const when = travelTimeFrom(new Date(2026, 9, 15, 14, 45));
    expect(when.minutes).toBe(14 * 60 + 45);
    expect(when.month).toBe(10);
  });
});

describe("examples taken from the wiki", () => {
  it("reads the maxspeed example", () => {
    const tag = "120 @ (06:00-20:00); 80 @ (wet)";
    expect(valueAt(tag, at({ minutes: 10 * 60 }))).toBe("120");
    expect(valueAt(tag, at({ minutes: 22 * 60 }))).toBeNull();
    expect(unreadableConditions(parseConditional(tag))).toBe(1);
  });

  it("reads a lorry ban in working hours", () => {
    const tag = "no @ (Mo-Fr 07:00-19:00)";
    expect(valueAt(tag, at({ weekday: 2, minutes: 8 * 60 }))).toBe("no");
    expect(valueAt(tag, at({ weekday: 6, minutes: 8 * 60 }))).toBeNull();
  });

  it("reads delivery access outside the pedestrian hours", () => {
    const tag = "destination @ (Mo-Sa 06:00-11:00)";
    expect(valueAt(tag, at({ weekday: 1, minutes: 7 * 60 }))).toBe("destination");
  });
});

describe("a condition group on its own", () => {
  it("answers directly without a surrounding rule", () => {
    const [rule] = parseConditional("no @ (Mo-Fr 07:00-19:00)");
    expect(conditionHolds(rule.conditions[0], at())).toBe(true);
    expect(conditionHolds(rule.conditions[0], at({ weekday: 5 }))).toBe(false);
  });
});

describe("alternatives inside one condition", () => {
  const tag = "no @ (Mo-Fr 07:00-19:00; Sa 08:00-12:00)";

  it("still reads as a single rule", () => {
    expect(parseConditional(tag)).toHaveLength(1);
  });

  it("applies in the weekday window", () => {
    expect(valueAt(tag, at({ weekday: 2, minutes: 8 * 60 }))).toBe("no");
  });

  it("applies in the Saturday window, which a split on the wrong semicolon would lose", () => {
    expect(valueAt(tag, at({ weekday: 5, minutes: 9 * 60 }))).toBe("no");
  });

  it("does not apply outside either", () => {
    expect(valueAt(tag, at({ weekday: 5, minutes: 14 * 60 }))).toBeNull();
    expect(valueAt(tag, at({ weekday: 6, minutes: 9 * 60 }))).toBeNull();
  });

  it("reads both windows rather than giving up on one", () => {
    expect(unreadableConditions(parseConditional(tag))).toBe(0);
  });
});

describe("a window that runs past midnight on a named day", () => {
  // `Fr 22:00-06:00` is one span beginning Friday evening and ending Saturday
  // morning. Asking "is it Friday?" and "is it between 22:00 and 06:00?"
  // separately answers both ends of it backwards.
  const tag = "no @ (Fr 22:00-06:00)";
  const friday = 4;
  const saturday = 5;

  it("does not apply on the Friday morning before it starts", () => {
    expect(valueAt(tag, at({ weekday: friday, minutes: 2 * 60 }))).toBeNull();
  });

  it("applies once Friday evening reaches it", () => {
    expect(valueAt(tag, at({ weekday: friday, minutes: 23 * 60 }))).toBe("no");
  });

  it("still applies after midnight, on the Saturday", () => {
    expect(valueAt(tag, at({ weekday: saturday, minutes: 2 * 60 }))).toBe("no");
  });

  it("stops when the Saturday morning passes its end", () => {
    expect(valueAt(tag, at({ weekday: saturday, minutes: 7 * 60 }))).toBeNull();
  });

  it("carries the same way from Sunday into Monday", () => {
    const sunday = "no @ (Su 22:00-06:00)";
    expect(valueAt(sunday, at({ weekday: 6, minutes: 23 * 60 }))).toBe("no");
    expect(valueAt(sunday, at({ weekday: 0, minutes: 2 * 60 }))).toBe("no");
    expect(valueAt(sunday, at({ weekday: 0, minutes: 7 * 60 }))).toBeNull();
  });

  it("covers every night of a weekday range", () => {
    const weekdays = "no @ (Mo-Fr 22:00-06:00)";
    // Saturday morning belongs to Friday night, Monday morning to Sunday's,
    // which is not in the range.
    expect(valueAt(weekdays, at({ weekday: 5, minutes: 2 * 60 }))).toBe("no");
    expect(valueAt(weekdays, at({ weekday: 0, minutes: 2 * 60 }))).toBeNull();
  });

  it("leaves a span inside one day alone", () => {
    expect(valueAt("no @ (Fr 09:00-17:00)", at({ weekday: friday, minutes: 12 * 60 }))).toBe("no");
    expect(valueAt("no @ (Fr 09:00-17:00)", at({ weekday: saturday, minutes: 12 * 60 }))).toBeNull();
  });
});

describe("times that are not times", () => {
  const unreadable = (tag: string) => parseConditional(tag)[0].conditions[0].unreadable !== undefined;

  it("takes 24:00 as the end of the day", () => {
    expect(valueAt("no @ (22:00-24:00)", at({ minutes: 23 * 60 }))).toBe("no");
  });

  it("refuses an hour past the end of the day", () => {
    // Reading 24:30 as 00:30 would quietly move the span onto the next day.
    expect(unreadable("no @ (24:30-06:00)")).toBe(true);
    expect(unreadable("no @ (25:00-06:00)")).toBe(true);
  });

  it("refuses a minute that is not one", () => {
    expect(unreadable("no @ (07:60-19:00)")).toBe(true);
  });
});

describe("a window that runs past the end of a month", () => {
  // The selector applies to the day a span begins on, so an October evening
  // rule runs on into the first of November.
  const october = "no @ (Oct 22:00-06:00)";
  const inOctober = { weekday: 2, month: 10, dayOfMonth: 15 };

  it("holds on an ordinary October night", () => {
    expect(valueAt(october, { ...inOctober, minutes: 23 * 60 })).toBe("no");
    expect(valueAt(october, { ...inOctober, minutes: 2 * 60 })).toBe("no");
  });

  it("holds into the morning of the first of November", () => {
    expect(valueAt(october, { weekday: 3, month: 11, dayOfMonth: 1, minutes: 2 * 60 })).toBe("no");
  });

  it("stops once that morning is over", () => {
    expect(valueAt(october, { weekday: 3, month: 11, dayOfMonth: 1, minutes: 7 * 60 })).toBeNull();
  });

  it("does not reach any later November night", () => {
    expect(valueAt(october, { weekday: 3, month: 11, dayOfMonth: 2, minutes: 2 * 60 })).toBeNull();
    expect(valueAt(october, { weekday: 3, month: 11, dayOfMonth: 15, minutes: 23 * 60 })).toBeNull();
  });

  it("carries across the end of a year", () => {
    const december = "no @ (Dec 22:00-06:00)";
    expect(valueAt(december, { weekday: 3, month: 1, dayOfMonth: 1, minutes: 2 * 60 })).toBe("no");
    expect(valueAt(december, { weekday: 3, month: 1, dayOfMonth: 2, minutes: 2 * 60 })).toBeNull();
  });

  it("treats a missing day of the month as a day that is not the first", () => {
    // Older callers built a travel time without one; they keep the answer
    // they always had, which is right on thirty days in thirty-one.
    expect(valueAt(october, { weekday: 3, month: 11, minutes: 2 * 60 })).toBeNull();
    expect(valueAt(october, { weekday: 3, month: 10, minutes: 2 * 60 })).toBe("no");
  });

  it("applies a month and a weekday and a time together", () => {
    const tag = "no @ (Oct Fr 22:00-06:00)";
    // Friday night in October.
    expect(valueAt(tag, { weekday: 4, month: 10, dayOfMonth: 17, minutes: 23 * 60 })).toBe("no");
    // The Saturday morning it runs into.
    expect(valueAt(tag, { weekday: 5, month: 10, dayOfMonth: 18, minutes: 2 * 60 })).toBe("no");
    // The same hours on a Wednesday, or in November.
    expect(valueAt(tag, { weekday: 2, month: 10, dayOfMonth: 15, minutes: 23 * 60 })).toBeNull();
    expect(valueAt(tag, { weekday: 4, month: 11, dayOfMonth: 21, minutes: 23 * 60 })).toBeNull();
  });

  it("leaves a rule with no day or month alone", () => {
    expect(valueAt("no @ (22:00-06:00)", { weekday: 3, month: 11, dayOfMonth: 1, minutes: 2 * 60 })).toBe("no");
    expect(valueAt("no @ (22:00-06:00)", { weekday: 3, month: 6, dayOfMonth: 9, minutes: 12 * 60 })).toBeNull();
  });

  it("reads the day of the month off a date", () => {
    expect(travelTimeFrom(new Date(2026, 10, 1, 2, 0)).dayOfMonth).toBe(1);
    expect(travelTimeFrom(new Date(2026, 10, 1, 2, 0)).month).toBe(11);
  });
});
