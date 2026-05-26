// ── OpenSubtitles download endpoint (fetch SRT, convert to WebVTT, cache) ────

import { getToken } from '../login/route.js';

// In-memory cache: Map<file_id, { vtt: string, timestamp: number }>
const vttCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

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

  if (!fileId) {
    return Response.json({ error: 'file_id required' }, { status: 400 });
  }

  try {
    // Check cache first
    const cached = vttCache.get(fileId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(`[OpenSubtitles] Cache HIT for file_id ${fileId}`);
      return new Response(cached.vtt, {
        status: 200,
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }

    // Cache miss - acquire token and download
    console.log(`[OpenSubtitles] Cache MISS for file_id ${fileId}, downloading...`);
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
    const vttText = srtToWebVTT(srtText);

    // Step 4: Cache the result
    vttCache.set(fileId, {
      vtt: vttText,
      timestamp: Date.now()
    });

    console.log(`[OpenSubtitles] Successfully converted and cached file_id ${fileId}`);

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
