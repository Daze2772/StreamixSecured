// ── On-demand HLS session creation (for mid-playback quality switching) ──
//
// The /api/realdebrid/resolve endpoint pre-creates HLS sessions for the
// primary stream, every available quality, and a handful of alternates —
// all at a fixed `startOffset` (0 for fresh playback, > 0 when resuming
// from Continue Watching). Those pre-built sessions stay valid as long
// as the user watches at that offset.
//
// But the moment the user switches quality mid-playback at, say, 18 minutes
// in, none of the pre-built sessions match their current real-world
// position — the 720p pre-built session starts at the same offset as the
// 1080p one (= the resume point), not at minute 18. Playing it would dump
// the user back to the resume point.
//
// This endpoint creates a fresh HLS session at an arbitrary `start`
// offset, so the client can construct it as:
//   start = video.currentTime + currentSessionStartOffset
// i.e., the user's real-world position at the moment they tapped the new
// quality. The resulting session's `currentTime = 0` corresponds to that
// real-world second, so the swap preserves position with no client seek.
//
// Security: `sourceUrl` is validated against Comet's playback URL prefix
// — that's the only legitimate kind of URL the resolver hands to ffmpeg.
// We don't want this endpoint to become an open proxy.

import { NextResponse } from 'next/server';
import { createSession } from '@/lib/hls-sessions';

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

    // ── Probe source duration immediately (quality-switch path) ───
    // createSession spawns the session object but doesn't call
    // ensureFfmpeg yet (that happens lazily on first playlist GET). For
    // quality switches we need sourceDuration in the POST response so the
    // frontend can atomically swap both URL and denominator. We probe
    // synchronously here — adds ~200-500 ms latency on the switch but
    // gives us the duration before the browser even starts loading.
    try {
      await import('@/lib/hls-sessions').then((mod) => mod.ensureFfmpeg(session));
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
