# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-16

### Fixed, after review of real Metro do Porto routes

- **A railway route began in the depot.** Snapping took the nearest rail, and
  every platform has a yard track or a crossover a few metres beside it: at
  Trindade the yard is 4.6 m from the station node and the running line 6.7 m.
  Routes started in the sidings and crossed out, which looks like a routing
  fault and is really a snapping one. Service track now carries a 30 m penalty
  when candidates are ranked — a preference, not a ban, so a point genuinely
  inside a yard still snaps there.

- **A route could be forced to leave in the wrong direction.** Two directed
  edges within half a metre of the best were treated as the same road, which
  is right for a carriageway carrying both directions at identical distance
  and wrong for a railway, where the two directions are separate one-way
  tracks several metres apart. Only the nearer was offered, so the journey had
  to go that way: Trindade to Senhor de Matosinhos came back as 16.1 km
  instead of 11.8. A graph that describes its track now uses a 25 m tolerance,
  about the width of a station throat, so every platform track is offered and
  the search takes the one the journey needs.

  Both rules apply only where railway attributes are present; a road graph
  snaps exactly as it did, which 30 road routes across three profiles confirm.

- **A shortest route cut through the depot.** A siding is often the shortest
  path between two parallel running lines, and nothing made it dearer: leaving
  Trindade the route took 83 m of yard to change track, and ran 9.35 km of
  sidings between Porto and Lisboa. Service track is now four times dearer for
  a `shortest` search — a `fastest` one already prefers the running line,
  because a siding is modelled at 25 km/h. The multiplier steers the search
  and never reaches the answer. Dearer, not forbidden: where a siding is the
  only way through it is still used.

  Measured against the Linha A alignment as OSM maps it, Trindade to Senhor de
  Matosinhos now deviates by a mean of 0.0 m and a worst of 3.0 m, with no
  point more than 10 m off. Before, it ran through the yard and down a Linha D
  platform, up to 31 m off.

### Fixed, in the release audit

- **A railway signed below 5 km/h was routed at 5 km/h.** The floor that keeps
  an *assumed* speed off zero was being applied to speeds the data states as
  well, so a track tagged `maxspeed=3` was travelled at 5 — faster than the
  limit, and arriving sooner than the track permits. A stated limit is now
  used as stated, and only the profile's own ceiling may lower it. The floor
  stays where it belongs, under an assumption.

- **`--railway-include` would route over track that has been lifted.** The
  inclusion list is typed, and a type constrains a TypeScript caller and
  nothing at all at a command line, where the flag arrives as plain text.
  `--railway-include abandoned,razed,construction` compiled all of them,
  against a README that promised it could not. Inclusions are now checked at
  run time and refused by name, with the reason: *railway class "abandoned"
  cannot be routed over: the track has been lifted.*

- **Malformed railway constraints are refused rather than read.** A
  `{ gaugeMm: NaN }` compares false against every stated gauge, so reading it
  would close the whole network and answer `NO_ROUTE` to what is really a
  typo; `{ voltage: -25000 }` and a misspelled key fail the other way, by
  applying nothing. `assertRailwayConstraints` now checks types, ranges,
  list shapes and key names, and runs in `route()`, `routeAlternatives()` and
  `RoadRouter.open` — the last before a byte is fetched.

- **A region with no height or no width compiled to nothing.** A single line
  of track at one latitude has a zero-height bounding box, which produced no
  tile rows at all and failed with "Invalid routing bundle directory" — a
  message about the output for a problem with the input. Such a region now
  yields the one tile it should.



### Added

- **Railway routing: `train` and `metro`.** Two profiles that route over
  mapped railway infrastructure instead of roads, using the same compiler, the
  same A\*, the same bundle format and the same `RoadRouter`.

  ```bash
  roadgraph-compile portugal.osm.pbf --output portugal-rail.efrb --profile train
  roadgraph-compile porto.osm.pbf    --output porto-metro.efrb  --profile metro
  ```

  ```ts
  const router = await RoadRouter.open("portugal-rail.efrb", undefined, { profile: "train" });
  const result = await router.route(portoCampanha, lisboaSantaApolonia, "shortest");
  // 336.0 km along the Linha do Norte
  ```

  There is no `RailRouter`, and no road behaviour changed. `train` is
  `railway=rail`; `metro` is `railway=subway` and `railway=light_rail`
  together, because Lisbon's system is tagged the first way and Porto's the
  second, and a profile holding one of them would miss a network.

  **A railway route here is a path through mapped physical infrastructure. It
  does not establish that passenger services exist, that the track is
  currently operational, or that a real train is authorised or physically
  capable of using the calculated path.** There is no GTFS, no timetable, no
  passenger journey, no arrival time and no signalling model.

- **What the track is, carried into the bundle and applied at routing time.**
  `gauge`, `electrified`, `voltage`, `frequency`, `usage` and `service` are
  read off each way and stored, and a route says what the train can run on:

  ```ts
  const result = await router.route(origin, destination, "shortest", {
    railway: { gaugeMm: 1668, requireElectrification: true },
  });
  ```

  Portugal's main line is 1,668 mm Iberian gauge, so Porto to Lisboa returns
  336.0 km under `{ gaugeMm: 1668 }` and `NO_ROUTE` under `{ gaugeMm: 1435 }`.
  Constraints narrow the same access mask the vehicle and the departure time
  narrow, so the search and the snapping agree about which track is usable.

  **The policy for a missing tag is stated and enforced:** a constraint
  excludes a track only where the track's own tags contradict it. OSM silence
  is an absent survey, not a statement of incompatibility, and excluding every
  unstated track would reduce most networks to nothing. That permissiveness is
  never reported as compatibility. Every railway route carries the answer on
  the result itself, as `result.railway`: how many metres ran on track that
  stated every constrained attribute and how many did not, which attributes
  were missing, how far it ran over service track, and every distinct gauge it
  crossed. A road route has no such field and a railway route always has one,
  including one over track that states nothing, which reports itself as
  entirely unstated — so the field's absence means one thing only.

  `strictUnknown: true` reverses the default for a caller who would rather
  have no route than an unverified one, and holds for a whole graph as well as
  for one track: a railway bundle whose tracks describe nothing is closed
  entirely rather than quietly accepted.

- **An inclusion policy for track that is arguably track.** `disused` is
  excluded by default and available as an explicit opt-in: the rails are
  there, but nothing has run over them and OSM does not say whether anything
  could. `narrow_gauge`, `tram`, `monorail` and `funicular` are opt-in for the
  same reason — they are real infrastructure that a given vehicle cannot
  necessarily use.

  ```bash
  roadgraph-compile portugal.osm.pbf --output rail.efrb --profile train \
    --railway-include disused,narrow_gauge
  ```

  `abandoned`, `razed`, `dismantled`, `demolished`, `proposed` and
  `construction` are excluded and are **not** opt-in. Inclusion is an
  allowlist of `railway=` values rather than a denylist, because the key
  carries dozens of values that are not track at all — `platform`, `station`,
  `turntable`, `ventilation_shaft` — and a denylist would route trains along
  station platforms the first time OSM invented a new value.

- **A railway section in the v7 profile chunk.** Shaped the other way round
  from the sparse limit and condition tables beside it, because nearly every
  railway edge states something and a whole line states the same thing: a
  dictionary of the distinct combinations plus one 16-bit row index per edge.
  All of Portugal's `railway=rail` network collapses onto **20 distinct rows**
  across 25,569 edges, and its metro onto 11. The section costs 2.08 bytes per
  edge raw and **0.31 bytes per edge gzipped** — 7.9 kB for every railway edge
  in Portugal.

  Gauge, voltage and frequency each keep a *second* stated value, because a
  dual-gauge or changeover track really does state two and a train matching
  either can run over it — `gauge=1000;1668` on Portuguese track,
  `frequency=0;16.7` on 176 Swiss ways.

### Changed

- **A bundle holds one network.** `--profile car,train` is refused with an
  explanation rather than obeyed, so railway geometry never lands in a road
  bundle and no road-routing user downloads track. Two *railway* profiles may
  share a bundle, because they genuinely share topology:
  `--profile train,metro` holds 26,052 edges on Portugal against the 23,273
  and 2,777 of the two separate bundles, and the same 12,413 nodes. The two
  extra edges are the two places in Portugal where a light-rail way runs
  through the end of a rail way: a junction once both are compiled, and a node
  simplified away when the metro is compiled alone. Nothing was merged and
  nothing duplicated. The two networks stay separate inside the bundle,
  because an edge belongs to one of them and the other profile's access mask
  closes it.

- **A profile now says which network it travels over.** `RoutingProfile` gains
  `networkKind: "road" | "railway"`, and the shared profile vocabulary moved
  to `./profile-types`, re-exported unchanged from `./routing-profile`.

### Fixed

- **A stitched corridor kept its track description.** `mergeRoadGraphs`
  rebases access, limits, conditions and turn restrictions onto the merged
  edge numbering, and railway attributes were not among them — so on any route
  long enough to span more than one tile, every railway constraint was
  silently vacuous. Found by routing Porto to Lisboa with a standard-gauge
  constraint and getting the Iberian-gauge main line back. Now rebased with
  the rest, and pinned by a test that compiles a multi-tile railway extract
  and asserts the constraint still bites.

### Railway topology

Connectivity comes from one thing: two ways sharing an OSM node. That is the
compiler's existing rule and it is the right one, so no railway-specific
topology code was added — but it is now covered by tests that run the real
compiler over real PBF files rather than over a reimplementation of it. Two
tracks crossing on the map without a shared node are not joined; a bridge and
the line beneath it are not joined; parallel tracks stay separate until a
mapped crossover joins them; a dead-end spur is routable to its end and not
beyond; disconnected networks report `NO_ROUTE`. No switch or junction is ever
invented.

In the whole Portugal extract exactly **4 nodes** are shared between two
different classes of railway, and **0** are places where `railway=rail`
changes gauge. The networks really are separate in the data.

`oneway=yes` and `oneway=-1` are the only things that restrict a track to one
direction — 906 of the 1,139 Metro do Porto `light_rail` ways carry one, so
assuming bidirectional running would route trains the wrong way down most of
that network. `railway:preferred_direction` is deliberately not read: it
describes how trains are normally run, not what the track permits.

### Cost

Railways add about **3.5 kB gzipped** to a browser bundle that will never use
them — 27.5 kB to 31.0 kB for the whole public surface. It is not
tree-shakeable: `routingProfiles` names every profile and the constraint
module is reached from `route()`. Hiding it behind a dynamic import would make
profile lookup asynchronous, which is a worse trade. Runtime dependencies are
unchanged, and `npm audit --omit=dev` reports no vulnerabilities.

### Compatibility

**A road bundle compiled by 0.4.0 is byte for byte the file 0.3.0 wrote**, and
a 0.3.0 reader opens it. The railway section lives in four header bytes of the
profile chunk that no chunk had ever written, and a road chunk leaves them
zero. This is pinned by a test holding the hashes 0.3.0 produced for all five
chunk layouts — packed v6, legacy v5, shared v7, a car profile chunk and a
truck profile chunk — not a snapshot of the current code.

A 0.3.0 reader handed a *railway* bundle refuses it by name rather than
routing with the wrong rules: `This routing bundle was compiled for a profile
this build does not support (id 6).` Profile ids 6 and 7 are new and no
existing id moved.

### Measured

Portugal, `portugal-latest.osm.pbf` at 425 MB, on one machine:

| | `train` | `metro` | `train,metro` | `car`, for scale |
| --- | --- | --- | --- | --- |
| Bundle | 293.9 kB | 39.7 kB | 373.4 kB | 38.04 MB |
| Compile time | 1m 18s | 1m 07s | 1m 14s | 8m 02s |
| Peak compile memory | 0.3–0.6 GB | 0.3–0.5 GB | 0.5 GB | 1.47 GB |
| Routing edges | 23,273 | 2,777 | 26,052 | 2,759,810 |

Porto Campanhã to Lisboa Santa Apolónia is 336.0 km over 22 range requests
and 265 kB, 89 ms cold and 4.2 ms warm. Metro do Porto's Linha A is 11.8 km
out of a 17.3 kB bundle. The distances check against the real network — the
Linha do Norte between those stations is about 336 km, Linha A about 12 — and
the *durations* do not, by design: they are line-speed estimates and are
optimistic against every real timetable.

## [0.3.0] - 2026-10-15

### Added

- **Conditional restrictions, when a route says when it starts.**
  `router.route(from, to, "fastest", { departAt })` closes the roads shut at
  that moment to both the search and the snapping, and slows the ones a
  conditional speed limit slows. The reported duration is the slowed one, not
  the one the route was planned against.

  `*:conditional` is read from the access ladder — `access`, `vehicle`,
  `motor_vehicle` and the profile's own key — and from `maxspeed`. Conditions
  resting on time of day, weekday, month, public holiday and the vehicle's own
  dimensions are answered, including windows that run past midnight, seasons
  that span the new year and several windows in one rule. Where more than one
  rule matches, the last wins, which is what OpenStreetMap specifies.

  Measured on Portugal, where the Ponte 25 de Abril carries
  `hgv:conditional = no @ (05:00-02:00)`: routing Almada to Lisbon, a lorry
  with no departure time takes the bridge in 13.0 km, at 03:00 takes it in
  13.0 km, and at 10:00 detours 63.4 km over the Ponte Vasco da Gama. A car
  crosses in 12.2 km at every hour. 3,328 of Portugal's 2,760,171 edges carry
  a conditional restriction, costing 14.8 kB — the bundle grew from 40.17 MB
  to 40.18 MB — and about 10 ms on a repeat long-distance route.

- **Alternative routes.** `routeAlternatives(from, to, preference, { count })`
  returns several routes, best first. It finds the best one, makes the roads
  it used dearer to the search than they really are, and searches again; the
  penalty steers the search and never reaches the answer, so every route is
  reported at the graph's own cost. Candidates far worse than the best, or
  mostly along the same road, are rejected rather than offered, so fewer
  routes than asked for is the normal answer on a network with one obvious
  way through.

  Porto to Lisbon returned three routes — 312.0 km, 319.0 km and 350.5 km —
  in 3.4 s against 2.5 s for the single route, downloading 3.0 MB beyond the
  29.2 MB the first route needed. A short urban route returned two in 79 ms
  with nothing further to download.

- **A departure may name the time zone the roads are in.** `timeZone:
  "Europe/Lisbon"` reads the date there rather than wherever the code runs,
  which is what a restriction written in local time means. Built on `Intl`;
  nothing is bundled for it.

- **Weather, who is driving and what for can be answered.**
  `circumstances: { conditions: ["wet"], userGroups: ["resident"],
  purposes: ["delivery"] }` makes the rules resting on them apply.
  Unanswered they never hold, so the behaviour of anyone not passing them is
  unchanged. `unreadableConditions` now counts only what the parser genuinely
  cannot read, which is what its name always claimed.

- **Roads the caller knows are shut can be avoided.** `avoid: [{ lat, lng,
  radiusMeters }]` closes everything a circle touches, to the search and to
  snapping alike, for that call only. Roadworks and incidents happen after a
  bundle is compiled and cannot be in it; this is how a caller reading a feed
  of them says so.

- **`searchWiderCorridor: false`** keeps an alternatives search to the tiles
  one route needed, trading reach for about three megabytes on a long
  journey.

- **The compile report counts `conditionalTurnRestrictionsIgnored`.** A turn
  banned only at certain hours is still banned at every hour; the number now
  says how much of a region that costs. Across Portugal it is 1 relation in
  26,599.

### Fixed

- **A road is identified by its shape in order, not by a sum of its points.**
  Adding coordinates up does not care which point came first, so a road
  bending north then east and one bending east then north read as the same
  road and one of them would be dropped as a duplicate alternative.

- **A closure standing on the date line shuts the roads under it.** The
  projection it was tested against subtracted longitudes at face value, so a
  road a few metres away measured half a world off.

- **A rule table too wide for its index stops the compile.** It used to drop
  the surplus rows, which turned a restricted road into an unrestricted one
  with nothing said. A tile holds up to 65,536 distinct conditional values;
  past that the compile fails and names `--tile-size-km` as the way through.

- **Two roads joining the same pair of junctions are two roads.** Telling
  alternatives apart by their endpoints alone treated a slip road and the road
  beside it as one, hiding a genuine second way there. The Porto to Lisbon
  corridor holds 12,015 such pairs, none the same length as its twin, so the
  length now separates them while staying equal for the two directions of one
  road.

- **Each end of a route counts what it actually drives.** The distance driven
  on the part-roads a route begins and ends on was split evenly between the
  two, which misreports overlap whenever one end joins its road near the far
  junction. `RouteSnap.travelledMeters` now carries the real figure.

- **A month selector is read with the window it governs.**
  `no @ (Oct 22:00-06:00)` stopped at midnight on the thirty-first instead of
  running to six on the first of November. `TravelTime` may now carry
  `dayOfMonth`; without one the answer is unchanged, which is right on thirty
  days in thirty-one.

- **Alternative options are refused before anything is downloaded**, rather
  than after a remote bundle has been asked for tiles.

- **A window named with a day is read as one window.** `no @ (Fr 22:00-06:00)`
  was matched by asking "is it Friday?" and "is it between 22:00 and 06:00?"
  separately, which answered both ends of it backwards: it applied at two on
  Friday morning, before it began, and not at two on Saturday morning, while
  it was still in force. A span running past midnight now belongs to the day
  it starts on, which also fixes Sunday into Monday.

- **`24:30` is no longer a time.** It parsed as half past midnight, quietly
  moving a window onto the following day. Only `24:00` is the end of a day.

- **A conditional speed limit keeps its units.** `30 mph @ (…)` was read with
  `parseFloat` and became 30 km/h — two-thirds of the real limit, applied to
  the road as fact. It now uses the same parser as a plain `maxspeed`.

- **A rule table too wide for its index drops its surplus.** Past 65,535
  distinct values the extra rows were kept and left pointing at rule zero,
  applying one road's restriction to another.

- **Alternatives search the corridor that was downloaded for them.** The
  widening that fetches the tiles an alternative could lie in replaced the
  stitched graph, but the search was handed the graph from before it, so the
  tiles were downloaded and discarded. Asking for a single route no longer
  widens the corridor at all.

- **Alternatives come back in the order they would be driven**, by their real
  cost, rather than in the order the penalties happened to find them; and two
  routes are told apart by the road they travel rather than by which direction
  of it, so coming back along a road already offered is no longer a different
  way there.

- **A bundle compiled for one vehicle now carries its conditional
  restrictions.** They were stored in the per-vehicle chunk, which only exists
  when a bundle holds several vehicles or one whose routes depend on its size.
  A `--profile car` compile wrote the single-chunk layout instead, where
  nothing held them, so every road read as permanently open however carefully
  a route named its departure time. The restrictions now ride in that layout
  too, in a header byte no chunk written before them ever used.

  Found while comparing bundle sizes between releases: a car-only Portugal
  compiled byte for byte the same under 0.2.0 and 0.3.0, which it should not
  have, since 129 of its ways carry `access:conditional` and 85
  `motor_vehicle:conditional`. Compiled for motorcycle alone, Monaco now
  stores the Avenue Pasteur ban it used to drop, and a route across it travels
  183 m at midday and 3,081 m at 23:00 — the same answers the multi-vehicle
  bundle gives.

- **Points on a road the network cannot reach no longer report no route.** The
  road nearest a point is sometimes one nothing may legally enter: a pocket of
  one-way streets behind banned turns, or an island of service roads. A route
  to such a point failed outright, however much of the network lay between.

  It now finishes on a road a little further off, trying the nearest few in
  turn and taking the first that works, and `destinationSnap.distanceMeters`
  reports how far short it stopped. `finishOnANearbyRoad: false` restores the
  old behaviour of being told plainly that the point cannot be reached.

  Found on Évora, where `no_left_turn` and `no_right_turn` relations on Rua de
  Serpa Pinto seal the only entry to a street: Lisbon to a point there now
  routes 133.2 km, finishing 23 m away, and Braga to Évora routes 460.2 km
  where both previously failed. Lisbon airport, whose terminal roads are an
  island 527 m from the nearest road a car can reach, routes too.

### Added

- `edgesWithConditionalRestrictions` in the compile report, beside
  `edgesWithPhysicalLimits`, so a region's conditional data can be counted
  rather than assumed.

### Known limitations

- **Nothing changes without `departAt`.** Omitting it ignores conditional
  restrictions entirely, which is how the library behaved before.
- **Only closures are applied.** A road the plain tags already forbid stays
  forbidden where a conditional value would open it, which errs towards
  refusing a usable road rather than permitting a forbidden one.
- **One moment for the whole route**, rather than an arrival time per edge. A
  long route is judged by when it set out.
- **`restriction:conditional` on a turn restriction relation is still not
  read.** A morning-peak no-left-turn is enforced at every hour.
- **Conditions this library cannot answer are counted, not guessed.** Weather,
  user groups, the purpose of access and a stay duration are parsed, reported
  by `unreadableConditions`, and then left to one side with the road open.
- **`departAt` is the local time of the roads travelled.** No time-zone
  conversion is done and no clock is consulted.

Measured against the earlier releases on one machine: routing is as fast as
0.2.0 — Porto to Lisbon 2,252 ms cold and 206 ms repeated, against 2,252 and
208 — and the compiler is 1% slower back to back, 8 min 05 s against
8 min 01 s, for 0.17 GB more memory. The browser build grew from 21.1 kB
gzipped to 24.8 kB, and the published tarball from 75.9 kB to 91.0 kB.

Braga to Évora is the one journey that changed materially, and it changed
from failing to working: 0.2.0 spent 7.9 s widening its corridor before
reporting no route, where this release finishes in 2.3 s.

### Compatibility

A bundle whose roads carry no conditional restriction is byte for byte the
file 0.2.0 wrote, in both layouts: the new sections live in header bytes that
every version so far left as zero. Monaco for a car is 26,177 bytes from
either compiler. Every bundle published so far still opens and routes
identically.

A bundle that does carry conditional restrictions cannot be opened by 0.2.0
or earlier, which report a truncated chunk.

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

- **Conditional restrictions are not read in this release.**
  `access:conditional`, `restriction:conditional` and `hgv:conditional` are
  ignored, so a street closed to lorries overnight or a square pedestrianised
  on Sundays appears permanently open. It is the limitation most likely to
  make a route wrong rather than merely longer, particularly for a lorry, so
  it was scheduled ahead of alternative routes and is addressed under
  Unreleased above.
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
