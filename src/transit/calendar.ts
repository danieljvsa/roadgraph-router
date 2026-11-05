import { dayNumber, weekdayOfDay } from "./time";
import type { TransitTimetable } from "./types";

/**
 * Which days each service runs, and which day's timetable a feed is read on
 * for a requested day: the day itself when the feed covers it, otherwise
 * (when asked) the nearest covered day with the same weekday.
 */
export class ServiceCalendar {
  /** Per feed, 1 for each day (from `firstDay`) on which that feed runs any trip. */
  private readonly feedRuns: Uint8Array[];
  private readonly bytesPerService: number;

  constructor(private readonly timetable: TransitTimetable) {
    this.bytesPerService = Math.ceil(timetable.dayCount / 8);
    this.feedRuns = timetable.feeds.map(() => new Uint8Array(timetable.dayCount));
    for (let s = 0; s < timetable.serviceCount; s += 1) {
      const runs = this.feedRuns[timetable.serviceFeed[s]];
      for (let d = 0; d < timetable.dayCount; d += 1) if (this.runsOn(s, timetable.firstDay + d)) runs[d] = 1;
    }
  }

  runsOn(service: number, day: number) {
    const t = this.timetable;
    const bit = day - t.firstDay;
    if (bit < 0 || bit >= t.dayCount) return false;
    return (t.serviceDays[service * this.bytesPerService + (bit >> 3)] & (1 << (bit & 7))) !== 0;
  }

  /** The day whose timetable feed `index` is read on, or null when it has none to offer. */
  dayFor(index: number, day: number, fallback: "none" | "same-weekday"): number | null {
    const feed = this.timetable.feeds[index];
    if (!feed.firstServiceDate) return null;
    // A substitute must be a day the feed actually runs trips on: some exports
    // list dates for a service no trip uses, which would be a day with nothing.
    const runs = (d: number) => this.feedRuns[index][d - this.timetable.firstDay] === 1;
    const first = dayNumber(feed.firstServiceDate);
    const last = dayNumber(feed.lastServiceDate);
    if (day >= first && day <= last) return day;
    if (fallback === "none") return null;
    const weekday = weekdayOfDay(day);
    // The covered day nearest in time with the same weekday: the last such day
    // when the feed has expired, the first when it has not started yet.
    if (day > last) {
      for (let d = last; d >= first; d -= 1) if (weekdayOfDay(d) === weekday && runs(d)) return d;
    } else {
      for (let d = first; d <= last; d += 1) if (weekdayOfDay(d) === weekday && runs(d)) return d;
    }
    return null;
  }
}
