/* Checks on real compiled data what the unit tests check on hand-built
 * graphs: that A* never returns a route using a banned turn, and that the
 * restrictions in the bundle actually change routes rather than sitting
 * inert. Sample routes are drawn from the graph's own nodes, so the script
 * needs no knowledge of the region it is given. */
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { openRoadGraphBundle, route } from "../dist/index.js";

const input = process.argv.slice(2).find((value) => value.endsWith(".efrb"));
const sampleSize = Number(process.argv[process.argv.indexOf("--samples") + 1]) || 200;
if (!input) throw new Error("Usage: node scripts/validate-bundle.mjs region.efrb [--samples 200]");

const file = await open(resolve(process.cwd(), input));
const fetcher = async (_url, init = {}) => {
  const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.get("Range") ?? "") ?? [];
  const body = new Uint8Array(Number(end) - Number(start) + 1);
  await file.read(body, 0, body.byteLength, Number(start));
  return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}` } });
};

const bundle = await openRoadGraphBundle("local://routing.efrb", fetcher);
const centreOf = (tile) => ({ lat: (tile.bounds.minLat + tile.bounds.maxLat) / 2, lng: (tile.bounds.minLng + tile.bounds.maxLng) / 2 });
// The densest tiles give the most restrictions per route attempt. `--merge`
// spans the two densest instead, which also exercises the cross-tile merge.
const densest = [...bundle.tiles].sort((a, b) => b.rawByteLength - a.rawByteLength);
const merging = process.argv.includes("--merge");
const scope = merging ? `tiles ${densest[0].id}+${densest[1].id} (merged)` : `tile ${densest[0].id}`;
const graph = await bundle.loadForRoute(centreOf(densest[0]), centreOf(merging ? densest[1] : densest[0]));

const scale = graph.coordinateScale ?? 1;
const restrictionCount = graph.turnRestrictionFromEdges?.length ?? 0;
const banned = new Set();
for (let pair = 0; pair < restrictionCount; pair += 1) banned.add(`${graph.turnRestrictionFromEdges[pair]}:${graph.turnRestrictionToEdges[pair]}`);

// Banned runs of three or more edges, from restrictions whose `via` is a way.
const runOffsets = graph.turnRestrictionSequenceOffsets;
const runs = [];
if (runOffsets && graph.turnRestrictionSequenceEdges) {
  for (let index = 0; index + 1 < runOffsets.length; index += 1) {
    runs.push(Array.from(graph.turnRestrictionSequenceEdges.subarray(runOffsets[index], runOffsets[index + 1])));
  }
}
const runsByFirstEdge = new Map();
for (const run of runs) {
  const bucket = runsByFirstEdge.get(run[0]);
  if (bucket) bucket.push(run); else runsByFirstEdge.set(run[0], [run]);
}

/** Nodes that a restriction constrains, so sampled routes actually pass one. */
const viaNodes = [...new Set([
  ...[...banned].map((pair) => graph.edgeTargets[Number(pair.split(":")[0])]),
  ...runs.map((run) => graph.edgeTargets[run[0]]),
])];
const coordinate = (node) => ({ lat: graph.nodeLatitudes[node] / scale, lng: graph.nodeLongitudes[node] / scale });

// A deterministic sampler keeps repeated runs comparable.
let seed = 0x2f6e2b1;
const nextRandom = () => ((seed = (Math.imul(seed, 48271) >>> 0) % 0x7fffffff) / 0x7fffffff);
const pick = (list) => list[Math.floor(nextRandom() * list.length)];

const unrestricted = { ...graph, turnRestrictionFromEdges: undefined, turnRestrictionToEdges: undefined };
let routed = 0;
let violations = 0;
let runViolations = 0;
let changed = 0;
let longer = 0;
for (let sample = 0; sample < sampleSize; sample += 1) {
  const from = coordinate(pick(viaNodes));
  const to = coordinate(pick(viaNodes));
  let restricted;
  try {
    restricted = route(graph, from, to);
  } catch {
    continue;
  }
  routed += 1;
  for (let hop = 1; hop < restricted.edgeIds.length; hop += 1) {
    if (banned.has(`${restricted.edgeIds[hop - 1]}:${restricted.edgeIds[hop]}`)) violations += 1;
  }
  for (let hop = 0; hop < restricted.edgeIds.length; hop += 1) {
    for (const run of runsByFirstEdge.get(restricted.edgeIds[hop]) ?? []) {
      if (hop + run.length > restricted.edgeIds.length) continue;
      if (run.every((edge, step) => restricted.edgeIds[hop + step] === edge)) runViolations += 1;
    }
  }
  try {
    const free = route(unrestricted, from, to);
    if (free.nodeIds.length !== restricted.nodeIds.length || free.nodeIds.some((node, index) => node !== restricted.nodeIds[index])) changed += 1;
    if (restricted.durationSeconds > free.durationSeconds + 0.5) longer += 1;
  } catch { /* the unrestricted search should never fail where the restricted one succeeded */ }
}

console.table({
  scope,
  graph_nodes: graph.nodeLatitudes.length.toLocaleString("en-US"),
  graph_edges: graph.edgeTargets.length.toLocaleString("en-US"),
  banned_turn_pairs: restrictionCount.toLocaleString("en-US"),
  banned_turn_runs: runs.length.toLocaleString("en-US"),
  constrained_junctions: viaNodes.length.toLocaleString("en-US"),
  routes_sampled: sampleSize,
  routes_found: routed,
  routes_violating_a_ban: violations,
  routes_violating_a_run: runViolations,
  routes_changed_by_restrictions: changed,
  routes_made_slower: longer,
});
await file.close();
if (violations || runViolations) {
  console.error(`\nFAIL: ${violations} routed turns and ${runViolations} routed runs violate a restriction.`);
  process.exitCode = 1;
} else {
  console.log(`\nOK: no routed turn violates a restriction across ${routed} real routes.`);
}
