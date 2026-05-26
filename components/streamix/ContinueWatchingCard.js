'use client';

import { img } from '@/lib/tmdb';

/**
 * ContinueWatchingCard — Vertical poster card matching MovieCard, with
 * a progress bar at the bottom of the poster (3-4px, red).
 *
 * §10 — The X (remove) button was removed entirely. It was intercepting
 * the first tap on iOS Safari (hover-on-touch quirk), forcing users to
 * tap 2-3 times before the click landed on the card itself. Single tap
 * now navigates immediately. The DELETE /api/progress route is preserved
 * server-side for future re-introduction.
 *
 * Props:
 * - item: watch_progress entry from API
 * - onClick: () => void — navigate to /watch/<...>?s=&e=&resume=
 */
const ContinueWatchingCard = ({ item, onClick }) => {
  const poster = img(item.posterPath, 'w342');
  const progress = item.duration > 0
    ? Math.min(100, Math.max(0, (item.position / item.duration) * 100))
    : 0;

  let displayTitle = item.title || 'Untitled';
  let subtitle = '';
  if (item.mediaType === 'tv' && item.season && item.episode) {
    subtitle = `S${item.season} · E${item.episode}`;
    if (item.episodeTitle) subtitle += ` · ${item.episodeTitle}`;
  } else if (item.mediaType === 'movie') {
    subtitle = 'Movie';
  }

  return (
    <button
      onClick={onClick}
      className="group relative flex-none w-[140px] md:w-[180px] text-left transition-transform duration-300 hover:scale-105 hover:z-10"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-neutral-900 ring-1 ring-white/5">
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={poster}
            alt={displayTitle}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-300 group-hover:brightness-110"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500 p-2 text-center">
            {displayTitle}
          </div>
        )}

        {/* Progress bar — flush against the bottom edge of the poster.
            3px on mobile, 4px on sm+. */}
        <div className="absolute inset-x-0 bottom-0 h-[3px] sm:h-[4px] bg-black/50">
          <div
            className="h-full bg-red-600"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <div className="mt-2 px-0.5">
        <p className="text-sm text-white line-clamp-1 font-medium">{displayTitle}</p>
        <p className="text-[11px] text-neutral-400 line-clamp-1">{subtitle}</p>
      </div>
    </button>
  );
};

export default ContinueWatchingCard;
