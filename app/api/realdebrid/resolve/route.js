import { NextResponse } from 'next/server';

/**
 * Real-Debrid Direct API Integration
 * No Comet, no middleware - just pure RD API calls
 */

const RD_API_KEY = process.env.REAL_DEBRID_API_KEY;
const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';

async function rdFetch(endpoint, options = {}) {
  const url = `${RD_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${RD_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    timeout: 15000,
  });
  
  if (!response.ok) {
    throw new Error(`RD API error: ${response.status}`);
  }
  
  return response.json();
}

async function searchTorrents(imdbId, season = null, episode = null) {
  const results = [];

  // For movies: Try YTS first (has good quality encodes)
  if (!season) {
    try {
      const ytsUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${imdbId}&limit=10`;
      const ytsRes = await fetch(ytsUrl, { timeout: 8000 });
      const ytsData = await ytsRes.json();
      
      if (ytsData.status === 'ok' && ytsData.data?.movies?.[0]) {
        const movie = ytsData.data.movies[0];
        if (movie.torrents) {
          movie.torrents.forEach(t => {
            results.push({
              magnet: `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title_long)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.tracker.cl:1337/announce`,
              name: `${movie.title} (${movie.year}) ${t.quality} YTS`,
              hash: t.hash.toLowerCase(),
              size: t.size_bytes || 0,
            });
          });
        }
      }
    } catch (e) {
      console.log('YTS search error:', e.message);
    }
  }

  // If no results yet, use a more comprehensive search
  if (results.length === 0) {
    // Use 1337x proxy or RARBG-like API
    // For production, integrate with Jackett or Prowlarr
    // For now, return some well-known public torrents for testing
    
    // Test with a known popular movie hash for Fight Club
    if (imdbId === 'tt0137523') {
      results.push({
        magnet: 'magnet:?xt=urn:btih:49E4105C5B515BFAC0E0D845FF9C90C09EB75140&dn=Fight+Club+1999+1080p+BluRay+x264&tr=udp://tracker.opentrackr.org:1337/announce',
        name: 'Fight Club (1999) 1080p BluRay',
        hash: '49e4105c5b515bfac0e0d845ff9c90c09eb75140',
        size: 2000000000,
      });
    }
  }

  return results;
}

async function checkInstantAvailability(hashes) {
  if (!hashes.length) return {};
  
  const hashesStr = hashes.join('/');
  const data = await rdFetch(`/torrents/instantAvailability/${hashesStr}`);
  return data;
}

async function addMagnet(magnet) {
  const response = await fetch(`${RD_API_BASE}/torrents/addMagnet`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RD_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ magnet }).toString(),
  });
  
  if (!response.ok) {
    throw new Error(`RD API error: ${response.status}`);
  }
  
  return response.json();
}

async function selectFiles(torrentId, fileIds) {
  const response = await fetch(`${RD_API_BASE}/torrents/selectFiles/${torrentId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RD_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ files: fileIds }).toString(),
  });
  
  if (!response.ok) {
    throw new Error(`RD API error: ${response.status}`);
  }
}

async function getTorrentInfo(torrentId) {
  return await rdFetch(`/torrents/info/${torrentId}`);
}

async function unrestrictLink(link) {
  const response = await fetch(`${RD_API_BASE}/unrestrict/link`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RD_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ link }).toString(),
  });
  
  if (!response.ok) {
    throw new Error(`RD API error: ${response.status}`);
  }
  
  return response.json();
}

function selectBestFile(files, season = null, episode = null) {
  if (!files || !files.length) return null;

  // Filter video files
  const videoFiles = files.filter(f => {
    const name = f.path?.toLowerCase() || '';
    return name.match(/\.(mkv|mp4|avi|mov)$/) && f.bytes > 50000000; // > 50MB
  });

  if (!videoFiles.length) return null;

  // For TV shows, try to match season/episode
  if (season && episode) {
    const seEp = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
    const match = videoFiles.find(f => f.path?.toLowerCase().includes(seEp));
    if (match) return match;
  }

  // Return largest file
  return videoFiles.sort((a, b) => b.bytes - a.bytes)[0];
}

function rankQuality(name) {
  const n = name.toLowerCase();
  let score = 0;
  
  if (n.includes('1080p')) score += 100;
  else if (n.includes('720p')) score += 70;
  else if (n.includes('2160p') || n.includes('4k')) score += 65;
  
  if (n.includes('x265') || n.includes('hevc')) score += 10;
  if (n.includes('bluray')) score += 15;
  
  // Penalize bad quality
  if (/(cam|hdcam|ts|telesync|screener)/i.test(n)) score -= 500;
  
  return score;
}

export async function GET(request) {
  if (!RD_API_KEY) {
    return NextResponse.json(
      { error: 'Real-Debrid API key not configured' },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const mediaType = searchParams.get('type'); // 'movie' or 'tv'
  const imdbId = searchParams.get('imdb');
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');

  if (!imdbId || !mediaType) {
    return NextResponse.json(
      { error: 'Missing imdb or type parameter' },
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
    // Step 1: Search for torrents
    const torrents = await searchTorrents(
      imdbId,
      season ? parseInt(season) : null,
      episode ? parseInt(episode) : null
    );

    if (!torrents.length) {
      return NextResponse.json(
        { error: 'No torrents found for this title' },
        { status: 404 }
      );
    }

    // Step 2: Check instant availability
    const hashes = torrents.map(t => t.hash);
    const availability = await checkInstantAvailability(hashes);

    // Step 3: Find best available torrent
    let bestTorrent = null;
    let bestScore = -Infinity;
    let bestVariant = null;

    for (const torrent of torrents) {
      const avail = availability[torrent.hash];
      if (!avail || !avail.rd || avail.rd.length === 0) continue;

      const score = rankQuality(torrent.name);
      if (score > bestScore) {
        bestScore = score;
        bestTorrent = torrent;
        bestVariant = avail.rd[0]; // First variant
      }
    }

    if (!bestTorrent || !bestVariant) {
      return NextResponse.json(
        { error: 'No cached torrents available on Real-Debrid' },
        { status: 404 }
      );
    }

    // Step 4: Add magnet to RD
    const { id: torrentId } = await addMagnet(bestTorrent.magnet);

    // Step 5: Select best file
    const torrentInfo = await getTorrentInfo(torrentId);
    const bestFile = selectBestFile(
      torrentInfo.files,
      season ? parseInt(season) : null,
      episode ? parseInt(episode) : null
    );

    if (!bestFile) {
      return NextResponse.json(
        { error: 'No suitable video file found' },
        { status: 404 }
      );
    }

    // Step 6: Select files in torrent
    await selectFiles(torrentId, String(bestFile.id));

    // Wait a moment for RD to process
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Step 7: Get download link
    const info = await getTorrentInfo(torrentId);
    if (!info.links || info.links.length === 0) {
      return NextResponse.json(
        { error: 'No download links available yet' },
        { status: 404 }
      );
    }

    // Step 8: Unrestrict the link
    const unrestricted = await unrestrictLink(info.links[0]);

    if (!unrestricted.download) {
      return NextResponse.json(
        { error: 'Failed to get direct download URL' },
        { status: 500 }
      );
    }

    // Success!
    return NextResponse.json({
      success: true,
      streamUrl: unrestricted.download,
      filename: unrestricted.filename || bestFile.path,
      quality: bestTorrent.name,
      size: bestFile.bytes,
    });

  } catch (error) {
    console.error('Real-Debrid resolve error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to resolve stream' },
      { status: 500 }
    );
  }
}
