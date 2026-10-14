import type { ProfileChunk, RoadGraph, SharedRoadGraph } from "./types";
import { allowsEverything } from "./access";
import { VarintReader, VarintWriter } from "./varint";
import { getRoutingProfileById } from "./routing-profile";

const MAGIC = 0x45465254;
const VERSION = 1;
const HEADER_BYTES = 16;
const COMPACT_MAGIC = 0x32524645; // EFR2 family
const COMPACT_VERSION = 2;
const SHAPED_COMPACT_VERSION = 3;
const RESTRICTED_COMPACT_VERSION = 4;
/** v5 adds banned edge sequences for `via`-way turn restrictions. */
const SEQUENCED_COMPACT_VERSION = 5;
const COMPACT_HEADER_BYTES = 32;
/** v3 and v4 share one 40-byte header; v4 fills the shape-point field's spare neighbour. */
const SHAPED_COMPACT_HEADER_BYTES = 40;
// v7 is listed so that handing half a split tile to decodeGraph() is answered
// by the explanation of what it is, rather than by "unsupported format".
const SUPPORTED_COMPACT_VERSIONS = new Set<number>([COMPACT_VERSION, SHAPED_COMPACT_VERSION, RESTRICTED_COMPACT_VERSION, SEQUENCED_COMPACT_VERSION, 6, 7]);

export function encodeGraph(graph: RoadGraph): ArrayBuffer {
  const nodes = graph.nodeLatitudes.length, edges = graph.edgeTargets.length;
  if (graph.nodeLongitudes.length !== nodes || graph.edgeOffsets.length !== nodes + 1 || graph.edgeDistancesMeters.length !== edges || graph.edgeDurationsSeconds.length !== edges || graph.edgeOffsets[nodes] !== edges) throw new Error("Invalid road graph");
  const buffer = new ArrayBuffer(HEADER_BYTES + nodes * 16 + (nodes + 1) * 4 + edges * 12);
  const view = new DataView(buffer); view.setUint32(0, MAGIC, true); view.setUint16(4, VERSION, true); view.setUint32(8, nodes, true); view.setUint32(12, edges, true);
  // v1 stores plain degrees, metres and seconds. A graph that arrived in
  // fixed-point form has to be converted back, or its coordinates would be
  // written as raw integers and land far off the globe.
  const coordinateScale = graph.coordinateScale ?? 1;
  const distanceScale = graph.edgeDistanceScale ?? 1;
  const durationScale = graph.edgeDurationScale ?? 1;
  let offset = HEADER_BYTES;
  new Float64Array(buffer, offset, nodes).set(Float64Array.from(graph.nodeLatitudes, (value) => value / coordinateScale)); offset += nodes * 8;
  new Float64Array(buffer, offset, nodes).set(Float64Array.from(graph.nodeLongitudes, (value) => value / coordinateScale)); offset += nodes * 8;
  new Uint32Array(buffer, offset, nodes + 1).set(graph.edgeOffsets); offset += (nodes + 1) * 4;
  new Uint32Array(buffer, offset, edges).set(graph.edgeTargets); offset += edges * 4;
  new Float32Array(buffer, offset, edges).set(Float32Array.from(graph.edgeDistancesMeters, (value) => value * distanceScale)); offset += edges * 4;
  new Float32Array(buffer, offset, edges).set(Float32Array.from(graph.edgeDurationsSeconds, (value) => value * durationScale));
  return buffer;
}

export function decodeGraph(buffer: ArrayBuffer): RoadGraph {
  if (buffer.byteLength < HEADER_BYTES) throw new Error("Invalid routing graph header");
  const view = new DataView(buffer), magic = view.getUint32(0, true), version = view.getUint16(4, true);
  if (magic === COMPACT_MAGIC && SUPPORTED_COMPACT_VERSIONS.has(version)) return decodeCompactGraph(buffer);
  if (magic !== MAGIC || version !== VERSION) throw new Error("Unsupported routing graph format");
  const nodes = view.getUint32(8, true), edges = view.getUint32(12, true), expected = HEADER_BYTES + nodes * 16 + (nodes + 1) * 4 + edges * 12;
  if (buffer.byteLength !== expected) throw new Error("Truncated routing graph");
  let offset = HEADER_BYTES;
  const nodeLatitudes = new Float64Array(buffer.slice(offset, offset += nodes * 8));
  const nodeLongitudes = new Float64Array(buffer.slice(offset, offset += nodes * 8));
  const edgeOffsets = new Uint32Array(buffer.slice(offset, offset += (nodes + 1) * 4));
  const edgeTargets = new Uint32Array(buffer.slice(offset, offset += edges * 4));
  const edgeDistancesMeters = new Float32Array(buffer.slice(offset, offset += edges * 4));
  const edgeDurationsSeconds = new Float32Array(buffer.slice(offset, offset += edges * 4));
  assertGeographic(nodeLatitudes, nodeLongitudes, 1);
  for (const target of edgeTargets) if (target >= nodes) throw new Error("Invalid routing graph: edge target outside the graph.");
  assertOffsets(edgeOffsets, nodes, edges, "edge offsets");
  return { nodeLatitudes, nodeLongitudes, edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds };
}

/**
 * Encodes fixed-point EFR2: v2 for a bare topology, v3 when per-edge shape
 * points exist, and v4 when the graph also carries turn restrictions. A v4
 * chunk always writes the shape section, empty if the graph has no geometry,
 * so the restriction arrays keep a single fixed position.
 */
export type CompactEncodeOptions = {
  /**
   * `packed` is the current layout (EFR2 v6). `legacy` writes the older v2-v5
   * layout, which readers predating v6 can still open, and which keeps the
   * decoding of those versions covered by tests.
   */
  layout?: "packed" | "legacy";
};

export function encodeCompactGraph(graph: RoadGraph, options: CompactEncodeOptions = {}): ArrayBuffer {
  return (options.layout ?? "packed") === "packed" ? encodePackedGraph(graph) : encodeLegacyCompactGraph(graph);
}

function encodeLegacyCompactGraph(graph: RoadGraph): ArrayBuffer {
  // v2-v5 have no room for profile metadata. Writing a non-car graph into one
  // would produce a file that reads back as a car graph, so it is refused.
  if (graph.profileId) throw new Error("The legacy EFR2 layout cannot store a routing profile. Use the packed layout.");
  if (!(graph.nodeLatitudes instanceof Int32Array) || !(graph.nodeLongitudes instanceof Int32Array) || !(graph.edgeDistancesMeters instanceof Uint16Array) || !(graph.edgeDurationsSeconds instanceof Uint16Array)) throw new Error("Compact graphs require Int32 coordinates and Uint16 edge weights.");
  const coordinateScale = graph.coordinateScale ?? 0, edgeDistanceScale = graph.edgeDistanceScale ?? 1, edgeDurationScale = graph.edgeDurationScale ?? 1;
  if (!Number.isInteger(coordinateScale) || !Number.isInteger(edgeDistanceScale) || !Number.isInteger(edgeDurationScale) || coordinateScale <= 0 || edgeDistanceScale <= 0 || edgeDurationScale <= 0 || edgeDistanceScale > 65535 || edgeDurationScale > 65535) throw new Error("Invalid compact graph scales.");
  const nodes = graph.nodeLatitudes.length, edges = graph.edgeTargets.length;
  if (graph.nodeLongitudes.length !== nodes || graph.edgeOffsets.length !== nodes + 1 || graph.edgeDistancesMeters.length !== edges || graph.edgeDurationsSeconds.length !== edges || graph.edgeOffsets[nodes] !== edges) throw new Error("Invalid road graph");
  const sequenceEdges = graph.turnRestrictionSequenceEdges?.length ?? 0;
  const sequences = sequenceEdges ? (graph.turnRestrictionSequenceOffsets?.length ?? 1) - 1 : 0;
  if (sequences && (!graph.turnRestrictionSequenceOffsets || graph.turnRestrictionSequenceOffsets[sequences] !== sequenceEdges)) throw new Error("Invalid compact turn restriction sequences.");
  for (let index = 0; index < sequenceEdges; index += 1) if (graph.turnRestrictionSequenceEdges![index] >= edges) throw new Error("Turn restriction references an edge outside the graph.");
  const restricted = Boolean(graph.turnRestrictionFromEdges?.length || graph.turnRestrictionToEdges?.length) || sequences > 0;
  if ((graph.turnRestrictionFromEdges?.length ?? 0) !== (graph.turnRestrictionToEdges?.length ?? 0)) throw new Error("Invalid compact turn restrictions.");
  const restrictions = graph.turnRestrictionFromEdges?.length ?? 0;
  for (let pair = 0; pair < restrictions; pair += 1) if (graph.turnRestrictionFromEdges![pair] >= edges || graph.turnRestrictionToEdges![pair] >= edges) throw new Error("Turn restriction references an edge outside the graph.");
  const hasShapes = Boolean(graph.edgeShapeOffsets || graph.edgeShapeLatitudes || graph.edgeShapeLongitudes);
  if (hasShapes && (!graph.edgeShapeOffsets || !graph.edgeShapeLatitudes || !graph.edgeShapeLongitudes || graph.edgeShapeOffsets.length !== edges + 1 || graph.edgeShapeLatitudes.length !== graph.edgeShapeLongitudes.length || graph.edgeShapeOffsets[edges] !== graph.edgeShapeLatitudes.length)) throw new Error("Invalid compact edge geometry.");
  const shaped = hasShapes || restricted;
  const version = sequences ? SEQUENCED_COMPACT_VERSION : restricted ? RESTRICTED_COMPACT_VERSION : hasShapes ? SHAPED_COMPACT_VERSION : COMPACT_VERSION;
  const points = graph.edgeShapeLatitudes?.length ?? 0, header = shaped ? SHAPED_COMPACT_HEADER_BYTES : COMPACT_HEADER_BYTES;
  const buffer = new ArrayBuffer(header + nodes * 8 + (nodes + 1) * 4 + edges * 8 + (shaped ? (edges + 1) * 4 + points * 8 : 0) + restrictions * 8 + (sequences ? (sequences + 1) * 4 + sequenceEdges * 4 : 0));
  const view = new DataView(buffer); view.setUint32(0, COMPACT_MAGIC, true); view.setUint16(4, version, true); view.setUint32(8, nodes, true); view.setUint32(12, edges, true); view.setUint32(16, coordinateScale, true); view.setUint16(20, edgeDistanceScale, true); view.setUint16(22, edgeDurationScale, true); if (shaped) { view.setUint32(24, points, true); view.setUint32(28, restrictions, true); view.setUint32(32, sequences, true); view.setUint32(36, sequenceEdges, true); }
  let offset = header;
  new Int32Array(buffer, offset, nodes).set(graph.nodeLatitudes); offset += nodes * 4;
  new Int32Array(buffer, offset, nodes).set(graph.nodeLongitudes); offset += nodes * 4;
  new Uint32Array(buffer, offset, nodes + 1).set(graph.edgeOffsets); offset += (nodes + 1) * 4;
  new Uint32Array(buffer, offset, edges).set(graph.edgeTargets); offset += edges * 4;
  new Uint16Array(buffer, offset, edges).set(graph.edgeDistancesMeters); offset += edges * 2;
  new Uint16Array(buffer, offset, edges).set(graph.edgeDurationsSeconds); offset += edges * 2;
  if (shaped) {
    if (hasShapes) new Uint32Array(buffer, offset, edges + 1).set(graph.edgeShapeOffsets!);
    offset += (edges + 1) * 4;
    new Int32Array(buffer, offset, points).set(graph.edgeShapeLatitudes ?? []); offset += points * 4;
    new Int32Array(buffer, offset, points).set(graph.edgeShapeLongitudes ?? []); offset += points * 4;
  }
  if (restrictions) {
    new Uint32Array(buffer, offset, restrictions).set(graph.turnRestrictionFromEdges!); offset += restrictions * 4;
    new Uint32Array(buffer, offset, restrictions).set(graph.turnRestrictionToEdges!); offset += restrictions * 4;
  }
  if (sequences) {
    new Uint32Array(buffer, offset, sequences + 1).set(graph.turnRestrictionSequenceOffsets!); offset += (sequences + 1) * 4;
    new Uint32Array(buffer, offset, sequenceEdges).set(graph.turnRestrictionSequenceEdges!);
  }
  return buffer;
}

function decodeCompactGraph(buffer: ArrayBuffer): RoadGraph {
  if (buffer.byteLength < COMPACT_HEADER_BYTES) throw new Error("Invalid compact routing graph header");
  const view = new DataView(buffer), version = view.getUint16(4, true), nodes = view.getUint32(8, true), edges = view.getUint32(12, true), coordinateScale = view.getUint32(16, true), edgeDistanceScale = view.getUint16(20, true), edgeDurationScale = view.getUint16(22, true);
  if (version === 6) return decodePackedGraph(buffer);
  if (version === SPLIT_COMPACT_VERSION) {
    throw new Error(view.getUint8(6) === ChunkKind.profile
      ? "This is a routing profile chunk; it has to be combined with the shared chunk it belongs to."
      : "This routing graph stores several profiles; load it with a profile chunk rather than on its own.");
  }
  const shaped = version >= SHAPED_COMPACT_VERSION, points = shaped ? view.getUint32(24, true) : 0, header = shaped ? SHAPED_COMPACT_HEADER_BYTES : COMPACT_HEADER_BYTES;
  const restrictions = version >= RESTRICTED_COMPACT_VERSION ? view.getUint32(28, true) : 0;
  const sequences = version >= SEQUENCED_COMPACT_VERSION ? view.getUint32(32, true) : 0;
  const sequenceEdges = version >= SEQUENCED_COMPACT_VERSION ? view.getUint32(36, true) : 0;
  const expected = header + nodes * 8 + (nodes + 1) * 4 + edges * 8 + (shaped ? (edges + 1) * 4 + points * 8 : 0) + restrictions * 8 + (sequences ? (sequences + 1) * 4 + sequenceEdges * 4 : 0);
  if (!coordinateScale || !edgeDistanceScale || !edgeDurationScale || buffer.byteLength !== expected) throw new Error("Truncated compact routing graph");
  let offset = header;
  const nodeLatitudes = new Int32Array(buffer.slice(offset, offset += nodes * 4));
  const nodeLongitudes = new Int32Array(buffer.slice(offset, offset += nodes * 4));
  const edgeOffsets = new Uint32Array(buffer.slice(offset, offset += (nodes + 1) * 4));
  const edgeTargets = new Uint32Array(buffer.slice(offset, offset += edges * 4));
  const edgeDistancesMeters = new Uint16Array(buffer.slice(offset, offset += edges * 2));
  const edgeDurationsSeconds = new Uint16Array(buffer.slice(offset, offset += edges * 2));
  assertGeographic(nodeLatitudes, nodeLongitudes, coordinateScale);
  for (const target of edgeTargets) if (target >= nodes) throw new Error("Invalid routing graph: edge target outside the graph.");
  assertOffsets(edgeOffsets, nodes, edges, "edge offsets");
  // v2-v5 predate profile metadata, so every such graph is a car graph.
  const graph: RoadGraph = { nodeLatitudes, nodeLongitudes, edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds, coordinateScale, edgeDistanceScale, edgeDurationScale };
  if (!shaped) return graph;
  const edgeShapeOffsets = new Uint32Array(buffer.slice(offset, offset += (edges + 1) * 4));
  const edgeShapeLatitudes = new Int32Array(buffer.slice(offset, offset += points * 4));
  const edgeShapeLongitudes = new Int32Array(buffer.slice(offset, offset += points * 4));
  if (points) {
    assertOffsets(edgeShapeOffsets, edges, points, "shape offsets");
    assertGeographic(edgeShapeLatitudes, edgeShapeLongitudes, coordinateScale);
    Object.assign(graph, { edgeShapeOffsets, edgeShapeLatitudes, edgeShapeLongitudes });
  }
  if (restrictions) {
    graph.turnRestrictionFromEdges = new Uint32Array(buffer.slice(offset, offset += restrictions * 4));
    graph.turnRestrictionToEdges = new Uint32Array(buffer.slice(offset, offset += restrictions * 4));
  }
  if (sequences) {
    graph.turnRestrictionSequenceOffsets = new Uint32Array(buffer.slice(offset, offset += (sequences + 1) * 4));
    graph.turnRestrictionSequenceEdges = new Uint32Array(buffer.slice(offset, offset += sequenceEdges * 4));
    assertOffsets(graph.turnRestrictionSequenceOffsets, sequences, sequenceEdges, "turn restriction offsets");
  }
  for (const edge of [...(graph.turnRestrictionFromEdges ?? []), ...(graph.turnRestrictionToEdges ?? []), ...(graph.turnRestrictionSequenceEdges ?? [])]) {
    if (edge >= edges) throw new Error("Invalid routing graph: turn restriction references an edge outside the graph.");
  }
  return graph;
}

/** v6 keeps the same graph but stores it far more tightly. */
const PACKED_COMPACT_VERSION = 6;
/**
 * v7 splits a tile in two. Nearly nine tenths of a compiled tile — geometry,
 * node coordinates, topology and distances — is the same whichever vehicle is
 * routing, so it is written once as a `shared` chunk, and each vehicle adds a
 * small `profile` chunk holding only what depends on it. A bundle can then
 * serve several vehicles without storing the road network several times, and a
 * reader downloads the shared chunk plus the one vehicle it wants.
 */
const SPLIT_COMPACT_VERSION = 7;
const ChunkKind = { shared: 0, profile: 1 } as const;
const PACKED_HEADER_BYTES = 64;
/** Nothing this library routes travels faster than this; a larger value means a corrupt header. */
const MAX_PLAUSIBLE_SPEED_KPH = 400;

/** Variable-length sections end on any byte; typed-array views need a multiple of four. */
function alignUp(offset: number) {
  return (offset + 3) & ~3;
}

/**
 * Edge offsets must rise, and end exactly at the edge count. A corrupt value
 * in the middle passes an end-only check yet makes the search walk millions of
 * edges that are not there.
 */
function assertOffsets(offsets: ArrayLike<number>, entries: number, total: number, what: string) {
  if (offsets.length !== entries + 1 || offsets[0] !== 0 || offsets[entries] !== total) throw new Error(`Invalid routing graph: ${what} do not span the data.`);
  for (let index = 1; index <= entries; index += 1) {
    if (offsets[index] < offsets[index - 1] || offsets[index] > total) throw new Error(`Invalid routing graph: ${what} are not ordered.`);
  }
}

/**
 * Coordinates outside the globe mean the chunk is corrupt. Catching it here
 * keeps nonsense out of the spatial indexes, where a bounding box spanning
 * half the coordinate space would otherwise cost unbounded memory to index.
 */
function assertGeographic(latitudes: ArrayLike<number>, longitudes: ArrayLike<number>, scale: number) {
  for (let index = 0; index < latitudes.length; index += 1) {
    if (!(Math.abs(latitudes[index] / scale) <= 90) || !(Math.abs(longitudes[index] / scale) <= 180)) {
      throw new Error("Invalid routing graph: coordinate outside the world.");
    }
  }
}

/**
 * Builds the shape table, collapsing each road's geometry onto one copy.
 * A two-way road stores the same points twice today, once per direction, and
 * on a Portugal extract that mirrored half is 47% of all shape points.
 */
function buildShapeTable(graph: RoadGraph) {
  const edges = graph.edgeTargets.length;
  const offsets = graph.edgeShapeOffsets;
  const latitudes = graph.edgeShapeLatitudes;
  const longitudes = graph.edgeShapeLongitudes;
  const references = new Uint32Array(edges);
  const shapes: { start: number; count: number }[] = [];
  if (!offsets || !latitudes || !longitudes) return { references, shapes, latitudes, longitudes };
  const seen = new Map<string, number>();
  for (let edge = 0; edge < edges; edge += 1) {
    const start = offsets[edge];
    const count = offsets[edge + 1] - start;
    if (!count) continue;
    const forward: number[] = [];
    const backward: number[] = [];
    for (let point = 0; point < count; point += 1) {
      forward.push(latitudes[start + point], longitudes[start + point]);
      backward.push(latitudes[start + count - 1 - point], longitudes[start + count - 1 - point]);
    }
    const forwardKey = forward.join(",");
    const existing = seen.get(forwardKey);
    if (existing !== undefined) { references[edge] = (existing + 1) * 2; continue; }
    const mirrored = seen.get(backward.join(","));
    if (mirrored !== undefined) { references[edge] = (mirrored + 1) * 2 + 1; continue; }
    const id = shapes.length;
    shapes.push({ start, count });
    seen.set(forwardKey, id);
    references[edge] = (id + 1) * 2;
  }
  return { references, shapes, latitudes, longitudes };
}

/**
 * The parts of a tile that do not depend on the vehicle. Identical to the v6
 * layout except that the duration column is left out, because that is the one
 * per-edge value a profile changes.
 */
export function encodeSharedGraph(graph: RoadGraph): ArrayBuffer {
  return encodePackedGraph(graph, SPLIT_COMPACT_VERSION);
}

function encodePackedGraph(graph: RoadGraph, version: number = PACKED_COMPACT_VERSION): ArrayBuffer {
  const nodes = graph.nodeLatitudes.length;
  const edges = graph.edgeTargets.length;
  if (!(graph.nodeLatitudes instanceof Int32Array) || !(graph.nodeLongitudes instanceof Int32Array) || !(graph.edgeDistancesMeters instanceof Uint16Array) || !(graph.edgeDurationsSeconds instanceof Uint16Array)) throw new Error("Compact graphs require Int32 coordinates and Uint16 edge weights.");
  if (graph.nodeLongitudes.length !== nodes || graph.edgeOffsets.length !== nodes + 1 || graph.edgeDistancesMeters.length !== edges || graph.edgeDurationsSeconds.length !== edges || graph.edgeOffsets[nodes] !== edges) throw new Error("Invalid road graph");
  const coordinateScale = graph.coordinateScale ?? 0;
  if (!Number.isInteger(coordinateScale) || coordinateScale <= 0) throw new Error("Invalid compact graph scales.");
  if ((graph.turnRestrictionFromEdges?.length ?? 0) !== (graph.turnRestrictionToEdges?.length ?? 0)) throw new Error("Invalid compact turn restrictions.");
  for (const edge of graph.turnRestrictionFromEdges ?? []) if (edge >= edges) throw new Error("Turn restriction references an edge outside the graph.");
  for (const edge of graph.turnRestrictionToEdges ?? []) if (edge >= edges) throw new Error("Turn restriction references an edge outside the graph.");
  for (const edge of graph.turnRestrictionSequenceEdges ?? []) if (edge >= edges) throw new Error("Turn restriction references an edge outside the graph.");
  const { references, shapes, latitudes, longitudes } = buildShapeTable(graph);

  // Per node: how many edges leave it. Prefix sums are rebuilt on decode.
  const degrees = new VarintWriter(nodes + 16);
  for (let node = 0; node < nodes; node += 1) degrees.push(graph.edgeOffsets[node + 1] - graph.edgeOffsets[node]);

  // Per edge: the target as a difference from its own source node, which is
  // small because the compiler numbers nearby nodes closely together.
  const targets = new VarintWriter(edges + 16);
  for (let node = 0; node < nodes; node += 1) {
    for (let edge = graph.edgeOffsets[node]; edge < graph.edgeOffsets[node + 1]; edge += 1) targets.pushSigned(graph.edgeTargets[edge] - node);
  }

  const shapeRefs = new VarintWriter(edges + 16);
  for (let edge = 0; edge < edges; edge += 1) shapeRefs.push(references[edge]);
  const shapeSizes = new VarintWriter(shapes.length + 16);
  for (const shape of shapes) shapeSizes.push(shape.count);

  // Each shape runs from its own first point; every later point is a step from
  // the one before, which is a handful of metres rather than a global coordinate.
  const shapePoints = new VarintWriter(shapes.length * 8 + 16);
  for (const shape of shapes) {
    let previousLat = 0;
    let previousLng = 0;
    for (let point = 0; point < shape.count; point += 1) {
      const lat = latitudes![shape.start + point];
      const lng = longitudes![shape.start + point];
      shapePoints.pushSigned(point ? lat - previousLat : lat);
      shapePoints.pushSigned(point ? lng - previousLng : lng);
      previousLat = lat;
      previousLng = lng;
    }
  }

  const pairs = graph.turnRestrictionFromEdges?.length ?? 0;
  const runs = graph.turnRestrictionSequenceEdges?.length ? (graph.turnRestrictionSequenceOffsets?.length ?? 1) - 1 : 0;
  const runEdges = graph.turnRestrictionSequenceEdges?.length ?? 0;
  const sections = [degrees, targets, shapeRefs, shapeSizes, shapePoints];
  const variableBytes = sections.reduce((sum, section) => sum + section.byteLength, 0);
  const shared = version === SPLIT_COMPACT_VERSION;
  // A shared chunk carries distances but not durations.
  const weightBytes = edges * (shared ? 2 : 4);
  const restrictionsAt = alignUp(PACKED_HEADER_BYTES + nodes * 8 + weightBytes + variableBytes);
  const buffer = new ArrayBuffer(restrictionsAt + pairs * 8 + (runs ? (runs + 1) * 4 + runEdges * 4 : 0));
  const view = new DataView(buffer);
  view.setUint32(0, COMPACT_MAGIC, true);
  view.setUint16(4, version, true);
  view.setUint8(6, shared ? ChunkKind.shared : ChunkKind.profile);
  view.setUint32(8, nodes, true);
  view.setUint32(12, edges, true);
  view.setUint32(16, graph.coordinateScale ?? 0, true);
  view.setUint16(20, graph.edgeDistanceScale ?? 1, true);
  view.setUint16(22, graph.edgeDurationScale ?? 1, true);
  view.setUint32(24, shapes.length, true);
  view.setUint32(28, pairs, true);
  view.setUint32(32, runs, true);
  view.setUint32(36, runEdges, true);
  for (let index = 0; index < sections.length; index += 1) view.setUint32(40 + index * 4, sections[index].byteLength, true);
  // Bytes 60-63 were spare in every v6 chunk written so far, and a chunk that
  // never set them reads back as zero — which is exactly "unspecified", so
  // existing bundles keep decoding as the car graphs they are.
  view.setUint8(60, graph.profileId ?? 0);
  view.setUint16(62, Math.round(graph.maxSpeedKph ?? 0), true);

  let offset = PACKED_HEADER_BYTES;
  new Int32Array(buffer, offset, nodes).set(graph.nodeLatitudes); offset += nodes * 4;
  new Int32Array(buffer, offset, nodes).set(graph.nodeLongitudes); offset += nodes * 4;
  new Uint16Array(buffer, offset, edges).set(graph.edgeDistancesMeters); offset += edges * 2;
  if (!shared) { new Uint16Array(buffer, offset, edges).set(graph.edgeDurationsSeconds); offset += edges * 2; }
  const bytes = new Uint8Array(buffer);
  for (const section of sections) { bytes.set(section.toUint8Array(), offset); offset += section.byteLength; }
  offset = restrictionsAt;
  if (pairs) {
    new Uint32Array(buffer, offset, pairs).set(graph.turnRestrictionFromEdges!); offset += pairs * 4;
    new Uint32Array(buffer, offset, pairs).set(graph.turnRestrictionToEdges!); offset += pairs * 4;
  }
  if (runs) {
    new Uint32Array(buffer, offset, runs + 1).set(graph.turnRestrictionSequenceOffsets!); offset += (runs + 1) * 4;
    new Uint32Array(buffer, offset, runEdges).set(graph.turnRestrictionSequenceEdges!);
  }
  return buffer;
}

function decodePackedGraph(buffer: ArrayBuffer, shared = false): RoadGraph {
  const view = new DataView(buffer);
  const nodes = view.getUint32(8, true);
  const edges = view.getUint32(12, true);
  const coordinateScale = view.getUint32(16, true);
  const edgeDistanceScale = view.getUint16(20, true);
  const edgeDurationScale = view.getUint16(22, true);
  const shapeCount = view.getUint32(24, true);
  const pairs = view.getUint32(28, true);
  const runs = view.getUint32(32, true);
  const runEdges = view.getUint32(36, true);
  const lengths = Array.from({ length: 5 }, (_, index) => view.getUint32(40 + index * 4, true));
  const variableBytes = lengths.reduce((sum, length) => sum + length, 0);
  const restrictionsAt = alignUp(PACKED_HEADER_BYTES + nodes * 8 + edges * (shared ? 2 : 4) + variableBytes);
  const expected = restrictionsAt + pairs * 8 + (runs ? (runs + 1) * 4 + runEdges * 4 : 0);
  if (!coordinateScale || !edgeDistanceScale || !edgeDurationScale || buffer.byteLength !== expected) throw new Error("Truncated compact routing graph");
  // Counts that do not take part in the length check above are bounded by what
  // the file could actually hold, so a corrupt header cannot ask for an
  // allocation far larger than the chunk itself.
  if (shapeCount > edges) throw new Error("Invalid compact routing graph: more shapes than edges.");
  const profileId = view.getUint8(60);
  const maxSpeedKph = view.getUint16(62, true);
  // A profile this build does not know about would route with the wrong rules
  // rather than fail, so an unknown id is refused rather than ignored.
  if (profileId && !getRoutingProfileById(profileId)) throw new Error(`Routing graph was compiled for an unsupported profile (id ${profileId}).`);
  if (maxSpeedKph > MAX_PLAUSIBLE_SPEED_KPH) throw new Error("Invalid compact routing graph: implausible profile speed ceiling.");

  let offset = PACKED_HEADER_BYTES;
  const nodeLatitudes = new Int32Array(buffer.slice(offset, offset += nodes * 4));
  const nodeLongitudes = new Int32Array(buffer.slice(offset, offset += nodes * 4));
  const edgeDistancesMeters = new Uint16Array(buffer.slice(offset, offset += edges * 2));
  // A shared chunk has no duration column: that is the one per-edge value the
  // vehicle changes, and it lives in the profile chunk instead. The zeroes
  // here are replaced by `combineProfiledGraph` before anything routes.
  const edgeDurationsSeconds = shared ? new Uint16Array(edges) : new Uint16Array(buffer.slice(offset, offset += edges * 2));
  const bytes = new Uint8Array(buffer);
  const starts: number[] = [];
  for (const length of lengths) { starts.push(offset); offset += length; }
  offset = restrictionsAt;

  const edgeOffsets = new Uint32Array(nodes + 1);
  const degrees = new VarintReader(bytes, starts[0]);
  for (let node = 0; node < nodes; node += 1) {
    const degree = degrees.read();
    if (degree > edges - edgeOffsets[node]) throw new Error("Invalid compact routing graph: node degrees exceed the edge count.");
    edgeOffsets[node + 1] = edgeOffsets[node] + degree;
  }
  if (edgeOffsets[nodes] !== edges) throw new Error("Invalid compact routing graph: node degrees do not sum to the edge count.");
  const edgeTargets = new Uint32Array(edges);
  const targets = new VarintReader(bytes, starts[1]);
  for (let node = 0; node < nodes; node += 1) {
    for (let edge = edgeOffsets[node]; edge < edgeOffsets[node + 1]; edge += 1) {
      const target = node + targets.readSigned();
      if (target < 0 || target >= nodes) throw new Error("Invalid compact routing graph: edge target outside the graph.");
      edgeTargets[edge] = target;
    }
  }

  assertGeographic(nodeLatitudes, nodeLongitudes, coordinateScale);
  const graph: RoadGraph = { nodeLatitudes, nodeLongitudes, edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds, coordinateScale, edgeDistanceScale, edgeDurationScale };
  if (profileId) graph.profileId = profileId;
  if (maxSpeedKph) graph.maxSpeedKph = maxSpeedKph;

  // Rebuild the per-edge geometry the rest of the library expects, expanding
  // each shared shape back out and mirroring it where an edge asked for it.
  const references = new Uint32Array(edges);
  const shapeRefs = new VarintReader(bytes, starts[2]);
  for (let edge = 0; edge < edges; edge += 1) {
    references[edge] = shapeRefs.read();
    if ((references[edge] >>> 1) > shapeCount) throw new Error("Invalid compact routing graph: edge references a missing shape.");
  }
  const shapeSizes = new VarintReader(bytes, starts[3]);
  const sizes = new Uint32Array(shapeCount);
  // Every stored point costs at least two bytes of varint, so the point stream
  // itself caps how many points the sizes may legitimately claim.
  const pointCeiling = Math.floor(lengths[4] / 2);
  let totalPoints = 0;
  for (let shape = 0; shape < shapeCount; shape += 1) {
    sizes[shape] = shapeSizes.read();
    totalPoints += sizes[shape];
    if (totalPoints > pointCeiling) throw new Error("Invalid compact routing graph: shape sizes exceed the stored geometry.");
  }
  const tableLatitudes = new Int32Array(totalPoints);
  const tableLongitudes = new Int32Array(totalPoints);
  const tableStarts = new Uint32Array(shapeCount + 1);
  const points = new VarintReader(bytes, starts[4]);
  let at = 0;
  for (let shape = 0; shape < shapeCount; shape += 1) {
    tableStarts[shape] = at;
    let lat = 0;
    let lng = 0;
    for (let point = 0; point < sizes[shape]; point += 1) {
      lat = point ? lat + points.readSigned() : points.readSigned();
      lng = point ? lng + points.readSigned() : points.readSigned();
      tableLatitudes[at] = lat;
      tableLongitudes[at] = lng;
      at += 1;
    }
  }
  tableStarts[shapeCount] = at;

  const edgeShapeOffsets = new Uint32Array(edges + 1);
  for (let edge = 0; edge < edges; edge += 1) {
    const reference = references[edge];
    edgeShapeOffsets[edge + 1] = edgeShapeOffsets[edge] + (reference ? sizes[(reference >>> 1) - 1] : 0);
  }
  const expandedPoints = edgeShapeOffsets[edges];
  if (expandedPoints) {
    const edgeShapeLatitudes = new Int32Array(expandedPoints);
    const edgeShapeLongitudes = new Int32Array(expandedPoints);
    for (let edge = 0; edge < edges; edge += 1) {
      const reference = references[edge];
      if (!reference) continue;
      const shape = (reference >>> 1) - 1;
      const reversed = (reference & 1) === 1;
      const count = sizes[shape];
      const from = tableStarts[shape];
      const to = edgeShapeOffsets[edge];
      for (let point = 0; point < count; point += 1) {
        const source = from + (reversed ? count - 1 - point : point);
        edgeShapeLatitudes[to + point] = tableLatitudes[source];
        edgeShapeLongitudes[to + point] = tableLongitudes[source];
      }
    }
    assertGeographic(edgeShapeLatitudes, edgeShapeLongitudes, coordinateScale);
    Object.assign(graph, { edgeShapeOffsets, edgeShapeLatitudes, edgeShapeLongitudes });
  }

  if (pairs) {
    graph.turnRestrictionFromEdges = new Uint32Array(buffer.slice(offset, offset += pairs * 4));
    graph.turnRestrictionToEdges = new Uint32Array(buffer.slice(offset, offset += pairs * 4));
  }
  if (runs) {
    graph.turnRestrictionSequenceOffsets = new Uint32Array(buffer.slice(offset, offset += (runs + 1) * 4));
    graph.turnRestrictionSequenceEdges = new Uint32Array(buffer.slice(offset, offset += runEdges * 4));
    assertOffsets(graph.turnRestrictionSequenceOffsets, runs, runEdges, "turn restriction offsets");
    for (const edge of graph.turnRestrictionSequenceEdges) if (edge >= edges) throw new Error("Invalid routing graph: turn restriction references an edge outside the graph.");
  }
  for (const edge of graph.turnRestrictionFromEdges ?? []) if (edge >= edges) throw new Error("Invalid routing graph: turn restriction references an edge outside the graph.");
  for (const edge of graph.turnRestrictionToEdges ?? []) if (edge >= edges) throw new Error("Invalid routing graph: turn restriction references an edge outside the graph.");
  return graph;
}


/* ------------------------------------------------------------------ v7 ---- */

const PROFILE_CHUNK_HEADER_BYTES = 64;

/**
 * The vehicle-dependent half of a tile: the duration of every edge for this
 * profile, and which edges it may use at all. An access mask that lets
 * everything through is left out, which is the usual case for the profile a
 * tile's topology was built around.
 */
export function encodeProfileChunk(chunk: ProfileChunk): ArrayBuffer {
  const edges = chunk.edgeDurationsSeconds.length;
  if (!(chunk.edgeDurationsSeconds instanceof Uint16Array)) throw new Error("Profile durations must be a Uint16Array.");
  if (!Number.isInteger(chunk.edgeDurationScale) || chunk.edgeDurationScale <= 0 || chunk.edgeDurationScale > 65535) throw new Error("Invalid profile duration scale.");
  if (!getRoutingProfileById(chunk.profileId) || !chunk.profileId) throw new Error(`Cannot write a profile chunk for an unsupported profile (id ${chunk.profileId}).`);
  if (chunk.maxSpeedKph <= 0 || chunk.maxSpeedKph > MAX_PLAUSIBLE_SPEED_KPH) throw new Error("Invalid profile speed ceiling.");
  const mask = chunk.edgeAccess && !allowsEverything(chunk.edgeAccess, edges) ? chunk.edgeAccess : undefined;
  if (mask && mask.length !== (edges + 7) >> 3) throw new Error("Profile access mask does not cover every edge.");

  const buffer = new ArrayBuffer(PROFILE_CHUNK_HEADER_BYTES + edges * 2 + (mask?.byteLength ?? 0));
  const view = new DataView(buffer);
  view.setUint32(0, COMPACT_MAGIC, true);
  view.setUint16(4, SPLIT_COMPACT_VERSION, true);
  view.setUint8(6, ChunkKind.profile);
  view.setUint8(7, chunk.profileId);
  view.setUint32(8, edges, true);
  view.setUint32(12, mask?.byteLength ?? 0, true);
  view.setUint16(16, chunk.edgeDurationScale, true);
  view.setUint16(18, Math.round(chunk.maxSpeedKph), true);
  new Uint16Array(buffer, PROFILE_CHUNK_HEADER_BYTES, edges).set(chunk.edgeDurationsSeconds);
  if (mask) new Uint8Array(buffer, PROFILE_CHUNK_HEADER_BYTES + edges * 2, mask.byteLength).set(mask);
  return buffer;
}

export function decodeProfileChunk(buffer: ArrayBuffer): ProfileChunk {
  if (buffer.byteLength < PROFILE_CHUNK_HEADER_BYTES) throw new Error("Invalid routing profile chunk header");
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== COMPACT_MAGIC || view.getUint16(4, true) !== SPLIT_COMPACT_VERSION || view.getUint8(6) !== ChunkKind.profile) {
    throw new Error("Unsupported routing profile chunk format");
  }
  const profileId = view.getUint8(7);
  const edges = view.getUint32(8, true);
  const maskBytes = view.getUint32(12, true);
  const edgeDurationScale = view.getUint16(16, true);
  const maxSpeedKph = view.getUint16(18, true);
  if (!profileId || !getRoutingProfileById(profileId)) throw new Error(`Routing graph was compiled for an unsupported profile (id ${profileId}).`);
  if (!edgeDurationScale) throw new Error("Invalid routing profile chunk: zero duration scale.");
  if (maxSpeedKph > MAX_PLAUSIBLE_SPEED_KPH) throw new Error("Invalid routing profile chunk: implausible profile speed ceiling.");
  if (maskBytes && maskBytes !== (edges + 7) >> 3) throw new Error("Invalid routing profile chunk: access mask does not cover every edge.");
  if (buffer.byteLength !== PROFILE_CHUNK_HEADER_BYTES + edges * 2 + maskBytes) throw new Error("Truncated routing profile chunk");
  return {
    profileId,
    maxSpeedKph,
    edgeDurationScale,
    edgeDurationsSeconds: new Uint16Array(buffer.slice(PROFILE_CHUNK_HEADER_BYTES, PROFILE_CHUNK_HEADER_BYTES + edges * 2)),
    ...(maskBytes ? { edgeAccess: new Uint8Array(buffer.slice(PROFILE_CHUNK_HEADER_BYTES + edges * 2)) } : {}),
  };
}

/**
 * The vehicle-independent half of a tile. Not routable on its own: every
 * duration is zero until a profile chunk supplies them.
 */
export function decodeSharedGraph(buffer: ArrayBuffer): SharedRoadGraph {
  if (buffer.byteLength < PACKED_HEADER_BYTES) throw new Error("Invalid shared routing graph header");
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== COMPACT_MAGIC || view.getUint16(4, true) !== SPLIT_COMPACT_VERSION || view.getUint8(6) !== ChunkKind.shared) {
    throw new Error("Unsupported shared routing graph format");
  }
  const { edgeDurationsSeconds: _durations, edgeDurationScale: _scale, profileId: _profile, maxSpeedKph: _speed, ...shared } = decodePackedGraph(buffer, true);
  return shared;
}

/** Joins a tile's two halves into the routable graph the rest of the library uses. */
export function combineProfiledGraph(shared: SharedRoadGraph, profile: ProfileChunk): RoadGraph {
  if (profile.edgeDurationsSeconds.length !== shared.edgeTargets.length) {
    throw new Error("Routing profile chunk does not match the shared chunk it was loaded with.");
  }
  return {
    ...shared,
    edgeDurationsSeconds: profile.edgeDurationsSeconds,
    edgeDurationScale: profile.edgeDurationScale,
    profileId: profile.profileId,
    maxSpeedKph: profile.maxSpeedKph,
    ...(profile.edgeAccess ? { edgeAccess: profile.edgeAccess } : {}),
  };
}
