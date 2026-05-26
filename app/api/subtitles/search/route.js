// ── OpenSubtitles search endpoint (TMDB→IMDB→OpenSubtitles) ─────────────────

import { getToken } from '../login/route.js';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const tmdbId = searchParams.get('tmdb_id');
  const mediaType = searchParams.get('type') || 'movie'; // 'movie' or 'tv'
  const season = searchParams.get('season');
  const episode = searchParams.get('episode');
  const languages = searchParams.get('languages') || 'en'; // comma-separated

  if (!tmdbId) {
    return Response.json({ error: 'tmdb_id required' }, { status: 400 });
  }

  try {
    // Step 1: TMDB → IMDB ID lookup
    const tmdbUrl = mediaType === 'tv' 
      ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`
      : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids`;
    
    const tmdbResponse = await fetch(tmdbUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.TMDB_ACCESS_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    if (!tmdbResponse.ok) {
      return Response.json(
        { error: 'TMDB lookup failed', status: tmdbResponse.status },
        { status: 502 }
      );
    }

    const tmdbData = await tmdbResponse.json();
    const imdbId = tmdbData.imdb_id;

    if (!imdbId) {
      return Response.json({ error: 'No IMDB ID found for this TMDB entry' }, { status: 404 });
    }

    // Step 2: Get OpenSubtitles JWT
    const token = await getToken();

    // Step 3: Search OpenSubtitles
    const searchUrl = new URL('https://api.opensubtitles.com/api/v1/subtitles');
    searchUrl.searchParams.set('imdb_id', imdbId.replace('tt', '')); // OpenSubs wants numeric only
    searchUrl.searchParams.set('languages', languages);
    
    if (mediaType === 'tv' && season && episode) {
      searchUrl.searchParams.set('season_number', season);
      searchUrl.searchParams.set('episode_number', episode);
    }

    const subsResponse = await fetch(searchUrl.toString(), {
      headers: {
        'Api-Key': process.env.OPENSUBTITLES_API_KEY,
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Streamix v1.0'
      }
    });

    if (!subsResponse.ok) {
      const errorText = await subsResponse.text();
      console.error('[OpenSubtitles] Search failed:', subsResponse.status, errorText);
      
      // Check for quota exhaustion
      if (subsResponse.status === 429 || errorText.includes('quota')) {
        return Response.json(
          { error: 'daily_quota_exhausted', message: 'OpenSubtitles daily quota reached. Try again tomorrow.' },
          { status: 429 }
        );
      }

      return Response.json(
        { error: 'Subtitle search failed', details: errorText },
        { status: subsResponse.status }
      );
    }

    const subsData = await subsResponse.json();

    // Step 4: Process results - one entry per language, top-downloaded variant only
    const languageMap = new Map();
    
    for (const sub of subsData.data || []) {
      const lang = sub.attributes.language;
      const downloads = sub.attributes.download_count || 0;
      
      if (!languageMap.has(lang) || downloads > languageMap.get(lang).downloads) {
        languageMap.set(lang, {
          file_id: sub.attributes.files[0]?.file_id,
          language: lang,
          language_name: sub.attributes.feature_details?.movie_name || lang,
          downloads: downloads,
          release: sub.attributes.release || 'Unknown'
        });
      }
    }

    const cleanResults = Array.from(languageMap.values())
      .sort((a, b) => b.downloads - a.downloads);

    console.log(`[OpenSubtitles] Found ${cleanResults.length} subtitle languages for IMDB ${imdbId}`);

    return Response.json({
      imdb_id: imdbId,
      results: cleanResults
    });

  } catch (error) {
    console.error('[OpenSubtitles] Search error:', error);
    return Response.json(
      { error: 'Search request failed', message: error.message },
      { status: 500 }
    );
  }
}
