/**
 * Embed Proxy Page (Server Component)
 *
 * Purpose: enables the "double-iframe sandbox" popup-blocking technique.
 *
 *   Main page  →  <iframe sandbox="..."> /embed?url=PROVIDER </iframe>  →  <iframe src=PROVIDER>
 *                  (outer sandbox enforced)                                  (no sandbox attr)
 *
 * The provider's own JS checks `window.frameElement.hasAttribute("sandbox")`
 * against its IMMEDIATE iframe element (the inner one) — that element has no
 * sandbox attribute, so the provider plays. Meanwhile, HTML5 spec propagates
 * sandbox flags from the outer iframe down into ALL nested browsing contexts,
 * so window.open / top.location / target="_blank" from the provider are
 * blocked by the browser. Cross-origin barriers prevent the provider from
 * reading the OUTER iframe's sandbox attribute.
 *
 * Security: we only allow a known whitelist of streaming-provider hostnames
 * to prevent this from being abused as an open-redirect / XSS surface.
 */

const ALLOWED_HOSTS = [
  // VidLink
  'vidlink.pro',
  // VidSrc family
  'vidsrc.to', 'vidsrc.net', 'vidsrc.me', 'vidsrc.cc', 'vidsrc.in', 'vidsrc.pm', 'vidsrc.xyz',
  // Embed.su
  'embed.su',
  // MultiEmbed
  'multiembed.mov',
  // 2Embed
  '2embed.cc', '2embed.skin', '2embed.org',
  // AutoEmbed (kept for future swap-in)
  'player.autoembed.cc', 'autoembed.cc',
  // Common alts (kept for future swap-in)
  '111movies.com', 'moviesapi.club', 'godriveplayer.com', 'smashystream.com',
];

function isAllowed(hostname) {
  const h = (hostname || '').toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => h === allowed || h.endsWith('.' + allowed));
}

const errorStyle = {
  position: 'fixed',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  background: '#000',
  color: '#fca5a5',
  fontFamily: 'system-ui, sans-serif',
  padding: '24px',
  textAlign: 'center',
};

const ErrorView = ({ message }) => (
  <div style={errorStyle}>
    <div>
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '6px' }}>
        Embed proxy error
      </div>
      <div style={{ fontSize: '12px', color: '#a1a1aa' }}>{message}</div>
    </div>
  </div>
);

const EmbedProxy = ({ searchParams }) => {
  const raw = searchParams?.url;
  if (!raw || typeof raw !== 'string') {
    return <ErrorView message="Missing url parameter" />;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    return <ErrorView message="Invalid URL" />;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return <ErrorView message="Only http(s) URLs are allowed" />;
  }
  if (!isAllowed(parsed.hostname)) {
    return <ErrorView message={`Provider host not in whitelist: ${parsed.hostname}`} />;
  }

  // Inner iframe — intentionally NO sandbox attribute on this element.
  // The outer iframe (on the main page) carries the sandbox; flags propagate
  // down into this nested context per HTML5 spec, but the provider can't see
  // our outer element's attribute (cross-origin), so its anti-sandbox check passes.
  return (
    <iframe
      src={parsed.toString()}
      title="Streaming provider"
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      allowFullScreen
      referrerPolicy="no-referrer"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        border: 'none',
        background: '#000',
        display: 'block',
      }}
    />
  );
};

export default EmbedProxy;
