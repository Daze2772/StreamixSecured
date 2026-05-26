'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { tmdb, backdrop, img, pickTrailer } from '@/lib/tmdb';
import { Play, Plus, Star, X, Calendar, Clock, Film, Youtube } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import MovieCard from './MovieCard';

const DetailModal = ({ open, onOpenChange, item, onCardClick }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [playTrailer, setPlayTrailer] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!open || !item) {
      setPlayTrailer(false);
      return;
    }
    const mediaType = item.media_type || (item.first_air_date ? 'tv' : 'movie');
    setLoading(true);
    setData(null);
    setPlayTrailer(false);
    tmdb.details(mediaType, item.id).then((d) => {
      setData(d ? { ...d, _media_type: mediaType } : null);
      setLoading(false);
    });
  }, [open, item]);

  const trailer = useMemo(() => pickTrailer(data?.videos?.results), [data]);

  if (!item) return null;

  const title = data?.title || data?.name || item.title || item.name;
  const overview = data?.overview || item.overview;
  const bg = backdrop(data?.backdrop_path || item.backdrop_path, 'original');
  const year = (data?.release_date || data?.first_air_date || item.release_date || item.first_air_date || '').slice(0, 4);
  const runtime = data?.runtime || (data?.episode_run_time && data.episode_run_time[0]);
  const genres = data?.genres || [];
  const cast = data?.credits?.cast?.slice(0, 8) || [];
  const similar = data?.similar?.results?.slice(0, 12) || [];
  const mediaType = data?._media_type || item.media_type || 'movie';

  const goToWatch = () => {
    onOpenChange(false);
    router.push(`/watch/${mediaType}/${item.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 bg-neutral-950 border-neutral-800 text-white overflow-hidden max-h-[92vh] overflow-y-auto">
        <div className="relative min-w-0">
          {/* Compact backdrop area (trailer is lazy-loaded on click — saves browser RAM) */}
          <div className="relative w-full bg-black overflow-hidden" style={{ height: 'min(45vh, 420px)' }}>
            {playTrailer && trailer ? (
              <iframe
                key={`autoplay-${trailer.key}`}
                src={`https://www.youtube.com/embed/${trailer.key}?autoplay=1&controls=1&rel=0&modestbranding=1`}
                className="absolute inset-0 w-full h-full"
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
                title={`${title} trailer`}
              />
            ) : (
              <>
                {bg ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={bg} alt={title} className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-neutral-700">
                    <Film className="w-20 h-20" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/40 to-transparent pointer-events-none" />
                {trailer && (
                  <button
                    onClick={() => setPlayTrailer(true)}
                    className="absolute inset-0 grid place-items-center group"
                    aria-label="Play trailer"
                  >
                    <div className="h-16 w-16 md:h-20 md:w-20 rounded-full bg-white/10 backdrop-blur-md border border-white/20 grid place-items-center transition group-hover:bg-white group-hover:scale-110">
                      <Play className="w-7 h-7 md:w-9 md:h-9 fill-white text-white group-hover:fill-black group-hover:text-black ml-1" />
                    </div>
                  </button>
                )}
                <div className="absolute bottom-0 left-0 right-0 p-5 md:p-8 pointer-events-none">
                  <h2 className="text-2xl md:text-4xl font-black drop-shadow-lg">{title}</h2>
                </div>
              </>
            )}
            <button
              onClick={() => onOpenChange(false)}
              className="absolute top-3 right-3 h-9 w-9 rounded-full bg-black/80 hover:bg-black grid place-items-center border border-white/10 z-20"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Title + Actions */}
          <div className="px-5 md:px-8 pt-4 pb-2">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Button
                onClick={goToWatch}
                className="basis-full sm:basis-auto bg-red-600 hover:bg-red-700 text-white font-bold h-11 px-6 shadow-lg shadow-red-600/30"
              >
                <Play className="w-5 h-5 mr-2 fill-white" /> Play Now
              </Button>
              {trailer && !playTrailer && (
                <Button
                  variant="secondary"
                  onClick={() => setPlayTrailer(true)}
                  className="flex-1 sm:flex-none bg-white/15 hover:bg-white/25 border border-white/10 h-11"
                >
                  <Youtube className="w-4 h-4 mr-2" /> Watch Trailer
                </Button>
              )}
              <Button variant="secondary" className="flex-1 sm:flex-none bg-white/15 hover:bg-white/25 border border-white/10 h-11">
                <Plus className="w-4 h-4 mr-2" /> My List
              </Button>
            </div>
          </div>

          {/* Meta */}
          <div className="p-5 md:p-8 grid md:grid-cols-3 gap-6">
            <div className="md:col-span-2">
              <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-300 mb-3">
                {data?.vote_average > 0 && (
                  <span className="flex items-center gap-1 text-yellow-400 font-semibold">
                    <Star className="w-4 h-4 fill-yellow-400" /> {data.vote_average.toFixed(1)}
                  </span>
                )}
                {year && (
                  <span className="flex items-center gap-1"><Calendar className="w-4 h-4" /> {year}</span>
                )}
                {runtime && (
                  <span className="flex items-center gap-1"><Clock className="w-4 h-4" /> {runtime} min</span>
                )}
                <span className="uppercase tracking-wide text-xs px-2 py-0.5 border border-neutral-700 rounded">
                  {mediaType === 'tv' ? 'TV Series' : 'Movie'}
                </span>
                {mediaType === 'tv' && data?.number_of_seasons && (
                  <span className="text-xs">{data.number_of_seasons} Season{data.number_of_seasons > 1 ? 's' : ''}</span>
                )}
              </div>
              <p className="text-sm md:text-base text-neutral-200 leading-relaxed">{overview || 'No overview available.'}</p>
            </div>
            <div className="text-sm space-y-3">
              {genres.length > 0 && (
                <div>
                  <span className="text-neutral-500">Genres: </span>
                  <span className="text-neutral-200">{genres.map((g) => g.name).join(', ')}</span>
                </div>
              )}
              {cast.length > 0 && (
                <div>
                  <span className="text-neutral-500">Cast: </span>
                  <span className="text-neutral-200">{cast.map((c) => c.name).join(', ')}</span>
                </div>
              )}
              {data?.original_language && (
                <div>
                  <span className="text-neutral-500">Language: </span>
                  <span className="text-neutral-200 uppercase">{data.original_language}</span>
                </div>
              )}
            </div>
          </div>

          {/* Cast row */}
          {cast.length > 0 && (
            <div className="px-5 md:px-8 pb-4">
              <h3 className="text-lg font-bold mb-3">Cast</h3>
              <div className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
                {cast.map((c) => (
                  <div key={c.id} className="flex-none w-24 text-center">
                    <div className="h-24 w-24 rounded-full overflow-hidden bg-neutral-800 mb-2">
                      {c.profile_path ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={img(c.profile_path, 'w185')} alt={c.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full grid place-items-center text-xs text-neutral-500">{c.name?.[0]}</div>
                      )}
                    </div>
                    <p className="text-xs font-medium line-clamp-1">{c.name}</p>
                    <p className="text-[10px] text-neutral-400 line-clamp-1">{c.character}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Similar */}
          {similar.length > 0 && (
            <div className="px-5 md:px-8 pb-8">
              <h3 className="text-lg font-bold mb-3">More Like This</h3>
              <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
                {similar.map((s) => (
                  <MovieCard
                    key={s.id}
                    item={{ ...s, media_type: mediaType }}
                    onClick={(it) => { onCardClick?.(it); }}
                  />
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="p-8 text-center text-neutral-400 text-sm">Loading details…</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DetailModal;
