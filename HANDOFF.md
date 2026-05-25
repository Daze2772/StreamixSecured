# Streamix — Project Handoff

> Last updated: 2026-05-25 by the agent that built the Real-Debrid HLS pipeline.
> If you're a new agent picking this up on a different account, **read this whole file before touching code.** It will save you hours.

---

## 1. What this app is

Streamix is a **Next.js 14** movie/TV streaming UI built on top of:

- **TMDB** for metadata + posters + catalog
- A **multi-server iframe-embed fallback chain** for free/ad-supported playback (VidLink, VidSrc, Embed.su, MultiEmbed, 2embed, plus a YouTube trailer "Demo" server)
- A **Real-Debrid (RD) Premium** path that scrapes torrents via the **Comet** Stremio addon, unrestricts via RD, and serves the result as **HLS** transcoded on-the-fly by **ffmpeg** running inside the Next.js server
- A secondary **AllDebrid (AD) Premium** path that does the same client-side (lib/alldebrid-client.js)

The HLS transcoding is the most novel part of the stack and is also the part most likely to confuse the next agent. Section 4 explains it.

---

## 2. File map (the parts that matter)

```
/app/
├── .env                            # all secrets/config — committed (see §3)
├── app/
│   ├── page.js                     # homepage (trending, by-genre, search)
│   ├── watch/[type]/[id]/page.js   # the watch page (movie & TV)
│   ├── embed/                      # iframe-embed shells for free servers
│   └── api/
│       ├── realdebrid/resolve/route.js   # ★ scrapes + ranks + probes + creates HLS session
│       ├── alldebrid/resolve/route.js    # AD path (client-side, mostly unused)
│       ├── stream/
│       │   ├── hls/[...path]/route.js    # ★ HLS playlist + segment server
│       │   └── proxy/route.js            # legacy direct-MP4 proxy (kept but unused)
│       └── [[...path]]/route.js          # catch-all (404 fallback for /api/*)
├── components/
│   └── streamix/
│       ├── VideoPlayer.js          # main player container (servers, premium state, alternates)
│       ├── HlsVideo.js             # ★ hls.js wrapper + click-to-pause + keyboard shortcuts
│       ├── MovieCard.js
│       └── ...
├── lib/
│   ├── hls-sessions.js             # ★ ffmpeg subprocess manager (per-session)
│   ├── streaming.js                # STREAMING_SERVERS array + getEmbedUrl helper
│   ├── tmdb.js                     # TMDB v3 client
│   └── alldebrid-client.js
├── bin/                            # ffmpeg + ffprobe binary fallbacks (auto-installed)
└── test_result.md                  # task history + testing-agent reports (do not delete)
```

`★` = changes likely to break things if you don't understand them. Read sections 4 and 5.

---

## 3. Environment variables (in `/app/.env`)

| Var | Required? | Where it's used | Notes |
|---|---|---|---|
| `MONGO_URL`, `DB_NAME` | yes (formally) | nowhere in current code | HLS pipeline is in-memory + /tmp. Mongo is set for the Emergent deployer's health check; harmless to keep |
| `NEXT_PUBLIC_BASE_URL` | yes | client-side links | DO NOT modify. Emergent injects this |
| `TMDB_API_KEY`, `NEXT_PUBLIC_TMDB_API_KEY` | **yes** | homepage + watch page metadata | Without these, homepage is empty |
| `TMDB_ACCESS_TOKEN` | optional | future v4 features | Not strictly used yet |
| `RD_ADDON_MANIFEST_URL` | **yes for premium** | server-side: `app/api/realdebrid/resolve/route.js` | Comet manifest URL with RD API key baked into the base64 config segment. See §6 for regenerating it |
| `NEXT_PUBLIC_RD_ADDON_MANIFEST_URL` | yes if AD path used | client-side AD resolver | Same URL, exposed to browser |
| `NEXT_PUBLIC_ALLDEBRID_API_KEY` | optional | client-side AD resolver | Only needed if AD Premium path is used |

`.gitignore` was deliberately edited to **not** hide `.env` — Emergent's native deployer reads it directly from the repo. If you re-introduce `.env` to `.gitignore`, the deployer fails. Leave it as is.

---

## 4. How the Real-Debrid Premium path actually works

This is the cleverest part of the system. Read it slowly.

### 4.1 End-to-end request flow

```
Browser <video> via hls.js
       │
       │ GET /api/stream/hls/<sessionId>/index.m3u8
       ↓
Next.js route (app/api/stream/hls/[...path]/route.js)
       │
       │ first hit only: ensureFfmpeg(session) → spawn ffmpeg
       ↓
ffmpeg subprocess (managed by lib/hls-sessions.js)
       │
       │ -i https://comet.elfhosted.com/playback/<token>/...
       ↓
Comet 302 → real-debrid.com CDN URL
       │
       │ delivers the actual MP4/MKV bytes
       ↓
ffmpeg remuxes (or transcodes) to HLS → /tmp/streamix-hls/<sessionId>/seg_*.ts + index.m3u8
       │
       │ HTTP 200 with the (rewritten) playlist
       ↓
hls.js plays
```

### 4.2 The resolver (`app/api/realdebrid/resolve/route.js`)

1. Queries Comet's `/stream/<type>/<id>.json` for all available streams for that title.
2. **Hard-rejects** anything with `UNKNOWN` in its Comet badge (e.g. `[RD⚡] COMET UNKNOWN`) — those are content mismatches (BBC News clips, porn under matching titles, mistagged uploads). This filter is critical; do not remove it.
3. Ranks the rest by a scoring function that prefers:
   - `[RD⚡]` (cached on RD) **massively** over `[RD⬇️]` (would need to be downloaded → Comet serves an 8-second "preparing" placeholder MP4 instead of the real file)
   - `.mp4` > `.mkv` > others
   - H.264 > HEVC > AV1
   - AAC / AC3 / MP3 > DTS / TrueHD / Atmos
   - 1-5 GB sweet spot for streaming
   - Penalty for REMUX, 4K, foreign-language tags, sample/trailer files
4. **Probes the top 6 candidates** server-side with a `Range: bytes=0-0` request and only accepts those that either:
   - 302-redirect to a `real-debrid.com` URL (real file), or
   - return `Content-Length` matching the expected videoSize (≥ 50% of declared)
   
   This skips the 8-second placeholder MP4s that Comet sometimes serves while RD is busy unrestricting.
5. Creates an HLS session via `createSession(rdUrl, meta)` and returns `/api/stream/hls/<sessionId>/index.m3u8` plus up to 5 pre-built alternate session URLs.

### 4.3 The HLS session manager (`lib/hls-sessions.js`)

- One ffmpeg child process per session, writing into `/tmp/streamix-hls/<sessionId>/`.
- Before spawning, runs **ffprobe** to detect codec. If video is `h264` `yuv420p` (and not Hi10p) and audio is `aac`/`mp3` mono/stereo → `-c copy` (lossless remux, ~5% CPU). Otherwise → `libx264 main + aac` transcode (~50-100% of one core).
- ffmpeg args use `-hls_playlist_type event` because that's the **only** type that writes the playlist incrementally to disk in a way that's actually readable while the process is running. `vod` defers the playlist write to ffmpeg exit; `temp_file` flag holds it through atomic rename. Neither works for our use case.
- **The route handler then rewrites the type from `EVENT` → `VOD` on every read**, and appends `#EXT-X-ENDLIST` once ffmpeg exits cleanly. This is how we get progressive playlist updates **without** hls.js's live-edge-seeking behavior (which was the cause of the "timestamp jumps from 3m to 25m" bug).
- Sessions are reaped after 5 min of no segment fetches (`IDLE_TTL_MS`).
- ffmpeg binary is auto-discovered with apt-install fallback. **In containerized environments, the apt-installed `/usr/bin/ffmpeg` sometimes vanishes on restart.** Copies in `/app/bin/` are checked next. If both missing, the manager runs `apt-get install -y ffmpeg` at session start. The first call after a fresh container will be slow because of this; subsequent calls are fast.

### 4.4 hls.js configuration (`components/streamix/HlsVideo.js`)

Three settings prevent the live-edge-seek bug, **do not change them**:

```js
startPosition: 0,                       // always start at 0:00 not the live edge
liveSyncDurationCount: 0,               // don't try to track a moving live point
liveMaxLatencyDurationCount: Infinity,  // don't ever consider the player "behind live"
```

Plus generous timeouts and retries because ffmpeg might take 10-20 s to write segment N+5 if it's stream-copying.

---

## 5. Known bugs / quirks / gotchas

### Comet rate-limiting (external, not a code bug)
After many hundreds of test requests in a short window, `comet.elfhosted.com/playback/*` starts returning **HTTP 403** to all User-Agents from your IP. The manifest and stream-list endpoints keep working. **Auto-recovers in 1-24 hours.** Not a deploy blocker; production users with normal viewing patterns never hit this. If a user is seeing "Premium playback failed" for every title, this is the most likely cause. Wait or switch IP/server.

### ffmpeg disappears on container restart
Already mitigated (auto-discovery + apt-install fallback). If you ever see `ffmpeg binary not found on host` in logs, hit play again — the second attempt will trigger reinstall and succeed.

### `[RD⚡] COMET UNKNOWN` filter rejects everything for obscure titles
When all available streams have UNKNOWN badges (rare, only for very obscure titles), resolver returns 404. This is the correct behavior — playing UNKNOWN content was causing BBC News clips and porn to play under wrong titles. **Don't loosen this filter without a different mismatch-detection strategy.**

### TMDB id vs IMDB id matters
Comet matches torrents by IMDB id (`tt0137523`-style). Passing `?tmdb=550` works for popular titles but is less reliable. The resolver accepts both but **prefer IMDB id on the client side** when calling `/api/realdebrid/resolve`.

### Headless Chromium can't validate H.264
Playwright's Chromium build does not ship the H.264 decoder (patent restrictions). **Frontend tests that try to verify `<video>` actually plays will fail in CI with `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` — even with Big Buck Bunny.** This is not a code bug. Real Chrome/Firefox/Safari/Edge all play fine. Skip Playwright media tests.

### Netlify cannot host this app
The HLS pipeline requires:
- Long-running Node.js process (Netlify Functions are serverless)
- ffmpeg as a child process (Netlify Functions can't spawn subprocesses)
- `/tmp` writes that persist across requests (Netlify Functions are stateless)

**Deploy to Emergent's native deployer, Render, Railway, Fly.io, or a VPS.** Anywhere with a real Node server + ffmpeg installed.

### Duration shows as growing during encoding
Expected behavior. ffmpeg writes segments faster than realtime (~6×); the playlist's listed segments grow accordingly; hls.js's reported `video.duration` reflects what's currently in the playlist. Once ffmpeg exits and `#EXT-X-ENDLIST` is appended, duration becomes fixed. **The player does NOT skip ahead anymore** (that bug is fixed via `startPosition: 0`).

---

## 6. Re-generating the Comet manifest URL with a different RD key

The `RD_ADDON_MANIFEST_URL` in `.env` has the user's RD key encoded inside a base64 JSON config in the URL path. To regenerate for a new RD key:

```python
import base64, json
config = {
  "maxResultsPerResolution": 0,
  "maxSize": 0,
  "cachedOnly": False,
  "sortCachedUncachedTogether": False,
  "removeTrash": True,
  "resultFormat": ["all"],
  "debridServices": [
    {"service": "realdebrid", "apiKey": "<NEW_RD_KEY_HERE>"}
  ],
  "enableTorrent": False,
  "deduplicateStreams": False,
  "scrapeDebridAccountTorrents": False,
  "debridStreamProxyPassword": "",
  "languages": {"required": [], "allowed": [], "exclude": [], "preferred": []},
  "resolutions": {},
  "options": {
    "remove_ranks_under": -10_000_000_000,
    "allow_english_in_languages": False,
    "remove_unknown_languages": False
  }
}
encoded = base64.urlsafe_b64encode(json.dumps(config).encode()).decode().rstrip("=")
print(f"https://comet.elfhosted.com/{encoded}/manifest.json")
```

(There's also a helper at `/app/scripts/generate_rd_manifest.py` for this.)

---

## 7. Test-result conventions

`/app/test_result.md` is the single source of truth for testing-agent runs. **Never edit the "Testing Protocol" section at the top.** Update only the `backend`, `frontend`, `metadata`, `test_plan`, and `agent_communication` blocks. Read the file before invoking `deep_testing_backend_nextjs` so you can write a useful task description.

Frontend testing in Playwright is gated behind explicit user permission. Default: backend only.

---

## 8. Suggested next moves (in priority order)

These are **optional polish** items the project hasn't done yet:

1. **Custom Tailwind player skin** (replace native HTML5 controls). Estimated 1-2 days. Risks: progress bar must handle `durationchange` events live, seeking-while-encoding needs a "buffering" state, mobile touch UX needs care. See chat history for full risk breakdown.
2. **Multi-bitrate HLS ladder** (1080p + 720p + 480p). Requires running ffmpeg with multiple output streams. 3× the CPU. Only do this if user complains about bandwidth.
3. **Skip-intro detection** (heuristic on audio fingerprint + episode pattern). Significant ML or third-party API integration.
4. **Picture-in-Picture button** in custom controls. One line: `await video.requestPictureInPicture()`.
5. **Subtitle support**. Comet doesn't pass subtitle tracks. Would need to scrape OpenSubtitles or similar separately and inject a `<track>` element.
6. **MediaFusion as a Comet alternative** (different scraper, may have better cached coverage for some titles). Same RD key works. Drop-in URL swap in `.env`.

---

## 9. Quick-start checklist for the next agent

- [ ] Read this file (you just did)
- [ ] Read `/app/test_result.md` for the latest task state
- [ ] Check `/app/.env` — every var in §3 must be set
- [ ] `which ffmpeg` — must exist (apt-get install -y ffmpeg if not)
- [ ] `sudo supervisorctl status` — `nextjs` must be RUNNING
- [ ] Hit `http://localhost:3000` in a real browser (not Playwright) and verify a movie loads + Premium plays
- [ ] If Premium fails with 502/timeout, check `tail -n 200 /var/log/supervisor/nextjs.out.log` for `[HLS] ffmpeg` errors. The most likely cause is Comet rate-limiting (§5) — wait an hour and retry before debugging

Good luck. The code is in a working state at the time of this handoff.
