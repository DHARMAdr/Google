# ClipCutter cloud server (optional)

A small server that renders your Shorts with real ffmpeg, so the phone does not have to.
One file (`server.js`), no libraries. Needs Node 18+ and ffmpeg.

## How it fits together
```
phone / site  --upload once-->  your server  --renders clips-->  you download them
                                      ^ deletes everything when you delete the video on the site
```

## Run it (pick ONE)

### A) Your own PC / VPS + Cloudflare Tunnel (easiest, free)
1. Install Node 18+ and ffmpeg.
2. `TOKEN=choose-a-long-secret node server.js`   (Windows: `set TOKEN=...` then `node server.js`)
3. In another window: `cloudflared tunnel --url http://localhost:8787`
   It prints an `https://something.trycloudflare.com` address. For a permanent address create a
   named tunnel on your Cloudflare account and route a hostname to `http://localhost:8787`.
4. On the site: **Cloud** button -> paste that https address and your token -> **Test connection**.

### B) Docker (any VPS)
`docker build -t clipcutter-server .` then
`docker run -d --restart unless-stopped -p 8787:8787 -e TOKEN=your-secret -v clipdata:/data clipcutter-server`
Put Cloudflare (proxy / tunnel) in front for https.

### C) Cloudflare Containers (paid Workers plan)
Use the Dockerfile above as the container image behind a Worker that forwards `/api/*` requests to it.
Mount or attach storage for `DATA_DIR` (container disk is wiped when it sleeps, so uploads would be lost:
use a persistent volume or keep it awake). Not tested by the author.

NOTE: a plain Cloudflare Worker cannot run ffmpeg. For STORAGE only on Cloudflare, see ../cloudflare-storage/README.md.

## Settings (environment variables)
| name | default | meaning |
|---|---|---|
| TOKEN | random (printed) | the secret the site must send. ALWAYS set your own |
| PORT | 8787 | port |
| DATA_DIR | ./data | where videos are kept |
| ALLOWED_ORIGINS | https://dharmadr.github.io,... | which sites may call the server (comma list, `*` = any) |
| MAX_GB | 4 | total space uploads may use |
| TTL_HOURS | 48 | videos untouched for this long are deleted (safety net) |
| FFMPEG / FONT | auto | paths if ffmpeg or the bold font are not found |
| USE_NVENC | 0 | set 1 to use an NVIDIA GPU (`h264_nvenc`) |

## Privacy and clean-up
- Nothing is uploaded unless you pick the Cloud engine (or turn on automatic upload).
- Deleting a video on the site deletes it here (source + all clips). If the server was unreachable, the
  site remembers and retries until it works. The "Delete everything on the server" button purges all.
- Anything untouched for TTL_HOURS is removed by the server itself.
- Use https only; the token is sent in an `Authorization` header and stored in the browser's localStorage.

## API (all need `Authorization: Bearer <TOKEN>` except health)
See the comment at the top of `server.js`.
