# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-15

Multi-vehicle routing. One bundle can now serve a car, a motorcycle and a
lorry, and a lorry's routes depend on its size and weight. Walking and cycling
ship too, in a bundle of their own. Alternative routes moved to 0.3.0.

### Added

- **Coordinates in a shared chunk are written as differences**, which takes
  about 6% off a multi-vehicle bundle and loses nothing: Portugal for walking
  and cycling went from 102.3 MB to 96.1 MB, and the three motor vehicles from
  42.8 MB to 40.2 MB. The single-chunk layout a one-vehicle bundle uses is
  untouched, so those stay readable by 0.1.0.
- **Barriers.** A gate, bollard or stile across a road is read from the node
  and becomes a ban on passing through it, which still lets you turn back the
  way you came. The same barrier stops different travellers differently: a
  bollard is nothing on foot and the end of the road in a car, a stile is the
  reverse. An unfamiliar barrier is left passable rather than guessed at.
- **`bicycle` and `pedestrian` profiles.** Not motor vehicles with different
  numbers: a posted limit never makes anyone pedal harder, so the way class
  decides the pace and `maxspeed` can only lower it; a one-way sign restrains
  traffic, which a pedestrian is not and a cyclist often has a signed
  contraflow out of; and footways, paths, steps and cycleways are the network
  rather than roads left out of it. They need their own bundle — Portugal is
  102.3 MB for both against 42.8 MB for the three motor vehicles — because
  folding them in would make every driver download the footpaths.
- **`motorcycle` and `truck` profiles.** The car profile became a factory
  parameterised by the mode name, so all three read the same tags in the same
  order and differ in the key at the bottom of each hierarchy: `motorcar`,
  `motorcycle`, `hgv`. `truck` caps every speed at 90 km/h rather than only
  bounding the A* heuristic, because a heavy vehicle is held below the posted
  limit nearly everywhere.
- **Physical limits for lorries.** `maxheight`, `maxwidth`, `maxlength` and
  `maxweight` are read per direction, preferring a limit signed for this
  direction, then one signed for lorries, then the general one, and taking the
  stricter of a signed and a `:physical` value. Feet and inches parse. A value
  that states no number reads as unknown rather than as zero.
- **Vehicle presets** — `van`, `rigid`, `articulated`, `road-train`,
  `us-semi` — resolved from the caller, then the bundle's own
  `--default-vehicle`, then `articulated`. The resolved dimensions are on
  `router.vehicle`, so a default is visible rather than hidden.
- **EFR2 v7 and EFRB v2.** A tile is written as a shared chunk holding the road
  network and one small chunk per vehicle holding its durations, access mask,
  restriction mask and limits. The directory lists them by `(tile, profile)`,
  so a reader downloads the shared half plus the one vehicle it wants.
- **`--profile car,truck,motorcycle`** compiles one bundle for several
  vehicles, reading the extract once.
- **`RoadRouter.profiles`, `RoadRouter.profile`, `RoadRouter.withProfile()`**
  for reading a bundle as another vehicle, reusing every shared chunk already
  downloaded.
- **Profile metadata in both formats**, in header bytes that were already
  reserved, so nothing published grew.

### Changed

- **Repeated routes are about four times faster.** The stitched corridor is
  cached between routes, and the stitch itself no longer builds a string key
  per node copy. Porto to Lisbon went from 2107 ms to 534 ms with nothing left
  to download. `mergedCacheSize` controls it; `0` restores the old behaviour.
- **The A* heuristic and the tile budget take their speed ceiling from the
  graph** rather than from the car profile. The heuristic stayed admissible
  with the wrong ceiling but collapsed towards zero; the tile budget would have
  over-downloaded badly for a slower vehicle.
- The car profile also reads `oneway:motor_vehicle`, `oneway:motorcar` and
  `maxspeed:motorcar`, which only matter where those tags exist.

### Fixed

- **`engines.node` was `>=22.5`**, the compiler's requirement, applied to the
  whole package — so installing the library on Node 18 or 20 warned, and failed
  under `engine-strict`. It is now `>=18`, and the CLI checks its own
  requirement at startup rather than after streaming the whole extract.
- **Switching vehicle threw when the first one had dimensions.** Opening as a
  lorry and asking for the car refused the switch, because the dimensions
  travelled with the options and a car cannot use them. The check moved to
  where a caller pairs a vehicle with a profile; past that, dimensions travel
  with the reader and apply only where they mean something, so truck to car to
  motorcycle and back ends with the dimensions it started with.
- **Switching vehicle discarded the stitched corridor.** A bundle kept two
  corridors however many vehicles it held, so three vehicles evicted each
  other and every switch re-stitched. It keeps one per vehicle now: a repeated
  Porto to Lisbon fell from about 1500 ms to 257 ms by car, 140 ms by lorry.
- **A route could fail because an end snapped to a disconnected stub.** The
  nearest road to a point is not always one that leads anywhere: a path behind
  a fence, a service road in a compound, a stretch clipped at a tile edge. A
  failed route is now retried against the piece of the network the other end
  is in. It runs only after a failure, so an ordinary route never pays for it.
  Walking and cycling networks feel this most, being full of small fragments.
- **Merging tiles dropped per-vehicle data.** Limits, access masks and
  restriction masks are rebased onto the merged numbering, keeping the stricter
  limit where two tiles disagree. A corridor built from more than one tile
  would otherwise have routed a lorry under a bridge it does not fit through.
- A truck bundle written in the single-chunk layout, which has nowhere to keep
  limits, is refused rather than routed with the dimensions silently ignored.

### Documentation

- **The README now states plainly what a route does not guarantee.** A route
  is a path over roads the data does not say are forbidden, which is weaker
  than legal or physical suitability. Time-dependent access, seasonal and
  weather rules, temporary closures, zone-level lorry bans and low-emission
  zones, axle load and hazardous goods rules, and untagged limits are all
  listed as unread, with the consequence for a heavy vehicle said directly:
  a route may pass under a bridge too low for it or along a street it is
  banned from at the hour you travel.

### Known limitations

- **Conditional restrictions are not read. They are the first item of
  0.3.0.** `access:conditional`, `restriction:conditional` and
  `hgv:conditional` are ignored, so a street closed to lorries overnight or a
  square pedestrianised on Sundays appears permanently open. It is the
  limitation most likely to make a route wrong rather than merely longer,
  particularly for a lorry, so it is scheduled ahead of alternative routes.
- An active-travel bundle at country scale cannot be compiled with small
  tiles: Portugal for walking and cycling at 40 km tiles exceeds the
  compiler's 3 GB ceiling and is refused. The default 120 km works, at the
  cost of a larger first download for a short urban route.
- Alternative routes are not in this release; they are planned for 0.3.0,
  after conditional restrictions.

### Compatibility

Bundles compiled by 0.1.0 open and route identically. A single-vehicle compile
with no physical limits still writes the one-chunk layout byte for byte. The
new formats appear only when a bundle holds several vehicles or a vehicle whose
routes depend on its size, and a 0.1.0 reader cannot open those.

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

### Documentation

- **The README now states plainly what a route does not guarantee.** A route
  is a path over roads the data does not say are forbidden, which is weaker
  than legal or physical suitability. Time-dependent access, seasonal and
  weather rules, temporary closures, zone-level lorry bans and low-emission
  zones, axle load and hazardous goods rules, and untagged limits are all
  listed as unread, with the consequence for a heavy vehicle said directly:
  a route may pass under a bridge too low for it or along a street it is
  banned from at the hour you travel.

### Known limitations

See the "Supported OSM features and limitations" section of the README.
