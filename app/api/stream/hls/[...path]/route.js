import { NextResponse } from 'next/server';
import { promises as fsp } from 'fs';
import path from 'path';
import { getSession, touchSession, ensureFfmpeg } from '@/lib/hls-sessions';

/**
 * HLS playlist + segment server.
 *
 *   GET /api/stream/hls/<sessionId>/index.m3u8
 *     → on first hit, lazily spawns ffmpeg via ensureFfmpeg(); blocks (up
 *       to ~30s) until the playlist + first segment exist on disk, then
 *       streams the playlist content.
 *
 *   GET /api/stream/hls/<sessionId>/seg_NNNNN.ts
 *     → streams the segment from disk. Touches the session so the idle
 *       reaper leaves it alone.
 *
 * Routing: `[...path]` catches both. We validate the path strictly so we
 * never serve arbitrary files from the temp dir.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Match exactly:  <sessionId>/index.m3u8  or  <sessionId>/seg_NNNNN.ts
const SAFE_SEGMENT = /^seg_\d{1,7}\.ts$/;
const SESSION_ID = /^[a-f0-9]{16}$/;

async function serveFile(filePath, contentType, extraHeaders = {}) {
  try {
    const data = await fsp.readFile(filePath);
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(data.length),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    };
    return new Response(data, { status: 200, headers });
  } catch (e) {
    return NextResponse.json(
      { error: 'File not ready', detail: e.code || e.message },
      { status: 404 },
    );
  }
}

export async function GET(request, { params }) {
  const parts = params?.path || [];
  if (parts.length !== 2) {
    return NextResponse.json({ error: 'Bad path' }, { status: 400 });
  }
  const [sessionId, file] = parts;

  if (!SESSION_ID.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  touchSession(sessionId);

  // ─── Playlist ────────────────────────────────────────────────
  if (file === 'index.m3u8') {
    try {
      if (!session.ready) {
        // Lazy-spawn ffmpeg on first playlist hit (block until first segments
        // are written). Subsequent calls await the same in-flight promise.
        await ensureFfmpeg(session);
      }
    } catch (e) {
      return NextResponse.json(
        { error: 'Transcoder failed to start', detail: e.message },
        { status: 502 },
      );
    }
    const playlistPath = path.join(session.dir, 'index.m3u8');
    return serveFile(playlistPath, 'application/vnd.apple.mpegurl');
  }

  // ─── Segment ─────────────────────────────────────────────────
  if (SAFE_SEGMENT.test(file)) {
    const segPath = path.join(session.dir, file);

    // If ffmpeg is still encoding, a segment may not yet exist. Briefly
    // poll (up to ~10s) before giving up. This lets hls.js stay calm
    // while we catch up to the playback head.
    for (let i = 0; i < 40; i++) {
      try {
        const st = await fsp.stat(segPath);
        if (st.size > 0) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return serveFile(segPath, 'video/MP2T');
  }

  return NextResponse.json({ error: 'Bad file name' }, { status: 400 });
}

// HLS doesn't usually require HEAD, but some players probe with it.
export async function HEAD(request, ctx) {
  const res = await GET(request, ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}
