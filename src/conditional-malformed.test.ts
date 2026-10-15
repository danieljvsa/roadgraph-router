import { decodeGraph, decodeProfileChunk, encodeCompactGraph, encodeProfileChunk } from "./codec";
import { compactGraph } from "./compact";
import { ConditionKind, packEdgeConditions } from "./conditional";
import { buildGraph } from "./test-support";
import type { EdgeConditions } from "./types";

const town = () => compactGraph(buildGraph({
  nodes: { A: [41.0, -8.0], B: [41.0, -7.99], C: [41.0, -7.98] },
  roads: ["A-B", "B-C"],
}));

const chunkWith = (conditions: EdgeConditions, edges: number) => encodeProfileChunk({
  profileId: 1,
  maxSpeedKph: 130,
  edgeDurationScale: 1,
  edgeDurationsSeconds: new Uint16Array(edges).fill(10),
  edgeConditions: conditions,
});

const sound = () => packEdgeConditions([
  { edge: 0, kind: ConditionKind.access, value: "no @ (Mo-Fr 07:00-19:00)" },
  { edge: 1, kind: ConditionKind.maxspeed, value: "30 @ (Mo-Fr)" },
])!;

describe("a conditional table that does not hold together", () => {
  const edges = 4;

  it("refuses columns of different lengths", () => {
    const broken = { ...sound(), kinds: new Uint8Array(1) };
    expect(() => chunkWith(broken, edges)).toThrow(/same length/);
  });

  it("refuses a rule number with no rule behind it", () => {
    const broken = { ...sound(), rules: Uint16Array.from([0, 99]) };
    expect(() => chunkWith(broken, edges)).toThrow(/not in the table/);
  });

  it("refuses an edge the graph does not have", () => {
    const broken = { ...sound(), edges: Uint32Array.from([0, 9_999]) };
    expect(() => chunkWith(broken, edges)).toThrow(/outside the graph/);
  });

  it("refuses rows that are not in order", () => {
    const broken = { ...sound(), edges: Uint32Array.from([3, 0]) };
    expect(() => chunkWith(broken, edges)).toThrow(/sorted/);
  });

  it("refuses a value carrying the byte that separates values", () => {
    const broken = { ...sound(), values: ["no @ (Mo)\u0000yes @ (Tu)", "30 @ (Mo-Fr)"] };
    expect(() => chunkWith(broken, edges)).toThrow(/null byte/);
  });
});

describe("a chunk whose bytes have been damaged", () => {
  const edges = 4;

  it("refuses a row count larger than the chunk could hold", () => {
    const buffer = chunkWith(sound(), edges);
    new DataView(buffer).setUint32(32, 1_000_000, true);
    expect(() => decodeProfileChunk(buffer)).toThrow();
  });

  it("refuses a text length that runs off the end", () => {
    const buffer = chunkWith(sound(), edges);
    new DataView(buffer).setUint32(36, 10_000_000, true);
    expect(() => decodeProfileChunk(buffer)).toThrow();
  });

  it("refuses conditions that claim no values at all", () => {
    const buffer = chunkWith(sound(), edges);
    new DataView(buffer).setUint32(36, 0, true);
    expect(() => decodeProfileChunk(buffer)).toThrow(/conditions with no values/);
  });

  it("refuses a truncated chunk rather than reading past it", () => {
    const buffer = chunkWith(sound(), edges);
    expect(() => decodeProfileChunk(buffer.slice(0, buffer.byteLength - 4))).toThrow(/Truncated/);
  });

  it("refuses a truncated one-vehicle chunk", () => {
    const buffer = encodeCompactGraph({ ...town(), edgeConditions: sound() });
    expect(() => decodeGraph(buffer.slice(0, buffer.byteLength - 4))).toThrow(/Truncated/);
  });

  it("refuses a chunk claiming conditions it does not carry", () => {
    // Byte 61 is the one bit of header saying a section follows. Setting it
    // on a chunk without one must not make the decoder read whatever happens
    // to lie at the end of the buffer.
    const buffer = encodeCompactGraph(town());
    new DataView(buffer).setUint8(61, 1);
    expect(() => decodeGraph(buffer)).toThrow(/Truncated|do not fit/);
  });

  it("refuses a one-vehicle chunk whose row count is impossible", () => {
    const graph = town();
    const plain = encodeCompactGraph(graph).byteLength;
    const buffer = encodeCompactGraph({ ...graph, edgeConditions: sound() });
    // The section begins on the first four-byte boundary past the plain
    // chunk, and opens with the number of rows it holds.
    const at = Math.ceil(plain / 4) * 4;
    new DataView(buffer).setUint32(at, 1_000_000, true);
    expect(() => decodeGraph(buffer)).toThrow(/do not fit|Truncated/);
  });
});

describe("a sound table", () => {
  it("still survives the trip, in both layouts", () => {
    const conditions = sound();
    const fromProfile = decodeProfileChunk(chunkWith(conditions, 4)).edgeConditions!;
    const fromGraph = decodeGraph(encodeCompactGraph({ ...town(), edgeConditions: conditions })).edgeConditions!;
    for (const read of [fromProfile, fromGraph]) {
      expect([...read.edges]).toEqual([...conditions.edges]);
      expect([...read.kinds]).toEqual([...conditions.kinds]);
      expect([...read.rules]).toEqual([...conditions.rules]);
      expect(read.values).toEqual(conditions.values);
    }
  });
});
