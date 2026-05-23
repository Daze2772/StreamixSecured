// Streaming providers for movies & TV using TMDB IDs.
// Ordered by reliability + ad-friendliness (lowest ads first when possible).

export const STREAMING_SERVERS = [
  {
    id: 'vidlink',
    name: 'VidLink',
    sub: 'Fast • Low ads',
    movie: (id) => `https://vidlink.pro/movie/${id}`,
    tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
  },
  {
    id: 'autoembed',
    name: 'AutoEmbed',
    sub: 'HD • Clean',
    movie: (id) => `https://player.autoembed.cc/embed/movie/${id}`,
    tv: (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidsrc-to',
    name: 'VidSrc',
    sub: 'Primary • HD',
    sandbox: true, // permissive sandbox prevents page wipe
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidsrc-xyz',
    name: 'VidSrc Pro',
    sub: 'Mirror • 4K',
    sandbox: true,
    movie: (id) => `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    id: '2embed',
    name: '2Embed',
    sub: 'Backup',
    movie: (id) => `https://www.2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
  {
    id: 'demo',
    name: 'Demo',
    sub: 'Big Buck Bunny',
    isDirect: true,
    src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
];

export function getEmbedUrl(server, mediaType, id, season = 1, episode = 1) {
  if (!server) return null;
  if (server.isDirect) return server.src;
  if (mediaType === 'tv') return server.tv?.(id, season, episode) || null;
  return server.movie?.(id) || null;
}
