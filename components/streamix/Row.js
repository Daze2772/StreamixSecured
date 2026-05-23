'use client';

import { useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import MovieCard from './MovieCard';
import { PosterSkeleton } from './Skeleton';

const Row = ({ title, items, loading, onCardClick, size = 'md' }) => {
  const scrollerRef = useRef(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(true);

  const update = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 10);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 10);
  };

  useEffect(() => {
    update();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [items]);

  const scroll = (dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.85;
    el.scrollBy({ left: dir * amount, behavior: 'smooth' });
  };

  return (
    <section className="relative group/row mb-8 md:mb-10">
      <div className="px-4 md:px-12 mb-3 flex items-center justify-between">
        <h2 className="text-lg md:text-2xl font-bold tracking-tight">{title}</h2>
      </div>

      <div className="relative">
        {/* Arrows */}
        {canLeft && (
          <button
            onClick={() => scroll(-1)}
            className="hidden md:flex absolute left-0 top-0 bottom-0 z-20 w-12 items-center justify-center bg-gradient-to-r from-black/80 to-transparent opacity-0 group-hover/row:opacity-100 transition"
            aria-label="Scroll left"
          >
            <ChevronLeft className="w-8 h-8" />
          </button>
        )}
        {canRight && (
          <button
            onClick={() => scroll(1)}
            className="hidden md:flex absolute right-0 top-0 bottom-0 z-20 w-12 items-center justify-center bg-gradient-to-l from-black/80 to-transparent opacity-0 group-hover/row:opacity-100 transition"
            aria-label="Scroll right"
          >
            <ChevronRight className="w-8 h-8" />
          </button>
        )}

        <div
          ref={scrollerRef}
          className="no-scrollbar flex gap-3 md:gap-4 overflow-x-auto scroll-smooth px-4 md:px-12 pb-2"
        >
          {loading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex-none w-[140px] md:w-[180px]">
                  <PosterSkeleton />
                </div>
              ))
            : items?.map((item) => (
                <MovieCard key={`${item.id}-${item.media_type || ''}`} item={item} onClick={onCardClick} size={size} />
              ))}
        </div>
      </div>
    </section>
  );
};

export default Row;
