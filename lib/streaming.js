// Streaming providers for movies & TV using TMDB IDs.
// Each provider declares whether it needs (or refuses) iframe sandboxing.

export const STREAMING_SERVERS = [
  {
    id: 'vidsrc-to',
    name: 'VidSrc',
    sub: 'Primary • HD',
    sandbox: false,
    movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'vidsrc-dev',
    name: 'VidSrc.dev',
    sub: 'Mirror • HD',
    sandbox: false,
    movie: (id) => `https://vidsrc.dev/embed/movie/${id}`,
    tv: (id, s, e) => `https://vidsrc.dev/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: '2embed',
    name: '2Embed',
    sub: 'Backup',
    sandbox: false, // explicitly refuses sandbox
    movie: (id) => `https://www.2embed.cc/embed/${id}`,
    tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
  },
  {
    id: 'embedsu',
    name: 'Embed.su',
    sub: 'Fast • 4K',
    sandbox: false,
    movie: (id) => `https://embed.su/embed/movie/${id}`,
    tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
  },
  {
    id: 'multi',
    name: 'MultiEmbed',
    sub: 'Alt',
    sandbox: false,
    movie: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
    tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
  },
  {
    id: 'demo',
    name: 'Demo',
    sub: 'Big Buck Bunny',
    isDirect: true,
    sandbox: false,
    src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
];

export function getEmbedUrl(server, mediaType, id, season = 1, episode = 1) {
  if (!server) return null;
  if (server.isDirect) return server.src;
  if (mediaType === 'tv') return server.tv?.(id, season, episode) || null;
  return server.movie?.(id) || null;
}
