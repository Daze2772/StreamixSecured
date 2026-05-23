'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { tmdb, backdrop, pickTrailer } from '@/lib/tmdb';
import { STREAMING_SERVERS, getEmbedUrl } from '@/lib/streaming';
import { ArrowLeft, Star, Calendar, Server, AlertCircle, RotateCw, Tv, Film as FilmIcon, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import EpisodeSelector from '@/components/streamix/EpisodeSelector';

const WatchPage = () => {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { mediaType, id } = params;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [serverIdx, setServerIdx] = useState(0);
  const [iframeKey, setIframeKey] = useState(0); // for hard reload
  const [iframeError, setIframeError] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);

  // TV: season + episode (default 1/1 or from query)
  const [season, setSeason] = useState(parseInt(searchParams.get('s') || '1', 10));
  const [episode, setEpisode] = useState(parseInt(searchParams.get('e') || '1', 10));

  useEffect(() => {
    setLoading(true);
    tmdb.details(mediaType, id).then((d) => {
      setData(d);
      setLoading(false);
      // Pick first valid season number for TV
      if (mediaType === 'tv' && d?.seasons?.length) {
        const firstValid = d.seasons.find((s) => s.season_number > 0) || d.seasons[0];
        if (!searchParams.get('s')) setSeason(firstValid.season_number);
      }
    });
  }, [mediaType, id]);

  const trailer = useMemo(() => pickTrailer(data?.videos?.results), [data]);
  const title = data?.title || data?.name || 'Loading…';
  const overview = data?.overview;
  const year = (data?.release_date || data?.first_air_date || '').slice(0, 4);
  const bg = backdrop(data?.backdrop_path, 'original');

  const activeServer = STREAMING_SERVERS[serverIdx];
  const embedUrl = getEmbedUrl(activeServer, mediaType, id, season, episode);

  // Reset error when server / episode changes
  useEffect(() => {
    setIframeError(false);
    setShowTrailer(false);
  }, [serverIdx, season, episode]);

  const handleSelectEpisode = (s, e) => {
    setSeason(s);
    setEpisode(e);
    const url = new URL(window.location.href);
    url.searchParams.set('s', String(s));
    url.searchParams.set('e', String(e));
    window.history.replaceState({}, '', url.toString());
  };

  return (
    <main className="min-h-screen bg-black text-white">
      {/* Top bar */}
      <div className="sticky top-0 z-40 bg-black/95 backdrop-blur border-b border-white/5">
        <div className="flex items-center justify-between px-4 md:px-8 h-14">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 text-sm font-medium text-neutral-200 hover:text-white"
          >
            <ArrowLeft className="w-5 h-5" /> Back to Home
          </button>
          <div className="text-sm font-semibold truncate max-w-[50%] text-center">
            {title}
            {mediaType === 'tv' && data && (
              <span className="text-neutral-400 ml-2">S{season} · E{episode}</span>
            )}
          </div>
          <div className="w-16 flex justify-end">
            <button
              onClick={() => setIframeKey((k) => k + 1)}
              title="Reload player"
              className="text-neutral-300 hover:text-white p-2"
              aria-label="Reload player"
            >
              <RotateCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Player */}
      <div className="relative w-full bg-black">
        <div className="relative w-full mx-auto bg-black" style={{ maxWidth: '1400px' }}>
          <div className="relative w-full aspect-video bg-black">
            {showTrailer && trailer ? (
              <iframe
                key={`trailer-${trailer.key}`}
                src={`https://www.youtube.com/embed/${trailer.key}?autoplay=1&rel=0&modestbranding=1`}
                className="absolute inset-0 w-full h-full"
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
              />
            ) : activeServer.isDirect ? (
              <video
                key={`direct-${iframeKey}`}
                src={activeServer.src}
                controls
                autoPlay
                playsInline
                poster={bg || undefined}
                className="w-full h-full object-contain bg-black"
              />
            ) : embedUrl ? (
              <iframe
                key={`${activeServer.id}-${season}-${episode}-${iframeKey}`}
                src={embedUrl}
                className="absolute inset-0 w-full h-full"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
                onError={() => setIframeError(true)}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-center p-6">
                <div>
                  <AlertCircle className="w-10 h-10 mx-auto mb-3 text-red-500" />
                  <p className="text-lg font-semibold">Source not available</p>
                  <p className="text-sm text-neutral-400 mt-1">Try another server below.</p>
                </div>
              </div>
            )}
          </div>

          {/* Fallback hint banner (shown briefly after error or always as helper) */}
          {!showTrailer && !activeServer.isDirect && (
            <div className="px-4 md:px-0 mt-3 text-xs text-neutral-400 flex items-center justify-between flex-wrap gap-2">
              <span className="inline-flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                Playing on <b className="text-neutral-200 mx-1">{activeServer.name}</b>. If it doesn't load or shows ads,
                switch to another server below.
              </span>
              {embedUrl && (
                <a
                  href={embedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-neutral-300 hover:text-white"
                >
                  Open in new tab <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Servers */}
      <section className="px-4 md:px-8 py-6">
        <div className="flex items-center gap-2 mb-3 text-neutral-300">
          <Server className="w-4 h-4" />
          <h3 className="text-sm font-semibold uppercase tracking-wider">Servers</h3>
          <span className="text-xs text-neutral-500 hidden md:inline">
            If a server is slow or not playing, try another one.
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {STREAMING_SERVERS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setServerIdx(i)}
              className={`px-4 py-2.5 rounded-md text-sm font-semibold border transition flex flex-col items-start ${
                i === serverIdx
                  ? 'bg-red-600 border-red-600 text-white shadow-lg shadow-red-600/30'
                  : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
              }`}
            >
              <span className="flex items-center gap-1.5">
                {i === serverIdx && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />}
                {s.name}
              </span>
              <span className="text-[10px] font-normal opacity-80 mt-0.5">{s.sub}</span>
            </button>
          ))}
          {trailer && (
            <button
              onClick={() => setShowTrailer((v) => !v)}
              className={`px-4 py-2.5 rounded-md text-sm font-semibold border transition flex flex-col items-start ${
                showTrailer
                  ? 'bg-white text-black border-white'
                  : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
              }`}
            >
              <span>{showTrailer ? 'Hide Trailer' : 'Watch Trailer'}</span>
              <span className="text-[10px] font-normal opacity-80 mt-0.5">YouTube</span>
            </button>
          )}
        </div>
      </section>

      {/* Episode selector for TV */}
      {mediaType === 'tv' && data?.seasons && (
        <EpisodeSelector
          tvId={id}
          seasons={data.seasons}
          season={season}
          episode={episode}
          onSelect={handleSelectEpisode}
        />
      )}

      {/* Details */}
      <section className="px-4 md:px-8 py-6 border-t border-white/5">
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
              <h1 className="text-2xl md:text-4xl font-black flex items-center gap-3">
                {mediaType === 'tv' ? <Tv className="w-6 h-6 text-red-500" /> : <FilmIcon className="w-6 h-6 text-red-500" />}
                {title}
              </h1>
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
                {mediaType === 'tv' && data?.number_of_seasons && (
                  <span className="text-xs">{data.number_of_seasons} Season{data.number_of_seasons > 1 ? 's' : ''}</span>
                )}
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
