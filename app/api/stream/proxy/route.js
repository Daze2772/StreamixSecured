import { NextResponse } from 'next/server';
import { isPrivateIp } from '@/lib/security-utils';

/**
 * Stream Proxy
 * ============
 * Premium backend CDN (and Comet's /playback redirect) serves video files with:
 *   Content-Type: application/force-download
 *   Content-Disposition: attachment; filename="..."
 *
 * Those headers force the browser to download the file instead of streaming
 * it in <video>. This proxy:
 *   1. Forwards the upstream byte range (so seeking works in <video>)
 *   2. Strips `Content-Disposition` so browsers play inline
 *   3. Rewrites `Content-Type` to a real video MIME based on the extension
 *   4. Passes through `Accept-Ranges`, `Content-Range`, `Content-Length`,
 *      and the upstream status (200 for full body, 206 for range)
 *
 * The proxy follows the Comet /playback redirect itself so the browser only
 * ever sees one origin (us). This also keeps the long signed backend URL out of
 * client-visible DOM.
 *
 * Usage:  /api/stream/proxy?url=<encoded-upstream-url>&ext=mp4
 *
 * Note: this is a streaming pass-through — we don't buffer the whole file.
 * Range requests are forwarded so the player can seek freely.
 *
 * SECURITY: SSRF protection prevents proxying to private IPs or localhost.
 */

export const dynamic = 'force-dynamic';
// Node runtime needed for streaming + redirect chasing
export const runtime = 'nodejs';

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m3u8: 'application/vnd.apple.mpegurl',
};

function guessMime(urlOrName, forced) {
  if (forced && MIME_BY_EXT[forced.toLowerCase()]) {
    return MIME_BY_EXT[forced.toLowerCase()];
  }
  try {
    const cleaned = (urlOrName || '').split('?')[0].split('#')[0];
    const m = cleaned.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (m && MIME_BY_EXT[m[1]]) return MIME_BY_EXT[m[1]];
  } catch (_) { /* ignore */ }
  return 'video/mp4';
}

function isAllowedHost(host) {
  // Whitelist the hosts we will proxy through. This stops the endpoint from
  // being abused as an open proxy for arbitrary URLs.
  if (!host) return false;
  const h = host.toLowerCase();
  return (
    h.endsWith('.real-debrid.com') ||
    h === 'real-debrid.com' ||
    h.endsWith('.alldebrid.com') ||
    h === 'alldebrid.com' ||
    h.endsWith('.elfhosted.com') ||
    h.endsWith('.debrid.it') ||
    h.endsWith('.rdeb.io')
  );
}

async function handle(request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');
  const ext = searchParams.get('ext'); // optional override (mp4|mkv)

  if (!target) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let upstream;
  try {
    upstream = new URL(target);
  } catch (_) {
    return NextResponse.json({ error: 'Invalid url parameter' }, { status: 400 });
  }

  // ── SECURITY: SSRF protection ────────────────────────────────────
  // Block private IPs (RFC1918, loopback, link-local) to prevent
  // attackers from using this proxy to scan internal network
  if (isPrivateIp(upstream.hostname)) {
    return NextResponse.json(
      { error: 'Private IPs and localhost are not allowed' },
      { status: 403 },
    );
  }

  if (!isAllowedHost(upstream.hostname)) {
    return NextResponse.json(
      { error: `Host not allowed: ${upstream.hostname}` },
      { status: 403 },
    );
  }

  // Build forwarded headers (Range + User-Agent only)
  const fwdHeaders = {
    'User-Agent': 'Streamix/1.0 (+video proxy)',
    Accept: '*/*',
  };
  const range = request.headers.get('range');
  if (range) fwdHeaders.Range = range;

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream.toString(), {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: fwdHeaders,
      redirect: 'follow',
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Upstream fetch failed: ${e.message}` },
      { status: 502 },
    );
  }

  // Determine MIME — prefer ext override, else final URL, else fallback
  const finalUrl = upstreamRes.url || upstream.toString();
  const mime = guessMime(finalUrl, ext);

  // Pass through key headers, override Content-Type, strip Content-Disposition
  const passHeaders = new Headers();
  const pickThrough = [
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
    'cache-control',
  ];
  for (const k of pickThrough) {
    const v = upstreamRes.headers.get(k);
    if (v) passHeaders.set(k, v);
  }
  passHeaders.set('Content-Type', mime);
  // Many CDNs default to no Accept-Ranges — but RD/Comet always supports bytes.
  if (!passHeaders.get('accept-ranges')) passHeaders.set('Accept-Ranges', 'bytes');
  // CORS — same-origin only really matters when frontend is on a different
  // origin in prod, but keep it permissive for the <video> element.
  passHeaders.set('Access-Control-Allow-Origin', '*');
  passHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  passHeaders.set('Access-Control-Allow-Headers', 'Range, Content-Type');
  passHeaders.set('Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges');

  if (request.method === 'HEAD') {
    return new Response(null, { status: upstreamRes.status, headers: passHeaders });
  }

  // Stream the body straight through. NextResponse supports ReadableStream
  // as the body, so this is a true pipe — no buffering.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: passHeaders,
  });
}

export async function GET(request) { return handle(request); }
export async function HEAD(request) { return handle(request); }
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
