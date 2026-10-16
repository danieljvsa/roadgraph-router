/**
 * Conditional restrictions: `hgv:conditional = no @ (Mo-Fr 07:00-19:00)`.
 *
 * A road can be closed overnight, a square pedestrianised on Sundays, a bridge
 * limited to 7.5 tonnes only for vehicles over a certain length. Until now
 * every one of those read as permanently open, which is the limitation most
 * likely to make a route wrong rather than merely longer.
 *
 * The value is a list of `value @ condition` pairs separated by semicolons,
 * and where several match, OpenStreetMap says the **last** one wins — the
 * convention being to write the general rule first and the specific one last.
 *
 * Not every condition can be answered. Weather, a driver's occupation and a
 * stay duration are not things a compiled graph knows, and a rule resting on
 * one is kept but marked, so a caller can count what was not understood
 * instead of being told silently that a road is open.
 */

import type { VehicleDimensions } from "./vehicle";
import type { EdgeConditions, RoadGraph } from "./types";
import { accessMaskFor, edgeAllowed } from "./access";
import { parseMaxSpeedKph } from "./speed";

/**
 * How many distinct conditional values one table can hold. The stored index
 * is sixteen bits wide, so the values are numbered 0 to 65535.
 */
export const MAX_STORED_VALUES = 65536;

/** When a journey passes, in the local time of the road it passes on. */
export type TravelTime = {
  /** 0 is Monday, 6 is Sunday. */
  weekday: number;
  /** Minutes since midnight, 0 to 1439. */
  minutes: number;
  /** 1 to 12, for a seasonal rule. */
  month: number;
  /**
   * The day of the month, 1 to 31. Only a span running past midnight needs
   * it, to know whether the morning it ends on began in the month before.
   * Leaving it out treats such a morning as belonging to the current month,
   * which is right on every day but the first.
   */
  dayOfMonth?: number;
  /** Whether it is a public holiday there, which only a caller can know. */
  publicHoliday?: boolean;
};

/** A span of minutes within a day, which may run past midnight. */
export type MinuteSpan = { from: number; to: number };
/** An inclusive range of weekdays, months, or anything else counted in order. */
export type Range = { from: number; to: number };

/** A measurement of the vehicle compared against a number, as `weight>7.5`. */
export type VehicleComparison = {
  property: "weight" | "height" | "width" | "length";
  operator: "<" | "<=" | ">" | ">=" | "=";
  amount: number;
};

/** One `(...)` group: every part present must hold for the group to match. */
export type Condition = {
  days?: Range[];
  times?: MinuteSpan[];
  months?: Range[];
  publicHoliday?: boolean;
  vehicle?: VehicleComparison[];
  /**
   * Circumstances this library cannot know by itself: the weather, who is
   * driving, what for. They are read from the tag and answered only by a
   * caller who says so; unanswered, the condition does not hold.
   */
  circumstances?: string[];
  /**
   * The part of the condition this parser could not read at all — a stay
   * duration, a form of words nobody has taught it. A condition carrying one
   * is never matched, and is counted so it can be reported rather than
   * quietly ignored.
   */
  unreadable?: string;
};

/**
 * What the caller knows that the map does not: whether it is raining, who is
 * at the wheel, what the journey is for. A conditional rule resting on one of
 * these is ignored unless the answer is given here.
 */
export type Circumstances = {
  /** Named states of the road or sky, such as `wet`, `snow`, `ice`. */
  conditions?: string[];
  /** Who is driving, such as `disabled`, `resident`, `emergency`. */
  userGroups?: string[];
  /** Why, such as `delivery`, `destination`, `agricultural`. */
  purposes?: string[];
};

/** Every circumstance a caller has answered yes to, lower-cased. */
function answered(circumstances: Circumstances | undefined) {
  const yes = new Set<string>();
  for (const list of [circumstances?.conditions, circumstances?.userGroups, circumstances?.purposes]) {
    for (const name of list ?? []) yes.add(name.trim().toLowerCase());
  }
  return yes;
}

/**
 * The circumstances OSM writes in a conditional value. Kept as a list rather
 * than guessed at: this library has no opinion about whether it is raining,
 * and inventing one would either close roads that are open or open roads that
 * are shut.
 */
const KNOWN_CIRCUMSTANCES = new Set([
  "wet", "dry", "snow", "ice", "fog", "rain",
  "disabled", "resident", "residents", "customers", "employees", "emergency", "permit", "school",
  "delivery", "destination", "agricultural", "forestry", "loading", "unloading",
]);

export type ConditionalRule = {
  /** What applies when the condition holds: `no`, `destination`, `30`, `7.5`. */
  value: string;
  /** Any of these matching makes the rule apply, as `Mo-Fr 07:00-19:00, Sa 08:00-12:00`. */
  conditions: Condition[];
};

const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Splits on a separator that is outside any brackets, so a grouped condition stays whole. */
function splitOutsideBrackets(text: string, separator: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  // 24:00 is midnight at the end of the day, which opening hours write as the
  // close of a span. There is no 24:30: an hour past the end of the day is not
  // a time, and reading it as 00:30 would silently move the span by a day.
  if (hours === 24 && minutes !== 0) return null;
  return hours * 60 + minutes;
}

function parseIndexedRange(text: string, table: string[]): Range | null {
  const [from, to] = text.split("-").map((part) => part.trim().toLowerCase().slice(0, 3));
  const start = table.indexOf(from);
  if (start < 0) return null;
  if (to === undefined) return { from: start, to: start };
  const end = table.indexOf(to);
  return end < 0 ? null : { from: start, to: end };
}

function parseVehicleComparison(text: string): VehicleComparison | null {
  const match = /^(weight|height|width|length)\s*(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)$/.exec(text.trim().toLowerCase());
  if (!match) return null;
  return { property: match[1] as VehicleComparison["property"], operator: match[2] as VehicleComparison["operator"], amount: Number(match[3]) };
}

/** Reads one condition group, which may mix days, times, months and vehicle tests. */
function parseCondition(text: string): Condition {
  const condition: Condition = {};
  const cleaned = text.trim().replace(/^\(|\)$/g, "").trim();
  if (!cleaned) return { unreadable: text };
  if (cleaned.toLowerCase() === "24/7") return { times: [{ from: 0, to: 1440 }] };

  for (const token of cleaned.split(/\s+(?:and|AND)\s+|\s+/).filter(Boolean)) {
    const lower = token.toLowerCase().replace(/,$/, "");
    if (lower === "ph") { condition.publicHoliday = true; continue; }

    const comparison = parseVehicleComparison(lower);
    if (comparison) { (condition.vehicle ??= []).push(comparison); continue; }

    // A comma joins alternatives of the same kind: `Mo-Fr,Su` or two spans.
    const pieces = lower.split(",").filter(Boolean);
    const spans: MinuteSpan[] = [];
    const days: Range[] = [];
    const months: Range[] = [];
    let understood = true;
    for (const piece of pieces) {
      const [left, right] = piece.split("-");
      const from = parseClock(left ?? "");
      if (from !== null && right !== undefined) {
        const to = parseClock(right);
        if (to === null) { understood = false; break; }
        spans.push({ from, to });
        continue;
      }
      const day = parseIndexedRange(piece, WEEKDAYS);
      if (day) { days.push(day); continue; }
      const month = parseIndexedRange(piece, MONTHS);
      if (month) { months.push(month); continue; }
      if (KNOWN_CIRCUMSTANCES.has(piece)) { (condition.circumstances ??= []).push(piece); continue; }
      understood = false;
      break;
    }
    if (!understood) { condition.unreadable = token; continue; }
    if (spans.length) (condition.times ??= []).push(...spans);
    if (days.length) (condition.days ??= []).push(...days);
    if (months.length) (condition.months ??= []).push(...months);
  }
  return condition;
}

/**
 * Reads a `*:conditional` value into its rules. An empty list means the value
 * was not a conditional expression at all.
 */
export function parseConditional(value: string | undefined): ConditionalRule[] {
  if (!value || !value.includes("@")) return [];
  const rules: ConditionalRule[] = [];
  for (const part of splitOutsideBrackets(value, ";")) {
    const at = part.indexOf("@");
    if (at < 0) continue;
    const left = part.slice(0, at).trim();
    const right = part.slice(at + 1).trim();
    if (!left || !right) continue;
    // Inside one condition, a semicolon separates alternatives the same way a
    // comma does between groups: `(Mo-Fr 07:00-19:00; Sa 08:00-12:00)` is two
    // windows, either of which makes the rule apply. A comma is left to the
    // group parser, because it also joins spans within one: `08:00-10:00,16:00-18:00`.
    const grouped = right.startsWith("(") && right.endsWith(")") ? right.slice(1, -1) : right;
    const parts = splitOutsideBrackets(grouped, ";");
    rules.push({ value: left, conditions: (parts.length ? parts : [grouped]).map(parseCondition) });
  }
  return rules;
}

const withinRange = (value: number, range: Range) => range.from <= range.to
  ? value >= range.from && value <= range.to
  // A range that wraps, as Fr-Mo or Nov-Feb.
  : value >= range.from || value <= range.to;

const withinSpan = (minutes: number, span: MinuteSpan) => span.from <= span.to
  ? minutes >= span.from && minutes < span.to
  // A span running past midnight, as 22:00-06:00.
  : minutes >= span.from || minutes < span.to;

const YESTERDAY = (weekday: number) => (weekday + 6) % 7;

/** The day before this one, as far as a rule's day and month selectors see it. */
function dayBefore(when: TravelTime) {
  // Only the first of a month belongs to the month before; every other
  // morning began in the month it is in.
  const rolledOver = when.dayOfMonth === 1;
  return {
    weekday: YESTERDAY(when.weekday),
    month: rolledOver ? (when.month === 1 ? 12 : when.month - 1) : when.month,
  };
}

/** Whether a rule's day-of-week and month selectors admit this calendar day. */
function selects(condition: Condition, day: { weekday: number; month: number }) {
  if (condition.days?.length && !condition.days.some((range) => withinRange(day.weekday, range))) return false;
  if (condition.months?.length && !condition.months.some((range) => withinRange(day.month - 1, range))) return false;
  return true;
}

/**
 * Whether the calendar day and the time hold together.
 *
 * They cannot be asked separately. `Fr 22:00-06:00` is one span that begins on
 * Friday evening and ends on Saturday morning, so two o'clock on Saturday is
 * inside it and two o'clock on Friday is not. Checking "is it Friday" and "is
 * it between 22:00 and 06:00" one at a time answers both of those backwards.
 *
 * The same holds for a month. `Oct 22:00-06:00` begins on an October evening,
 * and the one that begins on the thirty-first runs on into November, so the
 * morning half is judged by the day before rather than by the date it is.
 */
function dayAndTimeHold(condition: Condition, when: TravelTime): boolean {
  if (!condition.times?.length) return selects(condition, when);
  return condition.times.some((span) => {
    if (span.from <= span.to) return selects(condition, when) && withinSpan(when.minutes, span);
    // A span running past midnight: the evening half belongs to the day it
    // started on, the morning half to the day before.
    if (when.minutes >= span.from) return selects(condition, when);
    if (when.minutes < span.to) return selects(condition, dayBefore(when));
    return false;
  });
}

/** Whether one condition group holds at this moment, for this vehicle. */
export function conditionHolds(condition: Condition, when: TravelTime, vehicle?: VehicleDimensions, circumstances?: Circumstances): boolean {
  // A condition this parser could not read is never treated as holding, and
  // the caller is expected to have counted it.
  if (condition.unreadable !== undefined) return false;
  if (condition.publicHoliday && !when.publicHoliday) return false;
  if (condition.circumstances?.length) {
    // Every named circumstance has to hold: `no @ (wet AND Mo-Fr)` is not a
    // rule about Mondays in general.
    const yes = answered(circumstances);
    if (!condition.circumstances.every((name) => yes.has(name))) return false;
  }
  if (!dayAndTimeHold(condition, when)) return false;
  if (condition.vehicle?.length) {
    if (!vehicle) return false;
    for (const test of condition.vehicle) {
      const measured = test.property === "weight" ? vehicle.weightTonnes
        : test.property === "height" ? vehicle.heightMeters
        : test.property === "width" ? vehicle.widthMeters
        : vehicle.lengthMeters;
      const holds = test.operator === "<" ? measured < test.amount
        : test.operator === "<=" ? measured <= test.amount
        : test.operator === ">" ? measured > test.amount
        : test.operator === ">=" ? measured >= test.amount
        : measured === test.amount;
      if (!holds) return false;
    }
  }
  return true;
}

/**
 * What a conditional value comes to at this moment, or null when none of its
 * rules applies. Where several match, the last wins, which is what
 * OpenStreetMap says and why the convention is general first, specific last.
 */
export function conditionalValue(rules: ConditionalRule[], when: TravelTime, vehicle?: VehicleDimensions, circumstances?: Circumstances): string | null {
  let effective: string | null = null;
  for (const rule of rules) {
    if (rule.conditions.some((condition) => conditionHolds(condition, when, vehicle, circumstances))) effective = rule.value;
  }
  return effective;
}

/**
 * How many of these rules rest on something this parser cannot read at all.
 * A rule resting on the weather or on who is driving is readable and is not
 * counted here; it simply needs a caller to answer it.
 */
export function unreadableConditions(rules: ConditionalRule[]) {
  return rules.reduce((count, rule) => count + rule.conditions.filter((condition) => condition.unreadable !== undefined).length, 0);
}

const WEEKDAY_NUMBER: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/**
 * The moment a journey is travelled.
 *
 * Without a time zone the date is read as the machine reads it, which is
 * right when the roads and the reader are in the same place and wrong by
 * however many hours when they are not. Naming the zone the roads are in —
 * `"Europe/Lisbon"` — reads the date there instead, which is what a
 * restriction written in local time means.
 *
 * The zone names are the IANA ones the platform already knows; nothing is
 * bundled for this.
 */
export function travelTimeFrom(date: Date, publicHoliday = false, timeZone?: string): TravelTime {
  if (!timeZone) {
    return {
      weekday: (date.getDay() + 6) % 7,
      minutes: date.getHours() * 60 + date.getMinutes(),
      month: date.getMonth() + 1,
      dayOfMonth: date.getDate(),
      publicHoliday,
    };
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  // A midnight in some zones formats as 24 rather than 00.
  const hour = Number(field("hour")) % 24;
  return {
    weekday: WEEKDAY_NUMBER[field("weekday")] ?? 0,
    minutes: hour * 60 + Number(field("minute")),
    month: Number(field("month")),
    dayOfMonth: Number(field("day")),
    publicHoliday,
  };
}

/** What a stored conditional row says: an access rule or a speed limit. */
export const ConditionKind = { access: 0, maxspeed: 1 } as const;

/** Collects what a compiler found into the stored side table. */
export function packEdgeConditions(entries: { edge: number; kind: number; value: string }[]): EdgeConditions | undefined {
  const rows = entries
    .filter((entry) => parseConditional(entry.value).length > 0)
    .sort((a, b) => a.edge - b.edge || a.kind - b.kind);
  if (!rows.length) return undefined;
  const index = new Map<string, number>();
  const values: string[] = [];
  const kept: { edge: number; kind: number; rule: number }[] = [];
  for (const row of rows) {
    let at = index.get(row.value);
    if (at === undefined) {
      // A road whose restriction was dropped reads as a road with no
      // restriction, which is the one failure this table must not have. If
      // the index cannot name another value, the compile stops and says so
      // rather than handing back a graph that is quietly wrong.
      if (values.length >= MAX_STORED_VALUES) {
        throw new RangeError(
          `A tile holds more than ${MAX_STORED_VALUES} distinct conditional restrictions, which is more than the stored index can name. Compile the region in smaller tiles with --tile-size-km.`,
        );
      }
      at = values.push(row.value) - 1;
      index.set(row.value, at);
    }
    kept.push({ edge: row.edge, kind: row.kind, rule: at });
  }
  if (!kept.length) return undefined;
  return {
    edges: Uint32Array.from(kept, (row) => row.edge),
    kinds: Uint8Array.from(kept, (row) => row.kind),
    rules: Uint16Array.from(kept, (row) => row.rule),
    values,
  };
}

/** A bundle's conditional values parsed once, rather than per edge per search. */
export type ParsedConditions = { table: EdgeConditions; parsed: ConditionalRule[][] };

export function parseEdgeConditions(table: EdgeConditions | undefined): ParsedConditions | undefined {
  if (!table?.edges.length) return undefined;
  return { table, parsed: table.values.map(parseConditional) };
}

/** The first row for an edge, or -1; rows are sorted so the rest follow it. */
function firstRowFor(edges: Uint32Array, edge: number) {
  let low = 0;
  let high = edges.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (edges[middle] >= edge) { if (edges[middle] === edge) found = middle; high = middle - 1; } else low = middle + 1;
  }
  return found;
}

const CLOSED = new Set(["no", "private", "destination", "customers", "delivery", "permit", "agricultural", "forestry"]);

/**
 * What the conditional rules say about one edge at one moment: whether it is
 * closed, and any speed limit that applies.
 *
 * `destination` and the permit-style values count as closed because this
 * library has no notion of a journey's purpose, and treating "only if you live
 * here" as open would route strangers down a residents' street.
 */
export function conditionsOnEdge(conditions: ParsedConditions, edge: number, when: TravelTime, vehicle?: VehicleDimensions, circumstances?: Circumstances) {
  const { table, parsed } = conditions;
  let closed = false;
  let speedKph: number | undefined;
  for (let row = firstRowFor(table.edges, edge); row >= 0 && row < table.edges.length && table.edges[row] === edge; row += 1) {
    const value = conditionalValue(parsed[table.rules[row]], when, vehicle, circumstances);
    if (value === null) continue;
    if (table.kinds[row] === ConditionKind.access) {
      if (CLOSED.has(value.trim().toLowerCase())) closed = true;
    } else {
      // The same parser the plain `maxspeed` uses: a conditional limit is
      // written in the same units, and reading "30 mph" as 30 km/h would
      // slow a road to two-thirds of its real limit.
      const parsedSpeed = parseMaxSpeedKph(value);
      if (parsedSpeed !== null && parsedSpeed > 0) speedKph = speedKph === undefined ? parsedSpeed : Math.min(speedKph, parsedSpeed);
    }
  }
  return { closed, speedKph };
}

/**
 * The access mask for a departure time: the graph's own with the roads shut at
 * that moment cleared as well.
 *
 * Only closures are applied. A road whose plain tags already forbid it stays
 * forbidden even where a conditional value would open it, because the stored
 * mask has already dropped it and reopening one would need the compiler to
 * keep roads it currently discards. That errs towards refusing a road that is
 * in fact usable, which is the direction this library errs in everywhere else.
 */
export function accessAtTime(
  graph: Pick<RoadGraph, "edgeTargets" | "edgeAccess">,
  conditions: ParsedConditions | undefined,
  when: TravelTime | undefined,
  vehicle?: VehicleDimensions,
  base?: Uint8Array,
  circumstances?: Circumstances,
): Uint8Array | undefined {
  const start = base ?? graph.edgeAccess;
  if (!when || !conditions) return start;
  const edges = graph.edgeTargets.length;
  let mask: Uint8Array | undefined;
  const { table } = conditions;
  for (let row = 0; row < table.edges.length; row += 1) {
    const edge = table.edges[row];
    if (edge >= edges || table.kinds[row] !== ConditionKind.access) continue;
    // Rows are sorted by edge, so a repeat of one already cleared is skipped.
    if (mask && !edgeAllowed(mask, edge)) continue;
    if (!conditionsOnEdge(conditions, edge, when, vehicle, circumstances).closed) continue;
    mask ??= start ? Uint8Array.from(start) : accessMaskFor(edges, () => true);
    mask[edge >> 3] &= ~(1 << (edge & 7));
  }
  return mask ?? start;
}

/** How many edges this moment closes, for reporting rather than routing. */
export function countClosedAt(graph: Pick<RoadGraph, "edgeTargets" | "edgeAccess">, conditions: ParsedConditions | undefined, when: TravelTime, vehicle?: VehicleDimensions) {
  const before = graph.edgeAccess;
  const after = accessAtTime(graph, conditions, when, vehicle);
  if (after === before) return 0;
  let closed = 0;
  for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) {
    if (edgeAllowed(before, edge) && !edgeAllowed(after, edge)) closed += 1;
  }
  return closed;
}

/**
 * A graph's conditional values parsed once and kept against the graph, so a
 * search pays the parsing cost on its first route rather than on every edge.
 */
const parsedByTable = new WeakMap<EdgeConditions, ParsedConditions>();

export function conditionsOf(graph: Pick<RoadGraph, "edgeConditions">): ParsedConditions | undefined {
  const table = graph.edgeConditions;
  if (!table?.edges.length) return undefined;
  const existing = parsedByTable.get(table);
  if (existing) return existing;
  const parsed = parseEdgeConditions(table)!;
  parsedByTable.set(table, parsed);
  return parsed;
}

/**
 * The edges a conditional speed limit slows at this moment, as whole seconds.
 *
 * A conditional limit may only slow an edge, never speed it up. A faster
 * stored duration is left alone, because the A* bound is built from the
 * profile's ceiling and an edge quicker than the graph says would break the
 * guarantee that the route found is the best one.
 */
export function conditionalDurations(
  graph: Pick<RoadGraph, "edgeTargets" | "edgeDistancesMeters" | "edgeDistanceScale" | "edgeDurationsSeconds" | "edgeDurationScale">,
  conditions: ParsedConditions | undefined,
  when: TravelTime,
  vehicle?: VehicleDimensions,
  circumstances?: Circumstances,
): Map<number, number> | undefined {
  if (!conditions) return undefined;
  const distanceScale = graph.edgeDistanceScale ?? 1;
  const durationScale = graph.edgeDurationScale ?? 1;
  const slowed = new Map<number, number>();
  const { table } = conditions;
  for (let row = 0; row < table.edges.length; row += 1) {
    const edge = table.edges[row];
    if (table.kinds[row] !== ConditionKind.maxspeed || edge >= graph.edgeTargets.length || slowed.has(edge)) continue;
    const { speedKph } = conditionsOnEdge(conditions, edge, when, vehicle, circumstances);
    if (speedKph === undefined) continue;
    const stored = graph.edgeDurationsSeconds[edge] * durationScale;
    const limited = (graph.edgeDistancesMeters[edge] * distanceScale) / (speedKph / 3.6);
    if (limited > stored) slowed.set(edge, limited);
  }
  return slowed.size ? slowed : undefined;
}
