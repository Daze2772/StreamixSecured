// Client-side AllDebrid integration
// Runs in user's browser using their residential IP

const AD_API_BASE = 'https://api.alldebrid.com/v4.1'; // Updated to v4.1

export async function resolveAllDebrid({ imdbId, mediaType, season, episode, adApiKey, cometManifestUrl }) {
  console.log('[AD Client] Starting resolution...');

  try {
    // Step 1: Search torrents via Comet
    const torrents = await searchTorrentsViaComet(imdbId, mediaType, season, episode, cometManifestUrl);
    
    if (!torrents.length) {
      throw new Error('No torrents found for this title');
    }

    console.log(`[AD Client] Found ${torrents.length} torrents`);

    if (!torrents.length) {
      throw new Error('No torrents found for this title');
    }

    // Step 2: DON'T filter - rank ALL torrents (browser-compatible higher, but try everything)
    const ranked = torrents
      .map(t => ({ ...t, score: rankTorrent(t.name) }))
      .sort((a, b) => b.score - a.score);

    console.log(`[AD Client] Ranked ${ranked.length} torrents, trying best options...`);

    // Step 4: Try top 3 torrents (in case first isn't instantly cached)
    let success = false;
    let lastError = null;
    
    for (let torrentIdx = 0; torrentIdx < Math.min(3, ranked.length); torrentIdx++) {
      const best = ranked[torrentIdx];
      console.log(`[AD Client] Trying torrent ${torrentIdx + 1}/3: ${best.name.slice(0, 80)}`);

      try {
        // Add magnet to AllDebrid
        const magnet = await addMagnetAD(best.magnet, adApiKey);
        console.log(`[AD Client] Magnet added: ${magnet.id}`);

        // Wait and check if it's ready quickly (for cached torrents)
        await sleep(2000);
        
        let status;
        for (let i = 0; i < 8; i++) {
          status = await getMagnetStatusAD(magnet.id, adApiKey);
          console.log(`[AD Client] Torrent ${torrentIdx + 1}, attempt ${i + 1}/8: ${status.status}`);
          
          if (status.status === 'Ready') {
            success = true;
            break;
          }
          
          if (i < 7) await sleep(3000);
        }

        if (success) {
          // Select best file
          const file = selectBestFile(status.links, season, episode);
          
          if (!file) {
            throw new Error('No suitable video file found');
          }

          console.log(`[AD Client] File: ${file.n}`);

          // Unlock link
          const unlocked = await unlockLinkAD(file.link, adApiKey);

          console.log('[AD Client] Success!');

          return {
            success: true,
            streamUrl: unlocked.link,
            quality: best.name.slice(0, 100),
            filename: unlocked.filename || file.n,
          };
        }
        
        // Not ready yet, try next torrent
        lastError = `Torrent not instantly cached`;
        console.log(`[AD Client] Torrent ${torrentIdx + 1} not cached, trying next...`);
        
      } catch (err) {
        console.error(`[AD Client] Torrent ${torrentIdx + 1} failed:`, err.message);
        lastError = err.message;
        continue;
      }
    }
    
    // If we get here, none of the torrents worked
    throw new Error(`No instantly cached torrents found on AllDebrid. Try RD Premium instead.`);

  } catch (error) {
    console.error('[AD Client] Error:', error);
    throw error;
  }
}

async function searchTorrentsViaComet(imdbId, mediaType, season, episode, manifestUrl) {
  const cometBase = manifestUrl.replace(/\/manifest\.json.*$/i, '');
  const streamId = season ? `${imdbId}:${season}:${episode}` : imdbId;
  const streamType = mediaType === 'tv' ? 'series' : 'movie';
  const url = `${cometBase}/stream/${streamType}/${streamId}.json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Comet returned ${res.status}`);

  const data = await res.json();
  if (!data.streams) return [];

  return data.streams
    .filter(s => s.behaviorHints?.bingeGroup)
    .map(s => {
      const parts = s.behaviorHints.bingeGroup.split('|');
      const hash = parts[2]?.toLowerCase();
      if (!hash) return null;

      return {
        hash,
        name: `${s.name || ''} - ${s.behaviorHints?.filename || ''}`.slice(0, 200),
        magnet: `magnet:?xt=urn:btih:${hash}`,
      };
    })
    .filter(Boolean);
}

function rankTorrent(name) {
  const n = name.toLowerCase();
  let score = 0;

  if (n.includes('1080p')) score += 100;
  else if (n.includes('720p')) score += 80;
  else if (n.includes('2160p')) score += 40;

  if (n.includes('h264') || n.includes('x264') || n.includes('avc')) score += 50;
  else if (n.includes('hevc') || n.includes('h265')) score -= 30;

  if (n.includes('aac') || n.includes('ac3') || n.includes('dd')) score += 40;
  else if (n.includes('truehd') || n.includes('dts')) score -= 50;

  if (n.includes('.mp4')) score += 30;
  else if (n.includes('.mkv')) score -= 10;

  if (n.includes('bluray')) score += 25;
  if (n.includes('web-dl') || n.includes('webrip')) score += 20;
  if (/(cam|hdcam|ts|telesync)/i.test(n)) score -= 1000;

  return score;
}

async function addMagnetAD(magnet, apiKey) {
  const formData = new URLSearchParams();
  formData.append('magnets[]', magnet);

  const res = await fetch(`${AD_API_BASE}/magnet/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });

  if (!res.ok) throw new Error(`AD API ${res.status}`);

  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error(data.error?.message || 'Failed to add magnet');
  }

  return data.data.magnets[0];
}

async function getMagnetStatusAD(magnetId, apiKey) {
  const res = await fetch(`${AD_API_BASE}/magnet/status?id=${magnetId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`AD API ${res.status}`);

  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error(data.error?.message || 'Failed to get status');
  }

  return data.data.magnets;
}

async function unlockLinkAD(link, apiKey) {
  const res = await fetch(`${AD_API_BASE}/link/unlock?link=${encodeURIComponent(link)}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!res.ok) throw new Error(`AD API ${res.status}`);

  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error(data.error?.message || 'Failed to unlock link');
  }

  return data.data;
}

function selectBestFile(files, season, episode) {
  if (!files?.length) return null;

  const videoFiles = files.filter(f => {
    const name = (f.n || '').toLowerCase();
    return name.match(/\.(mkv|mp4|avi)$/) && f.s > 100000000;
  });

  if (!videoFiles.length) return files[0];

  if (season && episode) {
    const pattern = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
    const match = videoFiles.find(f => (f.n || '').toLowerCase().includes(pattern));
    if (match) return match;
  }

  return videoFiles.sort((a, b) => b.s - a.s)[0];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
