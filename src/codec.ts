import type { RoadGraph } from "./types";

const MAGIC = 0x45465254; // EFRT
const VERSION = 1;
const HEADER_BYTES = 16;

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
