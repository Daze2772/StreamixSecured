import { NextResponse } from 'next/server';

/**
 * Jackett Search API
 * 
 * Searches all configured Jackett indexers for torrents.
 * Returns magnet links with metadata (quality, size, seeders).
 */

const JACKETT_URL = process.env.JACKETT_URL || 'http://localhost:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY;

export async function GET(request) {
  try {
    if (!JACKETT_API_KEY) {
      return NextResponse.json(
        { error: 'Jackett not configured (JACKETT_API_KEY missing)' },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('query');
    const type = searchParams.get('type'); // 'movie' or 'series'
    const imdbId = searchParams.get('imdbId');
    const season = searchParams.get('season');
    const episode = searchParams.get('episode');

    if (!query && !imdbId) {
      return NextResponse.json(
        { error: 'Query or IMDb ID required' },
        { status: 400 }
      );
    }

    // Build search query
    let searchQuery = query || '';
    
    // For TV shows, add season/episode to query
    if (type === 'series' && season && episode) {
      const s = String(season).padStart(2, '0');
      const e = String(episode).padStart(2, '0');
      searchQuery += ` S${s}E${e}`;
    }

    // Query Jackett
    const jackettUrl = new URL(`${JACKETT_URL}/api/v2.0/indexers/all/results`);
    jackettUrl.searchParams.set('apikey', JACKETT_API_KEY);
    jackettUrl.searchParams.set('Query', searchQuery);
    
    if (imdbId) {
      jackettUrl.searchParams.set('imdbid', imdbId.replace('tt', ''));
    }

    console.log('[Jackett] Searching:', searchQuery, imdbId || '');

    const response = await fetch(jackettUrl.toString(), {
      signal: AbortSignal.timeout(15000), // 15s timeout
    });

    if (!response.ok) {
      throw new Error(`Jackett returned ${response.status}`);
    }

    const data = await response.json();
    
    // Parse and normalize results
    const results = (data.Results || [])
      .filter(r => r.MagnetUri) // Only torrents with magnet links
      .map(r => {
        // Extract info hash from magnet link
        const magnetMatch = r.MagnetUri.match(/btih:([a-fA-F0-9]{40})/i);
        const infoHash = magnetMatch ? magnetMatch[1].toLowerCase() : null;

        // Extract quality from title
        const title = r.Title || '';
        const quality = extractQuality(title);
        
        return {
          title: title,
          magnetUri: r.MagnetUri,
          infoHash: infoHash,
          size: r.Size || 0,
          seeders: r.Seeders || 0,
          peers: r.Peers || 0,
          indexer: r.Tracker || 'Unknown',
          publishDate: r.PublishDate || null,
          quality: quality,
          // For UI display
          sizeFormatted: formatBytes(r.Size || 0),
        };
      })
      .filter(r => r.infoHash) // Only torrents with valid info hash
      .sort((a, b) => {
        // Sort by: 1) Quality, 2) Seeders
        const qualityOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
        const qualityDiff = (qualityOrder[b.quality] || 0) - (qualityOrder[a.quality] || 0);
        if (qualityDiff !== 0) return qualityDiff;
        return (b.seeders || 0) - (a.seeders || 0);
      });

    console.log(`[Jackett] Found ${results.length} torrents`);

    return NextResponse.json({
      results: results,
      count: results.length,
      query: searchQuery,
    });

  } catch (error) {
    console.error('[Jackett] Search error:', error);
    return NextResponse.json(
      { error: error.message || 'Jackett search failed' },
      { status: 500 }
    );
  }
}

// Extract quality tag from torrent title
function extractQuality(title) {
  const lower = title.toLowerCase();
  if (/2160p|4k|uhd/i.test(lower)) return '2160p';
  if (/1080p/i.test(lower)) return '1080p';
  if (/720p/i.test(lower)) return '720p';
  if (/480p/i.test(lower)) return '480p';
  return 'unknown';
}

// Format bytes to human-readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
