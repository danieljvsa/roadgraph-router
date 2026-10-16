import { openRoadGraphBundle, route, routeAlternatives } from "./index";
import { writeOsmPbf } from "./test-support-pbf";
import { rangeFetcher } from "./test-support";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
jest.setTimeout(120000);
const RAIL = { railway: "rail", gauge: "1668", electrified: "contact_line", voltage: "25000", frequency: "50", usage: "main" };
it("dbg", async () => {
  const w = mkdtempSync(join(tmpdir(), "a2-"));
  const input = join(w, "a.osm.pbf"), output = join(w, "a.efrb");
  writeFileSync(input, writeOsmPbf([
    { id: 1, lat: 41.0, lon: -8.60 }, { id: 2, lat: 41.0, lon: -8.56 },
    { id: 10, lat: 41.02, lon: -8.585 }, { id: 11, lat: 41.02, lon: -8.575 },
    { id: 20, lat: 40.98, lon: -8.585 }, { id: 21, lat: 40.98, lon: -8.575 },
  ], [
    { id: 100, refs: [1, 10], tags: RAIL }, { id: 101, refs: [10, 11], tags: RAIL }, { id: 102, refs: [11, 2], tags: RAIL },
    { id: 103, refs: [1, 20], tags: RAIL }, { id: 104, refs: [20, 21], tags: RAIL }, { id: 105, refs: [21, 2], tags: RAIL },
  ]));
  execFileSync(process.execPath, ["scripts/roadgraph-compile.mjs", input, "--output", output, "--profile", "train", "--compression", "none", "--tile-size-km", "400"], { stdio: "pipe" });
  const bytes = readFileSync(output);
  const bundle = await openRoadGraphBundle(output, rangeFetcher(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).fetcher);
  const g = await bundle.loadTiles(bundle.tiles);
  const from = { lat: 41.0, lng: -8.60 }, to = { lat: 41.0, lng: -8.56 };
  const one = route(g, from, to, "shortest");
  console.log("nodes", g.nodeLatitudes.length, "edges", g.edgeTargets.length);
  console.log("single edges", JSON.stringify(one.edgeIds), "entry", one.originSnap.edge, "exit", one.destinationSnap.edge, (one.distanceMeters/1000).toFixed(2), "km");
  // What happens when the first route's interior edge is made dear by hand?
  for (const factor of [2, 5, 50]) {
    const penalties = new Map(one.edgeIds.map((e) => [e, factor]));
    const c = route(g, from, to, "shortest", { costPenalties: penalties });
    console.log(`penalty x${factor}: ${(c.distanceMeters/1000).toFixed(2)} km edges=${JSON.stringify(c.edgeIds)} entry=${c.originSnap.edge} exit=${c.destinationSnap.edge}`);
  }
  const alts = routeAlternatives(g, from, to, "shortest", { count: 3, maxStretch: 3 });
  console.log("alts", alts.map(a => `${(a.distanceMeters/1000).toFixed(2)}km edges=${JSON.stringify(a.edgeIds)}`).join(" | "));
});
