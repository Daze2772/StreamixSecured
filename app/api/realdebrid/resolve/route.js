import { NextResponse } from 'next/server';

/**
 * SIMPLIFIED Real-Debrid - Just use Comet's URLs directly!
 * No complex RD API calls, no waiting, no timeouts.
 * Comet handles everything for us.
 */

const RD_ADDON_MANIFEST_URL = process.env.RD_ADDON_MANIFEST_URL;

function getCometBase() {
  if (!RD_ADDON_MANIFEST_URL) return null;
  return RD_ADDON_MANIFEST_URL.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '');
}

function rankStream(name) {
  const n = name.toLowerCase();
  let score = 0;
  
  if (n.includes('1080p')) score += 100;
  else if (n.includes('720p')) score += 80;
  else if (n.includes('2160p') || n.includes('4k')) score += 40;
  
  if (n.includes('h264') || n.includes('x264') || n.includes('avc')) score += 50;
  else if (n.includes('hevc') || n.includes('h265')) score -= 20;
  
  if (n.includes('aac') || n.includes('ac3') || n.includes('dd')) score += 40;
  else if (n.includes('truehd') || n.includes('dts')) score -= 30;
  
  if (n.includes('.mp4')) score += 30;
  
  return score;
}

export async function GET(request) {
  const cometBase = getCometBase();
  if (!cometBase) {
    return NextResponse.json(
      { error: 'Real-Debrid not configured' },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const mediaType = searchParams.get('type');
  const imdbId = searchParams.get('imdb');
  const tmdbId = searchParams.get('tmdb');
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');

  if (!mediaType || (!imdbId && !tmdbId)) {
    return NextResponse.json(
      { error: 'Missing required parameters' },
      { status: 400 }
    );
  }

  if (mediaType === 'tv' && (!season || !episode)) {
    return NextResponse.json(
      { error: 'Missing season/episode for TV show' },
      { status: 400 }
    );
  }

  try {
    // Build stream ID
    const id = imdbId || tmdbId;
    const streamId = mediaType === 'tv' ? `${id}:${season}:${episode}` : id;
    const streamType = mediaType === 'tv' ? 'series' : 'movie';
    
    // Query Comet directly - it handles all RD logic!
    const url = `${cometBase}/stream/${streamType}/${streamId}.json`;
    
    console.log(`[RD Simple] Querying Comet: ${streamType}/${streamId}`);
    
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Streamix/1.0' },
      timeout: 10000,
    });
    
    if (!response.ok) {
      throw new Error(`Comet returned ${response.status}`);
    }
    
    const data = await response.json();
    
    if (!data.streams || !Array.isArray(data.streams) || data.streams.length === 0) {
      return NextResponse.json(
        { error: 'No streams found for this title' },
        { status: 404 }
      );
    }
    
    // Filter and rank streams
    const validStreams = data.streams.filter(s => s.url && s.url.startsWith('http'));
    
    if (!validStreams.length) {
      return NextResponse.json(
        { error: 'No valid stream URLs found' },
        { status: 404 }
      );
    }
    
    // Rank by quality/codec
    const ranked = validStreams
      .map(s => ({
        url: s.url,
        name: s.name || 'Unknown',
        score: rankStream(s.name || ''),
      }))
      .sort((a, b) => b.score - a.score);
    
    const best = ranked[0];
    
    console.log(`[RD Simple] Found ${validStreams.length} streams, best: ${best.name.slice(0, 80)}`);
    
    // Return immediately - no waiting, no complex API calls!
    return NextResponse.json({
      success: true,
      streamUrl: best.url,
      quality: best.name.slice(0, 100),
      filename: best.name,
    });

  } catch (error) {
    console.error('[RD Simple] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to resolve stream' },
      { status: 500 }
    );
  }
}
