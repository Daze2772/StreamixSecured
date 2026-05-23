'use client';

import { useEffect, useState } from 'react';
import { backdrop } from '@/lib/tmdb';
import { Play, Info, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';

const Hero = ({ items, onMoreInfo }) => {
  const [index, setIndex] = useState(0);
  const router = useRouter();

  useEffect(() => {
    if (!items?.length) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % Math.min(items.length, 6)), 8000);
    return () => clearInterval(t);
  }, [items]);

  if (!items?.length) {
    return <div className="w-full h-[60vh] md:h-[85vh] shimmer" />;
  }

  const item = items[index];
  const title = item.title || item.name;
  const overview = item.overview || '';
  const mediaType = item.media_type || (item.first_air_date ? 'tv' : 'movie');
  const bg = backdrop(item.backdrop_path, 'original');
  const year = (item.release_date || item.first_air_date || '').slice(0, 4);

  return (
    <div className="relative w-full h-[70vh] md:h-[92vh] overflow-hidden">
      {bg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={item.id}
          src={bg}
          alt={title}
          className="absolute inset-0 h-full w-full object-cover slow-zoom fade-in"
        />
      )}
      <div className="absolute inset-0 hero-gradient" />

      <div className="relative z-10 h-full flex items-end md:items-center">
        <div className="px-4 md:px-12 pb-16 md:pb-0 max-w-3xl fade-in" key={`text-${item.id}`}>
          <div className="mb-3 inline-flex items-center gap-2 text-xs font-bold tracking-widest text-red-500 uppercase">
            <span className="h-1 w-8 bg-red-600 rounded" /> Streamix Original
          </div>
          <h1 className="text-3xl md:text-6xl lg:text-7xl font-black tracking-tight drop-shadow-lg">
            {title}
          </h1>
          <div className="mt-3 flex items-center gap-3 text-sm text-neutral-300">
            <span className="flex items-center gap-1 text-yellow-400">
              <Star className="w-4 h-4 fill-yellow-400" /> {item.vote_average?.toFixed(1)}
            </span>
            <span className="text-neutral-500">•</span>
            <span>{year}</span>
            <span className="text-neutral-500">•</span>
            <span className="uppercase tracking-wide text-xs px-2 py-0.5 border border-neutral-600 rounded">
              {mediaType === 'tv' ? 'TV Series' : 'Movie'}
            </span>
          </div>
          <p className="mt-4 text-sm md:text-lg text-neutral-200 max-w-2xl line-clamp-3 md:line-clamp-4 drop-shadow">
            {overview}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              size="lg"
              onClick={() => router.push(`/watch/${mediaType}/${item.id}`)}
              className="bg-white text-black hover:bg-white/90 font-bold text-base px-6 md:px-8 h-11 md:h-12"
            >
              <Play className="w-5 h-5 mr-2 fill-black" /> Play
            </Button>
            <Button
              size="lg"
              variant="secondary"
              onClick={() => onMoreInfo?.({ ...item, media_type: mediaType })}
              className="bg-white/15 text-white hover:bg-white/25 backdrop-blur font-semibold text-base px-6 md:px-8 h-11 md:h-12 border border-white/10"
            >
              <Info className="w-5 h-5 mr-2" /> More Info
            </Button>
          </div>

          {/* Dots */}
          <div className="mt-6 hidden md:flex items-center gap-1.5">
            {items.slice(0, 6).map((_, i) => (
              <button
                key={i}
                onClick={() => setIndex(i)}
                className={`h-1 rounded-full transition-all ${i === index ? 'w-8 bg-white' : 'w-4 bg-white/30'}`}
                aria-label={`Hero slide ${i + 1}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Hero;
