// TMDB API service
// All requests go through the server-side proxy at /api/tmdb/* so the API
// key is never exposed to the browser. The proxy adds key + caches +
// rate-limits per IP. See /app/app/api/tmdb/[...path]/route.js.

import axios from 'axios';

const BASE_URL = '/api/tmdb';

export const IMG_BASE = 'https://image.tmdb.org/t/p';
export const img = (path, size = 'w500') => path ? `${IMG_BASE}/${size}${path}` : null;
export const backdrop = (path, size = 'original') => path ? `${IMG_BASE}/${size}${path}` : null;

const api = axios.create({
  baseURL: BASE_URL,
  params: { language: 'en-US' },
  timeout: 15000,
});

export const GENRES = {
  Action: 28,
  Drama: 18,
  Comedy: 35,
  'Sci-Fi': 878,
  Horror: 27,
  Romance: 10749,
  Animation: 16,
  Thriller: 53,
};

const safe = async (promise) => {
  try {
    const { data } = await promise;
    return data;
  } catch (e) {
    console.error('TMDB error', e?.response?.status, e?.config?.url);
    return { results: [] };
  }
};

export function pickTrailer(videos) {
  if (!videos?.length) return null;
  // Prefer official trailer on YouTube
  return (
    videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
    videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
    videos.find((v) => v.site === 'YouTube' && v.type === 'Teaser') ||
    videos.find((v) => v.site === 'YouTube') ||
    null
  );
}

export const tmdb = {
  trending: (window = 'day') => safe(api.get(`/trending/all/${window}`)),
  popularMovies: (page = 1) => safe(api.get('/movie/popular', { params: { page } })),
  topRatedMovies: (page = 1) => safe(api.get('/movie/top_rated', { params: { page } })),
  upcomingMovies: (page = 1) => safe(api.get('/movie/upcoming', { params: { page } })),
  nowPlaying: (page = 1) => safe(api.get('/movie/now_playing', { params: { page } })),
  popularTV: (page = 1) => safe(api.get('/tv/popular', { params: { page } })),
  topRatedTV: (page = 1) => safe(api.get('/tv/top_rated', { params: { page } })),
  discoverByGenre: (genreId, type = 'movie', page = 1) =>
    safe(api.get(`/discover/${type}`, {
      params: { with_genres: genreId, sort_by: 'popularity.desc', page, 'vote_count.gte': 100 },
    })),
  searchMulti: (query, page = 1) =>
    safe(api.get('/search/multi', { params: { query, page, include_adult: false } })),
  details: async (mediaType, id) => {
    try {
      const { data } = await api.get(`/${mediaType}/${id}`, {
        params: { append_to_response: 'credits,similar,videos,recommendations,external_ids' },
      });
      return data;
    } catch (e) {
      return null;
    }
  },
  tvSeason: async (id, seasonNumber) => {
    try {
      const { data } = await api.get(`/tv/${id}/season/${seasonNumber}`);
      return data;
    } catch (e) {
      return null;
    }
  },
};

export default tmdb;
