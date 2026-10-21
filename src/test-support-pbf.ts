/**
 * A minimal OSM PBF writer, for tests only.
 *
 * Railway topology is decided by the compiler rather than by the library: what
 * connects to what comes out of which OSM nodes two ways have in common, and
 * that rule lives in `scripts/roadgraph-compile.mjs`. Testing it against a
 * reimplementation would prove nothing, so these tests drive the real compiler
 * over a real PBF — which means being able to write one.
 *
 * Only the subset the compiler reads is produced: a header block, then one
 * data block holding plain nodes and ways. Nothing here is efficient, and
 * nothing here should be used outside a test.
 */

import { deflateSync } from "node:zlib";

/* ------------------------------------------------------------ protobuf --- */

function varint(value: number | bigint): number[] {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    const seven = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(remaining > 0n ? seven | 0x80 : seven);
  } while (remaining > 0n);
  return bytes;
}

const zigzag = (value: number) => (value < 0 ? -value * 2 - 1 : value * 2);

function tag(field: number, wire: number) {
  return varint(field * 8 + wire);
}

/** A varint field. */
function uint(field: number, value: number) {
  return [...tag(field, 0), ...varint(value)];
}

/** A length-delimited field: strings, bytes, submessages and packed arrays. */
function bytes(field: number, payload: readonly number[] | Uint8Array) {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

function text(field: number, value: string) {
  return bytes(field, [...new TextEncoder().encode(value)]);
}

function packed(field: number, values: readonly number[]) {
  return bytes(field, values.flatMap((value) => varint(value)));
}

/* ----------------------------------------------------------------- OSM --- */

export type PbfNode = { id: number; lat: number; lon: number; tags?: Record<string, string> };
export type PbfWay = { id: number; refs: number[]; tags?: Record<string, string> };

/** Coordinates are written at the default granularity of 100 nanodegrees. */
const COORDINATE_SCALE = 10_000_000;

function block(type: string, payload: Uint8Array, compress: boolean) {
  const body = compress ? deflateSync(payload) : payload;
  const blob = new Uint8Array(compress
    ? [...uint(2, payload.length), ...bytes(3, body)]
    : [...bytes(1, body)]);
  const header = new Uint8Array([...text(1, type), ...uint(3, blob.length)]);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length, false);
  return new Uint8Array([...length, ...header, ...blob]);
}

/**
 * Writes `nodes` and `ways` as a one-block PBF. Node and way ids are used as
 * written, so a test can say which ways share which node and read the answer
 * back out of the compiled graph.
 */
export function writeOsmPbf(nodes: readonly PbfNode[], ways: readonly PbfWay[]): Uint8Array {
  // String 0 is the empty string by convention; every key and value after it
  // is referenced by index from the nodes and ways.
  const strings = [""];
  const indexOf = new Map<string, number>();
  const intern = (value: string) => {
    let at = indexOf.get(value);
    if (at === undefined) { at = strings.length; strings.push(value); indexOf.set(value, at); }
    return at;
  };
  // Interned first, so the table is complete before anything references it.
  const nodeTags = nodes.map((node) => Object.entries(node.tags ?? {}).map(([key, value]) => [intern(key), intern(value)] as const));
  const wayTags = ways.map((way) => Object.entries(way.tags ?? {}).map(([key, value]) => [intern(key), intern(value)] as const));

  const group: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const pairs = nodeTags[index];
    group.push(...bytes(1, [
      ...uint(1, zigzag(node.id)),
      ...(pairs.length ? packed(2, pairs.map(([key]) => key)) : []),
      ...(pairs.length ? packed(3, pairs.map(([, value]) => value)) : []),
      ...[...tag(8, 0), ...varint(zigzag(Math.round(node.lat * COORDINATE_SCALE)))],
      ...[...tag(9, 0), ...varint(zigzag(Math.round(node.lon * COORDINATE_SCALE)))],
    ]));
  }
  for (let index = 0; index < ways.length; index += 1) {
    const way = ways[index];
    const pairs = wayTags[index];
    // Way refs are delta coded, so each is written as its step from the last.
    let previous = 0;
    const refs = way.refs.map((ref) => { const delta = ref - previous; previous = ref; return zigzag(delta); });
    group.push(...bytes(3, [
      ...uint(1, way.id),
      ...(pairs.length ? packed(2, pairs.map(([key]) => key)) : []),
      ...(pairs.length ? packed(3, pairs.map(([, value]) => value)) : []),
      ...packed(8, refs),
    ]));
  }

  const stringTable = bytes(1, strings.flatMap((value) => text(1, value)));
  // Offsets are written explicitly rather than left to the reader's defaults.
  const primitive = new Uint8Array([...stringTable, ...bytes(2, group), ...uint(19, 0), ...uint(20, 0)]);
  const header = new Uint8Array([...text(4, "OsmSchema-V0.6")]);
  const headerBlock = block("OSMHeader", header, false);
  // The parser requires the data block to be deflated; the header may be raw.
  const dataBlock = block("OSMData", primitive, true);
  return new Uint8Array([...headerBlock, ...dataBlock]);
}
