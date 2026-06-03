import { NextResponse } from 'next/server';
import { createSession, probeSourceOnly } from '@/lib/hls-sessions';

/**
 * Play From RD Torrent
 *
 * Given an RD torrentId for a torrent that the user has already added &
 * downloaded (typically via the Jackett "Prepare" flow), this endpoint:
 *
 *   1. Fetches torrent info from Real-Debrid (status, filename, links).
 *   2. Picks the largest VIDEO file from the torrent's link list — this
 *      filters out trailers/samples/sample.mkv/Sample.avi/.nfo metadata.
 *   3. Unrestricts that link via `/unrestrict/link` to get the raw CDN URL.
 *   4. Creates an HLS session (lazy ffmpeg spawn, same path as the main
 *      /api/realdebrid/resolve endpoint).
 *   5. Returns the same payload shape as `/api/realdebrid/resolve`:
 *        { success, streamUrl, sourceDuration, audioStreams, ... }
 *
 * This is used by the JackettResultsOverlay's "Play now" button so the
 * user can go straight from a completed download to playback without
 * reloading the page (which wouldn't find the file anyway, because
 * Comet's global cache doesn't see private user additions to RD).
 */

const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';
const RD_API_KEY = process.env.RD_API_KEY;

// Video extensions we'd consider as the "main" file. .iso / .vob are
// excluded — ffmpeg/HLS chokes on DVD images.
const VIDEO_EXTS = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v',
  'wmv', 'mpg', 'mpeg', 'ts', 'flv', 'ogv',
]);

function pickBestVideoLink(info) {
  // RD returns:
  //   info.files = [{ id, path, bytes, selected }]
  //   info.links = [<restricted url>, ...]   (1:1 with selected==1 files)
  // The "biggest video file" is almost always the actual movie episode.
  if (!info || !Array.isArray(info.links) || info.links.length === 0) {
    return null;
  }

  const selectedFiles = (info.files || []).filter(f => f.selected);
  // Map links to their files for proper sorting + filtering
  const candidates = info.links.map((url, idx) => {
    const file = selectedFiles[idx] || null;
    const path = file?.path || '';
    const filename = path.split('/').pop() || url.split('/').pop() || '';
    const ext = filename.split('.').pop().toLowerCase();
    return {
      url,
      path,
      filename,
      bytes: file?.bytes || 0,
      isVideo: VIDEO_EXTS.has(ext),
      // Filter heuristics — same patterns we apply in rankStream
      isSample: /\b(sample|trailer|teaser|preview|promo|tlr(-?\d+)?)\b/i.test(filename),
    };
  });

  // Prefer: video extension, not a sample, biggest bytes
  const usable = candidates
    .filter(c => c.isVideo && !c.isSample)
    .sort((a, b) => b.bytes - a.bytes);

  // Fallback to "any video file" if all are flagged as samples (rare)
  const fallback = candidates
    .filter(c => c.isVideo)
    .sort((a, b) => b.bytes - a.bytes);

  return usable[0] || fallback[0] || { url: info.links[0], filename: info.filename || '' };
}

export async function GET(request) {
  if (!RD_API_KEY) {
    return NextResponse.json({ error: 'Real-Debrid API key not configured' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const torrentId = searchParams.get('torrentId');
  if (!torrentId) {
    return NextResponse.json({ error: 'torrentId required' }, { status: 400 });
  }

  try {
    // ─── 1. Fetch torrent info ───────────────────────────────────
    const infoRes = await fetch(`${RD_API_BASE}/torrents/info/${torrentId}`, {
      headers: { 'Authorization': `Bearer ${RD_API_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!infoRes.ok) {
      return NextResponse.json(
        { error: `RD info failed: ${infoRes.status}` },
        { status: infoRes.status },
      );
    }
    const info = await infoRes.json();

    if (info.status !== 'downloaded' && (info.progress || 0) < 100) {
      return NextResponse.json(
        { error: 'Torrent is not finished downloading yet', status: info.status, progress: info.progress },
        { status: 409 },
      );
    }

    // ─── 2. Pick the main video file ─────────────────────────────
    const pick = pickBestVideoLink(info);
    if (!pick?.url) {
      return NextResponse.json({ error: 'No playable video file in torrent' }, { status: 404 });
    }

    // ─── 3. Unrestrict to get CDN URL ────────────────────────────
    const unrestrictRes = await fetch(`${RD_API_BASE}/unrestrict/link`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RD_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ link: pick.url }),
      signal: AbortSignal.timeout(15000),
    });
    if (!unrestrictRes.ok) {
      const txt = await unrestrictRes.text().catch(() => '');
      return NextResponse.json(
        { error: `RD unrestrict failed: ${unrestrictRes.status} ${txt.slice(0, 200)}` },
        { status: 500 },
      );
    }
    const unrestricted = await unrestrictRes.json();
    const directUrl = unrestricted.download;
    if (!directUrl) {
      return NextResponse.json({ error: 'Unrestrict returned no playable URL' }, { status: 500 });
    }

    console.log(`[PlayFromTorrent] ${torrentId} → ${pick.filename || directUrl.slice(0, 80)}`);

    // ─── 4. Build HLS session ────────────────────────────────────
    const meta = { filename: pick.filename || info.filename, sizeBytes: pick.bytes || info.bytes || null };
    const session = createSession(directUrl, meta, 0, null);
    let probed = null;
    try {
      probed = await probeSourceOnly(directUrl, 12000);
    } catch (e) {
      console.warn(`[PlayFromTorrent] Source probe failed for session ${session.id}:`, e?.message);
    }
    if (probed) {
      session.sourceDuration = probed.duration || null;
      session.audioStreams = probed.audioStreams || [];
      session.selectedAudioIndex = probed.selectedAudioIndex ?? 0;
    }

    return NextResponse.json({
      success: true,
      streamUrl: `/api/stream/hls/${session.id}/index.m3u8`,
      directUrl,
      filename: pick.filename || info.filename || '',
      sourceDuration: probed?.duration || null,
      audioStreams: probed?.audioStreams || [],
      selectedAudioIndex: probed?.selectedAudioIndex ?? 0,
      sizeBytes: pick.bytes || null,
    });

  } catch (error) {
    console.error('[PlayFromTorrent] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to prepare playback' },
      { status: 500 },
    );
  }
}
