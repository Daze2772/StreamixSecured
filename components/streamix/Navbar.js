'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X, Film } from 'lucide-react';
import { tmdb, img } from '@/lib/tmdb';
import Link from 'next/link';

const Navbar = ({ onResultClick }) => {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 30);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      const data = await tmdb.searchMulti(q.trim());
      const filtered = (data.results || [])
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .slice(0, 8);
      setResults(filtered);
      setLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled || open ? 'bg-black/95 backdrop-blur border-b border-white/5' : 'bg-gradient-to-b from-black/80 to-transparent'
      }`}
    >
      <div className="flex items-center justify-between px-4 md:px-12 h-16">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="h-9 w-9 rounded-md bg-red-600 grid place-items-center shadow-lg shadow-red-600/30">
            <Film className="w-5 h-5" />
          </div>
          <span className="text-xl md:text-2xl font-black tracking-tight">
            STREAM<span className="text-red-600">IX</span>
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-neutral-300">
          <Link href="/" className="hover:text-white transition">Home</Link>
          <a href="#movies" className="hover:text-white transition">Movies</a>
          <a href="#tv" className="hover:text-white transition">TV Shows</a>
          <a href="#trending" className="hover:text-white transition">Trending</a>
        </nav>

        <div ref={wrapperRef} className="relative">
          <div className={`flex items-center transition-all duration-300 ${open ? 'bg-black/90 border border-white/20 flex-1 md:flex-none md:w-64 px-3' : 'w-10 justify-center'} h-10 rounded-md`}>
            <button
              onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 50); }}
              aria-label="Search"
              className="text-neutral-200 hover:text-white"
            >
              <Search className="w-5 h-5" />
            </button>
            {open && (
              <>
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Titles, people, genres"
                  className="flex-1 bg-transparent outline-none px-2 text-sm placeholder:text-neutral-500"
                />
                {q && (
                  <button onClick={() => setQ('')} aria-label="Clear" className="text-neutral-400 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </>
            )}
          </div>

          {/* Autocomplete results */}
          {open && q && (
            <div className="absolute right-0 mt-2 w-[90vw] max-w-md bg-black/95 backdrop-blur border border-white/10 rounded-md overflow-hidden shadow-2xl">
              {loading && (
                <div className="p-4 text-sm text-neutral-400">Searching…</div>
              )}
              {!loading && results.length === 0 && (
                <div className="p-4 text-sm text-neutral-400">No results for "{q}"</div>
              )}
              <ul className="max-h-[60vh] overflow-y-auto">
                {results.map((r) => {
                  const t = r.title || r.name;
                  const y = (r.release_date || r.first_air_date || '').slice(0, 4);
                  const poster = img(r.poster_path, 'w200');
                  return (
                    <li key={`${r.id}-${r.media_type}`}>
                      <button
                        onClick={() => { setOpen(false); setQ(''); onResultClick?.(r); }}
                        className="w-full flex items-center gap-3 p-2 hover:bg-white/10 transition text-left"
                      >
                        <div className="h-16 w-12 flex-none bg-neutral-800 rounded overflow-hidden">
                          {poster && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={poster} alt={t} className="h-full w-full object-cover" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{t}</p>
                          <p className="text-xs text-neutral-400">
                            {y} • {r.media_type === 'tv' ? 'TV Series' : 'Movie'}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default Navbar;
