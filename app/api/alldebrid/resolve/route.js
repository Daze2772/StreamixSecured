import { NextResponse } from 'next/server';

/**
 * AllDebrid Direct Integration with Comet for Torrent Discovery
 * Similar to RD but uses AllDebrid's API
 */

const AD_API_KEY = process.env.ALLDEBRID_API_KEY;
const AD_API_BASE = 'https://api.alldebrid.com/v4';
const RD_ADDON_MANIFEST_URL = process.env.RD_ADDON_MANIFEST_URL; // Reuse Comet config

function getCometBase() {
  if (!RD_ADDON_MANIFEST_URL) return null;
  return RD_ADDON_MANIFEST_URL.replace(/\/manifest\.json\s*$/i, '').replace(/\/+$/, '');
}

async function adFetch(endpoint, options = {}) {
  const url = `${AD_API_BASE}${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${AD_API_KEY}`,
      ...options.headers,
    },
  });
  
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AD API ${response.status}: ${text}`);
  }
  
  const data = await response.json();
  
  if (data.status !== 'success') {
    throw new Error(`AD Error: ${data.error?.message || 'Unknown error'}`);
  }
  
  return data.data;
}

async function searchTorrentsViaComet(imdbId, season = null, episode = null) {
  const cometBase = getCometBase();
  if (!cometBase) {
    console.log('[AD] Comet not configured');
    return [];
  }

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
      headers: { 'User-Agent': 'Stremio/4.4 (Streamix)' },
    });
    
    if (!response.ok) {
      console.log(`[AD] Comet returned ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    if (!data.streams || !Array.isArray(data.streams)) {
      return [];
    }
    
    const torrents = [];
    for (const stream of data.streams) {
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
            fileIdx: null,
          });
        }
      }
    }
    
    console.log(`[AD] Comet found ${torrents.length} torrents`);
    
    // Filter for browser-compatible torrents
    const compatibleTorrents = torrents.filter(t => {
      const n = t.name.toLowerCase();
      
      if (n.includes('truehd') || n.includes('dts-hd') || n.includes('dts') || n.includes('atmos')) {
        return false;
      }
      
      const hasGoodAudio = n.includes('aac') || n.includes('ac3') || n.includes('dd') || n.includes('mp3');
      const hasGoodVideo = n.includes('h264') || n.includes('x264') || n.includes('avc') || !n.includes('hevc');
      
      return hasGoodAudio || hasGoodVideo;
    });
    
    console.log(`[AD] Filtered to ${compatibleTorrents.length} browser-compatible torrents`);
    
    return compatibleTorrents;
    
  } catch (error) {
    console.error('[AD] Comet search error:', error.message);
    return [];
  }
}

function rankTorrent(name) {
  const n = name.toLowerCase();
  let score = 0;
  
  if (n.includes('1080p')) score += 100;
  else if (n.includes('720p')) score += 80;
  else if (n.includes('2160p') || n.includes('4k')) score += 40;
  else if (n.includes('480p')) score += 20;
  
  if (n.includes('h264') || n.includes('h.264') || n.includes('x264') || n.includes('avc')) {
    score += 50;
  } else if (n.includes('h265') || n.includes('h.265') || n.includes('x265') || n.includes('hevc')) {
    score -= 30;
  }
  
  if (n.includes('aac') || n.includes('ac3') || n.includes('dd5.1') || n.includes('ddp') || n.includes('dd ')) {
    score += 40;
  } else if (n.includes('truehd') || n.includes('dts-hd') || n.includes('dts') || n.includes('atmos')) {
    score -= 50;
  }
  
  if (n.includes('.mp4') || n.includes(' mp4 ')) {
    score += 30;
  } else if (n.includes('.mkv') || n.includes(' mkv ')) {
    score -= 10;
  }
  
  if (n.includes('bluray') || n.includes('blu-ray')) score += 25;
  if (n.includes('web-dl') || n.includes('webdl') || n.includes('webrip')) score += 20;
  
  if (/(cam|hdcam|hdts|ts|telesync|telecine|tc|screener|scr)/i.test(n)) score -= 1000;
  
  if (n.includes('remux')) score -= 40;
  if (n.includes('10bit')) score -= 5;
  
  if (n.includes('yify') || n.includes('yts')) score += 15;
  
  return score;
}

async function addMagnet(magnet) {
  const formData = new URLSearchParams();
  formData.append('magnets[]', magnet);
  
  const data = await adFetch('/magnet/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  });
  
  if (!data.magnets || data.magnets.length === 0) {
    throw new Error('No magnet data returned');
  }
  
  return data.magnets[0];
}

async function getMagnetStatus(magnetId) {
  const data = await adFetch(`/magnet/status?id=${magnetId}`);
  return data.magnets;
}

async function unlockLink(link) {
  const data = await adFetch(`/link/unlock?link=${encodeURIComponent(link)}`);
  return data;
}

function selectBestFile(files, season = null, episode = null) {
  if (!files || !files.length) return null;
  
  const videoFiles = files.filter(f => {
    const name = (f.n || '').toLowerCase();
    return name.match(/\.(mkv|mp4|avi)$/) && f.s > 100000000;
  });
  
  if (!videoFiles.length) return files[0];
  
  if (season && episode) {
    const seEpPattern = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
    const altPattern = `${season}x${String(episode).padStart(2, '0')}`;
    
    const matchedFile = videoFiles.find(f => {
      const name = (f.n || '').toLowerCase();
      return name.includes(seEpPattern) || name.includes(altPattern);
    });
    
    if (matchedFile) {
      console.log(`[AD] Matched episode file: ${matchedFile.n}`);
      return matchedFile;
    }
    
    console.log(`[AD] WARNING: Could not find S${season}E${episode} in torrent files`);
  }
  
  return videoFiles.sort((a, b) => b.s - a.s)[0];
}

export async function GET(request) {
  if (!AD_API_KEY) {
    return NextResponse.json(
      { error: 'AllDebrid API key not configured' },
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
    console.log(`[AD] Resolving ${mediaType} ${imdbId}${season ? ` S${season}E${episode}` : ''}`);
    
    const torrents = await searchTorrentsViaComet(
      imdbId,
      season ? parseInt(season) : null,
      episode ? parseInt(episode) : null
    );

    if (!torrents.length) {
      console.log('[AD] No torrents found');
      return NextResponse.json(
        { error: 'No torrents found for this title' },
        { status: 404 }
      );
    }

    console.log(`[AD] Found ${torrents.length} browser-compatible torrents`);

    // Rank and select best torrent
    let bestTorrent = torrents[0];
    let bestScore = -Infinity;

    for (const torrent of torrents) {
      const score = rankTorrent(torrent.name);
      if (score > bestScore) {
        bestScore = score;
        bestTorrent = torrent;
      }
    }

    console.log(`[AD] Best torrent: ${bestTorrent.name.slice(0, 100)}`);

    // Add magnet to AllDebrid
    const magnetData = await addMagnet(bestTorrent.magnet);
    const magnetId = magnetData.id;
    console.log(`[AD] Added magnet ${magnetId}`);

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get magnet status and links
    let magnetStatus;
    for (let i = 0; i < 5; i++) {
      magnetStatus = await getMagnetStatus(magnetId);
      const status = magnetStatus.status;
      
      console.log(`[AD] Attempt ${i + 1}/5: status=${status}`);
      
      if (status === 'Ready') {
        break;
      }
      
      if (i < 4) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (magnetStatus.status !== 'Ready') {
      return NextResponse.json(
        { error: 'Magnet is still processing. Try again in a moment.' },
        { status: 202 }
      );
    }

    // Select best file
    const bestFile = selectBestFile(
      magnetStatus.links,
      season ? parseInt(season) : null,
      episode ? parseInt(episode) : null
    );

    if (!bestFile) {
      return NextResponse.json(
        { error: 'No suitable video file found' },
        { status: 404 }
      );
    }

    console.log(`[AD] Selected file: ${bestFile.n}`);

    // Unlock the link
    const unlocked = await unlockLink(bestFile.link);

    if (!unlocked.link) {
      return NextResponse.json(
        { error: 'Failed to get stream URL' },
        { status: 500 }
      );
    }

    console.log(`[AD] Success! Stream URL obtained`);

    return NextResponse.json({
      success: true,
      streamUrl: unlocked.link,
      filename: unlocked.filename || bestFile.n,
      quality: bestTorrent.name.slice(0, 100),
      size: bestFile.s,
    });

  } catch (error) {
    console.error('[AD] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to resolve stream' },
      { status: 500 }
    );
  }
}
