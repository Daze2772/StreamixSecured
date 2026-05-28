// Streaming providers for movies & TV using TMDB IDs.
//
// "Premium" servers are special — resolved server-side via our debrid backend
// which returns a direct HTTPS stream URL, not an iframe embed.
// Marked with `isPremium: true` so the player knows to fetch the URL 
// dynamically and render in <video>.
//
// Normal iframe providers: the iframe is wrapped in our /embed proxy so a
// strict sandbox on the outer iframe blocks tab-hijack ads without the
// provider being able to detect it via window.frameElement.

export const STREAMING_SERVERS = [
  {
    id: 'premium-rd',
    name: 'Premium 1',
    sub: 'Clean & Fast',
    isPremium: true,
    premiumType: 'realdebrid',
    badge: 'almost no ads',
  },
  {
    id: 'premium-ad',
    name: 'Premium 2',
    sub: 'Clean & Fast',
    isPremium: true,
    premiumType: 'alldebrid',
    badge: 'almost no ads',
  },
  {
    id: 'vidlink',
    name: 'Public Server 1',
    sub: 'HD',
    movie: (id) => `https://vidlink.pro/movie/${id}`,
    tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidsrc-to',
    name: 'Public Server 2',
    sub: 'HD',
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'embedsu',
    name: 'Public Server 3',
    sub: 'HD',
    movie: (id) => `https://embed.su/embed/movie/${id}`,
    tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'multiembed',
    name: 'Public Server 4',
    sub: 'Multi-source',
    movie: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    tv: (id, s, e) =>
      `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
  },
  {
    id: '2embed',
    name: 'Public Server 5',
    sub: 'Backup',
    movie: (id) => `https://www.2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
  {
    id: 'demo',
    name: 'Demo',
    sub: 'Sample',
    isDirect: true,
    src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
];

export function getEmbedUrl(server, mediaType, id, season = 1, episode = 1) {
  if (!server) return null;
  if (server.isDirect) return server.src;
  if (server.isPremium) return null; // resolved at runtime via /api/realdebrid/resolve
  if (mediaType === 'tv') return server.tv?.(id, season, episode) || null;
  return server.movie?.(id) || null;
}
