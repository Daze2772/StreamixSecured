import { NextResponse } from 'next/server';

/**
 * Proxy for Comet/Real-Debrid streams
 * Handles authentication and streams video content to the browser
 */

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const streamUrl = searchParams.get('url');

  if (!streamUrl) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  try {
    // Fetch the stream from Comet with proper headers
    const response = await fetch(streamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://comet.elfhosted.com/',
        'Origin': 'https://comet.elfhosted.com',
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Stream fetch failed: ${response.status}` },
        { status: response.status }
      );
    }

    // Stream the video content back to the client
    const headers = new Headers();
    headers.set('Content-Type', response.headers.get('Content-Type') || 'video/mp4');
    headers.set('Accept-Ranges', 'bytes');
    
    // Pass through range headers for seeking
    if (response.headers.get('Content-Range')) {
      headers.set('Content-Range', response.headers.get('Content-Range'));
    }
    if (response.headers.get('Content-Length')) {
      headers.set('Content-Length', response.headers.get('Content-Length'));
    }

    return new NextResponse(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    console.error('Stream proxy error:', error);
    return NextResponse.json(
      { error: 'Failed to proxy stream' },
      { status: 500 }
    );
  }
}
