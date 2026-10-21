# Historical bundles

Each of these was compiled by the release named in its filename, from that
release's own source — not by the current compiler. They exist so that a claim
about reading older bundles is measured against the version that wrote them
rather than against a re-encode.

They were produced by checking out the version's commit, installing and
building it, and running its own `scripts/roadgraph-compile.mjs` over
`monaco.osm.pbf`:

| file | written by | commit |
| --- | --- | --- |
| `monaco-v0.1.0-car.efrb` | 0.1.0 | `b4b054a` |
| `monaco-v0.2.0-car.efrb` | 0.2.0 | `a282159` |
| `monaco-v0.2.0-car-truck.efrb` | 0.2.0 | `a282159` |
| `monaco-v0.3.0-car.efrb` | 0.3.0 | `683a3a1` |
| `monaco-v0.3.0-car-truck.efrb` | 0.3.0 | `683a3a1` |

`src/historical-bundles.test.ts` reads them. Monaco is used because a whole
country fits in 26 kB.
