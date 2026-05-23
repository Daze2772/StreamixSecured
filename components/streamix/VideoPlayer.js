'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STREAMING_SERVERS, getEmbedUrl } from '@/lib/streaming';
import { backdrop } from '@/lib/tmdb';
import {
  Server, AlertCircle, RotateCw, ExternalLink, Loader2, CheckCircle2, XCircle, Circle, Youtube,
  ChevronRight, ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * VideoPlayer
 * - Manages multi-server playback for movies and TV episodes
 * - Tracks per-server status (untested / loading / ok / failed)
 * - Auto-suggests next server with toast after 10s of no load event
 * - Renders sandbox attribute per provider
 * - Always provides "Open in new tab" fallback
 */
const STATUS = { UNTESTED: 'untested', LOADING: 'loading', OK: 'ok', FAILED: 'failed' };

const LOAD_TIMEOUT_MS = 10000;

const statusDot = (s) => {
  if (s === STATUS.OK) return <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />;
  if (s === STATUS.FAILED) return <span className="h-1.5 w-1.5 rounded-full bg-red-500" />;
  if (s === STATUS.LOADING) return <span className="h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />;
};

const VideoPlayer = ({
  mediaType,
  tmdbId,
  season = 1,
  episode = 1,
  poster,
  trailerKey,
  storageKey,
}) => {
  // Last working server per title (persisted)
  const persistKey = useMemo(
    () => storageKey || `streamix:server:${mediaType}:${tmdbId}`,
    [storageKey, mediaType, tmdbId],
  );

  const initialIdx = (() => {
    if (typeof window === 'undefined') return 0;
    const saved = parseInt(window.localStorage.getItem(persistKey) || '0', 10);
    return Number.isFinite(saved) && saved >= 0 && saved < STREAMING_SERVERS.length ? saved : 0;
  })();

  const [serverIdx, setServerIdx] = useState(initialIdx);
  const [statuses, setStatuses] = useState(() => STREAMING_SERVERS.map(() => STATUS.UNTESTED));
  const [iframeKey, setIframeKey] = useState(0);
  const [showTrailer, setShowTrailer] = useState(false);
  const [toast, setToast] = useState(null);

  const timerRef = useRef(null);

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

  // Start "loading" status + timeout when server changes
  useEffect(() => {
    if (showTrailer) return;
    setToast(null);
    if (activeServer.isDirect) {
      updateStatus(serverIdx, STATUS.OK);
      return;
    }
    updateStatus(serverIdx, STATUS.LOADING);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // If still loading after timeout, surface a toast suggesting next
      setStatuses((prev) => {
        if (prev[serverIdx] === STATUS.LOADING) {
          const next = prev.slice();
          next[serverIdx] = STATUS.FAILED;
          return next;
        }
        return prev;
      });
      setToast({
        kind: 'warn',
        msg: `${activeServer.name} took too long. Trying next server…`,
        action: 'next',
      });
      // Auto-advance to next untested/ok server after another short delay
      setTimeout(() => {
        const nextIdx = findNextCandidate(serverIdx);
        if (nextIdx != null) setServerIdx(nextIdx);
      }, 1200);
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIdx, iframeKey, season, episode, showTrailer]);

  // Persist last selected server
  useEffect(() => {
    try { window.localStorage.setItem(persistKey, String(serverIdx)); } catch (_) {}
  }, [serverIdx, persistKey]);

  function findNextCandidate(fromIdx) {
    for (let i = 1; i < STREAMING_SERVERS.length; i++) {
      const idx = (fromIdx + i) % STREAMING_SERVERS.length;
      if (statuses[idx] !== STATUS.FAILED) return idx;
    }
    // Everything failed — fall back to demo
    const demoIdx = STREAMING_SERVERS.findIndex((s) => s.isDirect);
    return demoIdx >= 0 ? demoIdx : null;
  }

  const handleIframeLoad = () => {
    // iframe DOM 'load' event fires when the URL loaded — even if it's an error page.
    // We treat it as "OK" but the user can mark it broken manually.
    if (timerRef.current) clearTimeout(timerRef.current);
    updateStatus(serverIdx, STATUS.OK);
  };

  const handleIframeError = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    updateStatus(serverIdx, STATUS.FAILED);
    setToast({ kind: 'error', msg: `${activeServer.name} failed to load.`, action: 'next' });
  };

  const tryNextServer = () => {
    const next = findNextCandidate(serverIdx);
    if (next != null) setServerIdx(next);
    setToast(null);
  };

  const markBroken = () => {
    updateStatus(serverIdx, STATUS.FAILED);
    tryNextServer();
  };

  const reload = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIframeKey((k) => k + 1);
  };

  return (
    <div className="w-full">
      {/* Player */}
      <div className="relative w-full bg-black">
        <div className="relative w-full mx-auto bg-black" style={{ maxWidth: '1400px' }}>
          <div className="relative w-full aspect-video bg-black">
            {showTrailer && trailerKey ? (
              <iframe
                key={`trailer-${trailerKey}`}
                src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0&modestbranding=1`}
                className="absolute inset-0 w-full h-full"
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
                title="Trailer"
              />
            ) : activeServer.isDirect ? (
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
            ) : embedUrl ? (
              <iframe
                key={`${activeServer.id}-${season}-${episode}-${iframeKey}`}
                src={embedUrl}
                className="absolute inset-0 w-full h-full"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
                referrerPolicy="no-referrer"
                {...(activeServer.sandbox
                  ? { sandbox: 'allow-scripts allow-same-origin allow-forms allow-presentation' }
                  : {})}
                onLoad={handleIframeLoad}
                onError={handleIframeError}
                title={`${activeServer.name} player`}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-center p-6">
                <div>
                  <AlertCircle className="w-10 h-10 mx-auto mb-3 text-red-500" />
                  <p className="text-lg font-semibold">Source not available</p>
                  <p className="text-sm text-neutral-400 mt-1">Try another server below.</p>
                </div>
              </div>
            )}

            {/* Loading overlay (during the iframe boot window) */}
            {!showTrailer && !activeServer.isDirect && statuses[serverIdx] === STATUS.LOADING && (
              <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 to-transparent pointer-events-none">
                <div className="flex items-center gap-2 text-xs text-neutral-200">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Connecting to <b className="text-white">{activeServer.name}</b>…
                </div>
              </div>
            )}
          </div>

          {/* Toast / fallback hint */}
          {toast && (
            <div className={`mt-3 mx-2 md:mx-0 flex items-center justify-between gap-3 px-4 py-3 rounded-md border ${
              toast.kind === 'error'
                ? 'bg-red-950/40 border-red-900 text-red-200'
                : 'bg-yellow-950/40 border-yellow-900 text-yellow-200'
            }`}>
              <div className="flex items-center gap-2 text-sm">
                <AlertCircle className="w-4 h-4" />
                {toast.msg}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={tryNextServer} className="bg-white/10 hover:bg-white/20 border border-white/10">
                  Try next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
                <button onClick={() => setToast(null)} className="text-xs opacity-70 hover:opacity-100">Dismiss</button>
              </div>
            </div>
          )}

          {/* Status / Open-in-new-tab bar */}
          {!showTrailer && !activeServer.isDirect && (
            <div className="px-2 md:px-0 mt-3 text-xs text-neutral-400 flex items-center justify-between flex-wrap gap-2">
              <span className="inline-flex items-center gap-2">
                {statusDot(statuses[serverIdx])}
                Playing on <b className="text-neutral-200 ml-0.5">{activeServer.name}</b>
                {activeServer.sandbox && (
                  <span className="inline-flex items-center gap-1 ml-2 text-[10px] uppercase tracking-wider text-neutral-500">
                    <ShieldAlert className="w-3 h-3" /> sandboxed
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <button onClick={markBroken} className="text-neutral-400 hover:text-red-300 underline-offset-2 hover:underline">
                  Mark as broken
                </button>
                {embedUrl && (
                  <a
                    href={embedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 text-neutral-200"
                  >
                    Open in new tab <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Server tabs */}
      <section className="px-4 md:px-8 py-6">
        <div className="flex items-center justify-between gap-2 mb-3 text-neutral-300 flex-wrap">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4" />
            <h3 className="text-sm font-semibold uppercase tracking-wider">Servers</h3>
            <span className="text-xs text-neutral-500 hidden md:inline">
              Switch if one doesn't play or shows ads.
            </span>
          </div>
          <button
            onClick={reload}
            className="text-xs text-neutral-300 hover:text-white inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-white/5 hover:bg-white/10"
          >
            <RotateCw className="w-3.5 h-3.5" /> Reload player
          </button>
        </div>
        <div className="grid grid-cols-2 md:flex md:flex-wrap gap-2">
          {STREAMING_SERVERS.map((s, i) => {
            const isActive = i === serverIdx && !showTrailer;
            const st = statuses[i];
            const Icon = st === STATUS.OK ? CheckCircle2 : st === STATUS.FAILED ? XCircle : st === STATUS.LOADING ? Loader2 : Circle;
            return (
              <button
                key={s.id}
                onClick={() => { setShowTrailer(false); setServerIdx(i); }}
                className={`px-3 py-2.5 rounded-md text-sm font-semibold border transition flex items-center gap-2 text-left ${
                  isActive
                    ? 'bg-red-600 border-red-600 text-white shadow-lg shadow-red-600/30'
                    : st === STATUS.FAILED
                    ? 'bg-neutral-900/60 border-red-900/50 text-neutral-400 hover:border-red-700'
                    : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 flex-none ${st === STATUS.LOADING ? 'animate-spin' : ''} ${
                  isActive ? 'text-white' : st === STATUS.OK ? 'text-emerald-400' : st === STATUS.FAILED ? 'text-red-500' : 'text-neutral-500'
                }`} />
                <span className="flex flex-col items-start">
                  <span>{s.name}</span>
                  <span className="text-[10px] font-normal opacity-80">{s.sub}</span>
                </span>
              </button>
            );
          })}

          {trailerKey && (
            <button
              onClick={() => setShowTrailer((v) => !v)}
              className={`px-3 py-2.5 rounded-md text-sm font-semibold border transition flex items-center gap-2 ${
                showTrailer
                  ? 'bg-white text-black border-white'
                  : 'bg-neutral-900 border-neutral-800 hover:border-neutral-600 text-neutral-200'
              }`}
            >
              <Youtube className="w-3.5 h-3.5 flex-none text-red-500" />
              <span className="flex flex-col items-start">
                <span>{showTrailer ? 'Hide Trailer' : 'Watch Trailer'}</span>
                <span className="text-[10px] font-normal opacity-80">YouTube</span>
              </span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
};

export default VideoPlayer;
