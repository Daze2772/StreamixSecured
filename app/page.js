'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Navbar from '@/components/streamix/Navbar';
import Hero from '@/components/streamix/Hero';
import Row from '@/components/streamix/Row';
import LazyRow from '@/components/streamix/LazyRow';
import DetailModal from '@/components/streamix/DetailModal';
import ContinueWatchingCard from '@/components/streamix/ContinueWatchingCard';
import { tmdb, GENRES } from '@/lib/tmdb';
import { getClientId } from '@/lib/clientId';

const App = () => {
  const router = useRouter();
  const [hero, setHero] = useState([]);
  const [trendingDay, setTrendingDay] = useState(null);
  const [trendingWeek, setTrendingWeek] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeItem, setActiveItem] = useState(null);
  const [continueWatching, setContinueWatching] = useState([]);

  // Fetch ONLY hero + first 2 rows immediately. Rest load on scroll.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [day, week] = await Promise.all([
        tmdb.trending('day'),
        tmdb.trending('week'),
      ]);
      if (cancelled) return;
      const heroItems = (day.results || [])
        .filter((x) => x.backdrop_path && x.overview)
        .slice(0, 6);
      setHero(heroItems);
      setTrendingDay(day.results || []);
      setTrendingWeek(week.results || []);
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch Continue Watching on mount
  useEffect(() => {
    const clientId = getClientId();
    if (!clientId) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/progress?clientId=${encodeURIComponent(clientId)}&limit=20`);
        const data = await res.json();
        if (cancelled) return;
        setContinueWatching(data.items || []);
      } catch (err) {
        console.error('[ContinueWatching] Fetch error:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const openItem = useCallback((item) => {
    setActiveItem(item);
    setModalOpen(true);
  }, []);

  const handleContinueWatchingClick = useCallback((item) => {
    // §10 — Thread the saved real-world position into the watch page URL
    // as `?resume=`. The watch page reads it and passes it to VideoPlayer
    // as `initialResume`, which calls the resolver with `&start=` so the
    // HLS session itself spawns at that position (via ffmpeg `-ss`).
    // This is what makes a single tap on a CW card resume INSTANTLY at
    // the right second, with no client-side seek-after-loadedmetadata.
    const resumeParam = Number.isFinite(item?.position) && item.position >= 30
      ? `&resume=${Math.floor(item.position)}`
      : '';
    const url = item.mediaType === 'tv'
      ? `/watch/tv/${item.tmdbId}?s=${item.season || 1}&e=${item.episode || 1}${resumeParam}`
      : `/watch/movie/${item.tmdbId}${resumeParam ? `?${resumeParam.slice(1)}` : ''}`;
    router.push(url);
  }, [router]);

  return (
    <main className="min-h-screen bg-black text-white">
      <Navbar onResultClick={openItem} />

      <Hero items={hero} onMoreInfo={openItem} />

      <div className="relative -mt-12 md:-mt-24 z-10 space-y-2 md:space-y-3" id="trending">
        {/* Continue Watching row */}
        {continueWatching.length > 0 && (
          <section className="px-4 md:px-12">
            <h2 className="text-lg md:text-xl font-bold mb-3">Continue Watching</h2>
            <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
              {continueWatching.map((item) => (
                <ContinueWatchingCard
                  key={`${item.mediaType}-${item.tmdbId}-${item.season || 0}-${item.episode || 0}`}
                  item={item}
                  onClick={() => handleContinueWatchingClick(item)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Above-the-fold: eager */}
        <Row title="Trending Today" items={trendingDay} loading={trendingDay == null} onCardClick={openItem} />
        <Row title="Trending This Week" items={trendingWeek} loading={trendingWeek == null} onCardClick={openItem} />

        {/* Below-the-fold: lazy-loaded when scrolled into view */}
        <div id="movies" />
        <LazyRow title="Popular Movies" fetcher={() => tmdb.popularMovies()} onCardClick={openItem} />
        <LazyRow title="Top Rated Movies" fetcher={() => tmdb.topRatedMovies()} onCardClick={openItem} />
        <LazyRow title="Upcoming Movies" fetcher={() => tmdb.upcomingMovies()} onCardClick={openItem} />
        <div id="tv" />
        <LazyRow title="Popular TV Shows" fetcher={() => tmdb.popularTV()} onCardClick={openItem} />
        <LazyRow title="Action & Adventure" fetcher={() => tmdb.discoverByGenre(GENRES.Action)} onCardClick={openItem} />
        <LazyRow title="Drama" fetcher={() => tmdb.discoverByGenre(GENRES.Drama)} onCardClick={openItem} />
        <LazyRow title="Comedy" fetcher={() => tmdb.discoverByGenre(GENRES.Comedy)} onCardClick={openItem} />
        <LazyRow title="Sci-Fi" fetcher={() => tmdb.discoverByGenre(GENRES['Sci-Fi'])} onCardClick={openItem} />
        <LazyRow title="Horror" fetcher={() => tmdb.discoverByGenre(GENRES.Horror)} onCardClick={openItem} />
      </div>

      <footer className="mt-16 border-t border-white/5 px-4 md:px-12 py-10 text-sm text-neutral-500">
        <div className="max-w-5xl">
          <p className="font-semibold text-neutral-300 mb-2">Streamix</p>
          <p>This product uses the TMDB API but is not endorsed or certified by TMDB. All movie and TV show data is provided by The Movie Database.</p>
          <p className="mt-3">© {new Date().getFullYear()} Streamix — Demo project.</p>
        </div>
      </footer>

      <DetailModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        item={activeItem}
        onCardClick={openItem}
      />
    </main>
  );
};

export default App;
