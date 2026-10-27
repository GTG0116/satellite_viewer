/* Deployment settings (edit freely, no build step).
 *
 * s3Proxy: leave empty to read the NOAA buckets directly (they allow browser CORS + Range).
 *          On Cloudflare, set it to '/s3' to go through the bundled Worker, which adds edge
 *          caching of the immutable data files (see cloudflare/worker.js).
 * tcProxy: URL prefix for the model cyclone tracks of GEFS, GEPS, FNV3 and WNV3 (NOMADS and
 *          Google DeepMind Weather Lab send no CORS headers) and the Hurricane Hunter recon data
 *          (NHC's archive, no CORS either); the encoded file URL is appended.
 *          A Cloudflare deployment of this folder serves '/tc?u=' and switches this on by itself
 *          (_worker.js, run by the Worker through wrangler.jsonc or by Pages), as do
 *          cloudflare/worker.js and tools/serve.py. Its CORS is open, so the GitHub Pages copy
 *          uses the Cloudflare Worker's. Empty: only ECMWF tracks and no recon data.
 */
const TC_WORKER = 'https://satelliteviewer.gtg0116scratch.workers.dev/tc?u=';
window.SATVIEW_CONFIG = {
  s3Proxy: '',
  tcProxy: location.hostname.endsWith('github.io') ? TC_WORKER : '',
};
