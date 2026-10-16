/**
 * Reading a speed off an OSM tag.
 *
 * It lives on its own because both the profiles and the conditional
 * restrictions need it, and a conditional limit is written in the same units
 * as a plain one: `maxspeed:conditional = 30 mph @ (Mo-Fr 07:00-19:00)` means
 * 30 mph, not 30 km/h.
 */

/** Kilometres per hour, or null when the value is not a speed this reads. */
export function parseMaxSpeedKph(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text === "walk") return 7;
  const match = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|knots)?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (match[2] === "mph") return amount * 1.609344;
  if (match[2] === "knots") return amount * 1.852;
  return amount;
}
