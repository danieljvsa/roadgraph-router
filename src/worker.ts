import { decodeGraph } from "./codec";
import { route } from "./router";
import type { Coordinate, RoadGraph, RoutePreference } from "./types";

type WorkerRequest =
  | { id: number; type: "load"; graph: ArrayBuffer }
  | { id: number; type: "route"; from: Coordinate; to: Coordinate; preference?: RoutePreference };

let graph: RoadGraph | null = null;

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === "load") {
      graph = decodeGraph(data.graph);
      self.postMessage({ id: data.id, ok: true });
      return;
    }
    if (!graph) throw new Error("Load a routing graph before requesting a route.");
    self.postMessage({ id: data.id, ok: true, route: route(graph, data.from, data.to, data.preference) });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : "Routing failed" });
  }
};
