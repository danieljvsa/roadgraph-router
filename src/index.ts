export { combineProfiledGraph, decodeGraph, decodeProfileChunk, decodeSharedGraph, encodeCompactGraph, encodeGraph, encodeProfileChunk, encodeSharedGraph } from "./codec";
export type { CompactEncodeOptions } from "./codec";
export { VarintReader, VarintWriter, unzigzag, zigzag } from "./varint";
export { compactGraph } from "./compact";
export { accessMaskFor, allowsEverything, edgeAllowed } from "./access";
export { searchBoundsFor, straightLineAtMost } from "./search-bounds";
export type { SearchBounds } from "./search-bounds";
export { componentSizes, componentsFor } from "./connectivity";
export { accessForVehicle, countBlocked, fromDecimetres, fromHalfTonnes, packEdgeLimits, toDecimetres, toHalfTonnes } from "./limits";
export {
  ConditionKind, accessAtTime, conditionalDurations, conditionalValue, conditionHolds, conditionsOf, conditionsOnEdge,
  countClosedAt, packEdgeConditions, parseConditional, parseEdgeConditions, travelTimeFrom, unreadableConditions,
  type Condition, type ConditionalRule, type MinuteSpan, type ParsedConditions, type TravelTime, type VehicleComparison,
} from "./conditional";
export { findNearestNode, route } from "./router";
export type { RouteOptions } from "./router";
export type { DepartureOptions } from "./road-router";
export { routeAlternatives, type AlternativeRoutesOptions } from "./alternatives";
export { snapToGraph } from "./snap";
export { createEdgeSpatialIndex, edgePolyline, edgeSource, edgeSpatialIndexFor, nearbyEdgeIds } from "./edge-index";
export { createSpatialIndex, withSpatialIndex } from "./spatial-index";
export { RoadRouter } from "./road-router";
export type { RoadRouterOptions } from "./road-router";
export { BundleCompression, distanceToBounds, encodeCompressedRoadGraphBundle, encodeProfiledRoadGraphBundle, encodeRoadGraphBundle, openRoadGraphBundle } from "./bundle";
export { RouterError } from "./types";
export { createRouteGraphLoader } from "./manifest";
export { mergeRoadGraphs } from "./merge";
export { buildTurnRestrictionIndex, buildTurnSequenceIndex, guardedJunctionsFor, isTurnBanned, packTurnRestrictions, packTurnSequences } from "./turn-restrictions";
export { ProfileId, carRoutingProfile, getRoutingProfile, getRoutingProfileById, maxSpeedMpsFor, motorcycleRoutingProfile, parseLengthMeters, parseMaxSpeedKph, parseWeightTonnes, profileOf, routingProfiles, truckRoutingProfile } from "./routing-profile";
export { DEFAULT_VEHICLE_PRESET, VEHICLE_PRESETS, VehiclePresetId, resolveVehicle, vehiclePreset, vehiclePresetName } from "./vehicle";
export type { CompactGraphOptions } from "./compact";
export type { BundleBounds, BundleChunkRef, BundleEncodeOptions, BundleGraphTile, BundleOpenOptions, BundleProfiledTile, BundleTile, RoadGraphBundle } from "./bundle";
export type { Coordinate, CoordinateStorage, EdgeConditions, EdgeLimits, GeoJsonLineString, GeoJsonPosition, ProfileChunk, RouteSnap, EdgeWeightStorage, NodeSpatialIndex, RoadGraph, RoutePreference, RouteResult, RouterErrorCode, SharedRoadGraph } from "./types";
export type { GraphBounds, GraphTile, RouteGraphLoader, RouteGraphManifest } from "./manifest";
export type { GuardedJunctions, TurnRestrictionIndex, TurnSequenceIndex } from "./turn-restrictions";
export type { EdgeProjection, GraphSnap } from "./snap";
export type { EdgeSpatialIndex } from "./edge-index";
export type { OsmTags, ParsedTurnRestriction, RoutingProfile, TurnRestrictionKind, VehicleLimits, WayTraversal } from "./routing-profile";
export type { VehicleDimensions, VehicleInput } from "./vehicle";
