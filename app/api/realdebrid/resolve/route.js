import { NextResponse } from 'next/server';

/**
 * Premium (Real-Debrid) stream resolver
 * ──────────────────────────────────────────────────────────────────────
 * GET /api/realdebrid/resolve?type=movie&tmdb=550
 * GET /api/realdebrid/resolve?type=tv&tmdb=1399&season=1&episode=1
 * GET /api/realdebrid/resolve?type=movie&imdb=tt0137523        (skips TMDB lookup)
 *
 * Pipeline:
 *   1. Resolve IMDB ID (from `imdb` param, or via TMDB external_ids).
 *   2. Query the configured Stremio addon (Comet / MediaFusion) which:
 *        a) scrapes public torrent indexers for that IMDB id
 *        b) checks each magnet against Real-Debrid (using YOUR RD key
 *           that's encrypted inside the addon's token URL)
 *        c) returns direct HTTPS stream URLs for RD-cached files
 *   3. Rank the streams (resolution → codec → seeders, minus cam/screener).
 *   4. Return the best URL — playable directly in <video>.
 *
 * Why not call Torrentio / RD's API directly?
 *   • Torrentio is Cloudflare-blocked from datacenter IPs (Netlify/AWS).
 *   • Real-Debrid's `instantAvailability` endpoint was disabled in 2024
 *     (`error_code: 37`), so we can't query cache status directly.
 *   • Comet/MediaFusion on ElfHosted have no CF block AND keep your RD
 *     key encrypted inside their token URL — our server never handles it.
 *
 * Configuration:
 *   Set RD_ADDON_MANIFEST_URL in .env to the manifest URL you get from
 *   https://comet.elfhosted.com after configuring it with your RD key.
 *   See .env for the 60-second setup walkthrough.
 */

const RD_ADDON_MANIFEST_URL = process.env.RD_ADDON_MANIFEST_URL;
const TMDB_KEY =
  process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY;

// 30-min in-memory cache. Per Node process — survives warm Lambda invocations.
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

const ADDON_TIMEOUT_MS = 18000;
const TMDB_TIMEOUT_MS = 8000;

function getAddonBase() {
  if (!RD_ADDON_MANIFEST_URL) return null;
  // Strip trailing /manifest.json (optionally with whitespace) to get the base.
  return RD_ADDON_MANIFEST_URL.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '');
}

function rankStream(stream) {
  const text = `${stream.title || ''} ${stream.name || ''}`.toLowerCase();
  let score = 0;

  // Quality — favour 1080p (sweet spot of quality vs. start-up time)
  if (text.includes('1080p')) score += 100;
  else if (text.includes('720p')) score += 70;
  else if (text.includes('2160p') || text.includes('4k')) score += 65;
  else if (text.includes('480p')) score += 25;

  // Codec
  if (text.includes('hevc') || text.includes('x265')) score += 8;

  // Container — mp4 plays everywhere, mkv is hit-and-miss in browser
  if (text.includes('.mp4') || / mp4 /.test(text)) score += 14;
  else if (text.includes('.mkv') || / mkv /.test(text)) score += 4;

  // Penalize bad sources hard
  if (/\b(cam|hdcam|hdts|telesync|ts|telecine|tc)\b/.test(text)) score -= 300;
  if (/\b(screener|scr)\b/.test(text)) score -= 80;

  // Seeders if present
  const m = text.match(/👤\s*(\d+)|seed[er]*s?\s*[:=]?\s*(\d+)/i);
  if (m) {
    const s = parseInt(m[1] || m[2], 10);
    if (Number.isFinite(s)) score += Math.min(25, s / 5);
  }

  // Prefer items that look already cached (most addons mark these clearly)
  if (/\[(rd\+|cached|⚡)/i.test(stream.name || '')) score += 30;

  return score;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function resolveImdbFromTmdb(mediaType, tmdbId) {
  if (!TMDB_KEY) {
    return { error: 'TMDB key not configured server-side. Pass &imdb=ttXXXXXXX directly.' };
  }
  const tmdbType = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`;
  try {
    const r = await fetchWithTimeout(url, {}, TMDB_TIMEOUT_MS);
    if (!r.ok) return { error: `TMDB responded ${r.status}` };
    const j = await r.json();
    if (!j.imdb_id) return { error: 'TMDB has no IMDB id mapping for this title.' };
    return { imdb: j.imdb_id };
  } catch (e) {
    return { error: `TMDB lookup failed: ${e.message}` };
  }
}

export async function GET(request) {
  const addonBase = getAddonBase();
  if (!addonBase) {
    return NextResponse.json(
      {
        error: 'Premium (Real-Debrid) not configured.',
        details:
          'Set RD_ADDON_MANIFEST_URL in your environment. Visit https://comet.elfhosted.com, ' +
          'configure with your Real-Debrid API key, copy the resulting manifest URL, and paste it ' +
          'into your .env (or Netlify env vars). Restart the app.',
        setupUrl: 'https://comet.elfhosted.com',
      },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const mediaType = (searchParams.get('type') || '').toLowerCase();
  const tmdbId = searchParams.get('tmdb');
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');
  let imdb = searchParams.get('imdb');

  if (mediaType !== 'movie' && mediaType !== 'tv') {
    return NextResponse.json({ error: 'type must be "movie" or "tv"' }, { status: 400 });
  }
  if (!imdb && !tmdbId) {
    return NextResponse.json({ error: 'Either imdb or tmdb is required' }, { status: 400 });
  }
  if (mediaType === 'tv' && (!season || !episode)) {
    return NextResponse.json({ error: 'season and episode required for tv' }, { status: 400 });
  }

  if (!imdb) {
    const r = await resolveImdbFromTmdb(mediaType, tmdbId);
    if (r.error) {
      return NextResponse.json({ error: r.error }, { status: 502 });
    }
    imdb = r.imdb;
  }

  // Stremio uses "series" for TV
  const stremioType = mediaType === 'tv' ? 'series' : 'movie';
  const id = stremioType === 'series' ? `${imdb}:${season}:${episode}` : imdb;

  const cacheKey = `${stremioType}:${id}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json({ ...cached.payload, cached_hit: true });
  }

  const streamUrl = `${addonBase}/stream/${stremioType}/${id}.json`;

  let data;
  try {
    const r = await fetchWithTimeout(
      streamUrl,
      {
        headers: {
          'User-Agent': 'Stremio/4.4.142 (Streamix integration)',
          Accept: 'application/json',
        },
      },
      ADDON_TIMEOUT_MS,
    );
    if (!r.ok) {
      return NextResponse.json(
        { error: `Stream addon responded ${r.status}` },
        { status: 502 },
      );
    }
    data = await r.json();
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to reach stream addon: ${e.message}` },
      { status: 504 },
    );
  }

  const allStreams = Array.isArray(data?.streams) ? data.streams : [];

  // Skip the addon's "please reconfigure" warning streams
  const playable = allStreams.filter(
    (s) =>
      s &&
      typeof s.url === 'string' &&
      s.url.startsWith('http') &&
      !/obsolete|invalid configuration|reconfigure/i.test(
        `${s.name || ''} ${s.description || ''}`,
      ),
  );

  if (!playable.length) {
    return NextResponse.json(
      {
        error: 'No Real-Debrid streams found for this title.',
        details:
          'Either RD does not have this title cached yet, or your addon configuration is stale. ' +
          'You can re-configure at https://comet.elfhosted.com and update RD_ADDON_MANIFEST_URL.',
      },
      { status: 404 },
    );
  }

  // Rank and pick best
  playable.sort((a, b) => rankStream(b) - rankStream(a));
  const best = playable[0];

  const payload = {
    ok: true,
    streamUrl: best.url,
    quality: (best.name || '').replace(/\n/g, ' ').slice(0, 80),
    title: (best.title || '').replace(/\n/g, ' ').slice(0, 200),
    candidatesCount: playable.length,
    alternates: playable.slice(1, 4).map((s) => ({
      url: s.url,
      quality: (s.name || '').replace(/\n/g, ' ').slice(0, 80),
      title: (s.title || '').replace(/\n/g, ' ').slice(0, 200),
    })),
  };

  cache.set(cacheKey, { payload, expires: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(payload);
}
