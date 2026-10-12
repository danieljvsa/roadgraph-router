# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

First public release. Everything below is new, so this entry describes what the
package does rather than how it changed.

### Added

- **Generic OSM compiler.** `roadgraph-compile` turns any `.osm.pbf` extract
  into an EFRB bundle in two passes over the file, with no assumptions about
  which region it describes. Coordinates are indexed on disk through
  `node:sqlite`, tiles are encoded and spilled one at a time, and the bundle is
  streamed out, so peak memory tracks the largest tile rather than the region.
- **Routing profiles.** Tag handling lives behind a `RoutingProfile`. The
  bundled `car` profile resolves the OSM access hierarchy, `oneway`,
  `junction`, and `maxspeed` including `mph`, falling back to highway-class
  defaults for values it cannot parse.
- **Turn restrictions.** `no_*` and `only_*` relations are enforced, both the
  `via`-node form and the `via`-way form. A graph carrying restrictions is
  searched with an edge-labelled A*, so a banned turn cannot appear in a result.
- **Snapping to roads.** A coordinate is projected onto the nearest road rather
  than the nearest junction, which matters after topology simplification, where
  a rural road can run for a kilometre without a node.
- **Tile selection by distance.** The router loads the tiles that could hold a
  better route, judged by ground distance, so results do not depend on the tile
  size a region was compiled at. `maxDetourFactor` caps how far it will look.
- **Compact storage.** EFR2 v6 stores each road's geometry once and mirrors it
  for the reverse direction, writes coordinates and edge targets as
  variable-length differences, and rebuilds node offsets from degrees.
- **Range-addressable bundles.** An `.efrb` holds independently gzipped tiles
  behind a fixed directory, so a route downloads only the tiles it needs.
- **Formats.** Reads EFRT v1 and EFR2 v2 through v6; writes EFR2 v6 by default
  and the v2-v5 layout on request.

### Known limitations

See the "Supported OSM features and limitations" section of the README.
