import type { RoadGraph } from "./types";
import { packTurnRestrictions } from "./turn-restrictions";

/**
 * Test-only graph builder. Roads are written as `A-B` (two-way) or `A>B`
 * (one-way), and banned turns as a pair of directed edges, so a test reads like
 * the junction it describes instead of like a CSR array.
 */
export type GraphSpec = {
  nodes: Record<string, [latitude: number, longitude: number]>;
  /** `A-B` for a two-way road, `A>B` for a one-way road. */
  roads: string[];
  /** Speeds in km/h per road, keyed exactly as written in `roads`. */
  speedsKph?: Record<string, number>;
  /** Banned turns, each `[arrivingEdge, departingEdge]` written as `A>B`. */
  bans?: [string, string][];
  /** Intermediate shape points per directed edge `A>B`, as `[latitude, longitude]` pairs. */
  shapes?: Record<string, [number, number][]>;
};

const DEFAULT_SPEED_KPH = 50;
const EARTH_RADIUS_METERS = 6_371_000;

export function haversineMeters(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180;
  const dLat = (b[0] - a[0]) * radians;
  const dLng = (b[1] - a[1]) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * radians) * Math.cos(b[0] * radians) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export type BuiltGraph = RoadGraph & {
  /** Node index by name, for asserting on `RouteResult.nodeIds`. */
  nodeIndex: Record<string, number>;
  /** Names in node-index order, for turning a route back into a readable path. */
  nodeNames: string[];
};

/** Renders `RouteResult.nodeIds` as the names used in the spec, e.g. `"W>C>E"`. */
export function pathOf(graph: BuiltGraph, nodeIds: number[]) {
  return nodeIds.map((id) => graph.nodeNames[id]).join(">");
}

export function buildGraph(spec: GraphSpec): BuiltGraph {
  const names = Object.keys(spec.nodes);
  const nodeIndex = Object.fromEntries(names.map((name, index) => [name, index]));
  const directed: { from: number; to: number; key: string; speed: number }[] = [];
  for (const road of spec.roads) {
    const separator = road.includes(">") ? ">" : "-";
    const [left, right] = road.split(separator);
    if (!(left in nodeIndex) || !(right in nodeIndex)) throw new Error(`Road "${road}" names a node that is not in the spec.`);
    const speed = spec.speedsKph?.[road] ?? DEFAULT_SPEED_KPH;
    directed.push({ from: nodeIndex[left], to: nodeIndex[right], key: `${left}>${right}`, speed });
    if (separator === "-") directed.push({ from: nodeIndex[right], to: nodeIndex[left], key: `${right}>${left}`, speed });
  }
  directed.sort((a, b) => a.from - b.from || a.to - b.to);

  const edgeIndex = new Map(directed.map((edge, index) => [edge.key, index]));
  const edgeOffsets = new Uint32Array(names.length + 1);
  for (const edge of directed) edgeOffsets[edge.from + 1] += 1;
  for (let index = 1; index < edgeOffsets.length; index += 1) edgeOffsets[index] += edgeOffsets[index - 1];

  const edgeDistancesMeters = new Float32Array(directed.length);
  const edgeDurationsSeconds = new Float32Array(directed.length);
  const edgeShapeOffsets = new Uint32Array(directed.length + 1);
  const shapeLatitudes: number[] = [];
  const shapeLongitudes: number[] = [];
  let hasShapes = false;
  for (let index = 0; index < directed.length; index += 1) {
    const edge = directed[index];
    const shape = spec.shapes?.[edge.key] ?? [];
    if (shape.length) hasShapes = true;
    let distance = 0;
    const points: [number, number][] = [spec.nodes[names[edge.from]], ...shape, spec.nodes[names[edge.to]]];
    for (let point = 1; point < points.length; point += 1) distance += haversineMeters(points[point - 1], points[point]);
    edgeDistancesMeters[index] = distance;
    edgeDurationsSeconds[index] = distance / (edge.speed * (1000 / 3600));
    edgeShapeOffsets[index + 1] = edgeShapeOffsets[index] + shape.length;
    for (const [latitude, longitude] of shape) { shapeLatitudes.push(latitude); shapeLongitudes.push(longitude); }
  }

  const bans = (spec.bans ?? []).map(([fromKey, toKey]) => {
    const fromEdge = edgeIndex.get(fromKey);
    const toEdge = edgeIndex.get(toKey);
    if (fromEdge === undefined || toEdge === undefined) throw new Error(`Banned turn "${fromKey}" -> "${toKey}" names a road that is not in the spec.`);
    return [fromEdge, toEdge] as const;
  });

  const coordinateScale = 10_000_000;
  return {
    nodeIndex,
    nodeNames: names,
    nodeLatitudes: Int32Array.from(names, (name) => Math.round(spec.nodes[name][0] * coordinateScale)),
    nodeLongitudes: Int32Array.from(names, (name) => Math.round(spec.nodes[name][1] * coordinateScale)),
    coordinateScale,
    edgeOffsets,
    edgeTargets: Uint32Array.from(directed, (edge) => edge.to),
    edgeDistancesMeters,
    edgeDurationsSeconds,
    ...(hasShapes ? {
      edgeShapeOffsets,
      edgeShapeLatitudes: Int32Array.from(shapeLatitudes, (value) => Math.round(value * coordinateScale)),
      edgeShapeLongitudes: Int32Array.from(shapeLongitudes, (value) => Math.round(value * coordinateScale)),
    } : {}),
    ...(bans.length ? packTurnRestrictions(bans) : {}),
  };
}

export type RangeStats = { requests: number; bytes: number; rangeHeaders: string[] };

/**
 * Serves an in-memory bundle over HTTP Range semantics and records what was
 * read, so tests can assert that only the route-relevant tiles were fetched.
 */
export function rangeFetcher(bundle: ArrayBuffer) {
  const stats: RangeStats = { requests: 0, bytes: 0, rangeHeaders: [] };
  const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
    const header = String((init?.headers as Record<string, string>)?.Range);
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(header) ?? [];
    const slice = bundle.slice(Number(start), Number(end) + 1);
    stats.requests += 1;
    stats.bytes += slice.byteLength;
    stats.rangeHeaders.push(header);
    return new Response(slice, { status: 206 });
  };
  return { fetcher, stats };
}
