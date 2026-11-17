# ClipCutter storage on Cloudflare (Worker + R2)

Keeps your uploaded videos in a Cloudflare R2 bucket **temporarily** and deletes them
(when you delete the video on the site, or automatically after 48 hours).
It stores only - it cannot render (a Worker has no ffmpeg). Rendering stays on your phone.

## One-time setup (about 10 minutes, on a PC)
1. Install Node 18+ and run `npm i -g wrangler`, then `wrangler login` (opens Cloudflare in the browser).
2. R2 needs to be enabled once: Cloudflare dashboard -> R2 -> enable (a payment card may be asked; the free tier is 10 GB).
3. In this folder run:
   - `wrangler r2 bucket create clipcutter-storage`
   - `wrangler secret put TOKEN`   (type a long secret password, keep it)
   - `wrangler deploy`
4. Wrangler prints an address like `https://clipcutter-storage.YOURNAME.workers.dev`.
5. On the site: **Cloud** button -> paste that address and the token -> Save -> Test connection.
   It must say "ClipCutter server ... storage only".

## Settings (wrangler.toml)
- `ALLOWED_ORIGINS` - which sites may use it (default your GitHub Pages site)
- `TTL_HOURS` - auto-delete after this many hours (default 48; checked every hour)
- `MAX_GB` - total limit (default 8)

## Notes
- Do NOT use your MangaFlow Worker address; this is a separate Worker.
- Costs: R2 free tier covers 10 GB; there are no download fees (egress is free).
