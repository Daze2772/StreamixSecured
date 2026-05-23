'use client';

import { img } from '@/lib/tmdb';
import { Star, Play } from 'lucide-react';

const MovieCard = ({ item, onClick, size = 'md' }) => {
  const title = item.title || item.name || 'Untitled';
  const year = (item.release_date || item.first_air_date || '').slice(0, 4);
  const mediaType = item.media_type || (item.first_air_date ? 'tv' : 'movie');

  const widthClass = size === 'lg' ? 'w-[180px] md:w-[240px]' : 'w-[140px] md:w-[180px]';
  const posterSize = size === 'lg' ? 'w500' : 'w342'; // smaller = faster
  const poster = img(item.poster_path, posterSize);

  return (
    <button
      onClick={() => onClick?.({ ...item, media_type: mediaType })}
      className={`group relative flex-none ${widthClass} text-left transition-transform duration-300 hover:scale-105 hover:z-10`}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-neutral-900 ring-1 ring-white/5">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt={title}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-300 group-hover:brightness-110"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500 p-2 text-center">
            {title}
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 card-gradient opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        <div className="absolute inset-x-0 bottom-0 p-3 translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-xs text-yellow-400">
              <Star className="w-3 h-3 fill-yellow-400" />
              <span>{item.vote_average?.toFixed(1) || '—'}</span>
            </div>
            <div className="h-7 w-7 rounded-full bg-white text-black grid place-items-center">
              <Play className="w-3.5 h-3.5 fill-black" />
            </div>
          </div>
        </div>

        {/* Top-left rating badge always visible */}
        {item.vote_average > 0 && (
          <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur text-[10px] font-semibold">
            <Star className="w-2.5 h-2.5 fill-yellow-400 text-yellow-400" />
            {item.vote_average.toFixed(1)}
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <p className="text-sm text-white line-clamp-1 font-medium">{title}</p>
        <p className="text-[11px] text-neutral-400">{year}{mediaType === 'tv' ? ' • TV' : ''}</p>
      </div>
    </button>
  );
};

export default MovieCard;
