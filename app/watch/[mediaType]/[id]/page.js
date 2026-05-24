'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { tmdb, backdrop, pickTrailer } from '@/lib/tmdb';
import { ArrowLeft, Star, Calendar, Tv, Film as FilmIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import EpisodeSelector from '@/components/streamix/EpisodeSelector';
import VideoPlayer from '@/components/streamix/VideoPlayer';

const WatchPage = () => {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { mediaType, id } = params;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const [season, setSeason] = useState(parseInt(searchParams.get('s') || '1', 10));
  const [episode, setEpisode] = useState(parseInt(searchParams.get('e') || '1', 10));

  useEffect(() => {
    setLoading(true);
    tmdb.details(mediaType, id).then((d) => {
      setData(d);
      setLoading(false);
      if (mediaType === 'tv' && d?.seasons?.length && !searchParams.get('s')) {
        const firstValid = d.seasons.find((s) => s.season_number > 0) || d.seasons[0];
        setSeason(firstValid.season_number);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaType, id]);

  const trailer = useMemo(() => pickTrailer(data?.videos?.results), [data]);
  const title = data?.title || data?.name || 'Loading…';
  const overview = data?.overview;
  const year = (data?.release_date || data?.first_air_date || '').slice(0, 4);
  const bg = backdrop(data?.backdrop_path, 'original');

  const handleSelectEpisode = (s, e) => {
    setSeason(s);
    setEpisode(e);
    const url = new URL(window.location.href);
    url.searchParams.set('s', String(s));
    url.searchParams.set('e', String(e));
    window.history.replaceState({}, '', url.toString());
    // Scroll back to player
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
          <div className="text-sm font-semibold truncate max-w-[55%] text-center">
            {title}
            {mediaType === 'tv' && data && (
              <span className="text-neutral-400 ml-2">S{season} · E{episode}</span>
            )}
          </div>
          <div className="w-16" />
        </div>
      </div>

      {/* Player + servers */}
      <VideoPlayer
        mediaType={mediaType}
        tmdbId={id}
        imdbId={data?.external_ids?.imdb_id || null}
        season={season}
        episode={episode}
        poster={bg}
        trailerKey={trailer?.key || null}
      />

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
