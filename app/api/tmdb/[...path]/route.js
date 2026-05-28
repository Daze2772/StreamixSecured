import { NextResponse } from 'next/server';
import { isRateLimited } from '@/lib/rate-limiter';
import { getClientIp } from '@/lib/security-utils';

/**
 * TMDB API Proxy
 * ==============
 * Proxies requests to api.themoviedb.org to protect the API key from
 * client-side exposure and add server-side caching + rate limiting.
 *
 * Usage: /api/tmdb/[...path] (e.g., /api/tmdb/trending/movie/day)
 *
 * SECURITY:
 * - Per-IP rate limit: 60 requests per minute
 * - Server-side caching: 5 minutes for most endpoints
 * - API key hidden from client
 */

export const dynamic = 'force-dynamic';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

// In-memory cache: Map<cacheKey, { data, timestamp }>
const cache = globalThis.__streamixTmdbCache || new Map();
globalThis.__streamixTmdbCache = cache;

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 1000; // LRU eviction

// Rate limiting: 60 requests per minute per IP
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

function getCacheKey(path, params) {
  const sortedParams = Array.from(params.entries()).sort();
  return `${path}?${new URLSearchParams(sortedParams).toString()}`;
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  
  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  
  // LRU: Move to end
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

function setCache(key, data) {
  // LRU eviction
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  
  cache.set(key, {
    data,
    timestamp: Date.now(),
  });
}

async function handler(request, { params }) {
  const clientIp = getClientIp(request);

  // ── SECURITY: Rate limiting ────────────────────────────────────
  if (isRateLimited(clientIp, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW)) {
    return NextResponse.json(
      { 
        error: 'Rate limit exceeded for TMDB API',
        retryAfter: 60,
      },
      { status: 429 },
    );
  }

  if (!TMDB_API_KEY) {
    return NextResponse.json(
      { error: 'TMDB_API_KEY not configured' },
      { status: 500 },
    );
  }

  // Get the path segments from Next.js dynamic route
  const pathSegments = params.path || [];
  const tmdbPath = pathSegments.join('/');
  
  // Parse query params from original request
  const { searchParams } = new URL(request.url);
  
  // Add API key to params
  const tmdbParams = new URLSearchParams(searchParams);
  tmdbParams.set('api_key', TMDB_API_KEY);

  // Check cache
  const cacheKey = getCacheKey(tmdbPath, searchParams);
  const cached = getFromCache(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        'X-Cache': 'HIT',
        'Cache-Control': 'public, max-age=300', // 5 min browser cache
      },
    });
  }

  // Fetch from TMDB
  const tmdbUrl = `${TMDB_BASE}/${tmdbPath}?${tmdbParams.toString()}`;
  
  try {
    const response = await fetch(tmdbUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Streamix/1.0',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        { error: `TMDB API error: ${response.status}`, details: error },
        { status: response.status },
      );
    }

    const data = await response.json();
    
    // Cache successful responses
    setCache(cacheKey, data);

    return NextResponse.json(data, {
      headers: {
        'X-Cache': 'MISS',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to fetch from TMDB: ${error.message}` },
      { status: 502 },
    );
  }
}

export async function GET(request, context) {
  return handler(request, context);
}
