'use client';

import { useEffect, useRef, useState } from 'react';
import Row from './Row';

/**
 * LazyRow — only fetches TMDB data once the row scrolls into view.
 * Drastically reduces initial network + JS work on homepage load.
 */
const LazyRow = ({ title, fetcher, onCardClick }) => {
  const ref = useRef(null);
  const [items, setItems] = useState(null);
  const [hasFetched, setHasFetched] = useState(false);

  useEffect(() => {
    if (hasFetched) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !hasFetched) {
          setHasFetched(true);
          io.disconnect();
          fetcher().then((data) => setItems(data?.results || []));
        }
      },
      { rootMargin: '300px 0px', threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasFetched, fetcher]);

  return (
    <div ref={ref} className="min-h-[260px]">
      <Row title={title} items={items} loading={items == null} onCardClick={onCardClick} />
    </div>
  );
};

export default LazyRow;
