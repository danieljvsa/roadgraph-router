import { createRouteGraphLoader, type RouteGraphLoader } from "./manifest";
import { openRoadGraphBundle, type RoadGraphBundle } from "./bundle";
import { route } from "./router";
import type { Coordinate, RoadGraph, RoutePreference, RouteResult } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * High-level route entry point. `open()` currently accepts an EFRT manifest
 * or an already-decoded graph; later bundle readers plug into the same API.
 */
export class RoadRouter {
  private constructor(private readonly graph?: RoadGraph, private readonly loader?: Pick<RouteGraphLoader | RoadGraphBundle, "loadForRoute">) {}

  static fromGraph(graph: RoadGraph) {
    return new RoadRouter(graph);
  }

  static async open(source: string | RoadGraph, fetcher?: FetchLike) {
    if (typeof source !== "string") return RoadRouter.fromGraph(source);
    if (source.endsWith(".efrb")) return new RoadRouter(undefined, await openRoadGraphBundle(source, fetcher));
    return new RoadRouter(undefined, await createRouteGraphLoader(source, fetcher));
  }

  async route(from: Coordinate, to: Coordinate, preference: RoutePreference = "fastest"): Promise<RouteResult> {
    const graph = this.graph ?? await this.loader!.loadForRoute(from, to);
    return route(graph, from, to, preference);
  }
}
