import { compactGraph, decodeGraph, encodeCompactGraph, encodeGraph, route } from "./index";
import { buildGraph, type GraphSpec } from "./test-support";

/**
 * A routing bundle is a binary file fetched over the network, so every decoder
 * has to treat it as hostile. These tests corrupt and truncate real chunks and
 * require that each one is either rejected or decoded into a graph that is
 * structurally sound — never one that sends the search chasing edges that do
 * not exist, and never an allocation sized from an unchecked header field.
 */
const spec: GraphSpec = {
  nodes: { A: [0, 0], B: [0, 0.01], C: [0.01, 0.02], D: [0, 0.03], E: [-0.01, 0.02] },
  roads: ["A-B", "B-C", "C-D", "D-E", "E-B", "B>D"],
  shapes: { "A>B": [[0.002, 0.004], [0.001, 0.007]], "B>A": [[0.001, 0.007], [0.002, 0.004]] },
  bans: [["A>B", "B>D"]],
  bannedRuns: [["A>B", "B>C", "C>D"]],
};

const built = buildGraph(spec);
const compact = compactGraph(built);
/** Each case gets its own buffer, so a corruption cannot leak into the next test. */
const formats: Record<string, () => ArrayBuffer> = {
  "EFR2 v6 (packed)": () => encodeCompactGraph(compact),
  "EFR2 v5 (legacy)": () => encodeCompactGraph(compact, { layout: "legacy" }),
  "EFRT v1": () => encodeGraph(built),
};

const origin = { lat: 0, lng: 0 };
const destination = { lat: 0, lng: 0.03 };

/** Decoded graphs must satisfy the invariants the router relies on. */
function assertSound(graph: ReturnType<typeof decodeGraph>) {
  const nodes = graph.nodeLatitudes.length;
  const edges = graph.edgeTargets.length;
  expect(graph.edgeOffsets).toHaveLength(nodes + 1);
  expect(graph.edgeOffsets[0]).toBe(0);
  expect(graph.edgeOffsets[nodes]).toBe(edges);
  for (let node = 1; node <= nodes; node += 1) expect(graph.edgeOffsets[node]).toBeGreaterThanOrEqual(graph.edgeOffsets[node - 1]);
  for (const target of graph.edgeTargets) expect(target).toBeLessThan(nodes);
  for (let node = 0; node < nodes; node += 1) {
    expect(Math.abs(graph.nodeLatitudes[node] / (graph.coordinateScale ?? 1))).toBeLessThanOrEqual(90);
    expect(Math.abs(graph.nodeLongitudes[node] / (graph.coordinateScale ?? 1))).toBeLessThanOrEqual(180);
  }
  if (graph.edgeShapeOffsets) expect(graph.edgeShapeOffsets[edges]).toBe(graph.edgeShapeLatitudes!.length);
  for (const edge of graph.turnRestrictionFromEdges ?? []) expect(edge).toBeLessThan(edges);
  for (const edge of graph.turnRestrictionSequenceEdges ?? []) expect(edge).toBeLessThan(edges);
}

describe.each(Object.entries(formats))("%s rejects or survives malformed input", (_name, encode) => {
  it("rejects every truncation", () => {
    const encoded = encode();
    for (let length = 1; length < encoded.byteLength; length += 1) {
      expect(() => decodeGraph(encoded.slice(0, length))).toThrow();
    }
  });

  it("never decodes a structurally broken graph from a flipped byte", () => {
    const encoded = encode();
    for (let at = 0; at < encoded.byteLength; at += 1) {
      for (const mask of [0x01, 0x80, 0xff]) {
        const copy = encoded.slice(0);
        new Uint8Array(copy)[at] ^= mask;
        let graph;
        try { graph = decodeGraph(copy); } catch { continue; }
        assertSound(graph);
        // Routing over it may fail, but must not hang or throw something odd.
        try { route(graph, origin, destination); } catch (error) { expect(error).toBeInstanceOf(Error); }
      }
    }
  });

  it("refuses counts the file could not possibly hold", () => {
    const encoded = encode();
    for (const offset of [8, 12, 24, 28, 32]) {
      for (const value of [0xffffffff, 0x7fffffff, 0x0fffffff]) {
        const copy = encoded.slice(0);
        if (offset + 4 > copy.byteLength) continue;
        new DataView(copy).setUint32(offset, value, true);
        let graph;
        try { graph = decodeGraph(copy); } catch { continue; }
        // If it decoded at all, it must still be a sound graph.
        assertSound(graph);
      }
    }
  });
});

describe("specific corruptions that used to be dangerous", () => {
  it("rejects edge offsets that jump and come back", () => {
    const encoded = encodeCompactGraph(compact, { layout: "legacy" });
    const view = new DataView(encoded);
    // The offsets array follows the two coordinate blocks in a v2+ chunk.
    const nodes = view.getUint32(8, true);
    const offsetsAt = 40 + nodes * 8;
    view.setUint32(offsetsAt + 4, 16_711_681, true);
    expect(() => decodeGraph(encoded)).toThrow(/not ordered|do not span/);
  });

  it("rejects a shape count larger than the edges that could reference it", () => {
    const encoded = encodeCompactGraph(compact);
    new DataView(encoded).setUint32(24, 0x3fffffff, true);
    expect(() => decodeGraph(encoded)).toThrow(/more shapes than edges/);
  });

  it("rejects a coordinate outside the world", () => {
    const encoded = encodeCompactGraph(compact);
    // Node latitudes start straight after the 64-byte v6 header.
    new DataView(encoded).setInt32(64, 2_000_000_000, true);
    expect(() => decodeGraph(encoded)).toThrow(/outside the world/);
  });

  it("rejects a turn restriction pointing past the last edge", () => {
    const broken = { ...compact, turnRestrictionFromEdges: new Uint32Array([0]), turnRestrictionToEdges: new Uint32Array([10_000]) };
    expect(() => encodeCompactGraph(broken)).toThrow(/outside the graph/);
  });

  it("still decodes the untouched chunk of every format", () => {
    for (const encode of Object.values(formats)) {
      const graph = decodeGraph(encode());
      assertSound(graph);
      expect(route(graph, origin, destination).distanceMeters).toBeGreaterThan(0);
    }
  });
});

describe("EFRT v1 encoding of a fixed-point graph", () => {
  it("writes degrees, not the underlying fixed-point integers", () => {
    // compactGraph stores coordinates scaled by ten million; v1 stores degrees.
    const decoded = decodeGraph(encodeGraph(compact));
    expect(decoded.coordinateScale).toBeUndefined();
    expect(decoded.nodeLatitudes[0]).toBeCloseTo(0, 9);
    expect(decoded.nodeLongitudes[1]).toBeCloseTo(0.01, 9);
  });

  it("round-trips distances and durations through v1", () => {
    const decoded = decodeGraph(encodeGraph(compact));
    const scaled = (value: number, scale?: number) => value * (scale ?? 1);
    expect(decoded.edgeDistancesMeters[0]).toBeCloseTo(scaled(compact.edgeDistancesMeters[0], compact.edgeDistanceScale), 0);
    expect(decoded.edgeDurationsSeconds[0]).toBeCloseTo(scaled(compact.edgeDurationsSeconds[0], compact.edgeDurationScale), 0);
  });

  it("routes the same through v1 as through the packed layout", () => {
    // v1 carries neither geometry nor turn restrictions, so the comparison
    // uses a graph that has neither; see the format table in the README.
    const plain = compactGraph(buildGraph({ nodes: spec.nodes, roads: spec.roads }));
    const viaV1 = route(decodeGraph(encodeGraph(plain)), origin, destination);
    const viaPacked = route(decodeGraph(encodeCompactGraph(plain)), origin, destination);
    expect(viaV1.nodeIds).toEqual(viaPacked.nodeIds);
    expect(viaV1.distanceMeters).toBeCloseTo(viaPacked.distanceMeters, 0);
  });

  it("drops what v1 cannot express, rather than writing something wrong", () => {
    const decoded = decodeGraph(encodeGraph(compact));
    expect(decoded.turnRestrictionFromEdges).toBeUndefined();
    expect(decoded.edgeShapeLatitudes).toBeUndefined();
  });
});
