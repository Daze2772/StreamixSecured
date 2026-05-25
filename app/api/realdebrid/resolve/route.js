import { NextResponse } from 'next/server';
import { createSession } from '@/lib/hls-sessions';

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

const RD_ADDON_MANIFEST_URL = process.env.RD_ADDON_MANIFEST_URL;

function getCometBase() {
  if (!RD_ADDON_MANIFEST_URL) return null;
  return RD_ADDON_MANIFEST_URL.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '');
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

/** Create an HLS session and return its playlist URL for the browser. */
function buildHlsUrl(sourceUrl, meta = {}) {
  const session = createSession(sourceUrl, meta);
  return `/api/stream/hls/${session.id}/index.m3u8`;
}

export async function GET(request) {
  const cometBase = getCometBase();
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

    const url = `${cometBase}/stream/${streamType}/${streamId}.json`;
    console.log(`[RD] Querying Comet: ${streamType}/${streamId}`);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Streamix/1.0' },
    });
    if (!response.ok) throw new Error(`Comet returned ${response.status}`);

    const data = await response.json();
    if (!data.streams || !Array.isArray(data.streams) || data.streams.length === 0) {
      return NextResponse.json(
        { error: 'No streams found for this title' },
        { status: 404 },
      );
    }

    // Pull filename + size + name (cache badge) out of behaviorHints+stream.
    // Hard-reject streams whose Comet badge says "UNKNOWN" — those are
    // content mismatches in 99% of cases (BBC clips, adult content with
    // overlapping titles, mistagged uploads).
    const validStreams = data.streams
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
      .sort((a, b) => b.score - a.score);

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
    const hlsUrl = buildHlsUrl(chosen.url, {
      filename: chosen.filename,
      sizeBytes: chosen.sizeBytes,
      quality: chosen.name,
    });

    // ── Per-resolution quality bucket ────────────────────────────
    // For the player's "Quality" menu we want one entry per resolution
    // (2160p / 1080p / 720p / …) so the user can manually pick. We only
    // consider candidates we already probed-OK above (no extra probe
    // latency) and we keep the highest-scored leader per resolution
    // (`candidates` is sorted by score, so first-seen-per-bucket wins).
    // When the bucket leader is the same RD source as `chosen` we reuse
    // its HLS session URL — creating a second session for the same source
    // would just be a wasted /tmp dir.
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
        const streamUrl = entry.url === chosen.url
          ? hlsUrl
          : buildHlsUrl(entry.url, {
              filename: entry.filename,
              sizeBytes: entry.sizeBytes,
              quality: entry.name,
            });
        return {
          label,
          streamUrl,
          streamType: 'hls',
          sizeBytes: entry.sizeBytes,
          filename: entry.filename || entry.name,
        };
      })
      .filter(Boolean)
      .slice(0, 4);

    return NextResponse.json({
      success: true,
      streamUrl: hlsUrl,
      streamType: 'hls',
      directUrl: chosen.url,                 // for debugging
      quality: chosen.name.slice(0, 100),
      filename: chosen.filename || chosen.name,
      sizeBytes: chosen.sizeBytes,
      probedOk: chosenIdx >= 0,
      // Per-resolution quality picker. ≤ 4 entries, sorted hi→lo. The
      // player's settings menu lists these alongside an "Auto" option;
      // when the user picks one, the player swaps src to the matching
      // streamUrl (each is its own pre-built — lazy — HLS session).
      qualities,
      // Pre-ranked alternates the client can rotate to if the top HLS
      // session fails for any reason (e.g., ffmpeg refused to demux this
      // particular source). Each alternate gets its own HLS session.
      alternates: alternates.slice(0, 5).map((s) => ({
        streamUrl: buildHlsUrl(s.url, {
          filename: s.filename, sizeBytes: s.sizeBytes, quality: s.name,
        }),
        streamType: 'hls',
        directUrl: s.url,
        filename: s.filename || s.name,
        quality: s.name,
        sizeBytes: s.sizeBytes,
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
