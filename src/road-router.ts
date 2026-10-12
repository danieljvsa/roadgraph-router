import { createRouteGraphLoader, type RouteGraphLoader } from "./manifest";
import { openRoadGraphBundle, type BundleTile, type RoadGraphBundle } from "./bundle";
import { route } from "./router";
import { carRoutingProfile } from "./routing-profile";
import { RouterError, type Coordinate, type RoadGraph, type RoutePreference, type RouteResult } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RouteLoader = Pick<RouteGraphLoader | RoadGraphBundle, "loadForRoute"> & Partial<Pick<RoadGraphBundle, "loadExpandedForRoute">>;

/** The fastest any edge can be travelled, which bounds how far a given duration can reach. */
const MAX_SPEED_MPS = (carRoutingProfile.maxSpeedKph * 1000) / 3600;

/**
 * How much further than the straight line the first attempt is willing to look.
 * It is a fraction of the journey rather than a count of tiles, so the first
 * download does not change when a region is recompiled at a different tile size.
 */
const INITIAL_DETOUR_FACTOR = 1.4;

/**
 * Caps how far off the straight line the confirmation pass will reach, as a
 * multiple of the direct distance. `Infinity` leaves the search bounded only
 * by the route already found, which makes the answer the best the compiled
 * graph holds; a finite value trades that proof for a smaller download and
 * still ignores tile size, since the limit is a ground distance.
 */
export type RoadRouterOptions = { maxDetourFactor?: number };
const MINIMUM_BUDGET_METERS = 5_000;

/** Widening steps used only while no route has been found at all. */
const SEARCH_WIDENING_FACTORS = [3, 8, Infinity];

/** Safety stop; each pass can only lower the cost, so this is never reached in practice. */
const MAX_CONFIRMATION_PASSES = 4;

function isBundle(loader: RouteLoader | undefined): loader is RoadGraphBundle {
  return Boolean(loader && "tilesWithinBudget" in loader && "loadTiles" in loader);
}

function haversineMeters(a: Coordinate, b: Coordinate) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

/**
 * High-level route entry point. `open()` accepts an EFRB bundle, an EFRT
 * manifest, or an already-decoded graph.
 */
export class RoadRouter {
  private constructor(private readonly graph?: RoadGraph, private readonly loader?: RouteLoader, private readonly options: RoadRouterOptions = {}) {}

  static fromGraph(graph: RoadGraph) {
    return new RoadRouter(graph);
  }

  static async open(source: string | RoadGraph, fetcher?: FetchLike, options: RoadRouterOptions = {}) {
    if (typeof source !== "string") return RoadRouter.fromGraph(source);
    if (source.endsWith(".efrb")) return new RoadRouter(undefined, await openRoadGraphBundle(source, fetcher), options);
    return new RoadRouter(undefined, await createRouteGraphLoader(source, fetcher), options);
  }

  async route(from: Coordinate, to: Coordinate, preference: RoutePreference = "fastest"): Promise<RouteResult> {
    if (this.graph) return route(this.graph, from, to, preference);
    if (isBundle(this.loader)) return this.routeOverBundle(this.loader, from, to, preference);
    return this.routeOverLoader(this.loader!, from, to, preference);
  }

  /**
   * Downloads a corridor, routes, then asks whether any tile left out could
   * still hold something better. A route through a tile costs at least the
   * detour to reach it, so the answer is a geometric test against the route
   * already found: tiles that fail it are provably useless and stay
   * undownloaded, and when none passes, the route is the best the compiled
   * graph contains. Because the test measures ground distance rather than
   * counting neighbours, the answer does not depend on the tile size.
   */
  private async routeOverBundle(bundle: RoadGraphBundle, from: Coordinate, to: Coordinate, preference: RoutePreference) {
    const straightLine = haversineMeters(from, to);
    const ceiling = straightLine * (this.options.maxDetourFactor ?? Infinity);
    const reachFor = (result: RouteResult) => Math.min(ceiling, preference === "fastest" ? result.durationSeconds * MAX_SPEED_MPS : result.distanceMeters);
    let budget = Math.max(MINIMUM_BUDGET_METERS, Math.min(ceiling, straightLine * INITIAL_DETOUR_FACTOR));

    let loaded: BundleTile[] = [];
    let graph: RoadGraph | null = null;
    let best: RouteResult | null = null;
    let failure: unknown;

    const widen = async (nextBudget: number) => {
      const wanted = bundle.tilesWithinBudget(from, to, nextBudget);
      if (wanted.length <= loaded.length && wanted.every((tile) => loaded.some((held) => held.id === tile.id))) return false;
      loaded = wanted;
      graph = await bundle.loadTiles(wanted);
      return true;
    };

    await widen(budget);
    if (!graph) throw new RouterError("ROUTE_OUTSIDE_COVERAGE", "The route is outside the available bundle coverage.");

    // Phase 1: find any route, widening only while there is none to measure.
    for (const factor of [1, ...SEARCH_WIDENING_FACTORS]) {
      if (factor !== 1 && !(await widen(factor === Infinity ? Infinity : budget * factor))) break;
      try {
        best = route(graph!, from, to, preference);
        break;
      } catch (error) {
        failure = error;
        if ((error as { code?: string }).code !== "NO_ROUTE") throw error;
      }
    }
    if (!best) throw failure ?? new RouterError("NO_ROUTE", "No car route connects the selected points.");

    // Phase 2: confirm it against every tile that could still beat it. The
    // bound makes each pass cheap, since anything no better is abandoned early.
    for (let pass = 0; pass < MAX_CONFIRMATION_PASSES; pass += 1) {
      if (!(await widen(reachFor(best)))) return best;
      try {
        best = route(graph!, from, to, preference, { costBound: preference === "fastest" ? best.durationSeconds : best.distanceMeters });
      } catch (error) {
        if ((error as { code?: string }).code !== "NO_ROUTE") throw error;
        return best; // Nothing in the added tiles beats what we already have.
      }
    }
    return best;
  }

  private async routeOverLoader(loader: RouteLoader, from: Coordinate, to: Coordinate, preference: RoutePreference) {
    const graph = await loader.loadForRoute(from, to);
    try {
      return route(graph, from, to, preference);
    } catch (error) {
      if (!(error instanceof Error) || (error as { code?: string }).code !== "NO_ROUTE" || !loader.loadExpandedForRoute) throw error;
      // A straight geographic corridor may omit a tile holding a bridge, a
      // one-way detour, or a road around a physical obstacle. Retry once with
      // the immediate ring of neighbouring tiles before reporting no route.
      return route(await loader.loadExpandedForRoute(from, to), from, to, preference);
    }
  }
}
