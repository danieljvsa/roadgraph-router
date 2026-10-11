# @danieljvsa/roadgraph-router

Browser-safe routing primitives for pre-built directed road graphs. The package calculates car routes locally with A*.

It deliberately does not download OpenStreetMap data or call a directions service. Graph creation belongs to a separate Node-only importer.

## Usage

```ts
import { RoadRouter } from "@danieljvsa/roadgraph-router";

const router = await RoadRouter.open("/routing/manifest.json");
const result = await router.route(
  { lat: 37.0194, lng: -7.9304 },
  { lat: 37.1023, lng: -8.6731 },
);
```

`RoadRouter.open()` also accepts an already-decoded `RoadGraph`, which is useful
for embedded or application-managed graph data.

## Graph formats

The package reads the original EFRT v1 format and the compact EFR2 v2 format.
EFR2 stores latitude/longitude as fixed-point `Int32` values and edge weights as
scaled `Uint16` values. Use `compactGraph()` and `encodeCompactGraph()` when
producing v2 data. Existing `encodeGraph()` output remains supported.

For fast snapping, add a local index after loading a graph:

```ts
import { withSpatialIndex } from "@danieljvsa/roadgraph-router";

const indexedGraph = withSpatialIndex(graph);
```

The spatial index is built locally after a chunk has been loaded, avoiding a
full graph scan when snapping a coordinate to the road network.

## Range-addressable bundles

`encodeRoadGraphBundle()` creates a single `.efrb` file with a fixed-size
directory followed by independently readable EFR2 tile chunks. Opening an
`.efrb` URL downloads its 32-byte header and directory first, then requests
only the route-relevant tile byte ranges:

```ts
const router = await RoadRouter.open("/routing/portugal.efrb");
```

Serve bundles as `application/octet-stream` without whole-file HTTP content
encoding so byte offsets remain stable. The bundle reader already supports
individually gzip-compressed chunks; use
`encodeCompressedRoadGraphBundle()` when creating one in a browser-compatible
runtime. Spatial indexes are runtime structures for now, rather than part of
the on-disk format.

## Benchmark a bundle

Use exact or near-road coordinates to measure a representative route without
downloading the whole file. The runner reports bundle size, loaded nodes and
edges, Range bytes, memory delta, graph-load timing, and A* timing:

```sh
npm run benchmark -- path/to/portugal.efrb \
  --origin 37.0194,-7.9304 \
  --destination 37.0340,-7.8900
```
