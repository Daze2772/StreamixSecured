'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STREAMING_SERVERS, getEmbedUrl } from '@/lib/streaming';
import { resolveAllDebrid } from '@/lib/alldebrid-client';
import HlsVideo from '@/components/streamix/HlsVideo';
import {
  Server, AlertCircle, RotateCw, Loader2,
  CheckCircle2, XCircle, Circle, Youtube, ChevronRight, Play, Shield, ShieldOff,
  Crown, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * VideoPlayer — reliability-first multi-server player for movies & TV.
 *
 * Servers come in three flavours:
 *
 *  1. PREMIUM (Real-Debrid)  — server.isPremium === true
 *       Resolved server-side via /api/realdebrid/resolve. Returns a direct
 *       HTTPS stream URL we play in a native <video>. Almost ad-free.
 *       Configured via RD_ADDON_MANIFEST_URL (see .env).
 *
 *  2. EMBED (iframe providers) — server.movie / server.tv resolvers
 *       Wrapped in our /embed proxy with a strict outer-iframe sandbox.
 *       The "double-iframe sandbox" trick: provider can't detect our outer
 *       sandbox (cross-origin barrier) but sandbox flags still propagate
 *       to the nested context, blocking tab-hijack ads.
 *
 *  3. DIRECT (demo)  — server.isDirect === true
 *       Plain <video> with a hosted .mp4 (used as final fallback).
 *
 * UX:
 *   - Lazy mount: shows a big Play overlay until user clicks
 *   - 8-second load timeout for embeds → auto-fail → auto-switch
 *   - 25-second resolution timeout for Premium → auto-fail → auto-switch
 *   - Premium results cached in-component per (mediaType, tmdbId, S, E)
 *   - Per-server status: green ✓ / red ✗ / yellow ⟳ / empty ○
 *   - localStorage remembers last working server + popup-blocker preference
 */

const STATUS = { UNTESTED: 'untested', LOADING: 'loading', OK: 'ok', FAILED: 'failed' };
const LOAD_TIMEOUT_MS = 8000;
const PREMIUM_TIMEOUT_MS = 60000; // 60 seconds - enough for torrent preparation

// Sandbox applied to the OUTER iframe (which loads our /embed proxy).
// `allow-popups` is included to defeat providers' `window.open()` probe —
// without it providers refuse to play and show "disable sandbox". The
// popups that do spawn inherit the sandbox so they're neutered.
// `allow-top-navigation` is OFF — tab-hijack ads (the worst kind) are blocked.
const POPUP_BLOCK_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-presentation allow-modals allow-popups';

const VideoPlayer = ({
  mediaType,
  tmdbId,
  imdbId = null,
  season = 1,
  episode = 1,
  poster,
  trailerKey,
}) => {
  // Persistence keys
  const persistKey = useMemo(
    () => `streamix:server:${mediaType}:${tmdbId}`,
    [mediaType, tmdbId],
  );
  const blockerKey = 'streamix:popupBlocker';

  const initialIdx = (() => {
    if (typeof window === 'undefined') return 0;
    const v = parseInt(window.localStorage.getItem(persistKey) || '0', 10);
    return Number.isFinite(v) && v >= 0 && v < STREAMING_SERVERS.length ? v : 0;
  })();

  const initialBlock = (() => {
    if (typeof window === 'undefined') return true;
    const v = window.localStorage.getItem(blockerKey);
    return v === null ? true : v === '1';
  })();

  const [serverIdx, setServerIdx] = useState(initialIdx);
  const [statuses, setStatuses] = useState(() => STREAMING_SERVERS.map(() => STATUS.UNTESTED));
  const [iframeKey, setIframeKey] = useState(0);
  const [showTrailer, setShowTrailer] = useState(false);
  const [toast, setToast] = useState(null);
  const [playerActive, setPlayerActive] = useState(false);
  const [popupBlock, setPopupBlock] = useState(initialBlock);

  // Premium (Real-Debrid) resolution state
  // Shape: { state: 'idle'|'loading'|'ok'|'error', url, quality, title, error,
  //          alternates, altIndex, qualities }
  // - `qualities` is the per-resolution picker list from the resolver
  //   (≤4 entries, sorted hi→lo). Passed straight to HlsVideo as
  //   `qualityOptions`. Empty array when the resolver couldn't probe any
  //   candidates, or for the AllDebrid client-side path (which doesn't
  //   return a quality menu).
  const [premium, setPremium] = useState({
    state: 'idle', url: null, quality: null, title: null, error: null,
    alternates: [], altIndex: 0, qualities: [],
  });
  const premiumCacheRef = useRef(new Map());

  // Subtitles state
  const [subtitles, setSubtitles] = useState({ 
    available: [], // [{ file_id, language, language_name, downloads }]
    selected: null, // language code ('en', 'es', etc.) or null for off
    loading: false,
    error: null,
    quotaExhausted: false
  });
  const subtitleLangKey = 'streamix:subtitleLang';

  const timerRef = useRef(null);
  const triedAutoSwitchRef = useRef(new Set());

  const activeServer = STREAMING_SERVERS[serverIdx];
  const embedUrl = getEmbedUrl(activeServer, mediaType, tmdbId, season, episode);

  const updateStatus = useCallback((idx, status) => {
    setStatuses((prev) => {
      if (prev[idx] === status) return prev;
      const next = prev.slice();
      next[idx] = status;
      return next;
    });
  }, []);

  const findNextCandidate = useCallback(
    (fromIdx) => {
      for (let i = 1; i < STREAMING_SERVERS.length; i++) {
        const idx = (fromIdx + i) % STREAMING_SERVERS.length;
        if (statuses[idx] !== STATUS.FAILED && !triedAutoSwitchRef.current.has(idx)) {
          return idx;
        }
      }
      const demoIdx = STREAMING_SERVERS.findIndex((s) => s.isDirect);
      return demoIdx >= 0 ? demoIdx : null;
    },
    [statuses],
  );

  const tryNextServer = useCallback(() => {
    const next = findNextCandidate(serverIdx);
    if (next != null && next !== serverIdx) setServerIdx(next);
    setToast(null);
  }, [findNextCandidate, serverIdx]);

  // ────────────────────────────────────────────────────────────
  // EMBED load timer (8s) — applies only to iframe providers
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playerActive || showTrailer) return;
    if (activeServer.isPremium) return; // premium has its own resolver effect
    if (activeServer.isDirect) {
      updateStatus(serverIdx, STATUS.OK);
      return;
    }

    setToast(null);
    updateStatus(serverIdx, STATUS.LOADING);
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      setStatuses((prev) => {
        if (prev[serverIdx] !== STATUS.LOADING) return prev;
        const next = prev.slice();
        next[serverIdx] = STATUS.FAILED;
        return next;
      });
      triedAutoSwitchRef.current.add(serverIdx);
      setToast({
        kind: 'warn',
        msg: `${activeServer.name} failed to load — trying next server…`,
      });
      setTimeout(() => {
        const next = findNextCandidate(serverIdx);
        if (next != null && next !== serverIdx) setServerIdx(next);
      }, 900);
    }, LOAD_TIMEOUT_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIdx, iframeKey, season, episode, playerActive, showTrailer]);

  // ────────────────────────────────────────────────────────────
  // PREMIUM (Real-Debrid) resolver
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeServer.isPremium) {
      setPremium((p) => (p.state === 'idle' ? p : { state: 'idle', url: null, quality: null, title: null, error: null, alternates: [], altIndex: 0, qualities: [] }));
      return;
    }
    if (!playerActive || showTrailer) return;

    const cacheKey = `${mediaType}:${tmdbId}:${season}:${episode}`;
    const hit = premiumCacheRef.current.get(cacheKey);
    if (hit) {
      setPremium({ state: 'ok', ...hit, error: null, altIndex: 0 });
      updateStatus(serverIdx, STATUS.OK);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PREMIUM_TIMEOUT_MS);

    setPremium({ state: 'loading', url: null, quality: null, title: null, error: null, alternates: [], altIndex: 0, qualities: [] });
    updateStatus(serverIdx, STATUS.LOADING);
    setToast(null);

    // Determine which premium API to use based on server config
    const server = STREAMING_SERVERS[serverIdx];
    const premiumType = server?.premiumType || 'realdebrid';

    console.log(`[Premium] Using ${premiumType} for ${server?.name}`);

    // AllDebrid: Use client-side resolver (avoids server IP block)
    if (premiumType === 'alldebrid') {
      clearTimeout(timeoutId); // Clear default timeout for client-side resolver

      const adApiKey = process.env.NEXT_PUBLIC_ALLDEBRID_API_KEY;
      const cometManifestUrl = process.env.NEXT_PUBLIC_RD_ADDON_MANIFEST_URL;

      console.log('[Premium AD] API Key:', adApiKey ? 'SET' : 'MISSING');
      console.log('[Premium AD] Comet URL:', cometManifestUrl ? 'SET' : 'MISSING');

      resolveAllDebrid({
        imdbId,
        mediaType,
        season: mediaType === 'tv' ? season : null,
        episode: mediaType === 'tv' ? episode : null,
        adApiKey,
        cometManifestUrl,
      })
        .then(data => {
          if (cancelled) return;
          const payload = {
            url: data.streamUrl,
            quality: data.quality || data.filename,
            title: data.filename || '',
            alternates: [],
            qualities: [],
          };
          premiumCacheRef.current.set(cacheKey, payload);
          setPremium({ state: 'ok', ...payload, error: null, altIndex: 0 });
          updateStatus(serverIdx, STATUS.OK);
        })
        .catch(err => {
          if (cancelled) return;
          console.error(`[Premium AD] Error:`, err);
          setPremium({ state: 'error', url: null, quality: null, title: null, error: err.message, alternates: [], altIndex: 0, qualities: [] });
          updateStatus(serverIdx, STATUS.FAILED);
          triedAutoSwitchRef.current.add(serverIdx);
          setToast({ kind: 'error', msg: `AllDebrid: ${err.message}` });
          setTimeout(() => tryNextServer(), 1500);
        });

      return () => { cancelled = true; };
    }

    // Real-Debrid: Use server-side API
    const apiEndpoint = '/api/realdebrid/resolve';

    const params = new URLSearchParams({ type: mediaType });
    if (imdbId) params.set('imdb', imdbId);
    if (tmdbId) params.set('tmdb', String(tmdbId));
    if (mediaType === 'tv') {
      params.set('season', String(season));
      params.set('episode', String(episode));
    }

    fetch(`${apiEndpoint}?${params.toString()}`, { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !data.success || !data.streamUrl) {
          throw new Error(data.error || `Resolver returned ${r.status}`);
        }
        const payload = {
          url: data.streamUrl,
          quality: data.quality || data.filename,
          title: data.filename || '',
          alternates: Array.isArray(data.alternates) ? data.alternates : [],
          qualities: Array.isArray(data.qualities) ? data.qualities : [],
        };
        premiumCacheRef.current.set(cacheKey, payload);
        setPremium({ state: 'ok', ...payload, error: null, altIndex: 0 });
        updateStatus(serverIdx, STATUS.OK);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e.name === 'AbortError'
          ? 'Premium resolution timed out.'
          : (e.message || 'Premium resolution failed.');
        setPremium({ state: 'error', url: null, quality: null, title: null, error: msg, alternates: [], altIndex: 0, qualities: [] });
        updateStatus(serverIdx, STATUS.FAILED);
        triedAutoSwitchRef.current.add(serverIdx);
        setToast({
          kind: 'error',
          msg: `Premium: ${msg} — falling back to next server…`,
        });
        setTimeout(() => {
          if (cancelled) return;
          const next = findNextCandidate(serverIdx);
          if (next != null && next !== serverIdx) setServerIdx(next);
        }, 1800);
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeServer.isPremium, mediaType, tmdbId, imdbId, season, episode, playerActive, showTrailer, serverIdx]);

  // Persist last selected server
  useEffect(() => {
    try { window.localStorage.setItem(persistKey, String(serverIdx)); } catch (_) {}
  }, [serverIdx, persistKey]);

  // Persist popup-blocker preference
  useEffect(() => {
    try { window.localStorage.setItem(blockerKey, popupBlock ? '1' : '0'); } catch (_) {}
  }, [popupBlock]);

  // Fetch subtitles when media changes
  useEffect(() => {
    if (!tmdbId) return;

    let cancelled = false;
    setSubtitles(prev => ({ ...prev, loading: true, error: null, quotaExhausted: false }));

    const params = new URLSearchParams({
      tmdb_id: String(tmdbId),
      type: mediaType,
      languages: 'en,es,fr,de,it,pt,ru,ja,ko,zh' // Top 10 languages
    });

    if (mediaType === 'tv') {
      params.set('season', String(season));
      params.set('episode', String(episode));
    }

    const searchUrl = `/api/subtitles/search?${params.toString()}`;
    console.log(`[Subtitles] Fetching: ${searchUrl}`);

    fetch(searchUrl)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;

        console.log(`[Subtitles] Response status: ${r.status}, IMDB: ${data.imdb_id || 'N/A'}, Results: ${(data.results || []).length}`);

        if (!r.ok) {
          if (r.status === 429 || data.error === 'daily_quota_exhausted') {
            setSubtitles(prev => ({ 
              ...prev, 
              loading: false, 
              quotaExhausted: true,
              error: 'OpenSubtitles daily quota exhausted. Try again tomorrow.'
            }));
          } else {
            setSubtitles(prev => ({ 
              ...prev, 
              loading: false, 
              error: data.error || 'Subtitle search failed' 
            }));
          }
          return;
        }

        const available = data.results || [];
        console.log(`[Subtitles] Found ${available.length} languages for ${mediaType} ${tmdbId}`);

        // Restore last selected language if available
        let selected = null;
        try {
          const lastLang = window.localStorage.getItem(subtitleLangKey);
          if (lastLang && available.some(s => s.language === lastLang)) {
            selected = lastLang;
          }
        } catch (_) {}

        setSubtitles({ available, selected, loading: false, error: null, quotaExhausted: false });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[Subtitles] Search error:', err);
        setSubtitles(prev => ({ 
          ...prev, 
          loading: false, 
          error: err.message || 'Network error' 
        }));
      });

    return () => { cancelled = true; };
  }, [tmdbId, mediaType, season, episode]);

  // Persist selected subtitle language
  useEffect(() => {
    if (subtitles.selected) {
      try { 
        window.localStorage.setItem(subtitleLangKey, subtitles.selected); 
      } catch (_) {}
    }
  }, [subtitles.selected]);

  const handleIframeLoad = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    updateStatus(serverIdx, STATUS.OK);
  };

  const handleIframeError = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    updateStatus(serverIdx, STATUS.FAILED);
    triedAutoSwitchRef.current.add(serverIdx);
    setToast({ kind: 'error', msg: `${activeServer.name} failed — trying next server…` });
    const next = findNextCandidate(serverIdx);
    if (next != null && next !== serverIdx) {
      setTimeout(() => setServerIdx(next), 800);
    }
  };

  const markBroken = () => {
    updateStatus(serverIdx, STATUS.FAILED);
    triedAutoSwitchRef.current.add(serverIdx);
    tryNextServer();
  };

  const reload = () => {
    triedAutoSwitchRef.current.delete(serverIdx);
    if (timerRef.current) clearTimeout(timerRef.current);
    updateStatus(serverIdx, STATUS.UNTESTED);
    // For premium, clear cache for this title so it re-resolves
    if (activeServer.isPremium) {
      const cacheKey = `${mediaType}:${tmdbId}:${season}:${episode}`;
      premiumCacheRef.current.delete(cacheKey);
      setPremium({ state: 'idle', url: null, quality: null, title: null, error: null, qualities: [] });
    }
    setIframeKey((k) => k + 1);
  };

  const selectServer = (i) => {
    setShowTrailer(false);
    triedAutoSwitchRef.current.clear();
    setServerIdx(i);
    setToast(null);
  };

  // Reset playerActive when episode/season changes
  useEffect(() => {
    setPlayerActive(false);
  }, [season, episode]);

  // ────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────
  const isPremiumActive = activeServer.isPremium;
  const showPopupToggle = !activeServer.isDirect && !activeServer.isPremium;

  return (
    <div className="w-full">
      {/* Player frame */}
      <div className="relative w-full bg-black">
        <div className="relative w-full mx-auto bg-black" style={{ maxWidth: '1400px' }}>
          <div className="relative w-full aspect-video bg-black">
            {/* Lazy overlay — player only mounts after click */}
            {!playerActive && !showTrailer && (
              <button
                onClick={() => setPlayerActive(true)}
                className="absolute inset-0 w-full h-full group"
                aria-label="Play"
              >
                {poster ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={poster} alt="" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 bg-neutral-900" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-black/30" />
                <div className="absolute inset-0 grid place-items-center">
                  <div className="flex flex-col items-center gap-3 transition-transform group-hover:scale-105">
                    <div className={`h-20 w-20 md:h-24 md:w-24 rounded-full grid place-items-center shadow-2xl ring-4 ring-white/10 ${
                      isPremiumActive
                        ? 'bg-gradient-to-br from-amber-400 to-yellow-600 hover:from-amber-300 hover:to-yellow-500 shadow-amber-500/40'
                        : 'bg-red-600 hover:bg-red-700 shadow-red-600/40'
                    }`}>
                      <Play className="w-10 h-10 md:w-12 md:h-12 fill-white text-white ml-1" />
                    </div>
                    <span className="text-sm font-semibold text-white/90 tracking-wide">
                      Click to start playback
                    </span>
                    <span className="text-[11px] text-neutral-300 max-w-md text-center px-4 flex items-center gap-1.5">
                      {isPremiumActive && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                      Streaming on <b className="text-white">{activeServer.name}</b>
                      {mediaType === 'tv' && <> · S{season} · E{episode}</>}
                    </span>
                  </div>
                </div>
              </button>
            )}

            {/* Trailer */}
            {playerActive && showTrailer && trailerKey && (
              <iframe
                key={`trailer-${trailerKey}`}
                src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0&modestbranding=1`}
                className="absolute inset-0 w-full h-full"
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
                title="Trailer"
              />
            )}

            {/* DIRECT (demo) */}
            {playerActive && !showTrailer && activeServer.isDirect && (
              <video
                key={`direct-${iframeKey}`}
                src={activeServer.src}
                controls
                autoPlay
                playsInline
                poster={poster || undefined}
                className="w-full h-full object-contain bg-black"
                onCanPlay={() => updateStatus(serverIdx, STATUS.OK)}
              />
            )}

            {/* PREMIUM (Real-Debrid → HLS via ffmpeg) — codec-universal.
                Note: `${premium.url}` deliberately NOT in the key so that
                in-place src swaps (quality picker, fatal-fallback alternate
                rotation) DON'T remount HlsVideo. The hls.js effect inside
                HlsVideo handles src changes cleanly and preserves the
                playback position across the swap. iframeKey is still in the
                key because reload/server-change should fully remount. */}
            {playerActive && !showTrailer && isPremiumActive && premium.state === 'ok' && premium.url && (
              <HlsVideo
                key={`premium-${iframeKey}`}
                src={premium.url}
                poster={poster || undefined}
                className="w-full h-full object-contain bg-black"
                qualityLabel={premium.quality || 'Source · 1080p'}
                qualityOptions={premium.qualities || []}
                onQualityChange={(label, url) => {
                  // The picker (or its 10s safety revert) is asking us to
                  // swap the source. We only update `url` — quality label
                  // on the action bar continues to reflect the resolver's
                  // original primary pick, which is intentional (it's a
                  // brand mark, not a live indicator).
                  setPremium((p) => ({ ...p, url }));
                }}
                subtitleTracks={subtitles.available}
                selectedSubtitle={subtitles.selected}
                onSubtitleChange={(lang) => {
                  setSubtitles((prev) => ({ ...prev, selected: lang }));
                }}
                subtitlesLoading={subtitles.loading}
                subtitlesError={subtitles.error}
                onReady={() => updateStatus(serverIdx, STATUS.OK)}
                onFatal={() => {
                  // The HLS player gave up. Try alternates (each its own
                  // pre-built HLS session) before falling back to a
                  // different streaming server.
                  const alts = premium.alternates || [];
                  const nextAlt = premium.altIndex + 1;
                  if (nextAlt - 1 < alts.length) {
                    const a = alts[nextAlt - 1];
                    console.log(`[Premium] Primary failed, trying alternate #${nextAlt}: ${a.filename}`);
                    setToast({
                      kind: 'warn',
                      msg: `Primary stream failed, trying alternate #${nextAlt}…`,
                    });
                    setPremium((prev) => ({
                      ...prev,
                      url: a.streamUrl,
                      quality: a.quality || a.filename,
                      title: a.filename || '',
                      altIndex: nextAlt,
                    }));
                    return;
                  }
                  updateStatus(serverIdx, STATUS.FAILED);
                  triedAutoSwitchRef.current.add(serverIdx);
                  setToast({ kind: 'error', msg: 'Premium stream playback failed — trying next server…' });
                  setTimeout(() => tryNextServer(), 1000);
                }}
              />
            )}

            {/* PREMIUM loading overlay */}
            {playerActive && !showTrailer && isPremiumActive && premium.state === 'loading' && (
              <div className="absolute inset-0 grid place-items-center bg-black/80 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-4 text-center px-6">
                  <div className="relative">
                    <div className="absolute inset-0 rounded-full bg-amber-500/20 blur-2xl animate-pulse" />
                    <div className="relative h-16 w-16 rounded-full bg-gradient-to-br from-amber-400 to-yellow-600 grid place-items-center ring-4 ring-amber-500/30">
                      <Loader2 className="w-8 h-8 text-white animate-spin" />
                    </div>
                  </div>
                  <div>
                    <p className="text-base font-semibold text-amber-100 flex items-center justify-center gap-1.5">
                      <Crown className="w-4 h-4 text-amber-400" />
                      Unlocking Premium stream
                    </p>
                    <p className="text-xs text-neutral-400 mt-1.5 max-w-sm">
                      Asking Real-Debrid for the cleanest mirror… usually takes 2–5 seconds.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* PREMIUM error overlay (brief — auto-switching) */}
            {playerActive && !showTrailer && isPremiumActive && premium.state === 'error' && (
              <div className="absolute inset-0 grid place-items-center bg-black/85 px-6">
                <div className="max-w-md text-center">
                  <AlertCircle className="w-10 h-10 mx-auto mb-3 text-amber-400" />
                  <p className="text-base font-semibold text-amber-100">Premium unavailable for this title</p>
                  <p className="text-xs text-neutral-400 mt-2 break-words">{premium.error}</p>
                  <p className="text-xs text-neutral-500 mt-3">Switching to next server…</p>
                </div>
              </div>
            )}

            {/* EMBED iframe */}
            {playerActive && !showTrailer && !activeServer.isDirect && !isPremiumActive && embedUrl && (
              <iframe
                key={`${activeServer.id}-${season}-${episode}-${iframeKey}-${popupBlock ? 'pb' : 'np'}`}
                src={popupBlock ? `/embed?url=${encodeURIComponent(embedUrl)}` : embedUrl}
                className="absolute inset-0 w-full h-full"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
                referrerPolicy="no-referrer"
                {...(popupBlock ? { sandbox: POPUP_BLOCK_SANDBOX } : {})}
                onLoad={handleIframeLoad}
                onError={handleIframeError}
                title={`${activeServer.name} player`}
              />
            )}

            {playerActive && !showTrailer && !activeServer.isDirect && !isPremiumActive && !embedUrl && (
              <div className="absolute inset-0 grid place-items-center text-center p-6">
                <div>
                  <AlertCircle className="w-10 h-10 mx-auto mb-3 text-red-500" />
                  <p className="text-lg font-semibold">Source not available</p>
                  <p className="text-sm text-neutral-400 mt-1">Try another server below.</p>
                </div>
              </div>
            )}

            {/* Loading badge (embed only) */}
            {playerActive && !showTrailer && !activeServer.isDirect && !isPremiumActive && statuses[serverIdx] === STATUS.LOADING && (
              <div className="absolute top-3 left-3 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-black/70 backdrop-blur text-xs text-neutral-100">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Connecting to <b>{activeServer.name}</b>…
              </div>
            )}
          </div>

          {/* Toast */}
          {toast && (
            <div className={`mt-3 mx-2 md:mx-0 flex items-center justify-between gap-3 px-4 py-3 rounded-md border ${
              toast.kind === 'error'
                ? 'bg-red-950/40 border-red-900 text-red-200'
                : 'bg-yellow-950/40 border-yellow-900 text-yellow-200'
            }`}>
              <div className="flex items-center gap-2 text-sm">
                <AlertCircle className="w-4 h-4 flex-none" />
                <span>{toast.msg}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={tryNextServer} className="bg-white/10 hover:bg-white/20 border border-white/10">
                  Try next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
                <button onClick={() => setToast(null)} className="text-xs opacity-70 hover:opacity-100">Dismiss</button>
              </div>
            </div>
          )}

          {/* Action bar */}
          {!showTrailer && (
            <div className="px-2 md:px-0 mt-3 flex items-center justify-between flex-wrap gap-3">
              <div className="inline-flex items-center gap-2 text-xs text-neutral-300 flex-wrap">
                <StatusDot status={statuses[serverIdx]} />
                <span className="inline-flex items-center gap-1.5">
                  {isPremiumActive && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                  Playing on <b className="text-white">{activeServer.name}</b>
                </span>

                {/* Premium quality badge */}
                {isPremiumActive && premium.state === 'ok' && premium.quality && (
                  <span
                    className="inline-flex items-center gap-1 ml-2 text-[10px] uppercase tracking-wider text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5"
                    title={premium.title || ''}
                  >
                    <Sparkles className="w-3 h-3" />
                    {premium.quality.length > 32 ? premium.quality.slice(0, 32) + '…' : premium.quality}
                  </span>
                )}

                {/* Popup-blocker badge (embeds only) */}
                {showPopupToggle && (
                  <span
                    className={`inline-flex items-center gap-1 ml-2 text-[10px] uppercase tracking-wider ${
                      popupBlock ? 'text-emerald-400' : 'text-yellow-400'
                    }`}
                    title={popupBlock
                      ? 'Tab-hijack protection ON. Provider cannot redirect your tab or open further popups from popups. Some popup ads may still spawn but are heavily restricted.'
                      : 'Tab-hijack protection OFF. Provider can fully redirect your tab and spawn unrestricted popups.'}
                  >
                    {popupBlock ? <Shield className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
                    {popupBlock ? 'redirects blocked' : 'unprotected'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {showPopupToggle && (
                  <button
                    onClick={() => { setPopupBlock((v) => !v); setIframeKey((k) => k + 1); }}
                    title={popupBlock
                      ? 'Tab-hijack protection is ON. Disable only if this provider refuses to play.'
                      : 'Enable tab-hijack protection (blocks redirects, limits popups).'}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md border text-sm transition ${
                      popupBlock
                        ? 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
                        : 'bg-yellow-500/10 hover:bg-yellow-500/20 border-yellow-500/30 text-yellow-300'
                    }`}
                  >
                    {popupBlock ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                    <span className="hidden sm:inline">{popupBlock ? 'Protection: ON' : 'Protection: OFF'}</span>
                  </button>
                )}
                <button
                  onClick={reload}
                  title="Reload player"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-sm text-neutral-200"
                >
                  <RotateCw className="w-4 h-4" /> Reload
                </button>
                {!activeServer.isDirect && (
                  <button
                    onClick={markBroken}
                    className="text-xs text-neutral-400 hover:text-red-300 underline-offset-2 hover:underline px-2"
                  >
                    Mark broken
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Server tabs */}
      <section className="px-4 md:px-8 py-6">
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <div className="flex items-center gap-2 text-neutral-300">
            <Server className="w-4 h-4" />
            <h3 className="text-sm font-semibold uppercase tracking-wider">Servers</h3>
            <span className="text-xs text-neutral-500 hidden md:inline">
              Auto-switches if a server fails. The Premium tab uses Real-Debrid for nearly ad-free playback.
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 md:flex md:flex-wrap gap-2">
          {STREAMING_SERVERS.map((s, i) => {
            const isActive = i === serverIdx && !showTrailer;
            const st = statuses[i];
            const isPrem = s.isPremium;

            if (isPrem) {
              return (
                <button
                  key={s.id}
                  onClick={() => selectServer(i)}
                  className={`relative px-3 py-2.5 rounded-md text-sm font-semibold border transition flex items-center gap-2 text-left min-w-[160px] ${
                    isActive
                      ? 'bg-gradient-to-br from-amber-500 to-yellow-600 border-amber-400 text-white shadow-lg shadow-amber-500/40 ring-2 ring-amber-300/50'
                      : st === STATUS.FAILED
                      ? 'bg-amber-950/40 border-amber-900/60 text-amber-200/70 hover:border-amber-700'
                      : 'bg-gradient-to-br from-amber-950/60 to-yellow-950/40 border-amber-500/40 hover:border-amber-400 text-amber-100 hover:shadow-md hover:shadow-amber-500/20'
                  }`}
                  title="Real-Debrid powered — almost ad-free. Requires RD_ADDON_MANIFEST_URL set on the server."
                >
                  <Crown className={`w-4 h-4 flex-none ${isActive ? 'text-white' : 'text-amber-400'}`} />
                  <span className="flex flex-col items-start leading-tight">
                    <span className="flex items-center gap-1.5">
                      {s.name}
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                        isActive ? 'bg-white/25 text-white' : 'bg-amber-500/20 text-amber-300'
                      }`}>
                        Almost no ads
                      </span>
                    </span>
                    <span className="text-[10px] font-normal opacity-80">
                      {s.sub}
                    </span>
                  </span>
                  {st === STATUS.LOADING && (
                    <Loader2 className="w-3.5 h-3.5 absolute right-2 top-2 animate-spin text-amber-200" />
                  )}
                </button>
              );
            }

            return (
              <button
                key={s.id}
                onClick={() => selectServer(i)}
                className={`px-3 py-2.5 rounded-md text-sm font-semibold border transition flex items-center gap-2 text-left min-w-[130px] ${
                  isActive
                    ? 'bg-red-600 border-red-600 text-white shadow-lg shadow-red-600/30'
                    : st === STATUS.FAILED
                    ? 'bg-neutral-900/60 border-red-900/50 text-neutral-400 hover:border-red-700'
                    : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
                }`}
              >
                <StatusIcon status={st} active={isActive} />
                <span className="flex flex-col items-start leading-tight">
                  <span>{s.name}</span>
                  <span className="text-[10px] font-normal opacity-80">{s.sub}</span>
                </span>
              </button>
            );
          })}

          {trailerKey && (
            <button
              onClick={() => { setShowTrailer((v) => !v); setPlayerActive(true); }}
              className={`px-3 py-2.5 rounded-md text-sm font-semibold border transition flex items-center gap-2 min-w-[130px] ${
                showTrailer
                  ? 'bg-white text-black border-white'
                  : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
              }`}
            >
              <Youtube className="w-3.5 h-3.5 flex-none text-red-500" />
              <span className="flex flex-col items-start leading-tight">
                <span>{showTrailer ? 'Hide Trailer' : 'Watch Trailer'}</span>
                <span className="text-[10px] font-normal opacity-80">YouTube</span>
              </span>
            </button>
          )}
        </div>

        {/* Premium info note */}
        <p className="mt-3 text-[11px] text-neutral-500 max-w-2xl leading-relaxed">
          <Crown className="w-3 h-3 inline mr-1 -mt-0.5 text-amber-400/70" />
          <b className="text-amber-300/80">Premium (Real-Debrid)</b> streams direct from RD&apos;s servers — very low ads, no popups, faster start.
          Requires a configured Real-Debrid manifest URL on the server. If a title isn&apos;t cached yet, the player falls back automatically.
        </p>
      </section>
    </div>
  );
};

const StatusDot = ({ status }) => {
  if (status === STATUS.OK) return <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />;
  if (status === STATUS.FAILED) return <span className="h-1.5 w-1.5 rounded-full bg-red-500" />;
  if (status === STATUS.LOADING) return <span className="h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />;
};

const StatusIcon = ({ status, active }) => {
  const baseClass = 'w-3.5 h-3.5 flex-none';
  if (active) return <CheckCircle2 className={`${baseClass} text-white`} />;
  if (status === STATUS.OK) return <CheckCircle2 className={`${baseClass} text-emerald-400`} />;
  if (status === STATUS.FAILED) return <XCircle className={`${baseClass} text-red-500`} />;
  if (status === STATUS.LOADING) return <Loader2 className={`${baseClass} text-yellow-400 animate-spin`} />;
  return <Circle className={`${baseClass} text-neutral-500`} />;
};

export default VideoPlayer;
