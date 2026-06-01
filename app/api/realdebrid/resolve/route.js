import { NextResponse } from 'next/server';
import { createSession, probeSourceOnly } from '@/lib/hls-sessions';
import dns from 'dns';

// ── Force IPv4-first DNS resolution ─────────────────────────────────
// Node 18+ defaults to `verbatim: true` for dns.lookup, which can return
// IPv6 AAAA records before IPv4 A records. Jackett (and many local services)
// only bind to IPv4 by default, so `fetch('http://localhost:9117/...')` will
// try `::1` first, hang until the AbortSignal fires, and surface as a
// TimeoutError. Setting ipv4first globally restores Node 16 behavior and
// is safe — any service that's IPv6-only will still work via its hostname.
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* old node */ }

// Belt-and-suspenders: rewrite localhost → 127.0.0.1 in any URL before
// fetching. Some libraries cache the lookup result before the ipv4first
// flag takes effect.
function forceIpv4(url) {
  if (!url) return url;
  return url
    .replace(/\/\/localhost(?=[:/]|$)/i, '//127.0.0.1')
    .replace(/\/\/0\.0\.0\.0(?=[:/]|$)/, '//127.0.0.1');
}

/**
 * Real-Debrid resolver — Comet edition, HLS delivery.
 *
 * We delegate scraping + RD-unrestrict to the Comet Stremio addon (config
 * baked into RD_ADDON_MANIFEST_URL — see .env). Comet returns a
 * /playback/<token>/... URL that 302-redirects to a real-debrid.com CDN URL.
 *
 * Delivery rewrite (June 2025): the old "<video src='/api/stream/proxy?...'>"
 * approach failed for too many RD files because RD ships a wild variety of
 * codecs (Hi10P H.264, HEVC, DTS audio, etc.) that no browser can natively
 * decode. We now hand the RD URL to ffmpeg and stream HLS — every browser
 * plays HLS via Media Source Extensions / hls.js, regardless of the
 * source's codec. See /app/lib/hls-sessions.js.
 *
 * Ranker still prefers cached + browser-friendly files because that lets
 * ffmpeg use stream-copy (cheap) instead of re-encoding. But the playback
 * is no longer codec-fragile.
 */

const RD_ADDON_MANIFEST_URL        = process.env.RD_ADDON_MANIFEST_URL;
// Backup Comet manifest URL — used as a fallback ONLY when the primary
// URL returns 0 cached streams for a title. Typically configured with
// looser filters (no language preference, no resolution floor, larger
// size cap) to improve hit rate for foreign content (Turkish, Arabic,
// non-English releases) that the primary URL's English bias rejects.
//
// IMPORTANT: even if this backup URL is configured with `cachedOnly: false`,
// the resolver below ALWAYS filters to RD-cached streams (the ⚡ badge).
// Uncached streams can't play instantly via our HLS pipeline and are
// silently dropped, so misconfiguration here can never break playback.
const RD_ADDON_MANIFEST_URL_BACKUP = process.env.RD_ADDON_MANIFEST_URL_BACKUP;

// Returns `[primaryBase, backupBase | null]` — each is the addon URL
// minus the trailing `/manifest.json` so we can append `/stream/...`.
function getCometBases() {
  const norm = (u) => u
    ? u.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '')
    : null;
  return [norm(RD_ADDON_MANIFEST_URL), norm(RD_ADDON_MANIFEST_URL_BACKUP)];
}

// Backwards-compat — internal callers still using the old name keep working.
function getCometBase() {
  return getCometBases()[0];
}

/**
 * Jackett Torrent Search Helper
 * 
 * Queries Jackett for torrents when Comet returns nothing. Searches across
 * 50+ indexers and checks RD cache status for each result. Returns torrents
 * sorted by quality + seeders, with cached status.
 */
async function fetchJackettStreams(mediaType, imdbId, tmdbId, season, episode) {
  const t0 = Date.now();
  try {
    const JACKETT_URL_RAW = process.env.JACKETT_URL || 'http://localhost:9117';
    const JACKETT_URL = forceIpv4(JACKETT_URL_RAW);
    const JACKETT_API_KEY = process.env.JACKETT_API_KEY;
    const RD_API_KEY = process.env.RD_API_KEY;

    if (!JACKETT_API_KEY) {
      console.warn('[Jackett] API key not configured, skipping');
      return [];
    }

    if (JACKETT_URL !== JACKETT_URL_RAW) {
      console.log(`[Jackett] Rewrote URL ${JACKETT_URL_RAW} → ${JACKETT_URL} (IPv4-force)`);
    }

    // Build search query - we need title from TMDB
    let searchQuery = '';
    
    // Try to fetch title from TMDB
    if (tmdbId) {
      try {
        const tmdbApiKey = process.env.NEXT_PUBLIC_TMDB_API_KEY;
        if (tmdbApiKey) {
          const tmdbUrl = `https://api.themoviedb.org/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${tmdbApiKey}`;
          const tmdbRes = await fetch(tmdbUrl, { signal: AbortSignal.timeout(5000) });
          if (tmdbRes.ok) {
            const tmdbData = await tmdbRes.json();
            searchQuery = tmdbData.title || tmdbData.name || '';
          }
        }
      } catch (e) {
        console.warn('[Jackett] TMDB title fetch failed:', e.message);
      }
    }

    if (!searchQuery && !imdbId) {
      console.warn('[Jackett] No search query or IMDb ID available');
      return [];
    }

    // Add season/episode for TV shows
    if (mediaType === 'tv' && season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      searchQuery += ` S${s}E${e}`;
    }

    // Query Jackett
    // NOTE: We deliberately DO NOT pass `imdbid` here. Most of our working
    // public indexers (1337x, torrentdownloads) don't have IMDb→title
    // metadata; when Jackett receives an imdbid it tries to resolve via
    // those indexers' IMDb-search modes, which silently return 0 results
    // for indexers that don't support it. Title-only search returns the
    // full result set across every indexer. Verified empirically:
    //   curl ...?Query=iCarly+S01E01&imdbid=0972534  → 0 results
    //   curl ...?Query=iCarly+S01E01                 → 32 results
    const jackettUrl = new URL(`${JACKETT_URL}/api/v2.0/indexers/all/results`);
    jackettUrl.searchParams.set('apikey', JACKETT_API_KEY);
    if (searchQuery) jackettUrl.searchParams.set('Query', searchQuery);

    // Don't leak api key into logs — strip apikey query param when logging URL
    const safeUrl = jackettUrl.toString().replace(/(apikey=)[^&]+/i, '$1[REDACTED]');
    console.log(`[Jackett] GET ${safeUrl} (query="${searchQuery}")`);
    const startTime = Date.now();

    // 25s is generous — Jackett's "all indexers" endpoint typically returns
    // partial results within 10–15s even with 50+ indexers configured. Going
    // higher just blocks the user-facing /api/realdebrid/resolve longer.
    const jackettRes = await fetch(jackettUrl.toString(), {
      signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': 'Streamix/1.0' },
    });
    
    console.log(`[Jackett] Search completed in ${Date.now() - startTime}ms (status=${jackettRes.status})`);

    if (!jackettRes.ok) {
      console.warn(`[Jackett] Search failed: ${jackettRes.status}`);
      return [];
    }

    const jackettData = await jackettRes.json();
    const results = (jackettData.Results || [])
      .filter(r => r.MagnetUri)
      .map(r => {
        const magnetMatch = r.MagnetUri.match(/btih:([a-fA-F0-9]{40})/i);
        const infoHash = magnetMatch ? magnetMatch[1].toLowerCase() : null;
        const title = r.Title || '';
        
        return {
          title,
          magnetUri: r.MagnetUri,
          infoHash,
          size: r.Size || 0,
          seeders: r.Seeders || 0,
          indexer: r.Tracker || 'Unknown',
          quality: extractQualityFromTitle(title),
          sizeFormatted: formatBytesHelper(r.Size || 0),
        };
      })
      .filter(r => r.infoHash);

    if (results.length === 0) {
      console.log('[Jackett] No torrents found');
      return [];
    }

    // Check RD cache status for all torrents
    if (RD_API_KEY && results.length > 0) {
      const hashes = results.map(r => r.infoHash).slice(0, 100);
      const hashesParam = hashes.join('/');
      
      try {
        const rdRes = await fetch(
          `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${hashesParam}`,
          {
            headers: { 'Authorization': `Bearer ${RD_API_KEY}` },
            signal: AbortSignal.timeout(10000),
          }
        );

        if (rdRes.ok) {
          const rdData = await rdRes.json();
          
          // Mark cached status
          results.forEach(r => {
            const hashData = rdData[r.infoHash];
            r.cached = !!(hashData && hashData.rd && hashData.rd.length > 0);
          });
        }
      } catch (e) {
        console.warn('[Jackett] RD cache check failed:', e.message);
        // Continue without cache status
        results.forEach(r => r.cached = false);
      }
    }

    // Sort: cached first, then by quality, then by seeders
    results.sort((a, b) => {
      if (a.cached !== b.cached) return b.cached ? 1 : -1;
      const qualityOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
      const qualityDiff = (qualityOrder[b.quality] || 0) - (qualityOrder[a.quality] || 0);
      if (qualityDiff !== 0) return qualityDiff;
      return (b.seeders || 0) - (a.seeders || 0);
    });

    console.log(`[Jackett] Found ${results.length} torrents (${results.filter(r => r.cached).length} cached) in ${Date.now() - t0}ms total`);
    
    return results.slice(0, 20); // Return top 20

  } catch (error) {
    const elapsed = Date.now() - t0;
    // Distinguish abort/timeout from other failures so the user-visible log
    // line points at the right thing (network/dns vs slow Jackett vs config).
    const isTimeout = error?.name === 'TimeoutError' || /aborted|timeout/i.test(error?.message || '');
    if (isTimeout) {
      console.error(
        `[Jackett] TIMEOUT after ${elapsed}ms — common causes: ` +
        `1) JACKETT_URL points to wrong host/port (current: ${process.env.JACKETT_URL || 'http://localhost:9117'}) ` +
        `2) Jackett process not running (check 'systemctl status jackett') ` +
        `3) Firewall blocking the port. ` +
        `Try: curl -s "${(process.env.JACKETT_URL || 'http://127.0.0.1:9117').replace(/\/$/, '')}/api/v2.0/server/config?apikey=<key>"`
      );
    } else {
      console.error(`[Jackett] Error after ${elapsed}ms:`, error.message);
    }
    return [];
  }
}

function extractQualityFromTitle(title) {
  const lower = title.toLowerCase();
  if (/2160p|4k|uhd/i.test(lower)) return '2160p';
  if (/1080p/i.test(lower)) return '1080p';
  if (/720p/i.test(lower)) return '720p';
  if (/480p/i.test(lower)) return '480p';
  return 'unknown';
}

function formatBytesHelper(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Resolution tag we can pull from a release filename (e.g. "Fight.Club.1080p.BrRip.x264.mp4").
// Returns the lowercased label ('1080p', '720p', …) or null when nothing matches —
// in which case the candidate is simply omitted from the per-quality menu.
//
// Token rules:
//   • px-style tokens (2160p/1080p/720p/480p/360p) need only a RIGHT word
//     boundary, so "BD1080P", "WEB720p", "x1080p" are caught. Real-world
//     false-positive risk is ~zero — no release naming scheme embeds the
//     px-suffix inside a non-resolution word.
//   • '4k' and 'uhd' (2160p synonyms) need BOTH boundaries because they
//     can appear inside scene tags like "UHDTV" (not a resolution flag).
function parseResolution(filename) {
  const m = (filename || '').match(/(2160p|1080p|720p|480p|360p|\b4k\b|\buhd\b)/i);
  if (!m) return null;
  const tok = m[1].toLowerCase();
  if (tok === '4k' || tok === 'uhd') return '2160p';
  return tok;
}

// High → low display order. Anything outside this list is skipped from the picker.
const RES_ORDER = ['2160p', '1080p', '720p', '480p', '360p'];

// Scrub debrid badges from a quality label before sending to the client.
// Comet returns things like "[RD⚡] Comet 1080p" or "[AD⚡] Comet 4K UHD";
// we strip the bracketed prefix and the "Comet" provider tag so the user
// only sees the actual quality descriptor (e.g. "1080p").
function sanitizeQualityLabel(name) {
  if (!name) return '';
  return String(name)
    // Strip leading bracketed debrid badges like "[RD⚡]", "[AD⚡]",
    // "[RD]", "[ AD ⬇ ]", "[RD+]", etc. (case-insensitive, lightning/down arrows handled)
    .replace(/\[\s*(?:RD|AD|PM|DL|TB|OC)\s*[⚡⬇️↓↑+]*\s*\]\s*/gi, '')
    // Drop the "Comet" provider tag (with or without surrounding spaces/dashes)
    .replace(/\bComet\b\s*[-–—]?\s*/gi, '')
    // Tidy up double-spaces left behind
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Browser playback compatibility scorer.
// Higher = more likely to play in a stock browser <video> tag.
// `name` is Comet's badge (e.g. "[RD⚡] Comet 1080p" — ⚡ = cached/instant,
//  ⬇️ = NOT cached → Comet serves an 8s placeholder until RD downloads it).
// `filename` is the real release name we use to detect codec/container/etc.
function rankStream(filename, sizeBytes, name = '') {
  const n = (filename || '').toLowerCase();
  let score = 0;

  // ─── ★★★ MOST IMPORTANT: cached on Real-Debrid ──────────────
  // Without this, Comet returns an 8-second "preparing" placeholder
  // instead of the real file. Browsers see an 8s clip and bail.
  // We want CACHED streams above everything else.
  if (/⚡/.test(name) || /\[RD\s*⚡\]/i.test(name)) {
    score += 10000;        // ★ cached: instant playback
  } else if (/⬇/.test(name) || /\[RD\s*⬇/i.test(name)) {
    score -= 8000;         // not cached: unusable for <video>
  }

  // ─── ★★★ UNKNOWN-quality reject ─────────────────────────────
  // Comet stamps a torrent with `[RD⚡] COMET UNKNOWN` when the addon's
  // own quality detection failed to recognize the file. In practice
  // these are almost always content mismatches — non-English BBC clips,
  // adult content with overlapping titles, mistagged uploads. We refuse
  // to play them by giving an unrecoverable negative score (caller
  // filters anything below MIN_SCORE).
  if (/\bUNKNOWN\b/i.test(name)) {
    score -= 100000;
  }

  // ─── Container ───────────────────────────────────────────────
  if (/\.mp4(\b|$)/.test(n)) score += 1000;          // ★ MP4 = best
  else if (/\.webm(\b|$)/.test(n)) score += 800;
  else if (/\.mkv(\b|$)/.test(n)) score += 0;        // MKV: works via proxy if codecs OK
  else if (/\.avi(\b|$)/.test(n)) score -= 400;
  else if (/\.ts(\b|$)/.test(n)) score -= 200;

  // ─── Video codec ─────────────────────────────────────────────
  if (/\b(x264|h264|h\.264|avc)\b/.test(n)) score += 400;   // ★ universal
  if (/\b(x265|h265|h\.265|hevc)\b/.test(n)) score -= 500;  // not in Chrome/FF (mostly)
  if (/\b(av1|vp9)\b/.test(n)) score -= 200;

  // ─── Audio codec ─────────────────────────────────────────────
  if (/\b(aac)\b/.test(n)) score += 250;                    // ★ universal
  if (/\b(ac3|eac3|e-ac-3|ddp?|dolby\s*digital)\b/.test(n)) score += 150;
  if (/\b(mp3)\b/.test(n)) score += 200;
  if (/\b(opus|vorbis)\b/.test(n)) score += 150;
  if (/\b(dts(-?hd)?|truehd|atmos)\b/.test(n)) score -= 500; // not browser-supported

  // ─── Resolution sweet spot ───────────────────────────────────
  if (/\b1080p\b/.test(n)) score += 200;
  else if (/\b720p\b/.test(n)) score += 150;
  else if (/\b(2160p|4k|uhd)\b/.test(n)) score -= 100;       // huge + HEVC usually
  else if (/\b480p\b/.test(n)) score += 50;

  // ─── Dolby Vision penalty ────────────────────────────────────
  // DOVI sources (HEVC w/ proprietary RPU NAL units) crash ffmpeg's HEVC
  // parser with "Error parsing DOVI NAL unit / RPU validation failed",
  // which causes our HLS session to die before producing a playlist —
  // the player then spins forever. We have ffmpeg-side defenses (see
  // hls-sessions.js: hevc_metadata bsf + err_detect ignore_err), but the
  // cheapest fix is to just not pick DOVI versions when an SDR/HDR10
  // alternative is available.
  //
  // Heavy penalty (-3000) ensures DOVI ranks below ALL non-DOVI options
  // but still above UNKNOWN-quality (which is -100000) — so if DOVI is
  // the ONLY available release we'll still try it with the ffmpeg
  // defenses active.
  if (/\b(do?vi|dolby[.\s_-]?vision|dv[.\s_-]?(?:hdr|p[58]|profile)|dvhe|dvh1)\b/i.test(n)) {
    score -= 3000;
  }

  // ─── Source quality (cleaner audio/subs usually) ─────────────
  if (/\bweb[-. ]?dl\b/.test(n)) score += 100;
  if (/\bwebrip\b/.test(n)) score += 80;
  if (/\bbluray\b/.test(n)) score += 60;
  if (/\bbrrip\b/.test(n)) score += 50;
  if (/\bremux\b/.test(n)) score -= 300;                    // huge, lossless audio

  // ─── Size sweet spot for streaming ───────────────────────────
  if (sizeBytes && sizeBytes > 0) {
    const gb = sizeBytes / (1024 ** 3);
    if (gb >= 1 && gb <= 5) score += 200;       // ★ streaming sweet spot
    else if (gb > 5 && gb <= 10) score += 80;
    else if (gb > 10 && gb <= 20) score -= 100;
    else if (gb > 20) score -= 400;             // REMUX territory
    else if (gb < 0.7) score -= 200;            // probably samples / trailers
  }

  // ─── Junk / non-English flags ────────────────────────────────
  if (/\b(sample|trailer|preview)\b/.test(n)) score -= 5000;
  if (/\b(hindi|spanish|french|german|italian|portuguese|russian|chinese|korean|japanese|arabic|turkish|polish|latino|castellano|dub(bed)?|multi)\b/.test(n)) score -= 80;
  if (/\bvostfr\b/.test(n)) score -= 80;
  if (/\b(ita|esp|fra|ger|rus|pol|tur)\b/.test(n)) score -= 50;

  return score;
}

/**
 * Create an HLS session and return playlist URL + metadata.
 *
 * IMPORTANT (June 2025): We used to call `ensureFfmpeg(session, 5000)` here
 * to probe duration synchronously. That had a fatal flaw for problematic
 * sources (DOVI HEVC, weird codecs, slow CDN responses): if ffmpeg didn't
 * produce a playlist in 5s, `ensureFfmpeg` would SIGKILL the ffmpeg process
 * AND cache the rejected startup promise on the session — so the browser's
 * subsequent `/index.m3u8` GET would re-await the same rejected promise and
 * the session was permanently dead.
 *
 * Now we use `probeSourceOnly()` (ffprobe-only, no ffmpeg spawn) to fetch
 * duration + audio metadata for the resolver response. The actual ffmpeg
 * session starts LAZILY on the first browser playlist GET, with the full
 * 30s startup timeout window. This means:
 *   - Fast sources still respond fast (no double-probe penalty)
 *   - DOVI/slow sources get a chance to start ffmpeg with proper time budget
 *   - Sessions the browser never plays don't waste an ffmpeg process
 */
async function buildHlsUrl(sourceUrl, meta = {}, startOffset = 0, audioIndex = null, _legacyProbeTimeout) {
  const session = createSession(sourceUrl, meta, startOffset, audioIndex);
  // Probe via ffprobe only — no ffmpeg spawn. 12s gives slow RD CDN URLs
  // enough time to enumerate streams without breaking the user-facing
  // resolver SLA. If probe fails, the frontend gracefully falls back to
  // growing-duration mode and the session still starts ffmpeg on demand.
  let probed = null;
  try {
    probed = await probeSourceOnly(sourceUrl, 12000);
  } catch (e) {
    console.warn(`[RD] Source probe failed for session ${session.id}:`, e?.message);
  }
  // Mirror the metadata onto the session so /api/stream/hls/session and the
  // lazy ensureFfmpeg path can short-circuit ffprobe via the cache.
  if (probed) {
    session.sourceDuration = probed.duration || null;
    session.audioStreams = probed.audioStreams || [];
    session.selectedAudioIndex = probed.selectedAudioIndex ?? 0;
  }
  return {
    streamUrl: `/api/stream/hls/${session.id}/index.m3u8`,
    sourceDuration: probed?.duration || null,
    audioStreams: probed?.audioStreams || [],
    selectedAudioIndex: probed?.selectedAudioIndex ?? 0,
  };
}

export async function GET(request) {
  const [cometBase, cometBackup] = getCometBases();
  if (!cometBase) {
    return NextResponse.json(
      { error: 'Real-Debrid not configured (RD_ADDON_MANIFEST_URL missing)' },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const mediaType = searchParams.get('type');
  const imdbId = searchParams.get('imdb');
  const tmdbId = searchParams.get('tmdb');
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');
  const debug = searchParams.get('debug') === '1';
  // Optional resume offset (Continue Watching). When > 0, all HLS sessions
  // created here (primary + qualities + alternates) are spawned with ffmpeg
  // `-ss <start>` so the playlist begins at the user's saved real-world
  // position. Clamped to [0, 24h] to defend against absurd inputs.
  const startOffset = (() => {
    const raw = parseFloat(searchParams.get('start') || '0');
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, 86400);
  })();
  // Optional audio track index (Phase 2). User-selected audio language via
  // the in-player track switcher. When valid (>= 0), overrides the default
  // English-detection logic in probeCodecs. Out-of-bounds values fall back
  // to auto-detection (no crash).
  const audioIndex = (() => {
    const raw = parseInt(searchParams.get('audio') || '', 10);
    if (Number.isNaN(raw) || raw < 0) return null;
    return raw;
  })();

  if (!mediaType || (!imdbId && !tmdbId)) {
    return NextResponse.json(
      { error: 'Missing required parameters' },
      { status: 400 },
    );
  }
  if (mediaType === 'tv' && (!season || !episode)) {
    return NextResponse.json(
      { error: 'Missing season/episode for TV show' },
      { status: 400 },
    );
  }

  try {
    const id = imdbId || tmdbId;
    const streamId = mediaType === 'tv' ? `${id}:${season}:${episode}` : id;
    const streamType = mediaType === 'tv' ? 'series' : 'movie';

    // ── Comet fetch helper ────────────────────────────────────────
    // Returns an array of valid (cached, non-UNKNOWN, http) streams
    // already scored + sorted high-to-low. Empty array on any failure
    // (network error, non-2xx, malformed JSON) so callers can fall
    // through to the backup manifest without try/catch noise.
    const fetchAndRank = async (base, label) => {
      if (!base) return [];
      try {
        const u = `${base}/stream/${streamType}/${streamId}.json`;
        console.log(`[RD] Querying Comet (${label}): ${streamType}/${streamId}`);
        const r = await fetch(u, { headers: { 'User-Agent': 'Streamix/1.0' } });
        if (!r.ok) {
          console.warn(`[RD] Comet ${label} returned ${r.status}`);
          return [];
        }
        const data = await r.json();
        if (!data.streams || !Array.isArray(data.streams)) return [];

        return data.streams
          .filter((s) => s.url && /^https?:\/\//i.test(s.url))
          .filter((s) => !/\bUNKNOWN\b/i.test(s.name || ''))
          .map((s) => {
            const filename = s?.behaviorHints?.filename || s.name || '';
            const sizeBytes = Number(s?.behaviorHints?.videoSize) || 0;
            const cometName = s.name || ''; // e.g. "[RD⚡] Comet 1080p"
            return {
              url: s.url,
              name: cometName || filename || 'Unknown',
              filename,
              sizeBytes,
              cached: /⚡/.test(cometName),
              score: rankStream(filename || cometName, sizeBytes, cometName),
            };
          })
          // Defense-in-depth: even if a manifest URL is misconfigured
          // with `cachedOnly: false`, drop uncached streams here.
          // Uncached RD URLs can't play instantly via the HLS pipeline
          // — they'd require a multi-minute download to RD first.
          .filter((s) => s.cached)
          .sort((a, b) => b.score - a.score);
      } catch (e) {
        console.warn(`[RD] Comet ${label} fetch failed:`, e?.message);
        return [];
      }
    };

    // Try primary, then fall through to backup if it returned nothing.
    // Most titles resolve on primary; the backup is a safety net for
    // foreign content (Turkish, Arabic, etc.) the primary URL's English
    // language preference + size/resolution caps tend to miss.
    let validStreams = await fetchAndRank(cometBase, 'primary');
    if (validStreams.length === 0 && cometBackup) {
      console.log(`[RD] Primary returned 0 streams for ${streamId}, trying backup manifest`);
      validStreams = await fetchAndRank(cometBackup, 'backup');
      if (validStreams.length > 0) {
        console.log(`[RD] Backup manifest recovered ${validStreams.length} stream(s) for ${streamId}`);
      }
    }
    
    // ── Jackett fallback: Search 50+ indexers when Comet has nothing ─────
    // Jackett-sourced torrents return with a flag `jackett: true` and
    // `cached: false` initially. The frontend will show "Add to RD & wait"
    // buttons for these. This dramatically improves coverage for titles
    // Comet misses (older sitcoms, niche releases, recent drops).
    if (validStreams.length === 0 && process.env.JACKETT_API_KEY) {
      console.log(`[RD] Comet found nothing for ${streamId}, trying Jackett...`);
      const jackettStreams = await fetchJackettStreams(
        mediaType,
        imdbId,
        tmdbId,
        season,
        episode,
      );
      if (jackettStreams.length > 0) {
        console.log(`[RD] Jackett recovered ${jackettStreams.length} torrent(s) for ${streamId}`);
        // Return a special response for uncached Jackett torrents
        return NextResponse.json({
          success: false,
          jackettResults: jackettStreams,
          message: 'No cached streams found, but torrents are available',
        });
      }
    }
    
    if (validStreams.length === 0) {
      return NextResponse.json(
        { error: 'No streams found for this title' },
        { status: 404 },
      );
    }

    if (!validStreams.length) {
      return NextResponse.json(
        { error: 'No valid stream URLs found' },
        { status: 404 },
      );
    }

    const best = validStreams[0];

    console.log(
      `[RD] ${validStreams.length} streams, top (score=${best.score}): ${best.filename.slice(0, 100)}`,
    );

    if (debug) {
      return NextResponse.json({
        success: true,
        debug: true,
        count: validStreams.length,
        top: validStreams.slice(0, 12).map((s) => ({
          score: s.score,
          sizeGB: +(s.sizeBytes / 1024 ** 3).toFixed(2),
          filename: s.filename,
        })),
      });
    }

    // ── Probe candidates: skip "placeholder" streams ─────────────
    // Even when Comet says ⚡ cached, sometimes its /playback URL serves
    // an 8-second placeholder MP4 instead of unrestricting to RD. We probe
    // each candidate (max ~6) with a HEAD-via-GET and accept the first one
    // that either (a) 302-redirects to a real-debrid.com URL, or (b)
    // returns a Content-Length matching the expected videoSize (or just a
    // file larger than ~50 MB — placeholders are ~400 KB).
    const probeUpstream = async (s) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(s.url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0', 'User-Agent': 'Streamix/1.0' },
          redirect: 'manual',
          signal: ctrl.signal,
        });
        clearTimeout(t);

        // (a) 302 → real-debrid → unrestricted, real file
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location') || '';
          if (/real-debrid\.com|rdeb\.io|alldebrid\.com/i.test(loc)) {
            return { ok: true, reason: 'redirect-to-debrid', size: null };
          }
        }

        // (b) 206 / 200 with a real Content-Range/Length total
        if (res.status === 206 || res.status === 200) {
          const cr = res.headers.get('content-range') || '';
          const m = cr.match(/\/(\d+)\s*$/);
          const total = m ? Number(m[1]) : Number(res.headers.get('content-length') || 0);
          // Accept if total is plausibly the full file
          if (s.sizeBytes && total >= s.sizeBytes * 0.5) {
            return { ok: true, reason: 'matches-videoSize', size: total };
          }
          if (!s.sizeBytes && total > 50 * 1024 * 1024) {
            return { ok: true, reason: 'large-enough', size: total };
          }
          return { ok: false, reason: 'placeholder', size: total };
        }
        return { ok: false, reason: `status-${res.status}`, size: null };
      } catch (e) {
        return { ok: false, reason: `probe-error:${e.message}`, size: null };
      }
    };

    // Probe top N in parallel for speed — pick the first ok candidate by
    // ORIGINAL score order. Limit to 6 to keep latency under ~2s even on
    // slow days.
    const PROBE_LIMIT = Math.min(6, validStreams.length);
    const candidates = validStreams.slice(0, PROBE_LIMIT);
    const probes = await Promise.all(candidates.map(probeUpstream));

    let chosenIdx = -1;
    for (let i = 0; i < probes.length; i++) {
      if (probes[i].ok) {
        chosenIdx = i;
        console.log(
          `[RD] Probed #${i} OK (${probes[i].reason}, size=${probes[i].size}): ${candidates[i].filename.slice(0, 80)}`,
        );
        break;
      } else {
        console.log(
          `[RD] Probed #${i} SKIP (${probes[i].reason}, size=${probes[i].size}): ${candidates[i].filename.slice(0, 80)}`,
        );
      }
    }
    // If all top-6 probes failed (placeholders), fall back to the best
    // overall pick anyway — better to try playing something than 404.
    const chosen = chosenIdx >= 0 ? candidates[chosenIdx] : best;

    // Reorder validStreams so the probe-validated chosen one is first,
    // then the un-probed tail, then any probed-failed candidates (so we
    // still get alternates).
    const validatedIdx = new Set();
    const alternates = [];
    if (chosenIdx >= 0) validatedIdx.add(chosenIdx);
    // Add other probe-ok candidates first
    for (let i = 0; i < probes.length; i++) {
      if (i !== chosenIdx && probes[i].ok) {
        alternates.push(candidates[i]);
        validatedIdx.add(i);
      }
    }
    // Then add the untested tail
    for (let i = PROBE_LIMIT; i < validStreams.length && alternates.length < 5; i++) {
      alternates.push(validStreams[i]);
    }
    // Then add probe-failed candidates as last resort
    for (let i = 0; i < probes.length && alternates.length < 5; i++) {
      if (!validatedIdx.has(i)) alternates.push(candidates[i]);
    }

    // Build an HLS playlist URL so the browser plays via hls.js — works for
    // every codec the source might have (we transcode if needed).
    //
    // OPTIMIZATION: Don't probe Comet placeholders (known-dead streams).
    // These return status 302 with no real URL — probing wastes 5s for
    // nothing. Detect via emoji markers in filename/quality and return
    // sourceDuration=null immediately.
    const isPlaceholder = /\[(?:🔄|⚠️|❌)\]\s*Comet/i.test(chosen.filename || chosen.name || '');
    let hlsResult;
    if (isPlaceholder) {
      console.log(`[RD] Skipping probe for Comet placeholder: ${chosen.filename || chosen.name}`);
      const session = createSession(chosen.url, {
        filename: chosen.filename,
        sizeBytes: chosen.sizeBytes,
        quality: chosen.name,
      }, startOffset, audioIndex);
      hlsResult = {
        streamUrl: `/api/stream/hls/${session.id}/index.m3u8`,
        sourceDuration: null,
        audioStreams: [],
        selectedAudioIndex: 0,
      };
    } else {
      hlsResult = await buildHlsUrl(chosen.url, {
        filename: chosen.filename,
        sizeBytes: chosen.sizeBytes,
        quality: chosen.name,
      }, startOffset, audioIndex);
    }

    // ── Per-resolution quality bucket ────────────────────────────
    // For the player's "Quality" menu we want one entry per resolution
    // (2160p / 1080p / 720p / …) so the user can manually pick. We only
    // consider candidates we already probed-OK above (no extra probe
    // latency) and we keep the highest-scored leader per resolution
    // (`candidates` is sorted by score, so first-seen-per-bucket wins).
    // When the bucket leader is the same RD source as `chosen` we reuse
    // its HLS session URL — creating a second session for the same source
    // would just be a wasted /tmp dir.
    //
    // IMPORTANT: We DON'T probe qualities here — they're all transcodes
    // of the same source file (chosen.url) at different resolutions, so
    // they share the SAME sourceDuration. Probing each would multiply
    // resolver latency by N qualities. Instead we reuse hlsResult.sourceDuration.
    const qualityByRes = {};
    for (let i = 0; i < probes.length; i++) {
      if (!probes[i].ok) continue;
      const c = candidates[i];
      const res = parseResolution(c.filename);
      if (!res) continue;
      if (qualityByRes[res]) continue;
      qualityByRes[res] = c;
    }
    const qualities = RES_ORDER
      .map((label) => {
        const entry = qualityByRes[label];
        if (!entry) return null;
        // If this quality points to the same source as chosen, reuse the
        // already-probed session. Otherwise create a new session BUT
        // DON'T probe it (lazy — probe happens when user switches quality).
        const result = entry.url === chosen.url
          ? hlsResult
          : {
              streamUrl: `/api/stream/hls/${createSession(entry.url, {
                filename: entry.filename,
                sizeBytes: entry.sizeBytes,
                quality: entry.name,
              }, startOffset, audioIndex).id}/index.m3u8`,
              sourceDuration: hlsResult.sourceDuration, // same source file
              audioStreams: hlsResult.audioStreams,     // same source file
              selectedAudioIndex: hlsResult.selectedAudioIndex,
            };
        return {
          label,
          streamUrl: result.streamUrl,
          streamType: 'hls',
          sizeBytes: entry.sizeBytes,
          filename: entry.filename || entry.name,
          // directUrl is needed for mid-playback quality switches: the
          // client creates a brand-new HLS session at the current real-
          // world playback position (via POST /api/stream/hls/session).
          // This is what makes "switch to 720p without losing my place"
          // actually preserve position across the new ffmpeg session.
          directUrl: entry.url,
          sourceDuration: result.sourceDuration,
        };
      })
      .filter(Boolean)
      .slice(0, 4);

    return NextResponse.json({
      success: true,
      streamUrl: hlsResult.streamUrl,
      streamType: 'hls',
      directUrl: chosen.url,                 // for debugging + quality-swap re-seeding
      quality: sanitizeQualityLabel(chosen.name).slice(0, 100),
      filename: chosen.filename || chosen.name,
      sizeBytes: chosen.sizeBytes,
      probedOk: chosenIdx >= 0,
      // Resume offset (seconds) baked into the HLS sessions. 0 when not
      // resuming. The frontend uses this to render the time display in
      // real-world coordinates (currentTime + startOffset) and to compute
      // the new `start` value when creating a fresh session on quality swap.
      startOffset,
      // Source duration (float seconds) from ffprobe. The frontend uses
      // this as a FIXED denominator for the time display + scrubber so
      // the total runtime doesn't appear to "grow" over the first 1-2
      // minutes while the HLS transcoder writes segments on demand. Null
      // if ffprobe failed; the frontend falls back to the old growing-
      // duration behavior (video.duration + startOffset).
      sourceDuration: hlsResult.sourceDuration,
      // Audio tracks detected in the source (Phase 2). Multi-audio MKVs
      // (e.g. "Fight Club [English Hindi]") expose all detected streams
      // so the user can switch mid-playback. Empty array if probe failed.
      audioStreams: hlsResult.audioStreams,
      selectedAudioIndex: hlsResult.selectedAudioIndex,
      // Per-resolution quality picker. ≤ 4 entries, sorted hi→lo. The
      // player's settings menu lists these alongside an "Auto" option;
      // when the user picks one, the player swaps src to the matching
      // streamUrl (each is its own pre-built — lazy — HLS session).
      qualities,
      // Pre-ranked alternates the client can rotate to if the top HLS
      // session fails for any reason (e.g., ffmpeg refused to demux this
      // particular source). Each alternate gets its own HLS session.
      // Like qualities, alternates are NOT probed here (lazy) — they're
      // fallbacks only used if the primary fails. We still return
      // sourceDuration = hlsResult.sourceDuration because alternates are
      // typically the same source file from different RD mirrors/torrents.
      alternates: alternates.slice(0, 5).map((s) => ({
        streamUrl: `/api/stream/hls/${createSession(s.url, {
          filename: s.filename, sizeBytes: s.sizeBytes, quality: s.name,
        }, startOffset, audioIndex).id}/index.m3u8`,
        streamType: 'hls',
        directUrl: s.url,
        filename: s.filename || s.name,
        quality: sanitizeQualityLabel(s.name),
        sizeBytes: s.sizeBytes,
        sourceDuration: hlsResult.sourceDuration, // assume same source file
        audioStreams: hlsResult.audioStreams,     // assume same source file
        selectedAudioIndex: hlsResult.selectedAudioIndex,
      })),
    });
  } catch (error) {
    console.error('[RD] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to resolve stream' },
      { status: 500 },
    );
  }
}
