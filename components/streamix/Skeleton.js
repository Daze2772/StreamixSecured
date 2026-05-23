'use client';

export const PosterSkeleton = ({ className = '' }) => (
  <div className={`shimmer rounded-md aspect-[2/3] w-full ${className}`} />
);

export const RowSkeleton = ({ count = 8 }) => (
  <div className="px-4 md:px-12 mb-8">
    <div className="shimmer h-6 w-48 mb-3 rounded" />
    <div className="flex gap-3 overflow-hidden">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex-none w-[150px] md:w-[200px]">
          <PosterSkeleton />
        </div>
      ))}
    </div>
  </div>
);

export const HeroSkeleton = () => (
  <div className="relative w-full h-[60vh] md:h-[85vh] shimmer" />
);
