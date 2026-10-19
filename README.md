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
  native resolution inside the box; ground imagery is Esri World Imagery. With a VR headset the
  3D view can be entered in VR (see below).

Satellites: GOES-19 / GOES-18 (live), GOES-16 / GOES-17 (archive), Himawari-9 (live),
Himawari-8 (archive), GK2A (live, archive from Feb 2023). All 16 bands, 12 RGB composites (11 on
GK2A, which has no 2.2 µm band for Fire Temperature), loops, archive back to 2015, custom boxes,
pixel probe. VIIRS / ATMS polar products are not part of the web edition.

**GK2A** (GEO-KOMPSAT-2A, 128.2°E) is read from `noaa-gk2a-pds`: one AMI L1B NetCDF-4 file per band
(`AMI/L1B/FD` full disk every 10 min, `AMI/L1B/LA` the 1000 km Local Area over Korea every 2 min) with
1375² deflate chunks, so a custom box downloads only the chunks it touches. Counts carry a 2-bit
quality flag; IR bands are calibrated radiance → effective temperature at the channel's central
wavenumber → brightness temperature (the file's Teff→Tbb coefficients), visible bands to albedo.
Bands are named as KMA does (VI004 … IR133). Visible composites of the full disk need every 0.5–1 km
chunk (≈ 600 MB a frame), too heavy below High: GK2A then opens on Air Mass (Medium) or IR105 (Low).
The Local Area and custom boxes are light.

## VR

The 3D cloud volume has a VR button (goggles) when the browser supports WebXR `immersive-vr` (Quest
Browser, or Chrome / Edge on a PC with a SteamVR / Oculus Link headset; the page must be served over
HTTPS or from localhost). You start where the 3D camera was, at true size. Each eye is ray-marched
separately at a resolution that adapts to the headset's frame rate.

| Control | Does |
|---|---|
| Left stick | Fly over the ground toward where you look (faster higher up) |
| Right stick ↕ | Elevation: fly up / down |
| Right stick ↔ | Turn in 30° steps |
| Grip + right stick ↕ | Cloud *Height* (the 3D view's vertical exaggeration, 1–6×) |
| Trigger | Fly faster (up to 5×) |
| A / X, B / Y | Grow (see the area as a model, ×10 per press) / back toward true size |
| Right stick click | Play / pause the loop (when the 3D view shows a loop) |

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

A quality tier (Low / Medium / High) is picked from the device (memory, CPU cores, the GPU, GPU
limits, Save-Data) and can be changed under *Settings*. High needs a dedicated graphics card; laptops
with integrated graphics (Intel UHD / Iris, AMD APUs, Chromebooks) get Medium, or Low with ≤ 4 GB or
≤ 4 threads. It sets:

| | Low | Medium | High |
|---|---|---|---|
| Decoded frames kept | 96 MB | 256 MB | 1 GB |
| Pixels per frame | 1.6 M | 4 M | 24 M |
| Max download per frame | 40 MB | 120 MB | 900 MB |
| Default loop | 6 frames | 10 | 24 |
| Decode / tile / map workers | 2 / 1 / 1 | 3 / 2 / 2 | 5 / 3 / 2 |
| Map tiles | 256 px, 1× pixel ratio | 512 px, ≤1.25× | 512 px, ≤2× |
| Base map | no relief layer, no atmosphere glow | full | full |

With *Quality: Auto* the tier also adapts while the viewer runs:

- If the map keeps rendering under ~18 fps while it moves or plays, it switches to 1× pixels, drops the
  relief layer and atmosphere glow, and the next visit starts one tier lower (shown under *Settings*).
- If the browser runs out of memory decoding a frame, the page reloads one tier lower (on Low, the
  loop is halved instead). Choosing *Auto* again re-tests the device.

Other things that keep it light:

- Frames are stored as 16-bit codes (or RGBA for composites) at a resolution fitted to the tier and the
  loop length. Each product shows its download size per frame; ones too heavy for the tier are dimmed.
- GOES uses the 2 km multi-band L2 MCMIP files by default (one file, only the needed bands are
  read). *Settings → GOES data → Native* switches to the L1b radiances (0.5–2 km).
- Only one frame's tiles are drawn, however long the loop: the next frame loads into a hidden layer,
  is swapped in (or cross-faded) when ready, and the previous one is then removed.
- Each map tile's pixel lookup into the satellite grid is computed once per grid and reused by every
  loop frame on that grid, so playback only copies pixels (~10× faster tiles).
- The 3D volume lowers its resolution while the camera moves until it keeps up (~22 fps).
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
  js/vr3d.js         WebXR (VR headset) mode of the 3D view
  js/scenes.js       which files / chunks / segments a frame needs
  js/listing.js      S3 listings -> complete scans
  js/catalog.js      satellites, bands, products, colour tables
  js/geo.js          geostationary navigation, sun position
  js/perf.js         device tiers
  js/pool.js         decode worker pool
  js/tiles/          tile workers + router (satv:// and satdem:// protocols)
  js/decode/         HDF5, inflate, bzip2, HSD, composites, cloud retrieval, worker (GOES / AHI / AMI readers)
  vendor/            MapLibre GL JS 6.12.0, three.js 0.160.0
cloudflare/          Worker + wrangler.toml
tools/serve.py       local preview server
```
