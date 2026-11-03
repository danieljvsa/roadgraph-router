#!/usr/bin/env node
/**
 * roadgraph-compile-gtfs: compiles GTFS feeds into an EFTT transit timetable.
 *
 *   roadgraph-compile-gtfs --feed metro=metro.zip --feed stcp=stcp.zip \
 *     --output porto.eftt [--rail-bundle porto-metro.efrb] [--transfer-radius-m 250]
 *
 * Each --feed is `id=path`, where path is a GTFS .zip or a directory of its
 * .txt files; the id prefixes that feed's stop and route ids. With
 * --rail-bundle, rides on rail modes whose feed has no usable shape are drawn
 * along the mapped track: each hop between consecutive stations is routed over
 * the bundle (its `metro` or `train` profile) at compile time.
 *
 * Writes the timetable and a report beside it (`<output>.json`).
 */
import { readFile, readdir, stat, writeFile, open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log("Usage: roadgraph-compile-gtfs --feed id=feed.zip [--feed id=…] --output timetable.eftt [--rail-bundle rail.efrb] [--transfer-radius-m 250]");
  process.exit(args.length === 0 ? 64 : 0);
}
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const feedArgs = args.flatMap((arg, i) => (arg === "--feed" ? [args[i + 1]] : []));
const output = option("--output");
const railBundle = option("--rail-bundle");
const transferRadius = option("--transfer-radius-m");
if (!output || feedArgs.length === 0) {
  console.error("roadgraph-compile-gtfs needs at least one --feed id=path and an --output.");
  process.exit(64);
}

async function loadLibrary(entry) {
  try {
    return await import(new URL(`../dist/${entry}.js`, import.meta.url).href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") throw new Error("roadgraph-compile-gtfs needs the package build. Run `npm run build` first.");
    throw error;
  }
}

/** The .txt files of a GTFS feed, from a zip or a directory. */
async function readFeed(path) {
  const info = await stat(path);
  const files = {};
  if (info.isDirectory()) {
    for (const name of await readdir(path)) if (name.endsWith(".txt")) files[name] = await readFile(join(path, name), "utf8");
    return files;
  }
  for (const [name, bytes] of readZip(await readFile(path))) {
    // Some producers put the files in a folder inside the zip.
    const base = name.split("/").pop();
    if (base?.endsWith(".txt")) files[base] = new TextDecoder("utf-8").decode(bytes);
  }
  return files;
}

/** A minimal ZIP reader: stored and deflated entries, no ZIP64, no encryption. */
function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("Not a zip file (no end of central directory).");
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let e = 0; e < entries; e += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Corrupt zip central directory.");
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(buffer.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported; unzip the feed and pass the directory.");
    if (name.endsWith("/")) continue;
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}.`);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) out.push([name, data]);
    else if (method === 8) out.push([name, inflateRawSync(data)]);
    else throw new Error(`Zip entry ${name} uses compression method ${method}, which is not supported.`);
  }
  return out;
}

/** A fetch that serves byte ranges of a local file, for opening a bundle from disk. */
function fileFetcher(path) {
  return async (_url, init) => {
    const range = new Headers(init?.headers).get("Range");
    const handle = await openFile(path, "r");
    try {
      if (!range) return new Response(await handle.readFile(), { status: 200 });
      const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(startText);
      const length = Number(endText) - start + 1;
      const bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, start);
      return new Response(bytes, { status: 206 });
    } finally {
      await handle.close();
    }
  };
}

const started = Date.now();
const { RoadRouter } = await loadLibrary("index");
const { compileTransit, encodeTransitTimetable } = await loadLibrary("transit");

const feeds = [];
for (const spec of feedArgs) {
  const split = spec?.indexOf("=") ?? -1;
  if (split <= 0) throw new Error(`--feed expects id=path, got "${spec}".`);
  const id = spec.slice(0, split);
  const path = spec.slice(split + 1);
  console.log(`Reading feed ${id} from ${path}`);
  feeds.push({ id, files: await readFeed(path) });
}

let routeHop;
if (railBundle) {
  const base = await RoadRouter.open(railBundle, fileFetcher(railBundle));
  const routers = new Map();
  const routerFor = (mode) => {
    // Heavy rail on the train profile when the bundle has it; everything else on metro.
    const wanted = mode === "rail" && base.profiles.includes("train") ? "train" : base.profiles.includes("metro") ? "metro" : base.profile;
    if (!routers.has(wanted)) routers.set(wanted, wanted === base.profile ? base : base.withProfile(wanted));
    return routers.get(wanted);
  };
  console.log(`Routing rail hops over ${railBundle} (${base.profiles.join(", ")})`);
  routeHop = async ({ mode, from, to }) => {
    try {
      const result = await routerFor(mode).route(from, to, "shortest");
      // A station far from any track is not on this network.
      if (result.originSnap.distanceMeters > 120 || result.destinationSnap.distanceMeters > 120) return null;
      return result.geometry.coordinates;
    } catch {
      return null;
    }
  };
}

const { timetable, report } = await compileTransit(feeds, {
  routeHop,
  transferRadiusMeters: transferRadius ? Number(transferRadius) : undefined,
});
const bytes = await encodeTransitTimetable(timetable);
await writeFile(output, bytes);
report.timetableBytes = bytes.length;
report.elapsedMilliseconds = Date.now() - started;
await writeFile(`${output}.json`, JSON.stringify(report, null, 2));

console.log(`Wrote ${output}: ${(bytes.length / 1e6).toFixed(2)} MB, ${report.stops} stops, ${report.routes} lines, ${report.trips} trips in ${report.patterns} patterns, ${report.transfers} walking transfers.`);
console.log(`Ride geometry: ${report.hops.shape} hops from shapes, ${report.hops.routed} routed, ${report.hops.straight} straight.`);
for (const feed of report.feeds) console.log(`  ${feed.id}: service ${feed.firstServiceDate} – ${feed.lastServiceDate} (${feed.publisher})`);
if (Object.keys(report.skippedTrips).length) console.log("Skipped trips:", report.skippedTrips);
if (report.hopFallbacks.length) console.log(`${report.hopFallbacks.length} hops fell back to straight lines; see ${output}.json.`);
