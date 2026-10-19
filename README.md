# Satellite Viewer — web edition

The live GOES / Himawari viewer as a static site: no server, no build step, no API keys.
Everything the Python back end did is done in the browser:

- **Custom decoders** (`js/decode/`): a small HDF5 / NetCDF-4 reader (superblock v0–3, v1/v2 object
  headers, fractal heaps, v1/v2 B-trees, deflate + shuffle), a bzip2 decompressor and a Himawari HSD
  parser. Files are read straight from the NOAA Open Data buckets with HTTP range requests, so only
  the metadata and the HDF5 chunks a frame needs are downloaded.
- **Map**: [MapLibre GL JS](https://maplibre.org) 6.12 (vendored) on the free
  [OpenFreeMap](https://openfreemap.org) vector tiles: globe or flat map, dark / light / satellite base
  maps, day / night terminator, labels and borders above the imagery.
- **Imagery** stays in its native geostationary pixel grid. Tile workers render map tiles on demand
  through a `satv://` protocol, taking the single nearest satellite pixel for every map pixel (no
  smoothing), and hand them to MapLibre as `ImageBitmap`s (no PNG encoding).
- **3D on the map**: cloud-top relief (MapLibre terrain from worker-generated height tiles) and real
  mountains (AWS Terrain Tiles).
- **3D cloud volume**: the original three.js volumetric renderer. The cloud retrieval
  (`js/decode/retrieve3d.js`, a port of `backend/render3d.py`) runs in a worker on 5 bands read at
  native resolution inside the box; ground imagery is Esri World Imagery.

Satellites: GOES-19 / GOES-18 (live), GOES-16 / GOES-17 (archive), Himawari-9 (live),
Himawari-8 (archive). All 16 bands, 12 RGB composites, loops, archive back to 2015, custom boxes,
pixel probe. VIIRS / ATMS polar products are not part of the web edition.

## Run locally

```bash
python tools/serve.py
```

Then open http://127.0.0.1:8700. Any static file server works; `tools/serve.py` only turns caching off.

## Deploy

**GitHub Pages**: push the repository to GitHub, then in *Settings → Pages* pick *Source: GitHub
Actions*. `.github/workflows/pages.yml` publishes `web/` on every push to `main`. The NOAA buckets
allow browser CORS and range requests, so nothing else is needed.

**Cloudflare** (Worker with static assets + edge cache):

```bash
cd cloudflare
npx wrangler deploy
```

`cloudflare/worker.js` serves `web/` and proxies `/s3/<bucket>/<key>` to the NOAA buckets, caching every
byte range at the edge for a day (data files never change), so repeat visits and replayed loops come
from the nearest Cloudflare data centre. It also serves a `config.js` that switches the app to the proxy.
To use Cloudflare Pages instead, upload `web/` as is (it has a `_headers` file); it then reads NOAA
directly, as on GitHub Pages.

## Low-end devices

A quality tier (Low / Medium / High) is picked from the device (memory, CPU cores, GPU limits,
Save-Data) and can be changed under *Settings*. It sets:

| | Low | Medium | High |
|---|---|---|---|
| Decoded frames kept | 96 MB | 320 MB | 1 GB |
| Pixels per frame | 1.6 M | 6 M | 24 M |
| Max download per frame | 40 MB | 150 MB | 900 MB |
| Default loop | 6 frames | 12 | 24 |
| Decode / tile / map workers | 2 / 1 / 1 | 3 / 2 / 2 | 5 / 3 / 2 |
| Map tiles | 256 px, 1× pixel ratio | 512 px, ≤1.5× | 512 px, ≤2× |

Other things that keep it light:

- Frames are stored as 16-bit codes (or RGBA for composites) at a resolution fitted to the tier and the
  loop length. Each product shows its download size per frame; ones too heavy for the tier are dimmed.
- GOES uses the 2 km multi-band L2 MCMIP files by default (one file, only the needed bands are
  read). *Settings → GOES data → Native* switches to the L1b radiances (0.5–2 km).
- Only two frames' tiles are on the GPU at any time, however long the loop: the next frame loads
  into a hidden layer and is swapped in (or cross-faded) when ready.
- Native browser `DecompressionStream` for deflate, with a JavaScript fallback; composites compute
  sun geometry on a coarse lattice and use lookup tables.
- No blur effects on the Low tier; the map, workers and service worker cache only what they need.

## Layout

```
web/
  index.html  css/app.css  config.js  sw.js  manifest.webmanifest
  js/app.js          UI, state, loading, playback, archive
  js/map.js          MapLibre map, ping-pong frame layers, terrain, night
  js/volume.js       3D volume tools on the map
  js/render3d.js     three.js volumetric renderer
  js/scenes.js       which files / chunks / segments a frame needs
  js/listing.js      S3 listings -> complete scans
  js/catalog.js      satellites, bands, products, colour tables
  js/geo.js          geostationary navigation, sun position
  js/perf.js         device tiers
  js/pool.js         decode worker pool
  js/tiles/          tile workers + router (satv:// and satdem:// protocols)
  js/decode/         HDF5, inflate, bzip2, HSD, composites, cloud retrieval, worker
  vendor/            MapLibre GL JS 6.12.0, three.js 0.160.0
cloudflare/          Worker + wrangler.toml
tools/serve.py       local preview server
```
