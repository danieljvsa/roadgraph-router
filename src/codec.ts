import type { RoadGraph } from "./types";

const MAGIC = 0x45465254;
const VERSION = 1;
const HEADER_BYTES = 16;
const COMPACT_MAGIC = 0x32524645; // EFR2 family
const COMPACT_VERSION = 2;
const SHAPED_COMPACT_VERSION = 3;
const RESTRICTED_COMPACT_VERSION = 4;
const COMPACT_HEADER_BYTES = 32;
/** v3 and v4 share one 40-byte header; v4 fills the shape-point field's spare neighbour. */
const SHAPED_COMPACT_HEADER_BYTES = 40;
const SUPPORTED_COMPACT_VERSIONS = new Set<number>([COMPACT_VERSION, SHAPED_COMPACT_VERSION, RESTRICTED_COMPACT_VERSION]);

export function encodeGraph(graph: RoadGraph): ArrayBuffer {
  const nodes = graph.nodeLatitudes.length, edges = graph.edgeTargets.length;
  if (graph.nodeLongitudes.length !== nodes || graph.edgeOffsets.length !== nodes + 1 || graph.edgeDistancesMeters.length !== edges || graph.edgeDurationsSeconds.length !== edges || graph.edgeOffsets[nodes] !== edges) throw new Error("Invalid road graph");
  const buffer = new ArrayBuffer(HEADER_BYTES + nodes * 16 + (nodes + 1) * 4 + edges * 12);
  const view = new DataView(buffer); view.setUint32(0, MAGIC, true); view.setUint16(4, VERSION, true); view.setUint32(8, nodes, true); view.setUint32(12, edges, true);
  let offset = HEADER_BYTES;
  new Float64Array(buffer, offset, nodes).set(graph.nodeLatitudes); offset += nodes * 8;
  new Float64Array(buffer, offset, nodes).set(graph.nodeLongitudes); offset += nodes * 8;
  new Uint32Array(buffer, offset, nodes + 1).set(graph.edgeOffsets); offset += (nodes + 1) * 4;
  new Uint32Array(buffer, offset, edges).set(graph.edgeTargets); offset += edges * 4;
  new Float32Array(buffer, offset, edges).set(graph.edgeDistancesMeters); offset += edges * 4;
  new Float32Array(buffer, offset, edges).set(graph.edgeDurationsSeconds);
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
  return { nodeLatitudes, nodeLongitudes, edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds };
}

/**
 * Encodes fixed-point EFR2: v2 for a bare topology, v3 when per-edge shape
 * points exist, and v4 when the graph also carries turn restrictions. A v4
 * chunk always writes the shape section, empty if the graph has no geometry,
 * so the restriction arrays keep a single fixed position.
 */
export function encodeCompactGraph(graph: RoadGraph): ArrayBuffer {
  if (!(graph.nodeLatitudes instanceof Int32Array) || !(graph.nodeLongitudes instanceof Int32Array) || !(graph.edgeDistancesMeters instanceof Uint16Array) || !(graph.edgeDurationsSeconds instanceof Uint16Array)) throw new Error("Compact graphs require Int32 coordinates and Uint16 edge weights.");
  const coordinateScale = graph.coordinateScale ?? 0, edgeDistanceScale = graph.edgeDistanceScale ?? 1, edgeDurationScale = graph.edgeDurationScale ?? 1;
  if (!Number.isInteger(coordinateScale) || !Number.isInteger(edgeDistanceScale) || !Number.isInteger(edgeDurationScale) || coordinateScale <= 0 || edgeDistanceScale <= 0 || edgeDurationScale <= 0 || edgeDistanceScale > 65535 || edgeDurationScale > 65535) throw new Error("Invalid compact graph scales.");
  const nodes = graph.nodeLatitudes.length, edges = graph.edgeTargets.length;
  if (graph.nodeLongitudes.length !== nodes || graph.edgeOffsets.length !== nodes + 1 || graph.edgeDistancesMeters.length !== edges || graph.edgeDurationsSeconds.length !== edges || graph.edgeOffsets[nodes] !== edges) throw new Error("Invalid road graph");
  const restricted = Boolean(graph.turnRestrictionFromEdges?.length || graph.turnRestrictionToEdges?.length);
  if (restricted && graph.turnRestrictionFromEdges!.length !== graph.turnRestrictionToEdges!.length) throw new Error("Invalid compact turn restrictions.");
  const restrictions = restricted ? graph.turnRestrictionFromEdges!.length : 0;
  for (let pair = 0; pair < restrictions; pair += 1) if (graph.turnRestrictionFromEdges![pair] >= edges || graph.turnRestrictionToEdges![pair] >= edges) throw new Error("Turn restriction references an edge outside the graph.");
  const hasShapes = Boolean(graph.edgeShapeOffsets || graph.edgeShapeLatitudes || graph.edgeShapeLongitudes);
  if (hasShapes && (!graph.edgeShapeOffsets || !graph.edgeShapeLatitudes || !graph.edgeShapeLongitudes || graph.edgeShapeOffsets.length !== edges + 1 || graph.edgeShapeLatitudes.length !== graph.edgeShapeLongitudes.length || graph.edgeShapeOffsets[edges] !== graph.edgeShapeLatitudes.length)) throw new Error("Invalid compact edge geometry.");
  const shaped = hasShapes || restricted;
  const version = restricted ? RESTRICTED_COMPACT_VERSION : hasShapes ? SHAPED_COMPACT_VERSION : COMPACT_VERSION;
  const points = graph.edgeShapeLatitudes?.length ?? 0, header = shaped ? SHAPED_COMPACT_HEADER_BYTES : COMPACT_HEADER_BYTES;
  const buffer = new ArrayBuffer(header + nodes * 8 + (nodes + 1) * 4 + edges * 8 + (shaped ? (edges + 1) * 4 + points * 8 : 0) + restrictions * 8);
  const view = new DataView(buffer); view.setUint32(0, COMPACT_MAGIC, true); view.setUint16(4, version, true); view.setUint32(8, nodes, true); view.setUint32(12, edges, true); view.setUint32(16, coordinateScale, true); view.setUint16(20, edgeDistanceScale, true); view.setUint16(22, edgeDurationScale, true); if (shaped) { view.setUint32(24, points, true); view.setUint32(28, restrictions, true); }
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
  if (restricted) {
    new Uint32Array(buffer, offset, restrictions).set(graph.turnRestrictionFromEdges!); offset += restrictions * 4;
    new Uint32Array(buffer, offset, restrictions).set(graph.turnRestrictionToEdges!);
  }
  return buffer;
}

function decodeCompactGraph(buffer: ArrayBuffer): RoadGraph {
  if (buffer.byteLength < COMPACT_HEADER_BYTES) throw new Error("Invalid compact routing graph header");
  const view = new DataView(buffer), version = view.getUint16(4, true), nodes = view.getUint32(8, true), edges = view.getUint32(12, true), coordinateScale = view.getUint32(16, true), edgeDistanceScale = view.getUint16(20, true), edgeDurationScale = view.getUint16(22, true);
  const shaped = version >= SHAPED_COMPACT_VERSION, points = shaped ? view.getUint32(24, true) : 0, header = shaped ? SHAPED_COMPACT_HEADER_BYTES : COMPACT_HEADER_BYTES;
  const restrictions = version >= RESTRICTED_COMPACT_VERSION ? view.getUint32(28, true) : 0;
  const expected = header + nodes * 8 + (nodes + 1) * 4 + edges * 8 + (shaped ? (edges + 1) * 4 + points * 8 : 0) + restrictions * 8;
  if (!coordinateScale || !edgeDistanceScale || !edgeDurationScale || buffer.byteLength !== expected) throw new Error("Truncated compact routing graph");
  let offset = header;
  const nodeLatitudes = new Int32Array(buffer.slice(offset, offset += nodes * 4));
  const nodeLongitudes = new Int32Array(buffer.slice(offset, offset += nodes * 4));
  const edgeOffsets = new Uint32Array(buffer.slice(offset, offset += (nodes + 1) * 4));
  const edgeTargets = new Uint32Array(buffer.slice(offset, offset += edges * 4));
  const edgeDistancesMeters = new Uint16Array(buffer.slice(offset, offset += edges * 2));
  const edgeDurationsSeconds = new Uint16Array(buffer.slice(offset, offset += edges * 2));
  const graph: RoadGraph = { nodeLatitudes, nodeLongitudes, edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds, coordinateScale, edgeDistanceScale, edgeDurationScale };
  if (!shaped) return graph;
  const edgeShapeOffsets = new Uint32Array(buffer.slice(offset, offset += (edges + 1) * 4));
  const edgeShapeLatitudes = new Int32Array(buffer.slice(offset, offset += points * 4));
  const edgeShapeLongitudes = new Int32Array(buffer.slice(offset, offset += points * 4));
  if (points) Object.assign(graph, { edgeShapeOffsets, edgeShapeLatitudes, edgeShapeLongitudes });
  if (!restrictions) return graph;
  graph.turnRestrictionFromEdges = new Uint32Array(buffer.slice(offset, offset += restrictions * 4));
  graph.turnRestrictionToEdges = new Uint32Array(buffer.slice(offset, offset += restrictions * 4));
  return graph;
}
