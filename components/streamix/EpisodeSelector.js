'use client';

import { useEffect, useState } from 'react';
import { tmdb, img } from '@/lib/tmdb';
import { ChevronDown, Play, Calendar, Clock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const EpisodeSelector = ({ tvId, seasons, season, episode, onSelect }) => {
  const [seasonData, setSeasonData] = useState(null);
  const [loading, setLoading] = useState(false);

  // Filter out specials (season 0) optionally
  const visibleSeasons = (seasons || []).filter((s) => s.season_number > 0);

  useEffect(() => {
    if (!tvId || !season) return;
    setLoading(true);
    setSeasonData(null);
    tmdb.tvSeason(tvId, season).then((d) => {
      setSeasonData(d);
      setLoading(false);
    });
  }, [tvId, season]);

  return (
    <section className="px-4 md:px-8 py-4 border-t border-white/5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h3 className="text-lg md:text-xl font-bold">Episodes</h3>
        <div className="flex items-center gap-2">
          <Select value={String(season)} onValueChange={(v) => onSelect(parseInt(v, 10), 1)}>
            <SelectTrigger className="w-[180px] bg-neutral-900 border-neutral-700 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-neutral-900 border-neutral-700 text-white">
              {visibleSeasons.map((s) => (
                <SelectItem key={s.id} value={String(s.season_number)}>
                  Season {s.season_number} {s.episode_count ? `· ${s.episode_count} ep` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="shimmer rounded-lg h-28" />
          ))}
        </div>
      )}

      {!loading && seasonData?.episodes?.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {seasonData.episodes.map((ep) => {
            const active = ep.episode_number === episode;
            const still = img(ep.still_path, 'w300');
            return (
              <button
                key={ep.id}
                onClick={() => onSelect(season, ep.episode_number)}
                className={`group flex gap-3 p-2 rounded-lg border transition text-left ${
                  active
                    ? 'bg-red-600/15 border-red-600/50 ring-1 ring-red-500/40'
                    : 'bg-neutral-900/60 border-neutral-800 hover:border-neutral-600 hover:bg-neutral-900'
                }`}
              >
                <div className="relative flex-none w-32 aspect-video rounded-md overflow-hidden bg-neutral-800">
                  {still ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={still} alt={ep.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-xs text-neutral-500">No image</div>
                  )}
                  <div className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 group-hover:opacity-100 transition">
                    <Play className="w-6 h-6 fill-white" />
                  </div>
                  <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/80 text-[10px] font-bold rounded">
                    E{ep.episode_number}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold line-clamp-1 ${active ? 'text-red-400' : 'text-white'}`}>
                    {ep.episode_number}. {ep.name}
                  </p>
                  <div className="flex items-center gap-3 text-[11px] text-neutral-400 mt-0.5">
                    {ep.air_date && (
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {ep.air_date}</span>
                    )}
                    {ep.runtime && (
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {ep.runtime}m</span>
                    )}
                  </div>
                  <p className="text-xs text-neutral-400 line-clamp-2 mt-1">{ep.overview || 'No description.'}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {!loading && (!seasonData?.episodes || seasonData.episodes.length === 0) && (
        <p className="text-sm text-neutral-500">No episode info available.</p>
      )}
    </section>
  );
};

export default EpisodeSelector;
