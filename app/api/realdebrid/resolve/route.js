import { NextResponse } from 'next/server';

/**
 * Real-Debrid Direct Integration with Comet for Torrent Discovery
 * 
 * Uses Comet's configured addon to discover torrents (it has excellent scrapers),
 * then extracts the torrent hashes and uses Real-Debrid API directly to get stream URLs.
 */

const RD_API_KEY = process.env.REAL_DEBRID_API_KEY;
const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';
const RD_ADDON_MANIFEST_URL = process.env.RD_ADDON_MANIFEST_URL;

function getCometBase() {
  if (!RD_ADDON_MANIFEST_URL) return null;
  return RD_ADDON_MANIFEST_URL.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '');
}

async function rdFetch(endpoint, options = {}) {
  const url = `${RD_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${RD_API_KEY}`,
      ...options.headers,
    },
  });
  
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`RD API ${response.status}: ${text}`);
  }
  
  return response.json();
}


async function searchTorrentsViaComet(imdbId, season = null, episode = null) {
  const cometBase = getCometBase();
  if (!cometBase) {
    console.log('[RD] Comet not configured');
    return [];
  }

  // Build stream ID
  let streamId;
  if (season && episode) {
    streamId = `${imdbId}:${season}:${episode}`;
  } else {
    streamId = imdbId;
  }
  
  const streamType = season ? 'series' : 'movie';
  const url = `${cometBase}/stream/${streamType}/${streamId}.json`;
  
  try {
    const response = await fetch(url, { 
      timeout: 15000,
      headers: {
        'User-Agent': 'Stremio/4.4 (Streamix)',
      },
    });
    
    if (!response.ok) {
      console.log(`[RD] Comet returned ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    if (!data.streams || !Array.isArray(data.streams)) {
      return [];
    }
    
    // Parse Comet results and extract torrent hashes
    const torrents = [];
    for (const stream of data.streams) {
      // Comet's bingeGroup format: "comet|realdebrid|{hash}"
      if (stream.behaviorHints?.bingeGroup) {
        const parts = stream.behaviorHints.bingeGroup.split('|');
        if (parts.length >= 3) {
          const hash = parts[2].toLowerCase();
          const name = stream.name || stream.description || 'Unknown';
          const filename = stream.behaviorHints?.filename || '';
          
          torrents.push({
            hash,
            name: `${name} - ${filename}`.slice(0, 200),
            magnet: `magnet:?xt=urn:btih:${hash}`,
            fileIdx: null, // Comet already resolved the best file
            cometUrl: stream.url, // Keep Comet's direct URL as backup
          });
        }
      }
    }
    
    console.log(`[RD] Comet found ${torrents.length} torrents`);
    
    // Filter for browser-compatible torrents FIRST
    const compatibleTorrents = torrents.filter(t => {
      const n = t.name.toLowerCase();
      
      // MUST NOT have unsupported audio codecs
      if (n.includes('truehd') || n.includes('dts-hd') || n.includes('dts') || n.includes('atmos')) {
        return false; // Will have NO audio in browser
      }
      
      // Prefer supported codecs
      const hasGoodAudio = n.includes('aac') || n.includes('ac3') || n.includes('dd') || n.includes('mp3');
      const hasGoodVideo = n.includes('h264') || n.includes('x264') || n.includes('avc') || !n.includes('hevc');
      
      return hasGoodAudio || hasGoodVideo; // At least one should be good
    });
    
    console.log(`[RD] Filtered to ${compatibleTorrents.length} browser-compatible torrents`);
    
    return compatibleTorrents;
    
  } catch (error) {
    console.error('[RD] Comet search error:', error.message);
    return [];
  }
}

function rankTorrent(name) {
  const n = name.toLowerCase();
  let score = 0;
  
  // Resolution (favor 1080p for best balance of quality and browser compatibility)
  if (n.includes('1080p')) score += 100;
  else if (n.includes('720p')) score += 80;
  else if (n.includes('2160p') || n.includes('4k')) score += 40; // Lower priority - large files, often HEVC
  else if (n.includes('480p')) score += 20;
  
  // Video codec - CRITICAL FOR BROWSER PLAYBACK
  if (n.includes('h264') || n.includes('h.264') || n.includes('x264') || n.includes('avc')) {
    score += 50; // H.264/AVC is universally supported in all browsers
  } else if (n.includes('h265') || n.includes('h.265') || n.includes('x265') || n.includes('hevc')) {
    score -= 30; // HEVC/H.265 has limited browser support (Safari only with hardware decode)
  }
  
  // Audio codec - CRITICAL FOR BROWSER PLAYBACK
  if (n.includes('aac') || n.includes('ac3') || n.includes('dd5.1') || n.includes('ddp') || n.includes('dd ')) {
    score += 40; // AAC/AC3/Dolby Digital are browser-compatible
  } else if (n.includes('truehd') || n.includes('dts-hd') || n.includes('dts') || n.includes('atmos')) {
    score -= 50; // Lossless/advanced audio NOT supported in browsers - will have no sound!
  }
  
  // Container - MP4 is best for browsers
  if (n.includes('.mp4') || n.includes(' mp4 ')) {
    score += 30;
  } else if (n.includes('.mkv') || n.includes(' mkv ')) {
    score -= 10; // MKV can have compatibility issues
  }
  
  // Quality indicators
  if (n.includes('bluray') || n.includes('blu-ray')) score += 25;
  if (n.includes('web-dl') || n.includes('webdl') || n.includes('webrip')) score += 20;
  
  // Penalize bad quality
  if (/(cam|hdcam|hdts|ts|telesync|telecine|tc|screener|scr)/i.test(n)) score -= 1000;
  
  // Penalize very large files (remuxes are slow to buffer and usually have unsupported audio)
  if (n.includes('remux')) score -= 40;
  if (n.includes('10bit')) score -= 5; // Often paired with HEVC
  
  // Favor smaller, efficient encodes (better for streaming)
  if (n.includes('yify') || n.includes('yts')) score += 15;
  
  return score;
}

async function checkInstantAvailability(hashes) {
  if (!hashes.length) return {};
  
  const hashesStr = hashes.slice(0, 100).join('/'); // RD API limit
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
    throw new Error(`Add magnet failed: ${response.status}`);
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
    throw new Error(`Select files failed: ${response.status}`);
  }
}

async function getTorrentInfo(torrentId) {
  return await rdFetch(`/torrents/info/${torrentId}?t=${Date.now()}`); // Cache bust
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
    throw new Error(`Unrestrict failed: ${response.status}`);
  }
  
  return response.json();
}

function selectBestFile(files, torrentFileIdx = null, season = null, episode = null) {
  if (!files || !files.length) return null;
  
  // If Comet specified a file index, use it (they already matched the episode)
  if (torrentFileIdx !== null) {
    const file = files[torrentFileIdx - 1]; // 1-based index
    if (file) return file;
  }
  
  // Filter video files
  const videoFiles = files.filter(f => {
    const name = f.path?.toLowerCase() || '';
    return name.match(/\.(mkv|mp4|avi)$/) && f.bytes > 100000000; // > 100MB
  });
  
  if (!videoFiles.length) return files[0]; // Fallback
  
  // For TV shows, try to match the specific episode
  if (season && episode) {
    const seEpPattern = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
    const altPattern = `${season}x${String(episode).padStart(2, '0')}`; // Alternative format
    
    const matchedFile = videoFiles.find(f => {
      const name = f.path?.toLowerCase() || '';
      return name.includes(seEpPattern) || name.includes(altPattern);
    });
    
    if (matchedFile) {
      console.log(`[RD] Matched episode file: ${matchedFile.path}`);
      return matchedFile;
    }
    
    console.log(`[RD] WARNING: Could not find S${season}E${episode} in torrent files`);
  }
  
  // Return largest video file as fallback
  return videoFiles.sort((a, b) => b.bytes - a.bytes)[0];
}

export async function GET(request) {
  if (!RD_API_KEY) {
    return NextResponse.json(
      { error: 'Real-Debrid API key not configured' },
      { status: 503 }
    );
  }

  const { searchParams } = new URL(request.url);
  const mediaType = searchParams.get('type');
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
    console.log(`[RD] Resolving ${mediaType} ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
    
    // Step 1: Search torrents via Comet
    const torrents = await searchTorrentsViaComet(
      imdbId,
      season ? parseInt(season) : null,
      episode ? parseInt(episode) : null
    );

    if (!torrents.length) {
      console.log('[RD] No torrents found');
      return NextResponse.json(
        { error: 'No torrents found for this title' },
        { status: 404 }
      );
    }
    
    // Check if filtering removed all torrents
    const totalFound = torrents.length;
    if (totalFound > 0 && torrents.every(t => {
      const n = t.name.toLowerCase();
      return n.includes('truehd') || n.includes('dts') || n.includes('atmos');
    })) {
      console.log('[RD] All torrents have incompatible audio codecs');
      return NextResponse.json(
        { 
          error: `Found ${totalFound} cached torrents, but all use audio codecs not supported in browsers (TrueHD/DTS/Atmos)`,
          hint: 'Try VidLink or VidSrc servers instead - they work in all browsers'
        },
        { status: 404 }
      );
    }

    // Comet already filters for RD-cached torrents, so we can skip availability check
    // and just use the best-ranked torrent directly
    console.log(`[RD] Found ${torrents.length} RD-cached torrents`);

    // Step 2: Rank and select best torrent
    let bestTorrent = torrents[0]; // Default to first
    let bestScore = -Infinity;

    for (const torrent of torrents) {
      const score = rankTorrent(torrent.name);
      if (score > bestScore) {
        bestScore = score;
        bestTorrent = torrent;
      }
    }

    console.log(`[RD] Best torrent: ${bestTorrent.name.slice(0, 100)}`);

    // Step 3: Add magnet to RD
    const { id: torrentId } = await addMagnet(bestTorrent.magnet);
    console.log(`[RD] Added torrent ${torrentId}`);

    // Step 4: Get torrent info and select best file
    const torrentInfo = await getTorrentInfo(torrentId);
    console.log(`[RD] Torrent status: ${torrentInfo.status}, files: ${torrentInfo.files?.length || 0}`);
    
    const bestFile = selectBestFile(
      torrentInfo.files,
      bestTorrent.fileIdx,
      season ? parseInt(season) : null,
      episode ? parseInt(episode) : null
    );

    if (!bestFile) {
      return NextResponse.json(
        { error: 'No suitable video file found in torrent' },
        { status: 404 }
      );
    }

    console.log(`[RD] Selected file: ${bestFile.path}`);

    // Step 5: Select files
    await selectFiles(torrentId, String(bestFile.id));
    console.log(`[RD] Files selected, waiting for RD to generate download links...`);

    // Wait and get download links (with retries)
    let info;
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      info = await getTorrentInfo(torrentId);
      console.log(`[RD] Attempt ${i + 1}/5: status=${info.status}, links=${info.links?.length || 0}`);
      if (info.links && info.links.length > 0) break;
    }
    
    if (!info.links || info.links.length === 0) {
      return NextResponse.json(
        { error: 'Torrent is being prepared. This can take 10-30 seconds for large files.' },
        { status: 202 }
      );
    }

    // Step 6: Unrestrict the link
    const unrestricted = await unrestrictLink(info.links[0]);

    if (!unrestricted.download) {
      return NextResponse.json(
        { error: 'Failed to get stream URL from Real-Debrid' },
        { status: 500 }
      );
    }

    console.log(`[RD] Success! Stream URL obtained`);

    // Success!
    return NextResponse.json({
      success: true,
      streamUrl: unrestricted.download,
      filename: unrestricted.filename || bestFile.path,
      quality: bestTorrent.name.slice(0, 100),
      size: bestFile.bytes,
    });

  } catch (error) {
    console.error('[RD] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to resolve stream' },
      { status: 500 }
    );
  }
}
