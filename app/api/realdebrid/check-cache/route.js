import { NextResponse } from 'next/server';

/**
 * Real-Debrid Cache Checker
 * 
 * Checks if torrents are instantly available (cached) on Real-Debrid.
 * Takes array of magnet URIs or info hashes.
 */

const RD_API_KEY = process.env.RD_API_KEY;
const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';

export async function POST(request) {
  try {
    if (!RD_API_KEY) {
      return NextResponse.json(
        { error: 'Real-Debrid API key not configured (RD_API_KEY missing)' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { magnets = [], infoHashes = [] } = body;

    if (magnets.length === 0 && infoHashes.length === 0) {
      return NextResponse.json(
        { error: 'No magnets or info hashes provided' },
        { status: 400 }
      );
    }

    // Extract info hashes from magnets if needed
    const hashes = [...infoHashes];
    for (const magnet of magnets) {
      const match = magnet.match(/btih:([a-fA-F0-9]{40})/i);
      if (match) {
        hashes.push(match[1].toLowerCase());
      }
    }

    if (hashes.length === 0) {
      return NextResponse.json(
        { error: 'No valid info hashes found' },
        { status: 400 }
      );
    }

    console.log(`[RD Cache] Checking ${hashes.length} torrents...`);

    // RD instant availability API
    // Can check multiple hashes in one request (separated by /)
    const hashesParam = hashes.slice(0, 100).join('/'); // Limit to 100 per request

    const response = await fetch(
      `${RD_API_BASE}/torrents/instantAvailability/${hashesParam}`,
      {
        headers: {
          'Authorization': `Bearer ${RD_API_KEY}`,
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new Error(`RD API returned ${response.status}`);
    }

    const data = await response.json();

    // Parse response
    // Format: { "hash1": { "rd": [{ "files": [...] }] }, "hash2": { "rd": [...] } }
    const cacheStatus = {};

    for (const hash of hashes) {
      const hashData = data[hash];
      
      if (hashData && hashData.rd && hashData.rd.length > 0) {
        // Cached! Get file info
        const rdVariants = hashData.rd;
        const bestVariant = rdVariants[0]; // Use first variant (usually complete torrent)
        
        cacheStatus[hash] = {
          cached: true,
          variants: rdVariants.length,
          files: bestVariant.files || [],
        };
      } else {
        cacheStatus[hash] = {
          cached: false,
        };
      }
    }

    const cachedCount = Object.values(cacheStatus).filter(s => s.cached).length;
    console.log(`[RD Cache] ${cachedCount}/${hashes.length} torrents cached`);

    return NextResponse.json({
      cacheStatus: cacheStatus,
      totalChecked: hashes.length,
      totalCached: cachedCount,
    });

  } catch (error) {
    console.error('[RD Cache] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Cache check failed' },
      { status: 500 }
    );
  }
}
