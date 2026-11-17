# ClipCutter storage server on Cloudflare (Worker + R2) - with profiles

What it gives you
- A **new, separate** server (not your old Cloudflare Worker) that keeps your uploaded videos AND your finished Shorts.
- **Profiles**: each person has a username + 6-digit code. Everyone sees only their own files.
- An **ADMIN ("parent") profile** that can see every profile: videos, Shorts, sizes, last seen; download/delete their files, reset a code, delete a profile.
- Data stays on the server until you delete it (set `TTL_HOURS` to auto-delete after N hours).
- It only STORES. Rendering still happens on your phone (a Worker cannot run ffmpeg).

## A) Set it up from a phone or PC browser only (no commands)
Use a brand-new Cloudflare account if you do not want to touch the old one (free, any email).
1. Go to https://dash.cloudflare.com and sign up / log in.
2. **R2 Object Storage** -> *Create bucket* -> name `clipcutter-storage` (R2 asks for a payment card to switch on; the free tier is 10 GB and has no download fees).
3. **Workers & Pages** -> *Create* -> *Create Worker* -> name `clipcutter-storage` -> *Deploy* -> then *Edit code*.
   Delete the sample code, paste the **whole content of `worker.js`** (this folder), press *Deploy*.
4. Open the Worker -> **Settings** -> **Bindings** -> *Add* -> **R2 bucket** -> Variable name `BUCKET`, bucket `clipcutter-storage` -> Save.
5. **Settings** -> **Variables and Secrets** -> add:
   - Secret `TOKEN` = a long secret of your own. This is the **owner key** (needed once, to create the admin profile). Keep it private.
   - Text `ALLOWED_ORIGINS` = `https://dharmadr.github.io`
   - Text `OPEN_SIGNUP` = `true` (anyone with the address can make a normal profile) or `false` (only the owner key can create profiles)
   - Text `MAX_GB` = `8`   - Text `TTL_HOURS` = `0` (0 = keep until deleted)
6. **Settings** -> **Trigger Events** -> *Cron Triggers* -> add `0 * * * *` (hourly clean-up of unfinished uploads).
7. Copy the Worker address (looks like `https://clipcutter-storage.yourname.workers.dev`).

## B) First use on the site
1. Open the site -> **Profile**.
2. Type the server address, a username (for example `dad`), a 6-digit code. Open *Creating the ADMIN profile?* and type the owner key (the `TOKEN`). Press **Create profile**. This is your admin ("parent") profile.
3. Other people: Profile -> same server address -> their own username + code -> **Create profile** (no key). The admin sees them under *All profiles*.
4. From now on every video you add is uploaded automatically and every finished Short is kept on the server.
5. **Log out** (Profile -> Log out) forgets the server on that device and clears the page's local copy; your files stay on the server. Next time type the server address and log in again.

## Safety notes (honest)
- A 6-digit code is easy to guess in theory. The server stores only a salted hash, locks a profile for 10 minutes after 5 wrong tries, and sessions last 30 days. Keep `OPEN_SIGNUP` = `false` if you do not want strangers to sign up.
- Anyone who has the owner key is an admin. Never share it.
- R2 free tier: 10 GB stored, no download fees. Check Cloudflare's pricing page for current limits.

## C) Command-line alternative
`npm i -g wrangler` -> `wrangler login` -> `wrangler r2 bucket create clipcutter-storage` -> `wrangler secret put TOKEN` -> `wrangler deploy` (settings are in `wrangler.toml`).
