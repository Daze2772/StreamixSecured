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

  // Current + next season episode lists — used to compute `nextEpisode`
  // (poster, title) for the Up-Next countdown overlay. Both are nullable
  // until TMDB resolves; the overlay simply doesn't appear without data.
  const [currentSeasonData, setCurrentSeasonData] = useState(null);
  const [nextSeasonData, setNextSeasonData] = useState(null);

  // Resume offset (seconds) — when arriving via a Continue Watching card,
  // the URL carries `?resume=<seconds>` so we can spin up an HLS session
  // that starts at the saved real-world position. We only honour this on
  // the FIRST mount; subsequent in-page episode changes do not re-resume.
  const [initialResume] = useState(() => {
    const raw = parseFloat(searchParams.get('resume') || '0');
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.min(raw, 86400);
  });

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

  // Fetch current season's episode list (for Up-Next title/still) +
  // prefetch next season's first episode info for cross-boundary jumps.
  useEffect(() => {
    if (mediaType !== 'tv' || !id || !season) {
      setCurrentSeasonData(null);
      setNextSeasonData(null);
      return;
    }
    let cancelled = false;
    tmdb.tvSeason(id, season).then((sd) => {
      if (!cancelled) setCurrentSeasonData(sd);
    });
    tmdb.tvSeason(id, season + 1).then((sd) => {
      if (!cancelled) setNextSeasonData(sd && sd.episodes?.length ? sd : null);
    });
    return () => { cancelled = true; };
  }, [mediaType, id, season]);

  // Compute the next-episode descriptor for the Up-Next overlay.
  //   • Same-season:    (season, episode+1) with name/still from currentSeasonData
  //   • Cross-season:   (season+1, 1) with name/still from nextSeasonData
  //   • Series finale:  null
  //   • Movies:         null
  const nextEpisode = useMemo(() => {
    if (mediaType !== 'tv' || !data) return null;
    // Same-season next
    const eps = currentSeasonData?.episodes || [];
    const sameSeasonNext = eps.find((ep) => ep.episode_number === episode + 1);
    if (sameSeasonNext) {
      return {
        season,
        episode: sameSeasonNext.episode_number,
        episodeName: sameSeasonNext.name || `Episode ${sameSeasonNext.episode_number}`,
        stillPath: sameSeasonNext.still_path
          ? `https://image.tmdb.org/t/p/w300${sameSeasonNext.still_path}`
          : null,
        overview: sameSeasonNext.overview || '',
      };
    }
    // Cross-season — current episode is at/past last in season
    const lastNum = eps.length ? Math.max(...eps.map((e) => e.episode_number)) : 0;
    if (lastNum > 0 && episode >= lastNum && nextSeasonData?.episodes?.length) {
      const first = nextSeasonData.episodes.find((e) => e.episode_number === 1)
        || nextSeasonData.episodes[0];
      return {
        season: season + 1,
        episode: first.episode_number || 1,
        episodeName: first.name || `Season ${season + 1} · Episode 1`,
        stillPath: first.still_path
          ? `https://image.tmdb.org/t/p/w300${first.still_path}`
          : null,
        overview: first.overview || '',
      };
    }
    return null;
  }, [mediaType, data, currentSeasonData, nextSeasonData, season, episode]);

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

  // Back to Home — synchronously release the <video> + hls.js BEFORE
  // navigating so React's unmount cleanup isn't stuck waiting on iOS
  // Safari to flush the media decoder + abort dozens of in-flight HLS
  // fragment XHRs. On iPhone, leaving this to the React effect cleanup
  // alone causes a 10–20s blocked UI thread between click and the home
  // page appearing. Eagerly tearing the video down here turns the
  // upcoming unmount into a no-op so navigation feels instant.
  const handleBackHome = (e) => {
    if (e) { try { e.preventDefault(); } catch (_) {} }
    try {
      const v = document.querySelector('video');
      if (v) {
        try { v.pause(); } catch (_) {}
        try { v.removeAttribute('src'); } catch (_) {}
        try { v.load(); } catch (_) {}
      }
    } catch (_) {}
    // Defer the actual push by one microtask so the synchronous video
    // teardown above gets a chance to release decoder resources first.
    // Without this, on iOS the navigation reconciliation can still
    // overlap the (still-running) cleanup. queueMicrotask runs before
    // the next paint so the user perceives no extra delay.
    queueMicrotask(() => { try { router.push('/'); } catch (_) { router.push('/'); } });
  };

  return (
    <main className="min-h-screen bg-black text-white">
      {/* Top bar */}
      <div className="hide-landscape-phone sticky top-0 z-40 bg-black/95 backdrop-blur border-b border-white/5">
        <div className="flex items-center justify-between px-4 md:px-8 h-14">
          <button
            onClick={handleBackHome}
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
        title={title}
        posterPath={data?.poster_path || null}
        backdropPath={data?.backdrop_path || null}
        initialResume={initialResume}
        nextEpisode={nextEpisode}
        onPlayNext={nextEpisode ? () => handleSelectEpisode(nextEpisode.season, nextEpisode.episode) : null}
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
                onClick={handleBackHome}
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
