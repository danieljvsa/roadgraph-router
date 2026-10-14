import { createRouteGraphLoader, type RouteGraphLoader } from "./manifest";
import { openRoadGraphBundle, type BundleTile, type RoadGraphBundle } from "./bundle";
import { route } from "./router";
import { getRoutingProfile, getRoutingProfileById, maxSpeedMpsFor } from "./routing-profile";
import { RouterError, type Coordinate, type RoadGraph, type RoutePreference, type RouteResult } from "./types";
import { resolveVehicle, type VehicleDimensions, type VehicleInput } from "./vehicle";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RouteLoader = Pick<RouteGraphLoader | RoadGraphBundle, "loadForRoute"> & Partial<Pick<RoadGraphBundle, "loadExpandedForRoute">>;

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
export type RoadRouterOptions = {
  maxDetourFactor?: number;
  /** How many stitched corridors a bundle keeps; see `BundleOpenOptions`. */
  mergedCacheSize?: number;
  /**
   * Which vehicle to route as. Only a multi-profile bundle offers a choice;
   * leaving it out uses the vehicle the bundle was compiled around.
   */
  profile?: string;
  /**
   * The lorry's size and weight, for a profile whose routes depend on them. A
   * preset name, a set of dimensions, or a preset with fields overridden.
   * `null` turns the filtering off, which is a decision to accept routes no
   * real lorry may be able to drive.
   */
  vehicle?: VehicleInput | null;
};
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
  private constructor(private readonly graph?: RoadGraph, private readonly loader?: RouteLoader, private readonly options: RoadRouterOptions = {}, private readonly profileId?: number) {
    const profile = getRoutingProfileById(profileId ?? 0);
    if (options.vehicle !== undefined && options.vehicle !== null && profile && !profile.usesPhysicalLimits) {
      // Accepting dimensions a bundle cannot act on would look like they were
      // applied. A car graph holds no limits to apply them against.
      throw new Error(`The "${profile.name}" profile does not use vehicle dimensions; only a profile that stores physical limits does.`);
    }
    this.vehicle = profile?.usesPhysicalLimits && options.vehicle !== null ? resolveVehicle(options.vehicle ?? undefined) : undefined;
  }

  /** The lorry these routes are for, where the profile depends on one. */
  readonly vehicle?: VehicleDimensions;

  static fromGraph(graph: RoadGraph) {
    return new RoadRouter(graph);
  }

  static async open(source: string | RoadGraph, fetcher?: FetchLike, options: RoadRouterOptions = {}) {
    if (typeof source !== "string") return RoadRouter.fromGraph(source);
    if (source.endsWith(".efrb")) {
      const bundle = await openRoadGraphBundle(source, fetcher, { mergedCacheSize: options.mergedCacheSize, profile: options.profile });
      return new RoadRouter(undefined, bundle, options, bundle.profileId);
    }
    return new RoadRouter(undefined, await createRouteGraphLoader(source, fetcher), options);
  }

  /** The vehicle this router is routing as, when the source names one. */
  get profile() {
    return getRoutingProfileById(this.profileId ?? 0)?.name;
  }

  /**
   * The same bundle read as another vehicle. The shared half of every tile is
   * already downloaded and stays so, which is the point of storing the road
   * network once: switching vehicle costs only the small per-vehicle chunks.
   */
  withProfile(name: string): RoadRouter {
    const wanted = getRoutingProfile(name);
    if (!isBundle(this.loader)) throw new Error("Only a multi-profile bundle can be read as another vehicle.");
    if (!this.loader.profiles.includes(wanted.id)) {
      throw new Error(`This routing bundle does not hold the "${name}" profile. It holds: ${this.loader.profiles.map((id) => getRoutingProfileById(id)?.name ?? `id ${id}`).join(", ")}.`);
    }
    return new RoadRouter(undefined, this.loader, this.options, wanted.id);
  }

  async route(from: Coordinate, to: Coordinate, preference: RoutePreference = "fastest"): Promise<RouteResult> {
    if (this.graph) return route(this.graph, from, to, preference, { vehicle: this.vehicle });
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
    // How far a given duration can reach depends on the vehicle. Sizing a
    // walk's tile budget with a car's top speed would ask for a radius of
    // tiles forty times larger than the walk can cross.
    // A multi-profile bundle's header records the fastest vehicle it holds, so
    // the ceiling for the one actually selected comes from the profile itself.
    const selected = this.profileId ?? bundle.profileId;
    const maxSpeedMps = maxSpeedMpsFor({ profileId: selected, maxSpeedKph: bundle.profiles.length > 1 ? undefined : bundle.maxSpeedKph || undefined });
    const reachFor = (result: RouteResult) => Math.min(ceiling, preference === "fastest" ? result.durationSeconds * maxSpeedMps : result.distanceMeters);
    let budget = Math.max(MINIMUM_BUDGET_METERS, Math.min(ceiling, straightLine * INITIAL_DETOUR_FACTOR));

    let loaded: BundleTile[] = [];
    let graph: RoadGraph | null = null;
    let best: RouteResult | null = null;
    let failure: unknown;

    const widen = async (nextBudget: number) => {
      const wanted = bundle.tilesWithinBudget(from, to, nextBudget);
      if (wanted.length <= loaded.length && wanted.every((tile) => loaded.some((held) => held.id === tile.id))) return false;
      loaded = wanted;
      graph = await bundle.loadTiles(wanted, selected);
      return true;
    };

    await widen(budget);
    if (!graph) throw new RouterError("ROUTE_OUTSIDE_COVERAGE", "The route is outside the available bundle coverage.");

    // Phase 1: find any route, widening only while there is none to measure.
    for (const factor of [1, ...SEARCH_WIDENING_FACTORS]) {
      if (factor !== 1 && !(await widen(factor === Infinity ? Infinity : budget * factor))) break;
      try {
        best = route(graph!, from, to, preference, { vehicle: this.vehicle });
        break;
      } catch (error) {
        failure = error;
        if ((error as { code?: string }).code !== "NO_ROUTE") throw error;
      }
    }
    if (!best) throw failure ?? new RouterError("NO_ROUTE", "No route connects the selected points.");

    // Phase 2: confirm it against every tile that could still beat it. The
    // bound makes each pass cheap, since anything no better is abandoned early.
    for (let pass = 0; pass < MAX_CONFIRMATION_PASSES; pass += 1) {
      if (!(await widen(reachFor(best)))) return best;
      try {
        best = route(graph!, from, to, preference, { costBound: preference === "fastest" ? best.durationSeconds : best.distanceMeters, vehicle: this.vehicle });
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
      return route(graph, from, to, preference, { vehicle: this.vehicle });
    } catch (error) {
      if (!(error instanceof Error) || (error as { code?: string }).code !== "NO_ROUTE" || !loader.loadExpandedForRoute) throw error;
      // A straight geographic corridor may omit a tile holding a bridge, a
      // one-way detour, or a road around a physical obstacle. Retry once with
      // the immediate ring of neighbouring tiles before reporting no route.
      return route(await loader.loadExpandedForRoute(from, to), from, to, preference, { vehicle: this.vehicle });
    }
  }
}
