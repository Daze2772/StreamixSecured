// ── OpenSubtitles download endpoint (fetch SRT, convert to WebVTT, cache) ────

import { getToken } from '../login/route.js';

// In-memory cache: Map<cacheKey, { vtt: string, timestamp: number }>
// cacheKey = `${file_id}:${offset_seconds_int}` so the same file at
// different resume offsets gets independent cache entries.
const vttCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Parse a VTT timecode (HH:MM:SS.mmm or MM:SS.mmm) to seconds (float).
const vttTimeToSec = (ts) => {
  const parts = ts.split(':');
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    h = parseInt(parts[0], 10) || 0;
    m = parseInt(parts[1], 10) || 0;
    s = parseFloat(parts[2]) || 0;
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10) || 0;
    s = parseFloat(parts[1]) || 0;
  }
  return h * 3600 + m * 60 + s;
};

// Format seconds back to VTT timecode HH:MM:SS.mmm
const secToVtt = (sec) => {
  if (sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const sInt = Math.floor(s);
  const ms = Math.round((s - sInt) * 1000);
  // Clamp ms to [0, 999] (rounding edge case)
  const msClamped = ms >= 1000 ? 999 : ms;
  return (
    String(h).padStart(2, '0') + ':' +
    String(m).padStart(2, '0') + ':' +
    String(sInt).padStart(2, '0') + '.' +
    String(msClamped).padStart(3, '0')
  );
};

const VTT_CUE_RE = /^(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})(.*)$/;

// Shift every cue in a WebVTT document by -offsetSec. Cues whose new END
// time would be < 0 are dropped entirely (along with their cue identifier
// line, if any, and the text lines that follow until the blank separator).
// This is used so subtitles line up with the HLS session that was spawned
// with ffmpeg `-ss <offsetSec>` — the player's currentTime=0 corresponds
// to real-world second `offsetSec` in the source, so subtitle cues
// (which are in real-world coordinates) need the same shift applied.
function shiftVttCues(vtt, offsetSec) {
  if (!offsetSec || offsetSec <= 0) return vtt;
  const lines = vtt.split('\n');
  const out = [];
  let skipBlock = false; // true while we're discarding a cue that started before offset
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(VTT_CUE_RE);
    if (m) {
      const newStart = vttTimeToSec(m[1]) - offsetSec;
      const newEnd = vttTimeToSec(m[2]) - offsetSec;
      if (newEnd <= 0) {
        // Cue ends before our window starts — drop it entirely.
        // Also retroactively drop the cue identifier on the prior line
        // (if it was a number / id rather than a blank line).
        skipBlock = true;
        if (out.length > 0) {
          const prev = out[out.length - 1];
          if (prev !== '' && !VTT_CUE_RE.test(prev) && prev !== 'WEBVTT') {
            out.pop();
          }
        }
        continue;
      }
      // Cue survives; emit the shifted timecode (clamped start at 0).
      const clampedStart = Math.max(0, newStart);
      out.push(`${secToVtt(clampedStart)} --> ${secToVtt(newEnd)}${m[3] || ''}`);
      skipBlock = false;
      continue;
    }
    if (skipBlock) {
      // We're discarding the text lines of a dropped cue. A blank line
      // ends the cue block — stop skipping.
      if (line.trim() === '') skipBlock = false;
      continue;
    }
    out.push(line);
  }
  // Collapse runs of >2 blank lines (cosmetic — keeps the output tidy
  // when several consecutive cues got dropped).
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// SRT to WebVTT converter (inline, no external library)
function srtToWebVTT(srtContent) {
  try {
    // Remove BOM if present
    let content = srtContent;
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }

    // Start WebVTT output
    let vtt = 'WEBVTT\n\n';

    // Split into subtitle blocks
    const blocks = content.trim().split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue; // Skip malformed blocks

      // Line 0: sequence number (skip)
      // Line 1: timecode (convert)
      // Lines 2+: text

      const timecode = lines[1].replace(/,/g, '.'); // SRT uses commas, WebVTT uses dots
      const text = lines.slice(2).join('\n');

      vtt += `${timecode}\n${text}\n\n`;
    }

    return vtt;
  } catch (error) {
    throw new Error(`SRT conversion failed: ${error.message}`);
  }
}

// Decode SRT bytes with encoding fallback
function decodeSRT(arrayBuffer) {
  const uint8Array = new Uint8Array(arrayBuffer);
  
  // Try UTF-8 first
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(uint8Array);
  } catch (e) {
    // Fallback to windows-1252
    try {
      const decoder = new TextDecoder('windows-1252');
      return decoder.decode(uint8Array);
    } catch (e2) {
      // Final fallback to iso-8859-1
      const decoder = new TextDecoder('iso-8859-1');
      return decoder.decode(uint8Array);
    }
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get('file_id');
  // Optional cue-shift offset (Continue Watching). When > 0, every cue's
  // start/end is shifted by -offset and cues with new end <= 0 are dropped.
  const rawOffset = parseFloat(searchParams.get('offset') || '0');
  const offset = Number.isFinite(rawOffset) && rawOffset > 0
    ? Math.min(rawOffset, 86400)
    : 0;

  if (!fileId) {
    return Response.json({ error: 'file_id required' }, { status: 400 });
  }

  // Cache key includes integer offset so different resume positions don't
  // clobber each other. We use Math.floor so two near-identical floats
  // still share a cache hit (sub-second precision isn't meaningful for
  // subtitle alignment anyway).
  const cacheKey = `${fileId}:${Math.floor(offset)}`;

  try {
    // Check cache first
    const cached = vttCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`[OpenSubtitles] Cache HIT for ${cacheKey}`);
      return new Response(cached.vtt, {
        status: 200,
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }

    // If we have a non-zero offset, check the base (offset=0) cache —
    // we can shift on the fly instead of re-downloading.
    const baseCached = offset > 0 ? vttCache.get(`${fileId}:0`) : null;
    let vttText;
    if (baseCached && Date.now() - baseCached.timestamp < CACHE_TTL) {
      console.log(`[OpenSubtitles] Base cache HIT for file_id ${fileId}, shifting by -${offset}s`);
      vttText = shiftVttCues(baseCached.vtt, offset);
      vttCache.set(cacheKey, { vtt: vttText, timestamp: Date.now() });
      return new Response(vttText, {
        status: 200,
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }

    // Cache miss - acquire token and download
    console.log(`[OpenSubtitles] Cache MISS for ${cacheKey}, downloading...`);
    const token = await getToken();

    // Step 1: Request download link
    const downloadResponse = await fetch('https://api.opensubtitles.com/api/v1/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.OPENSUBTITLES_API_KEY,
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Streamix v1.0'
      },
      body: JSON.stringify({ file_id: parseInt(fileId) })
    });

    if (!downloadResponse.ok) {
      const errorText = await downloadResponse.text();
      console.error('[OpenSubtitles] Download request failed:', downloadResponse.status, errorText);

      // Check for quota exhaustion
      if (downloadResponse.status === 429 || errorText.includes('quota')) {
        return Response.json(
          { error: 'daily_quota_exhausted', message: 'OpenSubtitles daily download quota reached.' },
          { status: 429 }
        );
      }

      return Response.json(
        { error: 'Download link request failed', details: errorText },
        { status: downloadResponse.status }
      );
    }

    const downloadData = await downloadResponse.json();
    const downloadLink = downloadData.link;

    if (!downloadLink) {
      return Response.json({ error: 'No download link provided' }, { status: 502 });
    }

    // Step 2: Fetch SRT file
    const srtResponse = await fetch(downloadLink);
    if (!srtResponse.ok) {
      return Response.json(
        { error: 'SRT fetch failed', status: srtResponse.status },
        { status: 502 }
      );
    }

    const srtBuffer = await srtResponse.arrayBuffer();
    const srtText = decodeSRT(srtBuffer);

    // Step 3: Convert to WebVTT
    const baseVtt = srtToWebVTT(srtText);

    // Always cache the unshifted base — shifted variants reuse it.
    vttCache.set(`${fileId}:0`, { vtt: baseVtt, timestamp: Date.now() });

    // Step 4: Apply offset shift if requested
    vttText = offset > 0 ? shiftVttCues(baseVtt, offset) : baseVtt;

    // Cache the (potentially shifted) result under the offset-aware key
    if (offset > 0) {
      vttCache.set(cacheKey, { vtt: vttText, timestamp: Date.now() });
    }

    console.log(`[OpenSubtitles] Successfully converted and cached ${cacheKey}`);

    return new Response(vttText, {
      status: 200,
      headers: {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400'
      }
    });

  } catch (error) {
    console.error('[OpenSubtitles] Download error:', error);
    return Response.json(
      { error: 'Download failed', message: error.message },
      { status: 500 }
    );
  }
}
