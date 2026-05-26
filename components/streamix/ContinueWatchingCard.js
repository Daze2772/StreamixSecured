'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { backdrop } from '@/lib/tmdb';

/**
 * ContinueWatchingCard — Shows a title with progress bar + remove button
 * 
 * Props:
 * - item: watch_progress entry from API
 * - onClick: Navigate to /watch
 * - onRemove: Delete from Continue Watching
 */
const ContinueWatchingCard = ({ item, onClick, onRemove }) => {
  const [showRemove, setShowRemove] = useState(false);
  
  const bgImage = backdrop(item.backdropPath || item.posterPath, 'w780');
  const progress = item.duration > 0 ? (item.position / item.duration) * 100 : 0;
  
  // Format title + episode info
  let displayTitle = item.title || 'Unknown';
  if (item.mediaType === 'tv' && item.season && item.episode) {
    displayTitle += ` — S${item.season} · E${item.episode}`;
    if (item.episodeTitle) {
      displayTitle += ` ${item.episodeTitle}`;
    }
  }

  return (
    <div
      className="relative flex-none w-[280px] sm:w-[320px] group cursor-pointer"
      onMouseEnter={() => setShowRemove(true)}
      onMouseLeave={() => setShowRemove(false)}
      onClick={onClick}
    >
      {/* Backdrop image */}
      <div className="relative aspect-video rounded-md overflow-hidden bg-neutral-800">
        {bgImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={bgImage} alt={displayTitle} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full grid place-items-center text-neutral-600">
            No Image
          </div>
        )}
        
        {/* Title overlay at bottom */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3">
          <p className="text-sm font-semibold text-white line-clamp-2 leading-tight">
            {displayTitle}
          </p>
        </div>

        {/* Remove button (top-right, on hover) */}
        {showRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="absolute top-2 right-2 h-8 w-8 rounded-full bg-black/80 hover:bg-black grid place-items-center border border-white/20 z-10"
            aria-label="Remove from Continue Watching"
          >
            <X className="w-4 h-4 text-white" />
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-1 h-1 bg-neutral-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-red-600 transition-all"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
    </div>
  );
};

export default ContinueWatchingCard;
