'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { tmdb, backdrop } from '@/lib/tmdb';
import { ArrowLeft, Star, Calendar, Server, Maximize, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

const SERVERS = [
  {
    name: 'Server 1 — HD',
    type: 'video',
    src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  },
  {
    name: 'Server 2 — 4K',
    type: 'video',
    src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  },
  {
    name: 'Server 3 — Backup',
    type: 'video',
    src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  },
  {
    name: 'Server 4 — Trailer (YouTube)',
    type: 'youtube',
    src: null, // filled from TMDB videos when available
  },
];

const WatchPage = () => {
  const params = useParams();
  const router = useRouter();
  const { mediaType, id } = params;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [serverIdx, setServerIdx] = useState(0);
  const [trailerKey, setTrailerKey] = useState(null);

  useEffect(() => {
    setLoading(true);
    tmdb.details(mediaType, id).then((d) => {
      setData(d);
      const tr = d?.videos?.results?.find((v) => v.type === 'Trailer' && v.site === 'YouTube')
        || d?.videos?.results?.find((v) => v.site === 'YouTube');
      setTrailerKey(tr?.key || null);
      setLoading(false);
    });
  }, [mediaType, id]);

  const title = data?.title || data?.name || 'Loading...';
  const overview = data?.overview;
  const year = (data?.release_date || data?.first_air_date || '').slice(0, 4);
  const bg = backdrop(data?.backdrop_path, 'original');

  const activeServer = SERVERS[serverIdx];

  return (
    <main className="min-h-screen bg-black text-white">
      {/* Top bar */}
      <div className="sticky top-0 z-40 bg-black/90 backdrop-blur border-b border-white/5">
        <div className="flex items-center justify-between px-4 md:px-8 h-14">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-sm font-medium text-neutral-200 hover:text-white"
          >
            <ArrowLeft className="w-5 h-5" /> Back
          </button>
          <div className="text-sm font-semibold truncate max-w-[60%]">{title}</div>
          <div className="w-16" />
        </div>
      </div>

      {/* Player */}
      <div className="relative w-full bg-black">
        <div className="relative w-full aspect-video max-h-[80vh] mx-auto bg-black">
          {activeServer.type === 'video' && (
            <video
              key={activeServer.src}
              src={activeServer.src}
              controls
              autoPlay
              playsInline
              poster={bg || undefined}
              className="w-full h-full object-contain bg-black"
            />
          )}
          {activeServer.type === 'youtube' && (
            trailerKey ? (
              <iframe
                key={trailerKey}
                src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0`}
                className="w-full h-full"
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-neutral-400 text-sm">
                <div className="text-center">
                  <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                  No trailer available on this server. Try another server.
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Servers */}
      <section className="px-4 md:px-8 py-6">
        <div className="flex items-center gap-2 mb-3 text-neutral-300">
          <Server className="w-4 h-4" />
          <h3 className="text-sm font-semibold uppercase tracking-wider">Servers</h3>
          <span className="text-xs text-neutral-500">If a server is slow or not playing, try another one.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {SERVERS.map((s, i) => {
            const disabled = s.type === 'youtube' && !trailerKey;
            return (
              <button
                key={s.name}
                disabled={disabled}
                onClick={() => setServerIdx(i)}
                className={`px-4 py-2 rounded-md text-sm font-medium border transition ${
                  i === serverIdx
                    ? 'bg-red-600 border-red-600 text-white shadow-lg shadow-red-600/30'
                    : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
                } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {s.name}
              </button>
            );
          })}
        </div>
      </section>

      {/* Details */}
      <section className="px-4 md:px-8 pb-16">
        {loading ? (
          <div className="space-y-3">
            <div className="shimmer h-8 w-72 rounded" />
            <div className="shimmer h-4 w-40 rounded" />
            <div className="shimmer h-4 w-full max-w-2xl rounded" />
            <div className="shimmer h-4 w-full max-w-xl rounded" />
          </div>
        ) : (
          <div className="grid md:grid-cols-3 gap-8">
            <div className="md:col-span-2">
              <h1 className="text-2xl md:text-4xl font-black">{title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-neutral-300">
                {data?.vote_average > 0 && (
                  <span className="flex items-center gap-1 text-yellow-400">
                    <Star className="w-4 h-4 fill-yellow-400" /> {data.vote_average.toFixed(1)}
                  </span>
                )}
                {year && <span className="flex items-center gap-1"><Calendar className="w-4 h-4" /> {year}</span>}
                <span className="uppercase tracking-wide text-xs px-2 py-0.5 border border-neutral-700 rounded">
                  {mediaType === 'tv' ? 'TV Series' : 'Movie'}
                </span>
              </div>
              <p className="mt-4 text-neutral-200 leading-relaxed max-w-3xl">{overview}</p>
              {data?.genres?.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {data.genres.map((g) => (
                    <span key={g.id} className="text-xs px-2.5 py-1 rounded-full bg-neutral-800 border border-neutral-700">
                      {g.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="text-sm space-y-3">
              {data?.credits?.cast?.length > 0 && (
                <div>
                  <p className="text-neutral-500 mb-1">Top Cast</p>
                  <p className="text-neutral-200">
                    {data.credits.cast.slice(0, 6).map((c) => c.name).join(', ')}
                  </p>
                </div>
              )}
              {data?.production_companies?.length > 0 && (
                <div>
                  <p className="text-neutral-500 mb-1">Production</p>
                  <p className="text-neutral-200">
                    {data.production_companies.slice(0, 3).map((p) => p.name).join(', ')}
                  </p>
                </div>
              )}
              <Button
                onClick={() => router.push('/')}
                variant="secondary"
                className="bg-white/10 hover:bg-white/20 border border-white/10"
              >
                Back to Home
              </Button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
};

export default WatchPage;
