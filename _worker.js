/* Cloudflare Pages: this file makes a Pages deployment of web/ (Git-connected or uploaded) run the
 * small proxy the app needs for the sources that send no CORS headers, with no other setup:
 *   /tc?u=<url>   ensemble cyclone tracks (js/tracks.js) from NOMADS and Google DeepMind Weather
 *                 Lab, Hurricane Hunter messages (js/recon.js) from NHC's recon archive and Coral
 *                 Reef Watch SST (js/sst.js) from NOAA CoastWatch: only those prefixes, cached at
 *                 the edge for an hour (a published run or message never changes), directory
 *                 listings 1 min, misses 3 min. CORS is open, so a GitHub Pages copy can point its
 *                 tcProxy here ('https://<project>.pages.dev/tc?u=').
 *   /config.js    config.js with tcProxy set to '/tc?u='.
 *   everything else   the static files.
 * GitHub Pages ignores it. cloudflare/worker.js (the Worker deployment) uses the same proxy.
 */
export const TC_PREFIXES = ['https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/',
  'https://deepmind.google.com/science/weatherlab/download/cyclones/',
  'https://www.nhc.noaa.gov/archive/recon/',
  'https://coastwatch.pfeg.noaa.gov/erddap/griddap/NOAA_DHW.'];
export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };

/** /tc?u=<url>: one of the allowed files, edge-cached. */
export async function proxyTracks(url, request, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const u = url.searchParams.get('u') || '';
  if (!TC_PREFIXES.some((p) => u.startsWith(p)) || u.includes('..')) return new Response('not an allowed track source', { status: 403, headers: CORS });
  const cacheKey = new Request(`https://satview-cache/tc/${encodeURIComponent(u)}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return withCors(hit);
  let r;
  try {
    r = await fetch(u, { headers: { 'User-Agent': 'satellite-viewer (+https://github.com/GTG0116/satellite_viewer)', Accept: '*/*' } });
  } catch (e) {
    return new Response(`upstream fetch failed: ${e.message}`, { status: 502, headers: CORS });
  }
  const ok = r.status === 200, status = ok || r.status === 404 || r.status === 403 ? r.status : 502;
  const listing = u.endsWith('/') || u.includes('?');
  const resp = new Response(ok ? r.body : null, { status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'text/plain',
    'Cache-Control': `public, max-age=${ok ? (listing ? 60 : 3600) : 180}`, ...CORS } });
  if (status !== 502) ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
  return resp;
}

export function withCors(r) {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/tc') return proxyTracks(url, request, ctx);
    if (url.pathname === '/config.js') {
      // the deployed config.js, with the proxy switched on
      const r = await env.ASSETS.fetch(request);
      const js = `${r.ok ? await r.text() : 'window.SATVIEW_CONFIG = {};'}\nwindow.SATVIEW_CONFIG.tcProxy = window.SATVIEW_CONFIG.tcProxy || '/tc?u=';\n`;
      return new Response(js, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' } });
    }
    return env.ASSETS.fetch(request);
  },
};
