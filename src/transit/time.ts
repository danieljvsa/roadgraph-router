/**
 * Dates and times the way GTFS writes them.
 *
 * A service day is named by its date, YYYYMMDD, and times are seconds after
 * "noon minus twelve hours" on that date in the agency's timezone. That is
 * midnight except on the two days a year the clocks change, and it is why a
 * time may run past 24:00:00: a trip leaving at 23:50 and arriving at 00:20
 * belongs to the day it set out on, and arrives at 24:20:00.
 */

const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

/** `H:MM:SS` or `HH:MM:SS`, hours unbounded. Returns -1 for an empty field. */
export function parseGtfsTime(value: string): number {
  const text = value.trim();
  if (text === "") return -1;
  const parts = text.split(":");
  if (parts.length !== 3) throw new Error(`Unreadable GTFS time "${value}".`);
  const [h, m, s] = parts.map((part) => Number(part));
  if (![h, m, s].every((n) => Number.isInteger(n) && n >= 0) || m > 59 || s > 59) {
    throw new Error(`Unreadable GTFS time "${value}".`);
  }
  return h * 3600 + m * 60 + s;
}

/** YYYYMMDD to days since 1970-01-01. */
export function dayNumber(date: string): number {
  if (!/^\d{8}$/.test(date)) throw new Error(`Unreadable GTFS date "${date}".`);
  return Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))) / MS_PER_DAY);
}

/** Days since 1970-01-01 back to YYYYMMDD. */
export function dateOfDay(day: number): string {
  const d = new Date(day * MS_PER_DAY);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 0 = Monday … 6 = Sunday, matching the column order of calendar.txt. */
export function weekdayOfDay(day: number): number {
  // 1970-01-01 was a Thursday.
  return (day + 3) % 7;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The wall-clock reading in `timeZone` at instant `ms`. */
function wallClock(ms: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string) {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** Where an instant falls on the local calendar: its service day and seconds into it. */
export function localServiceTime(ms: number, timeZone: string): { day: number; seconds: number } {
  const w = wallClock(ms, timeZone);
  const day = Math.round(Date.UTC(w.year, w.month - 1, w.day) / MS_PER_DAY);
  // Measured from noon minus twelve hours, not from the wall clock's midnight,
  // so the number agrees with the feed on the days the clocks change.
  return { day, seconds: Math.round((ms - serviceDayOrigin(day, timeZone)) / 1000) };
}

/** The instant that GTFS time 00:00:00 refers to on service day `day`: local noon minus twelve hours. */
export function serviceDayOrigin(day: number, timeZone: string): number {
  const noonUtcGuess = day * MS_PER_DAY + 12 * 3600 * 1000;
  const noon = noonUtcGuess - zoneOffsetMs(noonUtcGuess, timeZone);
  return noon - 12 * 3600 * 1000;
}

export { SECONDS_PER_DAY };
