'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STREAMING_SERVERS, getEmbedUrl } from '@/lib/streaming';
import {
  Server, AlertCircle, RotateCw, Loader2,
  CheckCircle2, XCircle, Circle, Youtube, ChevronRight, Play, Shield, ShieldOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * VideoPlayer — reliability-first multi-server player for movies & TV.
 *
 * Popup-blocker strategy: DOUBLE-IFRAME SANDBOX PROXY.
 *
 *   Main page  →  <iframe sandbox="..."> /embed?url=PROVIDER </iframe>  →  <iframe src=PROVIDER>
 *                  (outer sandbox enforced)                                  (no sandbox attr)
 *
 *   - Provider's own anti-sandbox check (`window.frameElement.hasAttribute('sandbox')`)
 *     looks at the INNER iframe element, which has no sandbox attr → it plays.
 *   - HTML5 spec: sandbox flags propagate from OUTER iframe into ALL nested
 *     browsing contexts, so window.open / target="_blank" / top.location
 *     hijacks from inside the provider are blocked by the browser.
 *   - The provider cannot read the outer iframe's sandbox attribute due to
 *     the cross-origin barrier between our page and the provider's window.
 *
 *   The user can toggle the blocker off (per-title persisted) if a specific
 *   provider still misbehaves. Your own ads/UI on the main page are NOT
 *   affected — the sandbox only applies inside the player iframe.
 *
 * UX:
 *   - Lazy mount: shows a big Play overlay until user clicks (saves RAM)
 *   - 8-second load timeout → auto-marks server failed → shows toast → auto-switches
 *   - Per-server status: green ✓ / red ✗ / yellow ⟳ / empty ○
 *   - Reload player button to retry current server
 *   - localStorage remembers last working server + popup-blocker preference
 */

const STATUS = { UNTESTED: 'untested', LOADING: 'loading', OK: 'ok', FAILED: 'failed' };
const LOAD_TIMEOUT_MS = 8000;

// Sandbox applied to the OUTER iframe (which loads our /embed proxy page).
// Flags propagate to the nested provider iframe — blocking popups, top-nav
// and target=_blank — without the provider being able to detect or read it.
//   ✓ allow-scripts            → provider's player JS runs
//   ✓ allow-same-origin        → provider's localStorage / session cookies
//   ✓ allow-forms              → in-player search / quality selectors
//   ✓ allow-presentation       → Picture-in-Picture & fullscreen API
//   ✓ allow-modals             → some players use confirm() / alert() legit.
//   ✗ allow-popups             → window.open() ad spawns BLOCKED
//   ✗ allow-popups-to-escape-sandbox → any sneaky popup stays sandboxed
//   ✗ allow-top-navigation     → top.location ad redirects BLOCKED
//   ✗ allow-top-navigation-by-user-activation → ad-overlay click hijacks BLOCKED
const POPUP_BLOCK_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-presentation allow-modals';

const VideoPlayer = ({
  mediaType,
  tmdbId,
  season = 1,
  episode = 1,
  poster,
  trailerKey,
}) => {
  // Persist last-working server per title
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

  const timerRef = useRef(null);
  const triedAutoSwitchRef = useRef(new Set()); // prevents infinite auto-switch loop

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
      // Last resort: demo server (always works)
      const demoIdx = STREAMING_SERVERS.findIndex((s) => s.isDirect);
      return demoIdx >= 0 ? demoIdx : null;
    },
    [statuses],
  );

  // Start load timer when active server changes (only after user clicked Play)
  useEffect(() => {
    if (!playerActive || showTrailer) return;

    if (activeServer.isDirect) {
      updateStatus(serverIdx, STATUS.OK);
      return;
    }

    setToast(null);
    updateStatus(serverIdx, STATUS.LOADING);
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      // Still loading → mark failed and auto-switch
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
      // Brief delay so user sees the toast before switch
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

  // Persist last selected server
  useEffect(() => {
    try { window.localStorage.setItem(persistKey, String(serverIdx)); } catch (_) {}
  }, [serverIdx, persistKey]);

  // Persist popup-blocker preference
  useEffect(() => {
    try { window.localStorage.setItem(blockerKey, popupBlock ? '1' : '0'); } catch (_) {}
  }, [popupBlock]);

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

  const tryNextServer = () => {
    const next = findNextCandidate(serverIdx);
    if (next != null) setServerIdx(next);
    setToast(null);
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
    setIframeKey((k) => k + 1);
  };

  const selectServer = (i) => {
    setShowTrailer(false);
    triedAutoSwitchRef.current.clear();
    setServerIdx(i);
    setToast(null);
  };

  // Reset playerActive when episode/season changes (TV) — user should re-press play to reload
  useEffect(() => {
    setPlayerActive(false);
  }, [season, episode]);

  return (
    <div className="w-full">
      {/* Player frame */}
      <div className="relative w-full bg-black">
        <div className="relative w-full mx-auto bg-black" style={{ maxWidth: '1400px' }}>
          <div className="relative w-full aspect-video bg-black">
            {/* Lazy overlay — iframe only mounts after click */}
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
                    <div className="h-20 w-20 md:h-24 md:w-24 rounded-full bg-red-600 hover:bg-red-700 grid place-items-center shadow-2xl shadow-red-600/40 ring-4 ring-white/10">
                      <Play className="w-10 h-10 md:w-12 md:h-12 fill-white text-white ml-1" />
                    </div>
                    <span className="text-sm font-semibold text-white/90 tracking-wide">
                      Click to start playback
                    </span>
                    <span className="text-[11px] text-neutral-300 max-w-md text-center px-4">
                      Streaming on <b className="text-white">{activeServer.name}</b>
                      {mediaType === 'tv' && <> · S{season} · E{episode}</>}
                    </span>
                  </div>
                </div>
              </button>
            )}

            {/* Active player content */}
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

            {playerActive && !showTrailer && !activeServer.isDirect && embedUrl && (
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

            {playerActive && !showTrailer && !activeServer.isDirect && !embedUrl && (
              <div className="absolute inset-0 grid place-items-center text-center p-6">
                <div>
                  <AlertCircle className="w-10 h-10 mx-auto mb-3 text-red-500" />
                  <p className="text-lg font-semibold">Source not available</p>
                  <p className="text-sm text-neutral-400 mt-1">Try another server below.</p>
                </div>
              </div>
            )}

            {/* Loading badge */}
            {playerActive && !showTrailer && !activeServer.isDirect && statuses[serverIdx] === STATUS.LOADING && (
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

          {/* Action bar — always visible, prominent "Open in New Tab" */}
          {!showTrailer && (
            <div className="px-2 md:px-0 mt-3 flex items-center justify-between flex-wrap gap-3">
              <div className="inline-flex items-center gap-2 text-xs text-neutral-300">
                <StatusDot status={statuses[serverIdx]} />
                <span>
                  Playing on <b className="text-white">{activeServer.name}</b>
                </span>
                {!activeServer.isDirect && (
                  <span
                    className={`inline-flex items-center gap-1 ml-2 text-[10px] uppercase tracking-wider ${
                      popupBlock ? 'text-emerald-400' : 'text-yellow-400'
                    }`}
                    title={popupBlock
                      ? 'Popup blocker is active. Provider popups, redirects and target=_blank are blocked.'
                      : 'Popup blocker is OFF. Provider popups and redirects can occur.'}
                  >
                    {popupBlock ? <Shield className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
                    {popupBlock ? 'popups blocked' : 'popups allowed'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {!activeServer.isDirect && (
                  <button
                    onClick={() => { setPopupBlock((v) => !v); setIframeKey((k) => k + 1); }}
                    title={popupBlock
                      ? 'Disable popup blocker (use if a provider refuses to play)'
                      : 'Enable popup blocker (blocks provider popups & redirects)'}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md border text-sm transition ${
                      popupBlock
                        ? 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/30 text-emerald-300'
                        : 'bg-yellow-500/10 hover:bg-yellow-500/20 border-yellow-500/30 text-yellow-300'
                    }`}
                  >
                    {popupBlock ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                    <span className="hidden sm:inline">{popupBlock ? 'Blocker: ON' : 'Blocker: OFF'}</span>
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
              Auto-switches if a server fails. Try another server if one isn&apos;t working.
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 md:flex md:flex-wrap gap-2">
          {STREAMING_SERVERS.map((s, i) => {
            const isActive = i === serverIdx && !showTrailer;
            const st = statuses[i];
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
