import { decodeGraph } from "./codec";
import { route, type RouteOptions } from "./router";
import type { Coordinate, RoadGraph, RoutePreference } from "./types";

type WorkerRequest =
  | { id: number; type: "load"; graph: ArrayBuffer }
  // `departAt` crosses the worker boundary as a `Date` or as the plain parts,
  // both of which survive a structured clone.
  | { id: number; type: "route"; from: Coordinate; to: Coordinate; preference?: RoutePreference; departAt?: RouteOptions["departAt"]; publicHoliday?: boolean };

let graph: RoadGraph | null = null;

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === "load") {
      graph = decodeGraph(data.graph);
      self.postMessage({ id: data.id, ok: true });
      return;
    }
    if (!graph) throw new Error("Load a routing graph before requesting a route.");
    self.postMessage({ id: data.id, ok: true, route: route(graph, data.from, data.to, data.preference, { departAt: data.departAt, publicHoliday: data.publicHoliday }) });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : "Routing failed" });
  }
};
