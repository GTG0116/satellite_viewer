/* Deployment settings (edit freely, no build step).
 *
 * s3Proxy: leave empty to read the NOAA buckets directly (they allow browser CORS + Range).
 *          On Cloudflare, set it to '/s3' to go through the bundled Worker, which adds edge
 *          caching of the immutable data files (see cloudflare/worker.js).
 * tcProxy: URL prefix for the model cyclone tracks of GEFS, GEPS, FNV3 and WNV3 (NOMADS and
 *          Google DeepMind Weather Lab send no CORS headers) and the Hurricane Hunter recon data
 *          (NHC's archive, no CORS either); the encoded file URL is appended.
 *          The Cloudflare Worker serves '/tc?u=' (CORS open, so a GitHub Pages copy can use
 *          'https://<your-worker>/tc?u='), as does tools/serve.py, and a Cloudflare Pages
 *          deployment of this folder (its _worker.js switches this on there by itself). On GitHub
 *          Pages set it to 'https://<project>.pages.dev/tc?u='. Empty: only ECMWF tracks and no
 *          recon data.
 */
window.SATVIEW_CONFIG = {
  s3Proxy: '',
  tcProxy: '',
};
