// ── On-demand HLS session creation (for mid-playback quality / audio switching) ──
//
// The /api/realdebrid/resolve endpoint pre-creates HLS sessions for the
// primary stream, every available quality, and a handful of alternates —
// all at a fixed `startOffset` (0 for fresh playback, > 0 when resuming
// from Continue Watching). Those pre-built sessions stay valid as long
// as the user watches at that offset.
//
// But the moment the user switches quality (or audio language) mid-playback
// at, say, 18 minutes in, none of the pre-built sessions match their current
// real-world position — the 720p pre-built session starts at the same
// offset as the 1080p one (= the resume point), not at minute 18. Playing
// it would dump the user back to the resume point.
//
// This endpoint creates a fresh HLS session at an arbitrary `start`
// offset, so the client can construct it as:
//   start = video.currentTime + currentSessionStartOffset
// i.e., the user's real-world position at the moment they tapped the new
// quality / audio. The resulting session's `currentTime = 0` corresponds
// to that real-world second, so the swap preserves position with no
// client seek.
//
// ── PHASE 4 LATENCY HOTFIX ─────────────────────────────────────────────
// Originally this endpoint did `await ensureFfmpeg(session)` synchronously,
// which forced the client to wait ~15-25s on every audio/quality switch
// because:
//   • ffprobe on the RD CDN takes 5-15s (deep `-analyzeduration` reads)
//   • ffmpeg first-segment generation takes another 3-8s
// The resolver had ALREADY probed this exact sourceUrl when the initial
// session was created — re-probing was pure waste.
//
// Fix: hls-sessions.js now caches ffprobe results per-sourceUrl. When we
// see a cache hit here we take a FAST PATH:
//   • Populate audioStreams + sourceDuration from the cached probe
//   • Spawn ffmpeg in the BACKGROUND (no await)
//   • Return the new streamUrl immediately (~50ms total)
// The browser then GETs the playlist, which lazy-spawns / awaits ffmpeg
// (see /api/stream/hls/[...path]/route.js) — but ffmpeg has already been
// kicked off in the background, so by the time the browser is ready the
// first segment is usually written.
//
// On a cache miss (first session for a new sourceUrl) we fall back to the
// original behaviour: await ensureFfmpeg so the response carries probe
// data, no regression for the resolver's primary-session path.
//
// Security: `sourceUrl` is validated against Comet's playback URL prefix
// — that's the only legitimate kind of URL the resolver hands to ffmpeg.
// We don't want this endpoint to become an open proxy.

import { NextResponse } from 'next/server';
import { createSession, ensureFfmpeg, getCachedProbe } from '@/lib/hls-sessions';

const ALLOWED_SOURCE_PREFIXES = [
  'https://comet.elfhosted.com/playback/',
];

const isAllowedSource = (url) => {
  if (typeof url !== 'string') return false;
  return ALLOWED_SOURCE_PREFIXES.some((p) => url.startsWith(p));
};

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sourceUrl, filename, sizeBytes, quality, start, audioIndex } = body || {};

    if (!isAllowedSource(sourceUrl)) {
      return NextResponse.json(
        { error: 'sourceUrl must be a Comet playback URL' },
        { status: 400 },
      );
    }

    // Clamp start to a sane range. Negative or non-numeric → 0 (no offset).
    let startOffset = parseFloat(start);
    if (!Number.isFinite(startOffset) || startOffset <= 0) startOffset = 0;
    startOffset = Math.min(startOffset, 86400);

    // Phase 2: Optional audio track index for mid-playback audio switches.
    const normalizedAudioIndex = typeof audioIndex === 'number' && audioIndex >= 0
      ? Math.floor(audioIndex)
      : null;

    const session = createSession(
      sourceUrl,
      {
        filename: typeof filename === 'string' ? filename.slice(0, 300) : undefined,
        sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : undefined,
        quality: typeof quality === 'string' ? quality.slice(0, 100) : undefined,
      },
      startOffset,
      normalizedAudioIndex,
    );

    // ── FAST PATH: probe cache hit ────────────────────────────────
    // If we've probed this sourceUrl before (typical for audio/quality
    // switches — the resolver did the initial probe), skip the await on
    // ensureFfmpeg entirely. We can populate audioStreams + sourceDuration
    // directly from the cached probe, return immediately, and let ffmpeg
    // spawn in the background. The playlist endpoint (lazy-spawn) handles
    // any remaining wait, but by then ffmpeg is usually already producing
    // segments → user-perceived latency drops from ~20s to ~1-3s.
    const cachedProbe = getCachedProbe(sourceUrl);
    if (cachedProbe) {
      const audioStreams = cachedProbe.audioStreams || [];

      // Resolve the EFFECTIVE audio index the new ffmpeg session will use.
      // Mirrors the same logic ensureFfmpeg applies internally:
      //   - in-bounds requested index → that index
      //   - out-of-bounds / null → fall back to the cached English-first pick
      const effectiveAudioIndex =
        normalizedAudioIndex !== null
        && audioStreams.length > 0
        && normalizedAudioIndex < audioStreams.length
          ? normalizedAudioIndex
          : (cachedProbe.selectedAudioIndex ?? 0);

      // Eagerly kick off ffmpeg in the BACKGROUND. We swallow errors here
      // because the playlist GET will surface them properly to hls.js;
      // double-logging would be noise.
      ensureFfmpeg(session).catch((e) => {
        console.warn(
          `[HLS session] background ensureFfmpeg failed for ${session.id}:`,
          e?.message,
        );
      });

      console.log(
        `[HLS session] FAST PATH for ${session.id} ` +
        `(probe cache hit, audioIndex=${effectiveAudioIndex}, ` +
        `startOffset=${startOffset}s)`
      );

      return NextResponse.json({
        success: true,
        sessionId: session.id,
        streamUrl: `/api/stream/hls/${session.id}/index.m3u8`,
        streamType: 'hls',
        startOffset,
        sourceDuration: cachedProbe.duration || null,
        audioStreams,
        selectedAudioIndex: effectiveAudioIndex,
      });
    }

    // ── COLD PATH: no probe cache (first session for this source) ──
    // Probe + ffmpeg startup are awaited so the response carries real
    // audioStreams + sourceDuration. This matches the pre-hotfix behaviour
    // and is the path the resolver's primary-session creation takes.
    try {
      await ensureFfmpeg(session);
    } catch (e) {
      console.warn(`[HLS session] ensureFfmpeg failed for ${session.id}:`, e?.message);
    }

    return NextResponse.json({
      success: true,
      sessionId: session.id,
      streamUrl: `/api/stream/hls/${session.id}/index.m3u8`,
      streamType: 'hls',
      startOffset,
      sourceDuration: session.sourceDuration || null,
      audioStreams: session.audioStreams || [],
      selectedAudioIndex: session.selectedAudioIndex ?? 0,
    });
  } catch (error) {
    console.error('[HLS session] Error:', error?.message);
    return NextResponse.json(
      { error: error?.message || 'Failed to create HLS session' },
      { status: 500 },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
