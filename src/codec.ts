import type { RoadGraph } from "./types";

const MAGIC = 0x45465254; // EFRT
const VERSION = 1;
const HEADER_BYTES = 16;
const COMPACT_MAGIC = 0x32524645; // EFR2
const COMPACT_VERSION = 2;
const COMPACT_HEADER_BYTES = 32;

export function encodeGraph(graph: RoadGraph): ArrayBuffer {
  const nodeCount = graph.nodeLatitudes.length;
  const edgeCount = graph.edgeTargets.length;
  if (graph.nodeLongitudes.length !== nodeCount || graph.edgeOffsets.length !== nodeCount + 1 || graph.edgeDistancesMeters.length !== edgeCount || graph.edgeDurationsSeconds.length !== edgeCount || graph.edgeOffsets[nodeCount] !== edgeCount) throw new Error("Invalid road graph");
  const byteLength = HEADER_BYTES + nodeCount * 16 + (nodeCount + 1) * 4 + edgeCount * 12;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, edgeCount, true);
  let offset = HEADER_BYTES;
  new Float64Array(buffer, offset, nodeCount).set(graph.nodeLatitudes); offset += nodeCount * 8;
  new Float64Array(buffer, offset, nodeCount).set(graph.nodeLongitudes); offset += nodeCount * 8;
  new Uint32Array(buffer, offset, nodeCount + 1).set(graph.edgeOffsets); offset += (nodeCount + 1) * 4;
  new Uint32Array(buffer, offset, edgeCount).set(graph.edgeTargets); offset += edgeCount * 4;
  new Float32Array(buffer, offset, edgeCount).set(graph.edgeDistancesMeters); offset += edgeCount * 4;
  new Float32Array(buffer, offset, edgeCount).set(graph.edgeDurationsSeconds);
  return buffer;
}

export function decodeGraph(buffer: ArrayBuffer): RoadGraph {
  if (buffer.byteLength < HEADER_BYTES) throw new Error("Invalid routing graph header");
  const view = new DataView(buffer);
  if (view.getUint32(0, true) === COMPACT_MAGIC && view.getUint16(4, true) === COMPACT_VERSION) return decodeCompactGraph(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== VERSION) throw new Error("Unsupported routing graph format");
  const nodeCount = view.getUint32(8, true);
  const edgeCount = view.getUint32(12, true);
  const expected = HEADER_BYTES + nodeCount * 16 + (nodeCount + 1) * 4 + edgeCount * 12;
  if (buffer.byteLength !== expected) throw new Error("Truncated routing graph");
  let offset = HEADER_BYTES;
  const nodeLatitudes = new Float64Array(buffer.slice(offset, offset += nodeCount * 8));
  const nodeLongitudes = new Float64Array(buffer.slice(offset, offset += nodeCount * 8));
  const edgeOffsets = new Uint32Array(buffer.slice(offset, offset += (nodeCount + 1) * 4));
  const edgeTargets = new Uint32Array(buffer.slice(offset, offset += edgeCount * 4));
  const edgeDistancesMeters = new Float32Array(buffer.slice(offset, offset += edgeCount * 4));
  const edgeDurationsSeconds = new Float32Array(buffer.slice(offset, offset += edgeCount * 4));
  return { nodeLatitudes, nodeLongitudes, edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds };
}

/** Encodes the fixed-point v2 format. It cuts v1 graph storage roughly in half. */
export function encodeCompactGraph(graph: RoadGraph): ArrayBuffer {
  if (!(graph.nodeLatitudes instanceof Int32Array) || !(graph.nodeLongitudes instanceof Int32Array) || !(graph.edgeDistancesMeters instanceof Uint16Array) || !(graph.edgeDurationsSeconds instanceof Uint16Array)) {
    throw new Error("Compact graphs require Int32 coordinates and Uint16 edge weights.");
  }
  const coordinateScale = graph.coordinateScale ?? 0;
  const edgeDistanceScale = graph.edgeDistanceScale ?? 1;
  const edgeDurationScale = graph.edgeDurationScale ?? 1;
  if (!Number.isInteger(coordinateScale) || !Number.isInteger(edgeDistanceScale) || !Number.isInteger(edgeDurationScale) || coordinateScale <= 0 || edgeDistanceScale <= 0 || edgeDurationScale <= 0 || edgeDistanceScale > 65_535 || edgeDurationScale > 65_535) {
    throw new Error("Invalid compact graph scales.");
  }
  const nodeCount = graph.nodeLatitudes.length;
  const edgeCount = graph.edgeTargets.length;
  if (graph.nodeLongitudes.length !== nodeCount || graph.edgeOffsets.length !== nodeCount + 1 || graph.edgeDistancesMeters.length !== edgeCount || graph.edgeDurationsSeconds.length !== edgeCount || graph.edgeOffsets[nodeCount] !== edgeCount) throw new Error("Invalid road graph");
  const byteLength = COMPACT_HEADER_BYTES + nodeCount * 8 + (nodeCount + 1) * 4 + edgeCount * 8;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, COMPACT_MAGIC, true);
  view.setUint16(4, COMPACT_VERSION, true);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, edgeCount, true);
  view.setUint32(16, coordinateScale, true);
  view.setUint16(20, edgeDistanceScale, true);
  view.setUint16(22, edgeDurationScale, true);
  let offset = COMPACT_HEADER_BYTES;
  new Int32Array(buffer, offset, nodeCount).set(graph.nodeLatitudes); offset += nodeCount * 4;
  new Int32Array(buffer, offset, nodeCount).set(graph.nodeLongitudes); offset += nodeCount * 4;
  new Uint32Array(buffer, offset, nodeCount + 1).set(graph.edgeOffsets); offset += (nodeCount + 1) * 4;
  new Uint32Array(buffer, offset, edgeCount).set(graph.edgeTargets); offset += edgeCount * 4;
  new Uint16Array(buffer, offset, edgeCount).set(graph.edgeDistancesMeters); offset += edgeCount * 2;
  new Uint16Array(buffer, offset, edgeCount).set(graph.edgeDurationsSeconds);
  return buffer;
}

function decodeCompactGraph(buffer: ArrayBuffer): RoadGraph {
  if (buffer.byteLength < COMPACT_HEADER_BYTES) throw new Error("Invalid compact routing graph header");
  const view = new DataView(buffer);
  const nodeCount = view.getUint32(8, true);
  const edgeCount = view.getUint32(12, true);
  const coordinateScale = view.getUint32(16, true);
  const edgeDistanceScale = view.getUint16(20, true);
  const edgeDurationScale = view.getUint16(22, true);
  const expected = COMPACT_HEADER_BYTES + nodeCount * 8 + (nodeCount + 1) * 4 + edgeCount * 8;
  if (!coordinateScale || !edgeDistanceScale || !edgeDurationScale || buffer.byteLength !== expected) throw new Error("Truncated compact routing graph");
  let offset = COMPACT_HEADER_BYTES;
  const nodeLatitudes = new Int32Array(buffer.slice(offset, offset += nodeCount * 4));
  const nodeLongitudes = new Int32Array(buffer.slice(offset, offset += nodeCount * 4));
  const edgeOffsets = new Uint32Array(buffer.slice(offset, offset += (nodeCount + 1) * 4));
  const edgeTargets = new Uint32Array(buffer.slice(offset, offset += edgeCount * 4));
  const edgeDistancesMeters = new Uint16Array(buffer.slice(offset, offset += edgeCount * 2));
  const edgeDurationsSeconds = new Uint16Array(buffer.slice(offset, offset += edgeCount * 2));
  return { nodeLatitudes, nodeLongitudes, edgeOffsets, edgeTargets, edgeDistancesMeters, edgeDurationsSeconds, coordinateScale, edgeDistanceScale, edgeDurationScale };
}
