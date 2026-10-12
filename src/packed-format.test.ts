import { compactGraph, decodeGraph, encodeCompactGraph, encodeGraph, route } from "./index";
import { VarintReader, VarintWriter, unzigzag, zigzag } from "./varint";
import { buildGraph, type GraphSpec } from "./test-support";

const point = (lat: number, lng: number) => ({ lat, lng });

describe("varints", () => {
  it.each([0, 1, 127, 128, 300, 65_535, 2 ** 21, 2 ** 31 - 1, 2 ** 32 - 1])("round-trips %i unsigned", (value) => {
    const writer = new VarintWriter(1);
    writer.push(value);
    expect(new VarintReader(writer.toUint8Array()).read()).toBe(value);
  });

  it.each([0, -1, 1, -128, 128, -70_000, 70_000, -(2 ** 30), 2 ** 30])("round-trips %i signed", (value) => {
    const writer = new VarintWriter(1);
    writer.pushSigned(value);
    expect(new VarintReader(writer.toUint8Array()).readSigned()).toBe(value);
  });

  it("maps small magnitudes onto small unsigned values", () => {
    expect(zigzag(0)).toBe(0);
    expect(zigzag(-1)).toBe(1);
    expect(zigzag(1)).toBe(2);
    expect(unzigzag(zigzag(-12_345))).toBe(-12_345);
  });

  it("stores a near-zero sequence far more tightly than fixed width", () => {
    const writer = new VarintWriter();
    for (let index = 0; index < 1000; index += 1) writer.pushSigned((index % 7) - 3);
    expect(writer.byteLength).toBeLessThan(1000 * 4 * 0.3);
  });

  it("reads back a long mixed stream in order", () => {
    const values = Array.from({ length: 500 }, (_, index) => (index % 2 ? 1 : -1) * (index + 1) * 977);
    const writer = new VarintWriter();
    for (const value of values) writer.pushSigned(value);
    const reader = new VarintReader(writer.toUint8Array());
    expect(values.map(() => reader.readSigned())).toEqual(values);
  });

  it("rejects a malformed stream rather than looping", () => {
    expect(() => new VarintReader(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80])).read()).toThrow(/Malformed varint/);
  });
});

/** A small world exercising shared geometry, one-ways and both restriction kinds. */
const world: GraphSpec = {
  nodes: { A: [0, 0], B: [0, 0.01], C: [0.01, 0.02], D: [0, 0.03], E: [-0.01, 0.02] },
  roads: ["A-B", "B-C", "C-D", "D-E", "E-B", "B>D"],
  shapes: {
    "A>B": [[0.002, 0.004], [0.001, 0.007]],
    "B>A": [[0.001, 0.007], [0.002, 0.004]],
    "B>C": [[0.006, 0.014]],
    "C>B": [[0.006, 0.014]],
  },
  bans: [["A>B", "B>D"]],
  bannedRuns: [["A>B", "B>C", "C>D"]],
};

describe("packed EFR2 v6", () => {
  const built = compactGraph(buildGraph(world));

  it("declares version 6", () => {
    expect(new DataView(encodeCompactGraph(built)).getUint16(4, true)).toBe(6);
  });

  it("reproduces every array exactly", () => {
    const decoded = decodeGraph(encodeCompactGraph(built));
    expect(decoded.nodeLatitudes).toEqual(built.nodeLatitudes);
    expect(decoded.nodeLongitudes).toEqual(built.nodeLongitudes);
    expect(decoded.edgeOffsets).toEqual(built.edgeOffsets);
    expect(decoded.edgeTargets).toEqual(built.edgeTargets);
    expect(decoded.edgeDistancesMeters).toEqual(built.edgeDistancesMeters);
    expect(decoded.edgeDurationsSeconds).toEqual(built.edgeDurationsSeconds);
    expect(decoded.edgeShapeOffsets).toEqual(built.edgeShapeOffsets);
    expect(decoded.edgeShapeLatitudes).toEqual(built.edgeShapeLatitudes);
    expect(decoded.edgeShapeLongitudes).toEqual(built.edgeShapeLongitudes);
    expect(decoded.turnRestrictionFromEdges).toEqual(built.turnRestrictionFromEdges);
    expect(decoded.turnRestrictionToEdges).toEqual(built.turnRestrictionToEdges);
    expect(decoded.turnRestrictionSequenceEdges).toEqual(built.turnRestrictionSequenceEdges);
    expect(decoded.turnRestrictionSequenceOffsets).toEqual(built.turnRestrictionSequenceOffsets);
  });

  it("stores a two-way road's geometry once and mirrors it back", () => {
    // A>B and B>A describe the same road, so only one copy is written, yet
    // both directions come back with their own point order.
    const decoded = decodeGraph(encodeCompactGraph(built));
    const forward = route(decoded, point(0, 0), point(0, 0.01)).geometry.coordinates;
    const backward = route(decoded, point(0, 0.01), point(0, 0)).geometry.coordinates;
    expect(forward).toEqual([...backward].reverse());
    expect(forward).toHaveLength(4);
  });

  it("is smaller than both earlier layouts", () => {
    expect(encodeCompactGraph(built).byteLength).toBeLessThan(encodeCompactGraph(built, { layout: "legacy" }).byteLength);
    expect(encodeCompactGraph(built).byteLength).toBeLessThan(encodeGraph(buildGraph(world)).byteLength);
  });

  it("routes identically whichever layout it was stored in", () => {
    const packed = decodeGraph(encodeCompactGraph(built));
    const legacy = decodeGraph(encodeCompactGraph(built, { layout: "legacy" }));
    for (const [from, to] of [[point(0, 0), point(0, 0.03)], [point(0, 0.03), point(0, 0)], [point(-0.01, 0.02), point(0.01, 0.02)]] as const) {
      const a = route(packed, from, to);
      const b = route(legacy, from, to);
      expect(a.distanceMeters).toBeCloseTo(b.distanceMeters, 6);
      expect(a.geometry.coordinates).toEqual(b.geometry.coordinates);
      expect(a.edgeIds).toEqual(b.edgeIds);
    }
  });

  it("rejects a truncated chunk", () => {
    const encoded = encodeCompactGraph(built);
    expect(() => decodeGraph(encoded.slice(0, encoded.byteLength - 4))).toThrow(/Truncated/);
  });

  it("rejects a restriction pointing outside the graph", () => {
    const broken = { ...built, turnRestrictionFromEdges: new Uint32Array([0]), turnRestrictionToEdges: new Uint32Array([9999]) };
    expect(() => encodeCompactGraph(broken)).toThrow(/outside the graph/);
  });

  it("handles a graph with no geometry at all", () => {
    const bare = compactGraph(buildGraph({ nodes: world.nodes, roads: world.roads }));
    const decoded = decodeGraph(encodeCompactGraph(bare));
    expect(decoded.edgeShapeLatitudes).toBeUndefined();
    expect(decoded.edgeTargets).toEqual(bare.edgeTargets);
  });
});

describe("backward compatibility", () => {
  it("still reads the original EFRT v1 format", () => {
    const graph = buildGraph({ nodes: { A: [0, 0], B: [0, 0.01] }, roads: ["A-B"] });
    const v1 = encodeGraph({
      nodeLatitudes: Float64Array.from([0, 0]), nodeLongitudes: Float64Array.from([0, 0.01]),
      edgeOffsets: graph.edgeOffsets, edgeTargets: graph.edgeTargets,
      edgeDistancesMeters: Float32Array.from(graph.edgeDistancesMeters),
      edgeDurationsSeconds: Float32Array.from(graph.edgeDurationsSeconds),
    });
    expect(new DataView(v1).getUint16(4, true)).toBe(1);
    expect(decodeGraph(v1).nodeLatitudes).toHaveLength(2);
  });

  it.each([2, 3, 4, 5])("still reads a legacy v%i chunk", (version) => {
    const specs: Record<number, GraphSpec> = {
      2: { nodes: world.nodes, roads: world.roads },
      3: { nodes: world.nodes, roads: world.roads, shapes: world.shapes },
      4: { nodes: world.nodes, roads: world.roads, shapes: world.shapes, bans: world.bans },
      5: world,
    };
    const legacy = encodeCompactGraph(compactGraph(buildGraph(specs[version])), { layout: "legacy" });
    expect(new DataView(legacy).getUint16(4, true)).toBe(version);
    const decoded = decodeGraph(legacy);
    expect(decoded.edgeTargets).toHaveLength(buildGraph(specs[version]).edgeTargets.length);
    expect(() => route(decoded, point(0, 0), point(0, 0.03))).not.toThrow();
  });
});
