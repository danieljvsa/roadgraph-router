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

/** When a journey passes, in the local time of the road it passes on. */
export type TravelTime = {
  /** 0 is Monday, 6 is Sunday. */
  weekday: number;
  /** Minutes since midnight, 0 to 1439. */
  minutes: number;
  /** 1 to 12, for a seasonal rule. */
  month: number;
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
   * The part of the condition this parser could not read — weather, a user
   * group, a stay duration. A condition carrying one is never matched, and is
   * counted so it can be reported rather than quietly ignored.
   */
  unreadable?: string;
};

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

/** Whether one condition group holds at this moment, for this vehicle. */
export function conditionHolds(condition: Condition, when: TravelTime, vehicle?: VehicleDimensions): boolean {
  // A condition this parser could not read is never treated as holding, and
  // the caller is expected to have counted it.
  if (condition.unreadable !== undefined) return false;
  if (condition.publicHoliday && !when.publicHoliday) return false;
  if (condition.days?.length && !condition.days.some((range) => withinRange(when.weekday, range))) return false;
  if (condition.months?.length && !condition.months.some((range) => withinRange(when.month - 1, range))) return false;
  if (condition.times?.length && !condition.times.some((span) => withinSpan(when.minutes, span))) return false;
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
export function conditionalValue(rules: ConditionalRule[], when: TravelTime, vehicle?: VehicleDimensions): string | null {
  let effective: string | null = null;
  for (const rule of rules) {
    if (rule.conditions.some((condition) => conditionHolds(condition, when, vehicle))) effective = rule.value;
  }
  return effective;
}

/** How many of these rules rest on something this parser cannot read. */
export function unreadableConditions(rules: ConditionalRule[]) {
  return rules.reduce((count, rule) => count + rule.conditions.filter((condition) => condition.unreadable !== undefined).length, 0);
}

/** The moment a journey is travelled, from a date in the road's own local time. */
export function travelTimeFrom(date: Date, publicHoliday = false): TravelTime {
  return {
    weekday: (date.getDay() + 6) % 7,
    minutes: date.getHours() * 60 + date.getMinutes(),
    month: date.getMonth() + 1,
    publicHoliday,
  };
}
