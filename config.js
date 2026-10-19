/* Deployment settings (edit freely, no build step).
 *
 * s3Proxy: leave empty to read the NOAA buckets directly (they allow browser CORS + Range).
 *          On Cloudflare, set it to '/s3' to go through the bundled Worker, which adds edge
 *          caching of the immutable data files (see cloudflare/worker.js).
 */
window.SATVIEW_CONFIG = {
  s3Proxy: '',
};
