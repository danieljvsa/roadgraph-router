/**
 * What a railway track states about itself, how a bundle stores it, and how a
 * caller's constraints turn it into a yes or a no for one edge.
 *
 * Three things set this apart from the physical limits a lorry is measured
 * against. The attributes belong to the track rather than to one direction
 * along it. They repeat enormously — in the Portugal extract nearly nine
 * thousand `railway=rail` ways state only a handful of distinct combinations,
 * because a whole line is built to one gauge and one electrical system — so
 * they are stored as a small table of distinct rows with one index per edge
 * rather than as columns over every edge. And, most importantly, an untagged
 * value is *unknown*, never a default: a track that does not say it is
 * electrified has not said it is unelectrified either, and this module never
 * treats silence as either answer.
 *
 * ### The policy for missing tags
 *
 * A constraint excludes a track only where the track's own tags contradict it.
 * Track saying nothing about the attribute being constrained stays usable,
 * because OSM silence is an absence of survey rather than a statement of
 * incompatibility, and excluding every unstated track would reduce most
 * networks to nothing. That permissiveness is never reported as compatibility:
 * `railwayCertainty` says how much of a route ran on track that stated
 * nothing, and `strictUnknown` flips the default for a caller who would rather
 * have no route than an unverified one.
 */

import { accessMaskFor, edgeAllowed } from "./access";
import type { EdgeRailway, RoadGraph } from "./types";
import { ProfileId, type RailwayAttributes } from "./profile-types";

/** How a track is electrified. `none` is a stated `electrified=no`, not an absent tag. */
export const Electrification = {
  unknown: 0,
  /** `electrified=no`: the track is stated to have no contact system. */
  none: 1,
  /** `electrified=contact_line`: overhead wire. */
  contactLine: 2,
  /** `electrified=rail`: a third or fourth rail, which is how most metros run. */
  conductorRail: 3,
  /** `electrified=yes`: electrified, with the system left unsaid. */
  yes: 4,
  /** Electrified by something this table has no name for. */
  other: 5,
} as const;
export type Electrification = (typeof Electrification)[keyof typeof Electrification];

/**
 * The contact system's frequency. Direct current is `dc` rather than
 * `unknown`, because `frequency=0` is a statement and an absent tag is not.
 */
export const RailFrequency = { unknown: 0, dc: 1, hz16_7: 2, hz25: 3, hz50: 4, hz60: 5, other: 6 } as const;
export type RailFrequency = (typeof RailFrequency)[keyof typeof RailFrequency];
export type RailFrequencyName = "dc" | "16.7" | "25" | "50" | "60";

const FREQUENCY_NAMES: Record<RailFrequencyName, number> = {
  dc: RailFrequency.dc, "16.7": RailFrequency.hz16_7, "25": RailFrequency.hz25, "50": RailFrequency.hz50, "60": RailFrequency.hz60,
};

/** What the line is for, from OSM's `usage`. */
export const RailUsage = { unknown: 0, main: 1, branch: 2, industrial: 3, military: 4, tourism: 5, freight: 6, test: 7, other: 8 } as const;
export type RailUsage = (typeof RailUsage)[keyof typeof RailUsage];
export type RailUsageName = "main" | "branch" | "industrial" | "military" | "tourism" | "freight" | "test";

const USAGE_NAMES: Record<RailUsageName, number> = {
  main: RailUsage.main, branch: RailUsage.branch, industrial: RailUsage.industrial,
  military: RailUsage.military, tourism: RailUsage.tourism, freight: RailUsage.freight, test: RailUsage.test,
};

/**
 * What kind of service track this is, from OSM's `service`. `running` is the
 * absence of the tag, which in OSM means a running line rather than an
 * unsurveyed one — this is the one key where silence does carry a meaning.
 */
export const RailService = { running: 0, siding: 1, yard: 2, spur: 3, crossover: 4, other: 5 } as const;
export type RailService = (typeof RailService)[keyof typeof RailService];

/** A row saying nothing at all, which is what an edge with no railway tags gets. */
export const UNKNOWN_RAILWAY: RailwayAttributes = {
  gaugeMm: 0, secondGaugeMm: 0, electrification: Electrification.unknown,
  voltage: 0, secondVoltage: 0, frequency: RailFrequency.unknown, secondFrequency: RailFrequency.unknown,
  usage: RailUsage.unknown, service: RailService.running,
};

/** Gauges above this are not a track gauge; the value is stored in 16 bits. */
const MAX_GAUGE_MM = 65535;
const MAX_VOLTAGE = 65535;

function values(raw: string | undefined) {
  return raw ? raw.split(";").map((part) => part.trim().toLowerCase()).filter(Boolean) : [];
}

/**
 * Reads `gauge`. OSM states it in millimetres, and a dual-gauge track states
 * both separated by a semicolon. Anything that is not a plain number — the
 * occasional `standard` or `narrow` — reads as unknown rather than being
 * guessed at, since guessing it wrong is what puts a train on the wrong track.
 */
export function parseGaugeMm(raw: string | undefined): { gaugeMm: number; secondGaugeMm: number } {
  const found: number[] = [];
  for (const part of values(raw)) {
    const amount = Number(part);
    if (Number.isFinite(amount) && amount > 0 && amount <= MAX_GAUGE_MM) found.push(Math.round(amount));
  }
  found.sort((a, b) => a - b);
  return { gaugeMm: found[0] ?? 0, secondGaugeMm: found[1] ?? 0 };
}

/** Reads `electrified`. */
export function parseElectrification(raw: string | undefined): number {
  const text = raw?.trim().toLowerCase();
  if (!text) return Electrification.unknown;
  if (text === "no" || text === "none") return Electrification.none;
  if (text === "contact_line" || text === "overhead") return Electrification.contactLine;
  if (text === "rail" || text === "3rd_rail" || text === "4th_rail") return Electrification.conductorRail;
  if (text === "yes") return Electrification.yes;
  return Electrification.other;
}

/**
 * Reads `voltage`, tolerating the `750v` form the data actually contains. A
 * dual-system track states both, separated by a semicolon — `1500;25000` —
 * and a train matching either can run over it, so both are kept.
 */
export function parseVoltage(raw: string | undefined): { voltage: number; secondVoltage: number } {
  const found: number[] = [];
  for (const part of values(raw)) {
    const amount = Number(/^(\d+(?:\.\d+)?)\s*(?:v|volts?|kv)?$/.exec(part)?.[1] ?? NaN);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const volts = Math.round(/kv$/.test(part) ? amount * 1000 : amount);
    if (volts <= MAX_VOLTAGE && !found.includes(volts)) found.push(volts);
  }
  found.sort((a, b) => a - b);
  return { voltage: found[0] ?? 0, secondVoltage: found[1] ?? 0 };
}

function oneFrequency(text: string): number {
  if (text === "0") return RailFrequency.dc;
  // `16 2/3` and `16.67` are the same system written three different ways.
  if (/^16([.,]\d+)?(\s*2\/3)?$/.test(text)) return RailFrequency.hz16_7;
  const amount = Number(text.replace(",", "."));
  if (!Number.isFinite(amount)) return RailFrequency.other;
  if (amount === 25) return RailFrequency.hz25;
  if (amount === 50) return RailFrequency.hz50;
  if (amount === 60) return RailFrequency.hz60;
  return RailFrequency.other;
}

/**
 * Reads `frequency` in hertz. `0` is direct current, which is a stated fact
 * and not an absent one. A changeover line states both systems — `0;16.7` is
 * on 176 Swiss ways — and a train taking either can run over it, so both are
 * kept.
 */
export function parseFrequency(raw: string | undefined): { frequency: number; secondFrequency: number } {
  const found: number[] = [];
  for (const part of values(raw)) {
    const one = oneFrequency(part);
    if (!found.includes(one)) found.push(one);
  }
  found.sort((a, b) => a - b);
  return { frequency: found[0] ?? RailFrequency.unknown, secondFrequency: found[1] ?? RailFrequency.unknown };
}

export function parseUsage(raw: string | undefined): number {
  const text = raw?.trim().toLowerCase();
  if (!text) return RailUsage.unknown;
  return USAGE_NAMES[text as RailUsageName] ?? RailUsage.other;
}

export function parseService(raw: string | undefined): number {
  const text = raw?.trim().toLowerCase();
  if (!text) return RailService.running;
  if (text === "siding") return RailService.siding;
  if (text === "yard") return RailService.yard;
  if (text === "spur") return RailService.spur;
  if (text === "crossover") return RailService.crossover;
  return RailService.other;
}

/** Everything a railway way states about itself, read off its tags. */
export function railwayAttributesFor(tags: Record<string, string | undefined>): RailwayAttributes {
  return {
    ...parseGaugeMm(tags.gauge),
    ...parseVoltage(tags.voltage),
    ...parseFrequency(tags.frequency),
    electrification: parseElectrification(tags.electrified),
    usage: parseUsage(tags.usage),
    service: parseService(tags.service),
  };
}

/** The tag keys the attributes above are read from. */
export const RAILWAY_ATTRIBUTE_KEYS = ["gauge", "electrified", "voltage", "frequency", "usage", "service"] as const;

/* ------------------------------------------------------------ storage ---- */

function rowKey(railway: RailwayAttributes) {
  return `${railway.gaugeMm},${railway.secondGaugeMm},${railway.electrification},${railway.voltage},${railway.secondVoltage},${railway.frequency},${railway.secondFrequency},${railway.usage},${railway.service}`;
}

const EMPTY_KEY = rowKey(UNKNOWN_RAILWAY);
/** Row indices are stored in 16 bits, which is thousands of times more than any extract needs. */
const MAX_RAILWAY_ROWS = 65535;

/**
 * Collects the per-edge attributes a compiler gathered into the stored table,
 * folding every edge that states the same thing onto one row. Row 0 is always
 * the empty row, so an edge nobody described costs an index of zero and
 * nothing else.
 */
export function packEdgeRailway(entries: { edge: number; railway: RailwayAttributes }[], edges: number): EdgeRailway | undefined {
  const rows: RailwayAttributes[] = [UNKNOWN_RAILWAY];
  const index = new Map<string, number>([[EMPTY_KEY, 0]]);
  const edgeRows = new Uint16Array(edges);
  let described = false;
  for (const { edge, railway } of entries) {
    if (edge < 0 || edge >= edges) throw new Error("Railway attributes reference an edge outside the graph.");
    const key = rowKey(railway);
    let row = index.get(key);
    if (row === undefined) {
      if (rows.length > MAX_RAILWAY_ROWS) throw new Error("A tile states more distinct railway attributes than the format can hold.");
      row = rows.length;
      rows.push(railway);
      index.set(key, row);
    }
    edgeRows[edge] = row;
    if (row) described = true;
  }
  if (!described) return undefined;
  return {
    edgeRows,
    gaugeMm: Uint16Array.from(rows, (row) => row.gaugeMm),
    secondGaugeMm: Uint16Array.from(rows, (row) => row.secondGaugeMm),
    voltage: Uint16Array.from(rows, (row) => row.voltage),
    secondVoltage: Uint16Array.from(rows, (row) => row.secondVoltage),
    electrification: Uint8Array.from(rows, (row) => row.electrification),
    frequency: Uint8Array.from(rows, (row) => row.frequency),
    secondFrequency: Uint8Array.from(rows, (row) => row.secondFrequency),
    usage: Uint8Array.from(rows, (row) => row.usage),
    service: Uint8Array.from(rows, (row) => row.service),
  };
}

/** What the table says about one edge, or `undefined` where it holds no table. */
export function railwayOf(graph: Pick<RoadGraph, "edgeRailway">, edge: number): RailwayAttributes | undefined {
  const table = graph.edgeRailway;
  if (!table || edge < 0 || edge >= table.edgeRows.length) return undefined;
  return rowAttributes(table, table.edgeRows[edge]);
}

/** One row of a stored table, as the attributes it stands for. */
function rowAttributes(table: EdgeRailway, row: number): RailwayAttributes {
  return {
    gaugeMm: table.gaugeMm[row], secondGaugeMm: table.secondGaugeMm[row],
    voltage: table.voltage[row], secondVoltage: table.secondVoltage[row],
    electrification: table.electrification[row],
    frequency: table.frequency[row], secondFrequency: table.secondFrequency[row],
    usage: table.usage[row], service: table.service[row],
  };
}

/* -------------------------------------------------------- constraints ---- */

/**
 * What the train being routed can actually run on. Every field is optional,
 * and leaving one out asks no question about it rather than assuming an
 * answer. See the policy at the top of this file for how an untagged track is
 * treated.
 */
export type RailwayConstraints = {
  /** The vehicle's gauge in millimetres; several for a gauge-changing or dual-gauge vehicle. */
  gaugeMm?: number | readonly number[];
  /** Keep to track stated to be electrified. Track saying nothing stays usable unless `strictUnknown`. */
  requireElectrification?: boolean;
  /** Contact voltages the vehicle can take; several for a multi-system vehicle. */
  voltage?: number | readonly number[];
  /** Contact frequencies the vehicle can take. `"dc"` is direct current. */
  frequency?: RailFrequencyName | readonly RailFrequencyName[];
  /** Keep sidings, yards, spurs and crossovers out of the route. */
  excludeServiceTracks?: boolean;
  /** Only these usages. Left out, every usage is accepted, stated or not. */
  usage?: readonly RailUsageName[];
  /**
   * Treat an unstated attribute as incompatible rather than as unknown. This
   * will refuse routes over track nobody has surveyed, which on most networks
   * is a great deal of it; it is the right setting when a route that might not
   * be runnable is worse than no route at all.
   */
  strictUnknown?: boolean;
};

function asList<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value as readonly T[]) : ([value] as readonly T[]);
}

/* --------------------------------------------------------- validation --- */

/**
 * The bounds a stated constraint has to fall inside.
 *
 * Gauges run from the 260 mm of a miniature railway to the 3,000 mm of a few
 * historical broad-gauge lines; the stored column is sixteen bits, which is
 * the hard ceiling. Voltages run from a 48 V funicular to the 50 kV of heavy
 * freight. Anything outside is a mistake rather than an unusual railway, and
 * saying so is more useful than quietly routing as though nothing had been
 * asked.
 */
const MIN_GAUGE_MM = 100;
const MIN_VOLTAGE = 1;

class RailwayConstraintError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "RailwayConstraintError";
  }
}

function fail(where: string, field: string, saw: unknown, wanted: string): never {
  const shown = typeof saw === "string" ? JSON.stringify(saw)
    : Array.isArray(saw) ? `[${saw.map((value) => JSON.stringify(value)).join(", ")}]`
    : String(saw);
  throw new RailwayConstraintError(`${where}.${field} must be ${wanted}, not ${shown}.`);
}

/** A number constraint, which may also be given as a non-empty list of them. */
function checkNumbers(where: string, field: string, value: unknown, low: number, high: number, whole: boolean) {
  const list = Array.isArray(value) ? value : [value];
  if (Array.isArray(value) && value.length === 0) {
    fail(where, field, value, `a number or a non-empty list of numbers between ${low} and ${high}`);
  }
  for (const entry of list) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < low || entry > high || (whole && !Number.isInteger(entry))) {
      fail(where, field, entry, `${whole ? "a whole number" : "a number"} between ${low} and ${high}`);
    }
  }
}

function checkBoolean(where: string, field: string, value: unknown) {
  if (typeof value !== "boolean") fail(where, field, value, "true or false");
}

/** A name constraint, which may also be given as a non-empty list of names. */
function checkNames(where: string, field: string, value: unknown, allowed: readonly string[], listOnly: boolean) {
  if (listOnly && !Array.isArray(value)) fail(where, field, value, `a list of ${allowed.join(", ")}`);
  const list = Array.isArray(value) ? value : [value];
  if (!list.length) fail(where, field, value, `a non-empty list of ${allowed.join(", ")}`);
  for (const entry of list) {
    if (typeof entry !== "string" || !allowed.includes(entry)) fail(where, field, entry, `one of ${allowed.join(", ")}`);
  }
}

const CONSTRAINT_FIELDS = new Set([
  "gaugeMm", "requireElectrification", "voltage", "frequency", "excludeServiceTracks", "usage", "strictUnknown",
]);

/**
 * Checks a caller's constraints before anything expensive happens.
 *
 * A malformed constraint is a programming mistake, and the worst thing this
 * could do with one is ignore it: `{ gaugeMm: NaN }` compared against a stated
 * gauge is false for every track, so a silent reading would close the whole
 * network and report "no route" for what is really a typo. `{ gaugeMm: -1 }`
 * would do the opposite on a different field. Both are refused by name.
 *
 * Called from `route()` and `routeAlternatives()`, and from `RoadRouter.open`
 * where a standing constraint is supplied — the last of those is what keeps a
 * bad value from costing a tile download before anyone notices.
 */
export function assertRailwayConstraints(constraints: unknown, where = "railway"): asserts constraints is RailwayConstraints | undefined {
  if (constraints === undefined || constraints === null) return;
  if (typeof constraints !== "object" || Array.isArray(constraints)) {
    throw new RailwayConstraintError(`${where} must be an object of railway constraints, not ${Array.isArray(constraints) ? "an array" : typeof constraints}.`);
  }
  const given = constraints as Record<string, unknown>;

  // An unknown key is almost always a misspelling of a real one, and a
  // misspelled constraint is one that silently does not apply.
  for (const key of Object.keys(given)) {
    if (given[key] === undefined) continue;
    if (!CONSTRAINT_FIELDS.has(key)) {
      throw new RailwayConstraintError(
        `${where}.${key} is not a railway constraint. The constraints are: ${[...CONSTRAINT_FIELDS].join(", ")}.`);
    }
  }

  if (given.gaugeMm !== undefined) checkNumbers(where, "gaugeMm", given.gaugeMm, MIN_GAUGE_MM, MAX_GAUGE_MM, true);
  if (given.voltage !== undefined) checkNumbers(where, "voltage", given.voltage, MIN_VOLTAGE, MAX_VOLTAGE, false);
  if (given.frequency !== undefined) checkNames(where, "frequency", given.frequency, Object.keys(FREQUENCY_NAMES), false);
  if (given.usage !== undefined) checkNames(where, "usage", given.usage, Object.keys(USAGE_NAMES), true);
  if (given.requireElectrification !== undefined) checkBoolean(where, "requireElectrification", given.requireElectrification);
  if (given.excludeServiceTracks !== undefined) checkBoolean(where, "excludeServiceTracks", given.excludeServiceTracks);
  if (given.strictUnknown !== undefined) checkBoolean(where, "strictUnknown", given.strictUnknown);
}

/** True when any constraint in `constraints` could actually exclude an edge. */
export function constrainsAnything(constraints: RailwayConstraints | undefined): boolean {
  if (!constraints) return false;
  return constraints.gaugeMm !== undefined || constraints.requireElectrification === true
    || constraints.voltage !== undefined || constraints.frequency !== undefined
    || constraints.excludeServiceTracks === true || (constraints.usage?.length ?? 0) > 0;
}

/** Why one edge is not usable, or null when it is. Exported for diagnostics and tests. */
export function railwayRefusal(railway: RailwayAttributes, constraints: RailwayConstraints): string | null {
  const strict = constraints.strictUnknown === true;

  const gauges = asList(constraints.gaugeMm);
  if (gauges?.length) {
    const stated = [railway.gaugeMm, railway.secondGaugeMm].filter(Boolean);
    if (!stated.length) { if (strict) return "the track states no gauge"; }
    else if (!stated.some((value) => gauges.includes(value))) return `the track is ${stated.join("/")} mm gauge`;
  }

  if (constraints.requireElectrification) {
    if (railway.electrification === Electrification.none) return "the track is stated to be unelectrified";
    if (railway.electrification === Electrification.unknown && strict) return "the track states no electrification";
  }

  const voltages = asList(constraints.voltage);
  if (voltages?.length) {
    const stated = [railway.voltage, railway.secondVoltage].filter(Boolean);
    if (!stated.length) { if (strict) return "the track states no voltage"; }
    else if (!stated.some((value) => voltages.includes(value))) return `the track is electrified at ${stated.join("/")} V`;
  }

  const frequencies = asList(constraints.frequency);
  if (frequencies?.length) {
    const wanted = frequencies.map((name) => FREQUENCY_NAMES[name]).filter(Boolean);
    const stated = [railway.frequency, railway.secondFrequency].filter((value) => value !== RailFrequency.unknown);
    if (!stated.length) { if (strict) return "the track states no frequency"; }
    else if (!stated.some((value) => wanted.includes(value))) return "the track uses a different electrical frequency";
  }

  if (constraints.excludeServiceTracks && railway.service !== RailService.running) return "the track is a siding, yard, spur or crossover";

  if (constraints.usage?.length) {
    const wanted = constraints.usage.map((name) => USAGE_NAMES[name]).filter(Boolean);
    if (railway.usage === RailUsage.unknown) { if (strict) return "the track states no usage"; }
    else if (!wanted.includes(railway.usage)) return "the track has a different usage";
  }

  return null;
}

/**
 * The access mask a search should use for one train: the profile's own mask
 * with every track the train cannot run on cleared as well. Mirrors
 * `accessForVehicle`, and composes with it the same way — each narrowing step
 * takes the mask the step before it produced.
 */
export function accessForRailway(graph: RoadGraph, constraints: RailwayConstraints | undefined, base: Uint8Array | undefined = graph.edgeAccess): Uint8Array | undefined {
  const table = graph.edgeRailway;
  if (!constrainsAnything(constraints)) return base;
  const edges = graph.edgeTargets.length;
  if (!table) {
    // A railway graph with no table at all is one where every track states
    // nothing. Under the default policy that changes nothing — silence is not
    // a refusal — but a caller who asked for strictness asked not to be given
    // a route over track nobody has described, and that is the whole graph.
    const railway = graph.profileId === ProfileId.train || graph.profileId === ProfileId.metro;
    if (!railway || !railwayRefusal(UNKNOWN_RAILWAY, constraints!)) return base;
    return accessMaskFor(edges, () => false);
  }
  // Rows repeat across thousands of edges, so each distinct row is judged once.
  const rowCount = table.gaugeMm.length;
  const refused = new Uint8Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    refused[row] = railwayRefusal(rowAttributes(table, row), constraints!) ? 1 : 0;
  }
  if (!refused.some(Boolean)) return base;
  const mask = base ? Uint8Array.from(base) : accessMaskFor(edges, () => true);
  for (let edge = 0; edge < edges; edge += 1) {
    if (refused[table.edgeRows[edge]]) mask[edge >> 3] &= ~(1 << (edge & 7));
  }
  return mask;
}

/**
 * How much of a route ran on track that said nothing about what was asked of
 * it. A route is only as trustworthy as the survey behind it, and this is the
 * number that says so: a route entirely over unstated gauge satisfies a gauge
 * constraint without any evidence that it really does.
 */
export type RailwayCertainty = {
  /**
   * Metres of the route whose track stated every attribute that was
   * constrained. The two edges a route enters and leaves on are counted at
   * their full length rather than at the part actually travelled, so the
   * totals can slightly exceed the route's own distance: this measures which
   * tracks a route used, not how far it went along each.
   */
  statedMeters: number;
  /** Metres whose track left at least one constrained attribute unstated. */
  unstatedMeters: number;
  /** Which attributes were unstated somewhere along the route. */
  unstated: string[];
  /** Metres run over a siding, yard, spur or crossover. */
  serviceTrackMeters: number;
  /** Every distinct gauge the route ran over, in millimetres; more than one is a gauge change. */
  gauges: number[];
};

export function railwayCertainty(graph: RoadGraph, edgeIds: readonly number[], constraints: RailwayConstraints = {}): RailwayCertainty {
  const scale = graph.edgeDistanceScale ?? 1;
  const result: RailwayCertainty = { statedMeters: 0, unstatedMeters: 0, unstated: [], serviceTrackMeters: 0, gauges: [] };
  const unstated = new Set<string>();
  const gauges = new Set<number>();
  for (const edge of edgeIds) {
    const railway = railwayOf(graph, edge);
    const length = (graph.edgeDistancesMeters[edge] ?? 0) * scale;
    if (!railway) { result.unstatedMeters += length; unstated.add("railway attributes"); continue; }
    if (railway.gaugeMm) gauges.add(railway.gaugeMm);
    if (railway.service !== RailService.running) result.serviceTrackMeters += length;
    const missing: string[] = [];
    if (constraints.gaugeMm !== undefined && !railway.gaugeMm) missing.push("gauge");
    if (constraints.requireElectrification && railway.electrification === Electrification.unknown) missing.push("electrification");
    if (constraints.voltage !== undefined && !railway.voltage) missing.push("voltage");
    if (constraints.frequency !== undefined && railway.frequency === RailFrequency.unknown) missing.push("frequency");
    if (constraints.usage?.length && railway.usage === RailUsage.unknown) missing.push("usage");
    if (missing.length) { result.unstatedMeters += length; for (const key of missing) unstated.add(key); }
    else result.statedMeters += length;
  }
  result.unstated = [...unstated].sort();
  result.gauges = [...gauges].sort((a, b) => a - b);
  return result;
}

/** How many edges these constraints close, for reporting rather than routing. */
export function countRailwayBlocked(graph: RoadGraph, constraints: RailwayConstraints) {
  const mask = accessForRailway(graph, constraints);
  if (!mask) return 0;
  let blocked = 0;
  for (let edge = 0; edge < graph.edgeTargets.length; edge += 1) if (!edgeAllowed(mask, edge)) blocked += 1;
  return blocked;
}
