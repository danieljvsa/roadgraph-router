/* Routes the same random pairs through two bundles and reports any difference,
 * which is how a storage or tiling change is shown to be behaviour-preserving. */
import { open } from "node:fs/promises";
import { openRoadGraphBundle, RoadRouter } from "../dist/index.js";

async function reader(path) {
  const file = await open(path);
  const fetcher = async (_u, init = {}) => {
    const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    const [, s, e] = /bytes=(\d+)-(\d+)/.exec(h.get("Range") ?? "") ?? [];
    const b = new Uint8Array(Number(e) - Number(s) + 1);
    await file.read(b, 0, b.byteLength, Number(s));
    return new Response(b, { status: 206 });
  };
  return { file, fetcher, bundle: await openRoadGraphBundle("local://b.efrb", fetcher) };
}

const [,, pathA, pathB, sampleText] = process.argv;
const samples = Number(sampleText ?? 150);
const a = await reader(pathA), b = await reader(pathB);
const routerA = await RoadRouter.open("local://b.efrb", a.fetcher);
const routerB = await RoadRouter.open("local://b.efrb", b.fetcher);

// Draw endpoints from real node positions in the reference bundle, including
// points near tile edges, which is where a tiling change would show up first.
const area = a.bundle.tiles.reduce((best, t) => t.rawByteLength > best.rawByteLength ? t : best, a.bundle.tiles[0]);
const graph = await a.bundle.loadTiles([area]);
const scale = graph.coordinateScale ?? 1;
let seed = 0x9e3779b1;
const next = () => ((seed = (Math.imul(seed, 48271) >>> 0) % 0x7fffffff) / 0x7fffffff);
const pick = () => { const n = Math.floor(next() * graph.nodeLatitudes.length); return { lat: graph.nodeLatitudes[n] / scale, lng: graph.nodeLongitudes[n] / scale }; };

let compared = 0, identical = 0, differing = 0, onlyA = 0, onlyB = 0;
let worst = 0;
for (let i = 0; i < samples; i += 1) {
  const from = pick(), to = pick();
  const run = async (router) => { try { return await router.route(from, to); } catch { return null; } };
  const [ra, rb] = [await run(routerA), await run(routerB)];
  if (!ra && !rb) continue;
  if (ra && !rb) { onlyA += 1; continue; }
  if (!ra && rb) { onlyB += 1; continue; }
  compared += 1;
  const drift = Math.abs(ra.durationSeconds - rb.durationSeconds) / Math.max(1, ra.durationSeconds);
  worst = Math.max(worst, drift);
  if (drift < 1e-6) identical += 1; else differing += 1;
}
await a.file.close(); await b.file.close();
console.table({
  reference: pathA.split("/").pop(), candidate: pathB.split("/").pop(),
  routes_compared: compared,
  identical_duration: identical,
  differing_duration: differing,
  found_only_in_reference: onlyA,
  found_only_in_candidate: onlyB,
  worst_duration_drift: `${(worst * 100).toFixed(4)}%`,
});
