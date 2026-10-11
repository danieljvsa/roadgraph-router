import { createRouteGraphLoader, type RouteGraphLoader } from "./manifest";
import { openRoadGraphBundle, type RoadGraphBundle } from "./bundle";
import { route } from "./router";
import type { Coordinate, RoadGraph, RoutePreference, RouteResult } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RouteLoader = Pick<RouteGraphLoader | RoadGraphBundle, "loadForRoute"> & Partial<Pick<RoadGraphBundle, "loadExpandedForRoute">>;

/**
 * High-level route entry point. `open()` currently accepts an EFRT manifest
 * or an already-decoded graph; later bundle readers plug into the same API.
 */
export class RoadRouter {
  private constructor(private readonly graph?: RoadGraph, private readonly loader?: RouteLoader) {}

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
    try {
      return route(graph, from, to, preference);
    } catch (error) {
      if (!(error instanceof Error) || (error as { code?: string }).code !== "NO_ROUTE" || !this.loader?.loadExpandedForRoute) throw error;
      // A straight geographic corridor may omit a tile holding a bridge, a
      // one-way detour, or a road around a physical obstacle. Retry once with
      // the immediate ring of neighbouring tiles before reporting no route.
      return route(await this.loader.loadExpandedForRoute(from, to), from, to, preference);
    }
  }
}
