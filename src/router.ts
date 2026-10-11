import { MinPriorityQueue } from "./priority-queue";
import type { Coordinate, RoadGraph, RoutePreference, RouteResult } from "./types";
import { RouterError } from "./types";
import { nearbyNodeIds } from "./spatial-index";

const EARTH_RADIUS_METERS = 6_371_000;
const MAX_CAR_SPEED_MPS = 36.11; // 130 km/h: admissible fastest-route heuristic.

function haversineMeters(a: Coordinate, b: Coordinate) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const latA = a.lat * radians;
  const latB = b.lat * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function coordinateFor(graph: RoadGraph, nodeId: number): Coordinate {
  const scale = graph.coordinateScale ?? 1;
  return { lat: graph.nodeLatitudes[nodeId] / scale, lng: graph.nodeLongitudes[nodeId] / scale };
}

function assertGraph(graph: RoadGraph) {
  const nodes = graph.nodeLatitudes.length;
  const edges = graph.edgeTargets.length;
  if (!nodes || graph.nodeLongitudes.length !== nodes || graph.edgeOffsets.length !== nodes + 1 || graph.edgeDistancesMeters.length !== edges || graph.edgeDurationsSeconds.length !== edges || graph.edgeOffsets[nodes] !== edges) {
    throw new Error("Invalid road graph");
  }
}

export function findNearestNode(graph: RoadGraph, coordinate: Coordinate, maxDistanceMeters = 500): number | null {
  let closest: number | null = null;
  let closestDistance = maxDistanceMeters;
  const checkNode = (nodeId: number) => {
    const distance = haversineMeters(coordinate, coordinateFor(graph, nodeId));
    if (distance <= closestDistance) {
      closest = nodeId;
      closestDistance = distance;
    }
  };
  if (graph.spatialIndex) {
    for (const nodeId of nearbyNodeIds(graph.spatialIndex, coordinate, maxDistanceMeters)) checkNode(nodeId);
  } else {
    for (let nodeId = 0; nodeId < graph.nodeLatitudes.length; nodeId += 1) checkNode(nodeId);
  }
  return closest;
}

export function route(graph: RoadGraph, from: Coordinate, to: Coordinate, preference: RoutePreference = "fastest"): RouteResult {
  assertGraph(graph);
  const origin = findNearestNode(graph, from);
  if (origin === null) throw new RouterError("ORIGIN_NOT_ON_GRAPH", "No routable road is close to the origin.");
  const destination = findNearestNode(graph, to);
  if (destination === null) throw new RouterError("DESTINATION_NOT_ON_GRAPH", "No routable road is close to the destination.");

  const nodeCount = graph.nodeLatitudes.length;
  const costs = new Float64Array(nodeCount).fill(Infinity);
  const previousNode = new Int32Array(nodeCount).fill(-1);
  const previousEdge = new Int32Array(nodeCount).fill(-1);
  const queue = new MinPriorityQueue<number>();
  const destinationCoordinate = coordinateFor(graph, destination);
  costs[origin] = 0;
  queue.push(origin, 0);

  while (queue.size) {
    const node = queue.pop()!;
    if (node === destination) break;
    const start = graph.edgeOffsets[node];
    const end = graph.edgeOffsets[node + 1];
    for (let edge = start; edge < end; edge++) {
      const target = graph.edgeTargets[edge];
      const edgeCost = preference === "fastest"
        ? graph.edgeDurationsSeconds[edge] * (graph.edgeDurationScale ?? 1)
        : graph.edgeDistancesMeters[edge] * (graph.edgeDistanceScale ?? 1);
      const cost = costs[node] + edgeCost;
      if (cost >= costs[target]) continue;
      costs[target] = cost;
      previousNode[target] = node;
      previousEdge[target] = edge;
      const remainingDistance = haversineMeters(coordinateFor(graph, target), destinationCoordinate);
      const heuristic = preference === "fastest" ? remainingDistance / MAX_CAR_SPEED_MPS : remainingDistance;
      queue.push(target, cost + heuristic);
    }
  }

  if (!Number.isFinite(costs[destination])) throw new RouterError("NO_ROUTE", "No car route connects the selected points.");

  const nodeIds: number[] = [];
  let distanceMeters = 0;
  let durationSeconds = 0;
  for (let node = destination; node !== -1; node = previousNode[node]) {
    nodeIds.push(node);
    const edge = previousEdge[node];
    if (edge >= 0) {
      distanceMeters += graph.edgeDistancesMeters[edge] * (graph.edgeDistanceScale ?? 1);
      durationSeconds += graph.edgeDurationsSeconds[edge] * (graph.edgeDurationScale ?? 1);
    }
  }
  nodeIds.reverse();
  return {
    nodeIds,
    distanceMeters,
    durationSeconds,
    geometry: { type: "LineString", coordinates: nodeIds.map((node) => {
      const coordinate = coordinateFor(graph, node);
      return [coordinate.lng, coordinate.lat];
    }) },
  };
}
