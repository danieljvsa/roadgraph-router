/**
 * Compiling a synthetic extract with the real compiler, for tests.
 *
 * Connectivity, simplification and tiling are decided by
 * `scripts/roadgraph-compile.mjs`, not by the library, so a test that builds
 * its graph by hand is testing a reimplementation. These helpers write a real
 * PBF, run the real compiler and open the real bundle; each fixture is
 * compiled once per run and kept.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoadGraphBundle } from "./index";
import type { Coordinate, RoadGraph } from "./index";
import { rangeFetcher } from "./test-support";
import { writeOsmPbf, type PbfNode, type PbfWay } from "./test-support-pbf";

export type Compiled = { graph: RoadGraph; profiles: number[]; report: Record<string, unknown>; path: string };

export function compileWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "roadgraph-fixture-"));
  const compiled = new Map<string, Promise<Compiled>>();

  /**
   * Compiles a fixture, or returns the one already compiled under that name.
   * Passing no ways reuses an earlier fixture, which keeps a test that only
   * reads a graph from recompiling it.
   */
  const compile = (name: string, nodes: PbfNode[], ways: PbfWay[], args: string[] = ["--profile", "train"]) => {
    const existing = compiled.get(name);
    if (existing) return existing;
    const made = (async (): Promise<Compiled> => {
      const input = join(workspace, `${name}.osm.pbf`);
      const output = join(workspace, `${name}.efrb`);
      writeFileSync(input, writeOsmPbf(nodes, ways));
      // The CLI reads the first occurrence of an option, so a default is only
      // supplied where the caller did not give one of its own.
      const defaults = ["--compression", "none", "--tile-size-km", "400"];
      const supplied: string[] = [];
      for (let index = 0; index < defaults.length; index += 2) {
        if (!args.includes(defaults[index])) supplied.push(defaults[index], defaults[index + 1]);
      }
      try {
        execFileSync(process.execPath, ["scripts/roadgraph-compile.mjs", input, "--output", output, ...args, ...supplied], { stdio: "pipe", encoding: "utf8" });
      } catch (error) {
        const failure = error as { stderr?: string; stdout?: string };
        throw new Error(`compiling ${name} failed: ${failure.stderr ?? ""}${failure.stdout ?? ""}`);
      }
      const bytes = readFileSync(output);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const bundle = await openRoadGraphBundle(output, rangeFetcher(buffer).fetcher);
      const graph = await bundle.loadTiles(bundle.tiles);
      return { graph, profiles: bundle.profiles, report: JSON.parse(readFileSync(`${output}.json`, "utf8")), path: output };
    })();
    compiled.set(name, made);
    return made;
  };

  /** The same compiled fixture, read as another profile the bundle holds. */
  const openAs = async (name: string, profileId: number) => {
    const output = join(workspace, `${name}.efrb`);
    const bytes = readFileSync(output);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const bundle = await openRoadGraphBundle(output, rangeFetcher(buffer).fetcher);
    return bundle.loadTiles(bundle.tiles, profileId);
  };

  const cleanUp = () => rmSync(workspace, { recursive: true, force: true });
  return { compile, openAs, cleanUp, workspace };
}

export const at = (lat: number, lon: number): Coordinate => ({ lat, lng: lon });

/** A straight line of nodes heading east, one per 0.01 degrees. */
export function line(firstId: number, lat: number, startLon: number, count: number): PbfNode[] {
  return Array.from({ length: count }, (_, index) => ({ id: firstId + index, lat, lon: startLon + index * 0.01 }));
}

/** Tags for ordinary Iberian-gauge main line. */
export const RAIL = { railway: "rail", gauge: "1668", electrified: "contact_line", voltage: "25000", frequency: "50", usage: "main" } as const;
