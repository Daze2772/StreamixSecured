'use client';

import { useCallback, useEffect, useState } from 'react';
import Navbar from '@/components/streamix/Navbar';
import Hero from '@/components/streamix/Hero';
import Row from '@/components/streamix/Row';
import LazyRow from '@/components/streamix/LazyRow';
import DetailModal from '@/components/streamix/DetailModal';
import { tmdb, GENRES } from '@/lib/tmdb';

const App = () => {
  const [hero, setHero] = useState([]);
  const [trendingDay, setTrendingDay] = useState(null);
  const [trendingWeek, setTrendingWeek] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeItem, setActiveItem] = useState(null);

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

  const openItem = useCallback((item) => {
    setActiveItem(item);
    setModalOpen(true);
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <Navbar onResultClick={openItem} />

      <Hero items={hero} onMoreInfo={openItem} />

      <div className="relative -mt-16 md:-mt-24 z-10 space-y-2 md:space-y-3" id="trending">
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
