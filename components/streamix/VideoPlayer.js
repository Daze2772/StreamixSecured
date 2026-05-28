'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STREAMING_SERVERS, getEmbedUrl } from '@/lib/streaming';
import { resolveAllDebrid } from '@/lib/alldebrid-client';
import HlsVideo from '@/components/streamix/HlsVideo';
import {
  Server, AlertCircle, RotateCw, Loader2,
  CheckCircle2, XCircle, Circle, Youtube, ChevronRight, Play, Shield, ShieldOff,
  Crown, Sparkles, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * VideoPlayer — reliability-first multi-server player for movies & TV.
 *
 * Servers come in three flavours:
 *
 *  1. PREMIUM — server.isPremium === true
 *       Resolved server-side via our debrid backend. Returns a direct
 *       HTTPS stream URL we play in a native <video>. Almost ad-free.
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
  title = null,
  posterPath = null,
  backdropPath = null,
  // Continue Watching resume offset (seconds, real-world). When > 0, the
  // RD resolver is invoked with `&start=<initialResume>` so the spawned
  // HLS sessions begin at the saved position. The session's startOffset
  // is echoed back to us as `premium.sessionStartOffset` and threaded
  // into HlsVideo for display + progress accounting. Only honoured on
  // the FIRST mount per route (the parent watch page snapshots it from
  // the URL once).
  initialResume = 0,
  // ── Up-Next / Auto-play next episode ──────────────────────────
  // `nextEpisode` is a descriptor of the episode that should play
  // next; the watch page computes it from TMDB season data. When
  // set, the player will surface a Netflix-style "Up Next" overlay
  // in the final seconds of the current episode and call
  // `onPlayNext()` either when the user clicks "Play Now" or when
  // the countdown reaches zero / the video ends. Movies and the
  // last episode of the last season get `null` and never see the
  // overlay.
  nextEpisode = null,
  onPlayNext = null,
}) => {
  // Persistence keys
  const persistKey = useMemo(
    () => `streamix:server:${mediaType}:${tmdbId}`,
    [mediaType, tmdbId],
  );
  const blockerKey = 'streamix:popupBlocker';
  // Session-persisted dismissal of the "public server has external ads"
  // advisory. We DELIBERATELY use sessionStorage (not localStorage) so the
  // notice reappears on a fresh visit — first-time users on each session
  // are always reminded that Premium is available for free, but returning
  // visitors within the same tab won't be nagged.
  const embedAdvisoryKey = 'streamix:embedAdvisoryDismissed';

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
  // Whether the embed-ads advisory should appear when an embed server is
  // active. Defaults to true; flipped to false (for the rest of the tab
  // session) when the user clicks Dismiss on the advisory card. Reads
  // sessionStorage on mount so dismissal survives in-tab navigation
  // (e.g. Back to Home and re-opening a title) but resets on a fresh tab.
  const initialEmbedAdvisoryOpen = (() => {
    if (typeof window === 'undefined') return true;
    try { return window.sessionStorage.getItem(embedAdvisoryKey) !== '1'; } catch (_) { return true; }
  })();
  const [embedAdvisoryOpen, setEmbedAdvisoryOpen] = useState(initialEmbedAdvisoryOpen);

  // Premium resolution state
  // Shape: { state: 'idle'|'loading'|'ok'|'error', url, quality, title, error,
  //          alternates, altIndex, qualities, sessionStartOffset, sourceDuration }
  // - `qualities` is the per-resolution picker list from the resolver
  //   (≤4 entries, sorted hi→lo). Passed straight to HlsVideo as
  //   `qualityOptions`. Empty array when the resolver couldn't probe any
  //   candidates, or for the premium client-side path (which doesn't
  //   return a quality menu).
  // - `sourceDuration` (float seconds) is the FULL video duration from
  //   ffprobe (probed once at session creation). The frontend uses it as
  //   a FIXED denominator for the time display + scrubber so the total
  //   runtime doesn't appear to "grow" as the HLS transcoder writes
  //   segments on demand. Null if ffprobe failed → fallback to the old
  //   growing-duration behavior.
  // - `audioStreams` (Phase 2) is the full list of audio tracks detected
  //   in the source (e.g. [{audioIndex:0, language:'eng', codec:'aac',
  //   channels:6}, ...]). Empty array if probe failed or single-audio.
  // - `currentAudioIndex` (Phase 2) is the actively-playing audio track
  //   index (0-based). Updated on audio switches.
  // - `currentSourceUrl` (Phase 4 hotfix) is the premium backend
  //   playback URL backing the CURRENTLY PLAYING HLS session. Persists
  //   across audio switches (audio swap re-spawns the session for the
  //   same source) and updates on quality / alternate swap. Used by
  //   onAudioChange to re-mint an HLS session — previously this was
  //   looked up via `qualities.find(...) || alternates.find(...)`, which
  //   broke after the first audio switch because `premium.url` then
  //   pointed at a brand-new session URL that was in neither list.
  const [premium, setPremium] = useState({
    state: 'idle', url: null, quality: null, title: null, error: null,
    alternates: [], altIndex: 0, qualities: [],
    // Real-world seconds the HLS session(s) START at. 0 = fresh playback.
    // > 0 = Continue Watching resume (initialResume from URL) baked into
    // ffmpeg via `-ss`. The frontend displays (currentTime + sessionStartOffset)
    // and saves progress as (currentTime + sessionStartOffset). When the
    // user switches quality mid-playback we POST /api/stream/hls/session
    // with start=<currentRealTime> and update this value to the new offset.
    sessionStartOffset: 0,
    sourceDuration: null,
    audioStreams: [],
    currentAudioIndex: null,
    currentSourceUrl: null,
  });
  const premiumCacheRef = useRef(new Map());
  // initialResume should only fire the resume path on the FIRST resolver
  // hit per mount. If the user navigates to another episode in-page (which
  // re-runs the resolver), we must NOT re-resume from the URL's resume.
  const resumeConsumedRef = useRef(false);

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
  // PREMIUM resolver
  // ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeServer.isPremium) {
      setPremium((p) => (p.state === 'idle' ? p : { state: 'idle', url: null, quality: null, title: null, error: null, alternates: [], altIndex: 0, qualities: [], sessionStartOffset: 0, sourceDuration: null, audioStreams: [], currentAudioIndex: null, currentSourceUrl: null }));
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

    setPremium({ state: 'loading', url: null, quality: null, title: null, error: null, alternates: [], altIndex: 0, qualities: [], sessionStartOffset: 0, sourceDuration: null, audioStreams: [], currentAudioIndex: null, currentSourceUrl: null });
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
            sessionStartOffset: 0,
            sourceDuration: null,
            audioStreams: [],
            currentAudioIndex: null,
            currentSourceUrl: data.directUrl || data.sourceUrl || null,
          };
          premiumCacheRef.current.set(cacheKey, payload);
          setPremium({ state: 'ok', ...payload, error: null, altIndex: 0 });
          updateStatus(serverIdx, STATUS.OK);
        })
        .catch(err => {
          if (cancelled) return;
          console.error(`[Premium AD] Error:`, err);
          setPremium({ state: 'error', url: null, quality: null, title: null, error: err.message, alternates: [], altIndex: 0, qualities: [], sessionStartOffset: 0, sourceDuration: null, audioStreams: [], currentAudioIndex: null, currentSourceUrl: null });
          updateStatus(serverIdx, STATUS.FAILED);
          triedAutoSwitchRef.current.add(serverIdx);
          setToast({ kind: 'error', msg: `Premium 2: ${err.message}` });
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
    // Resume offset — only on the FIRST resolver hit of this mount. After
    // consumption, the ref is set so subsequent episode-change resolves
    // (TV) re-start from 0 of the new episode rather than re-applying
    // the URL's `?resume=` (which was meaningful only for the original
    // {mediaType, tmdbId, season, episode} the user clicked).
    if (!resumeConsumedRef.current && initialResume > 0) {
      params.set('start', String(initialResume));
    }
    resumeConsumedRef.current = true;

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
          sessionStartOffset: Number(data.startOffset) || 0,
          sourceDuration: typeof data.sourceDuration === 'number' ? data.sourceDuration : null,
          audioStreams: Array.isArray(data.audioStreams) ? data.audioStreams : [],
          currentAudioIndex: typeof data.selectedAudioIndex === 'number' ? data.selectedAudioIndex : null,
          // Phase 4 hotfix: track the underlying RD/Comet source URL so
          // subsequent audio switches always know what to feed back into
          // /api/stream/hls/session (instead of trying to look it up via
          // a stale `qualities`/`alternates` table — which broke after
          // the first switch because `url` then points at a new HLS
          // session URL that's in neither list).
          currentSourceUrl: data.directUrl || null,
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
        setPremium({ state: 'error', url: null, quality: null, title: null, error: msg, alternates: [], altIndex: 0, qualities: [], sessionStartOffset: 0, sourceDuration: null, audioStreams: [], currentAudioIndex: null, currentSourceUrl: null });
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

        // Restore last selected language if available, default to OFF
        let selected = null;
        try {
          const lastLang = window.localStorage.getItem(subtitleLangKey);
          // Only restore if: (a) not 'off', (b) exact language is available
          if (lastLang && lastLang !== 'off' && available.some(s => s.language === lastLang)) {
            selected = lastLang;
            console.log(`[Subtitles] Auto-enabled last language: ${lastLang}`);
          } else {
            console.log(`[Subtitles] Defaulting to OFF (last: ${lastLang || 'none'})`);
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

  // Persist selected subtitle language (including 'off')
  useEffect(() => {
    try {
      if (subtitles.selected) {
        window.localStorage.setItem(subtitleLangKey, subtitles.selected);
      } else {
        // Save 'off' when subtitles are disabled
        window.localStorage.setItem(subtitleLangKey, 'off');
      }
    } catch (_) {}
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
      setPremium({ state: 'idle', url: null, quality: null, title: null, error: null, qualities: [], sessionStartOffset: 0, sourceDuration: null, audioStreams: [], currentAudioIndex: null, currentSourceUrl: null });
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
  // Index of the first premium server in the catalogue — used as the
  // target for the "Switch to Premium" CTA inside the embed-ads advisory.
  // If no premium server is configured the advisory CTA is hidden.
  const firstPremiumIdx = useMemo(
    () => STREAMING_SERVERS.findIndex((s) => s.isPremium),
    [],
  );
  // True when the embed-ads advisory should actually render: the active
  // server is a third-party iframe provider (not premium, not the demo
  // direct-MP4 server), AND there's at least one premium server we can
  // route the user to, AND they haven't dismissed it this session.
  const showEmbedAdvisory =
    embedAdvisoryOpen
    && !activeServer.isPremium
    && !activeServer.isDirect
    && firstPremiumIdx >= 0
    && !showTrailer;

  const dismissEmbedAdvisory = () => {
    setEmbedAdvisoryOpen(false);
    try { window.sessionStorage.setItem(embedAdvisoryKey, '1'); } catch (_) {}
  };

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

            {/* PREMIUM (HLS via ffmpeg) — codec-universal.
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
                sessionStartOffset={premium.sessionStartOffset || 0}
                sourceDuration={premium.sourceDuration || null}
                audioStreams={premium.audioStreams || []}
                currentAudioIndex={premium.currentAudioIndex}
                onAudioChange={async (newIndex) => {
                  // Phase 2: Mid-playback audio track switch. Creates a fresh
                  // HLS session at the current real-world position with the
                  // chosen audio track. Same pattern as quality switch path #3.
                  //
                  // Phase 4 hotfix: use `premium.currentSourceUrl` instead of
                  // looking up the directUrl via the (now-stale) qualities /
                  // alternates arrays. After the FIRST audio switch, `premium
                  // .url` points at a brand-new HLS session URL that is NOT
                  // in either list, so the old lookup returned null and
                  // every subsequent switch silently bailed out (Issue #3).
                  const videoEl = document.querySelector('video');
                  if (!videoEl) return;
                  const realTime = (videoEl.currentTime || 0) + (premium.sessionStartOffset || 0);
                  try {
                    const sourceUrl = premium.currentSourceUrl
                      || premium.qualities?.find(q => q.streamUrl === premium.url)?.directUrl
                      || premium.alternates?.find(a => a.streamUrl === premium.url)?.directUrl
                      || null;
                    if (!sourceUrl) {
                      console.warn('[Audio switch] No directUrl available for re-session; audio switch requires directUrl');
                      setToast({ kind: 'error', msg: 'Cannot switch audio — source URL unavailable' });
                      return;
                    }
                    const res = await fetch('/api/stream/hls/session', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        sourceUrl,
                        start: realTime,
                        audioIndex: newIndex,
                        quality: premium.quality,
                        filename: premium.title,
                      }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.success || !data.streamUrl) {
                      throw new Error(data.error || `Audio session creation failed (${res.status})`);
                    }
                    setPremium((p) => ({
                      ...p,
                      url: data.streamUrl,
                      sessionStartOffset: Number(data.startOffset) || realTime,
                      sourceDuration: typeof data.sourceDuration === 'number' ? data.sourceDuration : p.sourceDuration,
                      audioStreams: Array.isArray(data.audioStreams) && data.audioStreams.length > 0 ? data.audioStreams : p.audioStreams,
                      currentAudioIndex: typeof data.selectedAudioIndex === 'number' ? data.selectedAudioIndex : newIndex,
                      // Audio switch DOES NOT change the underlying source —
                      // we're re-encoding the same RD URL with a different
                      // -map 0:a:N. Preserve currentSourceUrl explicitly so
                      // subsequent switches still find it. (The spread ...p
                      // already does this but we make the intent obvious.)
                      currentSourceUrl: p.currentSourceUrl || sourceUrl,
                    }));
                  } catch (e) {
                    console.warn('[Audio switch] Failed:', e?.message);
                    setToast({ kind: 'error', msg: 'Audio switch failed' });
                  }
                }}
                onQualityChange={async (label, target, realTime) => {
                  // Three paths converge here:
                  //   1. Safety-timer revert from HlsVideo. target is the
                  //      minimal { streamUrl: <prevUrl> } the picker stashed
                  //      pre-swap, realTime is null. We do an in-place URL
                  //      swap; the offset is unchanged, so HlsVideo's hls
                  //      effect restores currentTime via pendingSeekRef and
                  //      the user lands where they were.
                  //   2. Quality option without directUrl (legacy / Auto on
                  //      a server that didn't expose it). Same path as (1)
                  //      — in-place swap, pre-built session handles position
                  //      restoration with the SAME startOffset as the
                  //      current session.
                  //   3. Manual quality pick with directUrl + a known
                  //      realTime. We POST to /api/stream/hls/session to
                  //      mint a brand-new HLS session whose first segment
                  //      sits at the user's current real-world second.
                  //      Atomically swap both url AND sessionStartOffset;
                  //      HlsVideo detects the offset change and skips
                  //      pendingSeekRef so the new session plays from t=0
                  //      (= the desired real second).
                  if (!target?.directUrl || !Number.isFinite(realTime)) {
                    setPremium((p) => ({ ...p, url: target?.streamUrl || p.url }));
                    return;
                  }
                  try {
                    const res = await fetch('/api/stream/hls/session', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        sourceUrl: target.directUrl,
                        start: realTime,
                        quality: target.label || label,
                        filename: target.filename,
                        sizeBytes: target.sizeBytes,
                      }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.success || !data.streamUrl) {
                      throw new Error(data.error || `Session creation failed (${res.status})`);
                    }
                    setPremium((p) => ({
                      ...p,
                      url: data.streamUrl,
                      sessionStartOffset: Number(data.startOffset) || realTime,
                      sourceDuration: typeof data.sourceDuration === 'number' ? data.sourceDuration : p.sourceDuration,
                      audioStreams: Array.isArray(data.audioStreams) && data.audioStreams.length > 0 ? data.audioStreams : p.audioStreams,
                      currentAudioIndex: typeof data.selectedAudioIndex === 'number' ? data.selectedAudioIndex : p.currentAudioIndex,
                      // Quality swap → different file at a different RD URL.
                      // Update currentSourceUrl so subsequent audio switches
                      // re-seed against the new source.
                      currentSourceUrl: target.directUrl,
                    }));
                  } catch (e) {
                    // Per spec: if fresh-session creation fails, fall back
                    // to the pre-built streamUrl so playback isn't broken.
                    // This effectively resets to the resolver's original
                    // startOffset (current accepted behavior pre-§10) for
                    // this swap only — the user can resume normally on the
                    // next page load.
                    // TODO: surface this fallback with a toast.
                    console.warn('[Quality swap] new-session creation failed; falling back to pre-built URL:', e?.message);
                    setPremium((p) => ({ ...p, url: target.streamUrl, currentSourceUrl: target.directUrl || p.currentSourceUrl }));
                  }
                }}
                subtitleTracks={subtitles.available}
                selectedSubtitle={subtitles.selected}
                onSubtitleChange={(lang) => {
                  setSubtitles((prev) => ({ ...prev, selected: lang }));
                }}
                subtitlesLoading={subtitles.loading}
                subtitlesError={subtitles.error}
                mediaType={mediaType}
                tmdbId={tmdbId}
                season={season}
                episode={episode}
                title={title}
                posterPath={posterPath}
                backdropPath={backdropPath}
                nextEpisode={nextEpisode}
                onPlayNext={onPlayNext}
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
                      // Alternate rotation = different source file = different
                      // RD URL. Refresh currentSourceUrl so post-rotation
                      // audio switches re-seed against the new source.
                      currentSourceUrl: a.directUrl || prev.currentSourceUrl,
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
                      Searching for the cleanest mirror… usually takes 2–5 seconds, depending on your internet speed.
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

          {/* Embed-server advisory — only shown when on a 3rd-party iframe
              provider. Reminds the user that ads come from the provider
              (we don't control them) and offers a one-tap switch to the
              free Premium tier. Dismissible per-session. */}
          {showEmbedAdvisory && (
            <div className="mt-3 mx-2 md:mx-0 rounded-lg border border-amber-500/30 bg-gradient-to-br from-amber-950/50 to-yellow-950/30 px-4 py-3 flex items-start gap-3">
              <div className="mt-0.5 h-8 w-8 rounded-full bg-amber-500/20 grid place-items-center flex-none">
                <Crown className="w-4 h-4 text-amber-300" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-amber-100">
                  Heads up — <span className="text-amber-300">{activeServer.name}</span> is a third-party server
                </p>
                <p className="text-xs text-neutral-300 mt-1 leading-relaxed">
                  Any ads or pop-ups you see come from the provider — we don't control them. For an almost ad-free experience, try our <b className="text-amber-200">Premium</b> server — it's <b className="text-amber-200">free</b>.
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      selectServer(firstPremiumIdx);
                      dismissEmbedAdvisory();
                    }}
                    className="bg-gradient-to-br from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500 text-white font-semibold h-8 px-3 shadow shadow-amber-500/20"
                  >
                    <Crown className="w-3.5 h-3.5 mr-1.5" />
                    Switch to Premium For Free
                  </Button>
                  <button
                    onClick={dismissEmbedAdvisory}
                    className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1"
                  >
                    Not now
                  </button>
                </div>
              </div>
              <button
                onClick={dismissEmbedAdvisory}
                aria-label="Dismiss advisory"
                className="flex-none text-neutral-500 hover:text-neutral-200 transition"
              >
                <X className="w-4 h-4" />
              </button>
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
              Auto-switches if a server fails. Premium servers provide nearly ad-free playback.
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
                  className={`relative px-2.5 py-2 sm:px-3 sm:py-2.5 rounded-md text-sm font-semibold border transition flex items-center gap-2 text-left min-w-[160px] ${
                    isActive
                      ? 'bg-gradient-to-br from-amber-500 to-yellow-600 border-amber-400 text-white shadow-lg shadow-amber-500/40 ring-2 ring-amber-300/50'
                      : st === STATUS.FAILED
                      ? 'bg-amber-950/40 border-amber-900/60 text-amber-200/70 hover:border-amber-700'
                      : 'bg-gradient-to-br from-amber-950/60 to-yellow-950/40 border-amber-500/40 hover:border-amber-400 text-amber-100 hover:shadow-md hover:shadow-amber-500/20'
                  }`}
                  title="Premium server — almost ad-free. Powered by our debrid backend."
                >
                  <Crown className={`w-4 h-4 flex-none ${isActive ? 'text-white' : 'text-amber-400'}`} />
                  <span className="flex flex-col items-start leading-tight min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span className="truncate">{s.name}</span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider whitespace-nowrap ${
                        isActive ? 'bg-white/25 text-white' : 'bg-amber-500/20 text-amber-300'
                      }`}>
                        Almost no ads
                      </span>
                    </span>
                    <span className="text-[10px] font-normal opacity-80 truncate w-full">
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
                className={`px-2.5 py-2 sm:px-3 sm:py-2.5 rounded-md text-sm font-semibold border transition flex items-center gap-2 text-left min-w-[130px] ${
                  isActive
                    ? 'bg-red-600 border-red-600 text-white shadow-lg shadow-red-600/30'
                    : st === STATUS.FAILED
                    ? 'bg-neutral-900/60 border-red-900/50 text-neutral-400 hover:border-red-700'
                    : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
                }`}
              >
                <StatusIcon status={st} active={isActive} />
                <span className="flex flex-col items-start leading-tight min-w-0 flex-1">
                  <span className="truncate">{s.name}</span>
                  <span className="text-[10px] font-normal opacity-80 truncate w-full">{s.sub}</span>
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
          <b className="text-amber-300/80">Premium</b> streams direct from our backend — very low ads, no popups, faster start.
          If a title isn&apos;t cached yet, the player falls back automatically.
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
