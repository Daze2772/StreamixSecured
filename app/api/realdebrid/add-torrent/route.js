import { NextResponse } from 'next/server';

/**
 * Real-Debrid Torrent Adder
 * 
 * Adds a magnet link to Real-Debrid and tracks download progress.
 * Used for uncached torrents that need to be downloaded before streaming.
 */

const RD_API_KEY = process.env.RD_API_KEY;
const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';

export async function POST(request) {
  try {
    if (!RD_API_KEY) {
      return NextResponse.json(
        { error: 'Real-Debrid API key not configured' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { magnet } = body;

    if (!magnet) {
      return NextResponse.json(
        { error: 'Magnet URI required' },
        { status: 400 }
      );
    }

    console.log('[RD Add] Adding magnet to Real-Debrid...');

    // Step 1: Add magnet to RD
    const addResponse = await fetch(`${RD_API_BASE}/torrents/addMagnet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RD_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ magnet }),
      signal: AbortSignal.timeout(10000),
    });

    if (!addResponse.ok) {
      const errorText = await addResponse.text();
      throw new Error(`RD addMagnet failed: ${addResponse.status} - ${errorText}`);
    }

    const addData = await addResponse.json();
    const torrentId = addData.id;

    if (!torrentId) {
      throw new Error('No torrent ID returned from RD');
    }

    console.log(`[RD Add] Torrent added: ${torrentId}`);

    // Step 2: Get torrent info to select files
    const infoResponse = await fetch(`${RD_API_BASE}/torrents/info/${torrentId}`, {
      headers: {
        'Authorization': `Bearer ${RD_API_KEY}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!infoResponse.ok) {
      throw new Error(`RD info failed: ${infoResponse.status}`);
    }

    const info = await infoResponse.json();

    // Step 3: Select all files for download
    const fileIds = (info.files || []).map(f => f.id).join(',');

    if (fileIds) {
      const selectResponse = await fetch(`${RD_API_BASE}/torrents/selectFiles/${torrentId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RD_API_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ files: fileIds }),
        signal: AbortSignal.timeout(10000),
      });

      if (!selectResponse.ok) {
        console.warn('[RD Add] File selection failed, but continuing...');
      } else {
        console.log('[RD Add] Files selected for download');
      }
    }

    // Return torrent info
    return NextResponse.json({
      torrentId: torrentId,
      status: info.status,
      filename: info.filename || info.original_filename || 'Unknown',
      bytes: info.bytes || 0,
      progress: info.progress || 0,
      speed: info.speed || 0,
      seeders: info.seeders || 0,
    });

  } catch (error) {
    console.error('[RD Add] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to add torrent' },
      { status: 500 }
    );
  }
}

// GET endpoint to check status of a torrent
export async function GET(request) {
  try {
    if (!RD_API_KEY) {
      return NextResponse.json(
        { error: 'Real-Debrid API key not configured' },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const torrentId = searchParams.get('torrentId');

    if (!torrentId) {
      return NextResponse.json(
        { error: 'Torrent ID required' },
        { status: 400 }
      );
    }

    // Get torrent info
    const response = await fetch(`${RD_API_BASE}/torrents/info/${torrentId}`, {
      headers: {
        'Authorization': `Bearer ${RD_API_KEY}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`RD info failed: ${response.status}`);
    }

    const info = await response.json();

    // Check if download is complete
    const isComplete = info.status === 'downloaded' || info.progress >= 100;

    // If complete, get unrestricted link
    let links = [];
    if (isComplete && info.links && info.links.length > 0) {
      // Get first video file link
      const videoLink = info.links.find(link => {
        const ext = link.split('.').pop().toLowerCase();
        return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v'].includes(ext);
      }) || info.links[0];

      // Unrestrict the link
      try {
        const unrestrictResponse = await fetch(`${RD_API_BASE}/unrestrict/link`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RD_API_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ link: videoLink }),
          signal: AbortSignal.timeout(10000),
        });

        if (unrestrictResponse.ok) {
          const unrestrictData = await unrestrictResponse.json();
          links.push({
            url: unrestrictData.download,
            filename: unrestrictData.filename,
            filesize: unrestrictData.filesize,
          });
        }
      } catch (e) {
        console.warn('[RD Status] Unrestrict failed:', e);
      }
    }

    return NextResponse.json({
      torrentId: torrentId,
      status: info.status,
      filename: info.filename || info.original_filename || 'Unknown',
      bytes: info.bytes || 0,
      progress: info.progress || 0,
      speed: info.speed || 0,
      seeders: info.seeders || 0,
      isComplete: isComplete,
      links: links,
    });

  } catch (error) {
    console.error('[RD Status] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to get torrent status' },
      { status: 500 }
    );
  }
}
