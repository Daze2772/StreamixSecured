// Streaming source builder for movies & TV using TMDB IDs.
// Each provider returns an embeddable iframe URL.

export const STREAMING_SERVERS = [
  {
    id: 'vidsrc-to',
    name: 'VidSrc',
    sub: 'Primary • HD',
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidsrc-xyz',
    name: 'VidSrc Pro',
    sub: 'Mirror • 4K',
    movie: (id) => `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    tv: (id, s, e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
  },
  {
    id: 'embedsu',
    name: 'Embed.su',
    sub: 'Fast • HD',
    movie: (id) => `https://embed.su/embed/movie/${id}`,
    tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: '2embed',
    name: '2Embed',
    sub: 'Backup',
    movie: (id) => `https://www.2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
  {
    id: 'multi',
    name: 'MultiEmbed',
    sub: 'Alt',
    movie: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
  },
  {
    id: 'demo',
    name: 'Demo',
    sub: 'Test video (Big Buck Bunny)',
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
