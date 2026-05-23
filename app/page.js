'use client';

import { useEffect, useState, useCallback } from 'react';
import Navbar from '@/components/streamix/Navbar';
import Hero from '@/components/streamix/Hero';
import Row from '@/components/streamix/Row';
import DetailModal from '@/components/streamix/DetailModal';
import { tmdb, GENRES } from '@/lib/tmdb';

const App = () => {
  const [hero, setHero] = useState([]);
  const [rows, setRows] = useState({});
  const [modalOpen, setModalOpen] = useState(false);
  const [activeItem, setActiveItem] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [
        trendingDay,
        trendingWeek,
        popularMovies,
        topRated,
        upcoming,
        popularTV,
        action,
        drama,
        comedy,
        scifi,
        horror,
      ] = await Promise.all([
        tmdb.trending('day'),
        tmdb.trending('week'),
        tmdb.popularMovies(),
        tmdb.topRatedMovies(),
        tmdb.upcomingMovies(),
        tmdb.popularTV(),
        tmdb.discoverByGenre(GENRES.Action),
        tmdb.discoverByGenre(GENRES.Drama),
        tmdb.discoverByGenre(GENRES.Comedy),
        tmdb.discoverByGenre(GENRES['Sci-Fi']),
        tmdb.discoverByGenre(GENRES.Horror),
      ]);
      if (cancelled) return;
      const heroItems = (trendingDay.results || []).filter((x) => x.backdrop_path && x.overview).slice(0, 6);
      setHero(heroItems);
      setRows({
        trendingDay: trendingDay.results || [],
        trendingWeek: trendingWeek.results || [],
        popularMovies: popularMovies.results || [],
        topRated: topRated.results || [],
        popularTV: popularTV.results || [],
        upcoming: upcoming.results || [],
        action: action.results || [],
        drama: drama.results || [],
        comedy: comedy.results || [],
        scifi: scifi.results || [],
        horror: horror.results || [],
      });
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
        <Row title="Trending Today" items={rows.trendingDay} loading={!rows.trendingDay} onCardClick={openItem} />
        <Row title="Trending This Week" items={rows.trendingWeek} loading={!rows.trendingWeek} onCardClick={openItem} />
        <div id="movies" />
        <Row title="Popular Movies" items={rows.popularMovies} loading={!rows.popularMovies} onCardClick={openItem} />
        <Row title="Top Rated Movies" items={rows.topRated} loading={!rows.topRated} onCardClick={openItem} />
        <Row title="Upcoming Movies" items={rows.upcoming} loading={!rows.upcoming} onCardClick={openItem} />
        <div id="tv" />
        <Row title="Popular TV Shows" items={rows.popularTV} loading={!rows.popularTV} onCardClick={openItem} />
        <Row title="Action & Adventure" items={rows.action} loading={!rows.action} onCardClick={openItem} />
        <Row title="Drama" items={rows.drama} loading={!rows.drama} onCardClick={openItem} />
        <Row title="Comedy" items={rows.comedy} loading={!rows.comedy} onCardClick={openItem} />
        <Row title="Sci-Fi" items={rows.scifi} loading={!rows.scifi} onCardClick={openItem} />
        <Row title="Horror" items={rows.horror} loading={!rows.horror} onCardClick={openItem} />
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
