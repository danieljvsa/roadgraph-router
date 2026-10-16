/**
 * Reading bundles that older releases actually wrote.
 *
 * Every file under `test-fixtures/historical` was compiled by the release in
 * its name, from that release's own source. Re-encoding a graph with today's
 * encoder and reading it back proves the encoder agrees with itself; only a
 * file an older version produced can show whether this one still reads what
 * that one wrote.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RoadRouter, openRoadGraphBundle, ProfileId } from "./index";
import { rangeFetcher } from "./test-support";

const FIXTURES = resolve(__dirname, "../test-fixtures/historical");
const MONACO = { lat: 43.7384, lng: 7.4246 };
const FONTVIEILLE = { lat: 43.7325, lng: 7.4189 };

function bundleBytes(file: string) {
  const bytes = readFileSync(resolve(FIXTURES, file));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * What each writing release itself reported for this journey, taken by
 * building that release and running it over its own bundle.
 *
 * The distance is the same for all of them — it comes from the geometry,
 * which has not moved. The duration is not: 0.3.0's compiler stopped storing
 * an edge as quicker than its own length at the profile's ceiling, so a
 * bundle it wrote holds slightly longer durations than one 0.2.0 wrote. Both
 * are read back exactly as their writer read them, which is the property
 * these fixtures exist to hold.
 */
const EXPECTED: Record<string, { distanceMeters: number; durationSeconds: number }> = {
  "monaco-v0.1.0-car.efrb": { distanceMeters: 1210.1679197254357, durationSeconds: 108.67912263009045 },
  "monaco-v0.2.0-car.efrb": { distanceMeters: 1210.1679197254357, durationSeconds: 108.67912263009045 },
  "monaco-v0.3.0-car.efrb": { distanceMeters: 1210.1679197254357, durationSeconds: 111.43659923349935 },
  "monaco-v0.3.0-car-truck.efrb": { distanceMeters: 1210.1679197254357, durationSeconds: 111.43659923349935 },
};

describe.each([
  ["monaco-v0.1.0-car.efrb", "0.1.0"],
  ["monaco-v0.2.0-car.efrb", "0.2.0"],
  ["monaco-v0.3.0-car.efrb", "0.3.0"],
])("a single-profile bundle written by %s", (file) => {
  it("opens and reports the vehicle it was compiled for", async () => {
    const { fetcher } = rangeFetcher(bundleBytes(file));
    const bundle = await openRoadGraphBundle(file, fetcher);
    expect(bundle.profiles).toEqual([ProfileId.car]);
    expect(bundle.tiles.length).toBeGreaterThan(0);
  });

  it("still returns the route that release returned", async () => {
    const { fetcher } = rangeFetcher(bundleBytes(file));
    const router = await RoadRouter.open(file, fetcher, {});
    const result = await router.route(MONACO, FONTVIEILLE, "fastest");
    expect(result.distanceMeters).toBeCloseTo(EXPECTED[file].distanceMeters, 9);
    expect(result.durationSeconds).toBeCloseTo(EXPECTED[file].durationSeconds, 9);
    // A road bundle makes no claim about track.
    expect(result.railway).toBeUndefined();
  });

  it("serves it by byte range rather than whole", async () => {
    const { fetcher, stats } = rangeFetcher(bundleBytes(file));
    const router = await RoadRouter.open(file, fetcher, {});
    await router.route(MONACO, FONTVIEILLE, "fastest");
    expect(stats.requests).toBeGreaterThan(1);
    expect(stats.rangeHeaders.every((header) => header.startsWith("bytes="))).toBe(true);
  });
});

describe("a multi-profile bundle written by 0.3.0", () => {
  const file = "monaco-v0.3.0-car-truck.efrb";

  it("opens, lists both vehicles, and routes as either", async () => {
    const { fetcher } = rangeFetcher(bundleBytes(file));
    const bundle = await openRoadGraphBundle(file, fetcher);
    expect(bundle.profiles).toEqual([ProfileId.car, ProfileId.truck]);

    const car = await RoadRouter.open(file, rangeFetcher(bundleBytes(file)).fetcher, { profile: "car" });
    const byCar = await car.route(MONACO, FONTVIEILLE, "fastest");
    expect(byCar.distanceMeters).toBeCloseTo(EXPECTED[file].distanceMeters, 9);
    expect(byCar.durationSeconds).toBeCloseTo(EXPECTED[file].durationSeconds, 9);

    const lorry = car.withProfile("truck");
    const byLorry = await lorry.route(MONACO, FONTVIEILLE, "fastest");
    expect(byLorry.distanceMeters).toBeGreaterThan(0);
  });
});

/**
 * The one gap, recorded rather than papered over.
 *
 * 0.3.0 moved a shared chunk's node coordinates out of a fixed block and into
 * a sixth varint section, and kept the same chunk version for both layouts,
 * so a newer reader measures an older shared chunk wrongly. Single-profile
 * bundles are unaffected — that layout was left alone deliberately — and the
 * two versions that reached npm, `0.0.0-stage` and `0.1.0`, predate
 * multi-profile bundles entirely.
 *
 * This asserts the limitation so that it cannot be fixed by accident and go
 * unnoticed: if a later change makes this bundle readable, this test fails
 * and the compatibility table should be corrected.
 */
describe("a multi-profile bundle written by 0.2.0", () => {
  const file = "monaco-v0.2.0-car-truck.efrb";

  it("is refused, and says the chunk does not measure up", async () => {
    const { fetcher } = rangeFetcher(bundleBytes(file));
    const router = await RoadRouter.open(file, fetcher, {});
    await expect(router.route(MONACO, FONTVIEILLE, "fastest")).rejects.toThrow(/Truncated compact routing graph/);
  });

  // The header is still read, so a caller is told what the bundle holds
  // before the failure — the break is in the tile, not in the directory.
  it("still describes itself from its header", async () => {
    const { fetcher } = rangeFetcher(bundleBytes(file));
    const bundle = await openRoadGraphBundle(file, fetcher);
    expect(bundle.profiles).toEqual([ProfileId.car, ProfileId.truck]);
    expect(bundle.tiles.length).toBeGreaterThan(0);
  });
});
