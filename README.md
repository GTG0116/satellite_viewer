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
  through a `satv://` protocol, taking the single nearest satellite pixel for every map pixel, and
  hand them to MapLibre as `ImageBitmap`s (no PNG encoding). *Display → Smooth imagery* blends the
  2 × 2 pixels around each map pixel instead (bilinear; band codes are linear in the value, RGBs per
  channel, the nearest kept next to no-data) and lets MapLibre scale tiles linearly.
- **3D on the map**: cloud-top relief (MapLibre terrain from worker-generated height tiles) and real
  mountains (AWS Terrain Tiles).
- **3D cloud volume**: the original three.js volumetric renderer. The cloud retrieval
  (`js/decode/retrieve3d.js`, a port of `backend/render3d.py`) runs in a worker on 5 bands read at
  native resolution inside the box (VIIRS I5 + I1 for polar slices); ground imagery is Esri World
  Imagery. With a VR headset the 3D view can be entered in VR (see below).

Satellites: GOES-19 / GOES-18 (live), Himawari-9 (live), GK2A (live, archive from Feb 2023),
NOAA-20 / NOAA-21 / Suomi NPP (polar orbiters, live and archive), and the retired GOES-16 / GOES-17 /
Himawari-8, which are listed in Archive mode only (going Live from one switches to its successor).
All 16 bands, 12 RGB composites (11 on GK2A, which has no 2.2 µm band for Fire Temperature), loops,
archive back to 2015, custom boxes, pixel probe.

**Polar orbiters** (`js/polar.js`, `js/decode/swath.js`): VIIRS I1–I5, M1–M16, the Day/Night Band,
True Color (M5 / M4 / M3) and Natural Color (I3 / I2 / I1) from the SDR granules, and all 22 ATMS
channels, rain rate and precipitable water from the MiRS IMG files (`noaa-nesdis-{n20,n21,snpp}-pds`).
Each frame is a *slice*: the granules that started in one 2 / 5 / 10 / 20 minute window (the *sector*
buttons), i.e. the strip the satellite scanned then. Day folders are listed from the window's hour
(`start-after`), so a listing is a few hundred names, not a day's thousands. In the decode workers
each granule's geolocation is read (750 m GMTCO; older I-band granules fall back to the 375 m GITCO;
the DNB has its own), every granule's bands are resampled in parallel onto a Lambert azimuthal
equal-area grid centred on the slice and turned to follow the ground track: each swath pixel claims
the cells within its footprint that no nearer pixel has claimed, so every cell holds its nearest swath
pixel (I-band pixel centres are placed inside each 16-line scan from the 750 m geolocation; bow-tie
deleted pixels never claim cells, the overlapping scan fills them). The parts are merged, the DNB gets
its contrast from the slice (2nd–99.7th percentile of log radiance), and the result is an ordinary
frame: tiles, smoothing, colour tables, probe, legend and loops work as for geostationary data, and
the slice's ground track is drawn as its outline. Cells are native size (375 m / 750 m, ATMS 4 km)
unless the tier's frame budget needs them coarser. A slice is 20–110 MB of downloads, so polar loops
are capped at 3 / 6 / 12 frames (Low / Medium / High). Visible bands are empty on the night side.
The 3D cloud volume works on polar slices too, whatever product the map shows: the slice's granules
are picked by their outlines (the G-Ring in each geolocation file's metadata, a few hundred kB), only
those crossing the box are read (I5 10.8 µm for the cloud tops, I1 0.64 µm for the optical depth by
day), and they are resampled the same way onto an equal-area grid over the box (375 m, coarser for
large boxes). SDR reflectance is already divided by the sun's cosine, and VIIRS looks down from
~830 km, so there is no geostationary parallax correction. A box the slice does not reach says so;
in the 3D loop, slices that miss the box are left out.

**Overlays** (*Display*): **GLM lightning**, the flashes of the GOES-East and GOES-West Geostationary
Lightning Mappers in the 1–15 minutes before the shown frame (`js/glm.js`: the 20 s L2 LCFA files,
each decoded once in a worker; GOES-16 / -17 before GOES-19 / -18 took over), coloured by age and
sized by energy; and **tropical cyclones** from NHC (Atlantic, East / Central Pacific: NOAA's tropical
map service) and JTWC (West Pacific, Indian Ocean, Southern Hemisphere: its warning feed and track
files): position, past and forecast track, NHC's cone, intensity colours, a storm list that flies to
each (`js/overlays.js`). All of these sources allow browser requests, so the overlays work on GitHub
Pages too. Cyclones are current storms, shown in Live mode.

**Model tracks** (*Display → Model tracks (ensembles)*, `js/tracks.js`, the same file as the desktop
edition's): every member of the ECMWF ENS (51), ECMWF AIFS ENS (52), GEFS (31), GEPS (21), FNV3 (50)
and WNV3 (60–64) ensembles, with the mean and / or median, lines and points coloured by model, wind or pressure, a run
picker (Latest, or a run of the last 3 days) and a *Through* slider that stops every track at that
forecast hour. *Intensity charts* opens a window (`js/tchart.js`, full screen on phones) with the
maximum wind (category thresholds marked), the intensity distribution of one ensemble and the minimum
pressure of a storm, for any number of ensembles, each with members / mean / median / 10–90 % spread
switchable, and a hover readout. ECMWF's track files (BUFR, decoded here) comes from data.ecmwf.int / its AWS mirror, which
allow browser requests. GEFS / GEPS (NCEP's ensemble tracker on NOMADS) and FNV3 / WNV3 (Google DeepMind
Weather Lab) do not, so they go through a small proxy set as `tcProxy` in `config.js`: the Cloudflare
Worker's `/tc` (and `tools/serve.py`'s) fetch only from those two hosts and cache an hour. Without a
proxy (plain GitHub Pages) only ECMWF is available, unless `tcProxy` points at a deployed Worker
(`'https://<your-worker>/tc?u='`; its CORS is open).

**GK2A** (GEO-KOMPSAT-2A, 128.2°E) is read from `noaa-gk2a-pds`: one AMI L1B NetCDF-4 file per band
(`AMI/L1B/FD` full disk every 10 min, `AMI/L1B/LA` the 1000 km Local Area over Korea every 2 min) with
1375² deflate chunks, so a custom box downloads only the chunks it touches. Counts carry a 2-bit
quality flag; IR bands are calibrated radiance → effective temperature at the channel's central
wavenumber → brightness temperature (the file's Teff→Tbb coefficients), visible bands to albedo.
Bands are named as KMA does (VI004 … IR133). Visible composites of the full disk need every 0.5–1 km
chunk (≈ 600 MB a frame), too heavy below High: GK2A then opens on Air Mass (Medium) or IR105 (Low).
The Local Area and custom boxes are light.

## Settings

Everything you set is kept in `localStorage` and restored on the next visit: satellite, sector,
product, the colour table of each product, the Data / Display / 3D / Settings tab, the product-group
filter (All, RGB, Visible, Infrared, Water Vapor), the folded side panel, every map and loop option,
the quality tier, the archive window, the camera and every 3D-view option. A `#sat=…` link still
takes precedence. The Clean IR colour table and the legend's brightness temperatures are in °C.

## VR

The 3D cloud volume has a VR button (goggles) when the browser supports WebXR `immersive-vr` (Quest
Browser, or Chrome / Edge on a PC with a SteamVR / Oculus Link headset; the page must be served over
HTTPS or from localhost). You start where the 3D camera was, at true size. Each eye is ray-marched
separately at a resolution that adapts to the headset's frame rate.

For the sharpest view, connect the headset to a PC (Meta Link cable or Air Link, Virtual Desktop, or
SteamVR) and open the page in Chrome / Edge on the PC: the desktop GPU renders the clouds at up to the
headset's full resolution, with more ray-march steps and no foveation. The render resolution is the
one set in the Link app (or SteamVR); 72 Hz leaves the most time per frame. In the Quest Browser on
its own the clouds are rendered coarser for the headset's mobile GPU.

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

Then open http://127.0.0.1:8700. Any static file server works; `tools/serve.py` turns caching off and
adds the `/tc` proxy for the GEFS / GEPS / FNV3 / WNV3 model tracks.

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
from the nearest Cloudflare data centre. It also proxies the model-track files of NOMADS and Weather
Lab (`/tc`, see *Model tracks*) and serves a `config.js` that switches the app to both proxies.
To use Cloudflare Pages instead, upload `web/` as is (it has a `_headers` file); it then reads NOAA
directly, as on GitHub Pages.

## Low-end devices

A quality tier (Low / Medium / High) is picked from the device (memory, CPU cores, the GPU, GPU
limits, Save-Data) and can be changed under *Settings*. High needs a dedicated graphics card; laptops
with integrated graphics (Intel UHD / Iris, AMD APUs, Chromebooks) and high-end phones get Medium;
phones and laptops with ≤ 4 GB or ≤ 4 threads get Low. Each tier's memory is sized so that its
default view runs at the sector's full resolution:

| | Low (phones, low-end laptops) | Medium (high-end phones, laptops) | High (desktops, gaming laptops) |
|---|---|---|---|
| Decoded frames kept | 176 MB | 600 MB | 1.5 GB |
| Pixels per frame | 4.2 M | 8.5 M | 30 M |
| Default view (CONUS GeoColor) | 2 km, 6 frames | 2 km, 10 frames | 2 km, 24 frames |
| Full disk | 6 km | 4 km | 4 km (24 frames), native 2 km (≤ 6) |
| Max download per frame | 40 MB | 150 MB | 900 MB |
| Decode / tile / map workers | 2 / 1 / 1 | 3 / 2 / 2 | 5 / 3 / 2 |
| Map tiles | 256 px; pixel ratio 1 (phones 1.5) | 512 px; ≤ 1.5 (phones 2) | 512 px; ≤ 2 |
| Base map | no relief layer, no atmosphere glow | full | full |

Longer loops than the default share the same memory, so each frame then gets fewer pixels.

With *Quality: Auto* the tier also adapts while the viewer runs:

- If the map keeps rendering under ~18 fps while it moves or plays, it switches to 1× pixels, drops the
  relief layer and atmosphere glow, and the next visit starts one tier lower (shown under *Settings*).
- If the browser runs out of memory decoding a frame, the page reloads one tier lower (on Low, the
  loop is halved instead). Choosing *Auto* again re-tests the device.

Other things that keep it fast and light:

- `js/boot.js` runs before MapLibre (1 MB) has loaded: it starts the decode workers, lists the
  bucket and starts downloading the newest frame of the saved view, so the data and the map load
  side by side. All modules are `modulepreload`ed (one round trip, not one per import level).
- During playback the frame after the shown one loads its tiles in a hidden layer (opacity 0:
  MapLibre loads its tiles but does not draw it), so each step is an instant swap.
- All frames on the same grid share one tile worker, so a loop navigates each map tile and
  resamples its city lights once. The Black Marble city-light tiles are kept in Cache Storage
  (NASA serves them uncacheable).
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
  js/boot.js         settings, device tier, decode workers, first frame (runs before the map loads)
  js/app.js          UI, state, loading, playback, archive
  js/map.js          MapLibre map, ping-pong frame layers, terrain, night
  js/volume.js       3D volume tools on the map
  js/polar.js        polar orbiters: slice listings (VIIRS SDR, MiRS ATMS), slice grids, loading
  js/glm.js          GLM lightning: file listings and flashes before a time
  js/overlays.js     lightning + cyclone layers, NHC / JTWC fetching and parsing (shared with frontend/)
  js/tracks.js       ensemble model tracks: sources, ECMWF BUFR decoder, mean / median, layers, panel (shared)
  js/tchart.js       ensemble intensity charts: wind, intensity distribution, pressure (shared)
  js/render3d.js     three.js volumetric renderer
  js/vr3d.js         WebXR (VR headset) mode of the 3D view
  js/scenes.js       which files / chunks / segments a frame needs
  js/listing.js      S3 listings -> complete scans
  js/catalog.js      satellites, bands, products, colour tables
  js/geo.js          geostationary navigation, sun position
  js/perf.js         device tiers
  js/pool.js         decode worker pool
  js/tiles/          tile workers + router (satv:// and satdem:// protocols)
  js/decode/         HDF5, inflate, bzip2, HSD, composites, cloud retrieval, worker (GOES / AHI / AMI readers),
                     swath.js (VIIRS / ATMS swaths onto the slice grid)
  vendor/            MapLibre GL JS 6.12.0, three.js 0.160.0
cloudflare/          Worker + wrangler.toml
tools/serve.py       local preview server
```
