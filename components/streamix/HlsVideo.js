'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Play, Pause, Volume2, VolumeX, Volume1, Maximize, Minimize,
  PictureInPicture2, Settings, Check, Loader2,
} from 'lucide-react';

/**
 * HlsVideo — custom Tailwind player on top of hls.js
 * ===================================================
 *
 * Why a custom skin instead of native <video controls>:
 *  - Consistent look across Chrome / FF / Safari (native is each-OS-flavored)
 *  - Bigger scrub bar with buffered + played visualization
 *  - Hover-time tooltip
 *  - Speed control (0.5× — 2×)
 *  - Quality display (placeholder until we add multi-bitrate ABR)
 *  - PiP button
 *  - Auto-hiding overlay
 *
 * What's intentionally NOT here:
 *  - Hover-preview thumbnails — would need a server-side sprite-sheet
 *    + WebVTT track from ffmpeg. Deferred (see HANDOFF.md).
 *  - Functional quality switching — our HLS pipeline outputs a single
 *    bitrate, so the menu just SHOWS "Source · 1080p" until we add ABR.
 *  - Subtitle picker — Comet doesn't pass subtitle tracks.
 *
 * Playback engine (hls.js setup) is UNCHANGED from the previous version
 * — the three magic settings (startPosition:0, liveSync*Count:0,
 * liveMaxLatency:Infinity) that prevent the "skip to live edge" bug are
 * still here. If you're rewriting this file, leave the hls.js block alone.
 */

const formatTime = (sec) => {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
};

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export default function HlsVideo({
  src,
  poster,
  className = '',
  onReady,
  onFatal,
  autoPlay = true,
  qualityLabel = 'Source · 1080p',
}) {
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const progressRef = useRef(null);
  const volumeRef = useRef(null);
  const hlsRef = useRef(null);

  // ── Latest-callback refs (so the hls effect doesn't re-run on parent re-render)
  const onReadyRef = useRef(onReady);
  const onFatalRef = useRef(onFatal);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onFatalRef.current = onFatal; }, [onFatal]);

  // ── Player UI state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState('main'); // main | speed | quality
  const [hoverTime, setHoverTime] = useState(null); // {sec, x} | null
  const [isBuffering, setIsBuffering] = useState(false);

  // Click flash (kept from prior version)
  const [flash, setFlash] = useState(null);
  const flashTimerRef = useRef(null);
  const triggerFlash = useCallback((kind) => {
    setFlash(kind);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 600);
  }, []);

  const clickTimerRef = useRef(null);
  const hideTimerRef = useRef(null);

  // ─────────────────────────────────────────────────────────
  // Action handlers
  // ─────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().then(() => triggerFlash('play')).catch(() => {});
    } else {
      v.pause();
      triggerFlash('pause');
    }
  }, [triggerFlash]);

  const toggleFullscreen = useCallback(() => {
    const w = wrapRef.current;
    if (!w) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      (w.requestFullscreen?.() || Promise.resolve()).catch(() => {});
    }
  }, []);

  const togglePiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      }
    } catch (_) { /* ignored */ }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, []);

  const setSpeed = useCallback((r) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = r;
    setPlaybackRate(r);
  }, []);

  const seekTo = useCallback((sec) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, sec));
  }, []);

  // ─────────────────────────────────────────────────────────
  // Click / double-click on the video picture
  // ─────────────────────────────────────────────────────────
  const handleVideoClick = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      toggleFullscreen();
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, 230);
  }, [togglePlay, toggleFullscreen]);

  // ─────────────────────────────────────────────────────────
  // Keyboard shortcuts (wrapper must be focused/hovered)
  // ─────────────────────────────────────────────────────────
  const handleKey = useCallback((e) => {
    const v = videoRef.current;
    if (!v) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.code) {
      case 'Space':
      case 'KeyK':
        e.preventDefault(); togglePlay(); break;
      case 'ArrowRight':
        e.preventDefault(); seekTo(v.currentTime + 5); break;
      case 'ArrowLeft':
        e.preventDefault(); seekTo(v.currentTime - 5); break;
      case 'ArrowUp':
        e.preventDefault();
        v.volume = Math.min(1, v.volume + 0.05); v.muted = false; break;
      case 'ArrowDown':
        e.preventDefault();
        v.volume = Math.max(0, v.volume - 0.05); break;
      case 'KeyF':
        e.preventDefault(); toggleFullscreen(); break;
      case 'KeyM':
        e.preventDefault(); toggleMute(); break;
      case 'KeyP':
        e.preventDefault(); togglePiP(); break;
      default: break;
    }
  }, [togglePlay, toggleFullscreen, toggleMute, togglePiP, seekTo]);

  // ─────────────────────────────────────────────────────────
  // Scrub bar — pointer events with drag support
  // ─────────────────────────────────────────────────────────
  const computeBarSeek = useCallback((clientX) => {
    const el = progressRef.current;
    const v = videoRef.current;
    if (!el || !v) return 0;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    return pct * dur;
  }, []);

  const onProgressMove = useCallback((e) => {
    const t = computeBarSeek(e.clientX);
    const rect = progressRef.current.getBoundingClientRect();
    setHoverTime({ sec: t, x: e.clientX - rect.left });
  }, [computeBarSeek]);

  const onProgressLeave = useCallback(() => setHoverTime(null), []);

  const onProgressPointerDown = useCallback((e) => {
    e.preventDefault();
    const t = computeBarSeek(e.clientX);
    seekTo(t);
    // Drag-to-scrub: capture pointer and keep updating as user moves.
    const id = e.pointerId;
    progressRef.current?.setPointerCapture?.(id);
    const move = (ev) => seekTo(computeBarSeek(ev.clientX));
    const up = (ev) => {
      progressRef.current?.removeEventListener?.('pointermove', move);
      progressRef.current?.removeEventListener?.('pointerup', up);
      progressRef.current?.removeEventListener?.('pointercancel', up);
      try { progressRef.current?.releasePointerCapture?.(id); } catch (_) {}
    };
    progressRef.current?.addEventListener?.('pointermove', move);
    progressRef.current?.addEventListener?.('pointerup', up);
    progressRef.current?.addEventListener?.('pointercancel', up);
  }, [computeBarSeek, seekTo]);

  // ─────────────────────────────────────────────────────────
  // Volume slider — same drag pattern, simpler
  // ─────────────────────────────────────────────────────────
  const onVolumePointerDown = useCallback((e) => {
    e.preventDefault();
    const apply = (clientX) => {
      const el = volumeRef.current;
      const v = videoRef.current;
      if (!el || !v) return;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      v.volume = pct;
      v.muted = pct === 0;
    };
    apply(e.clientX);
    const id = e.pointerId;
    volumeRef.current?.setPointerCapture?.(id);
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      volumeRef.current?.removeEventListener?.('pointermove', move);
      volumeRef.current?.removeEventListener?.('pointerup', up);
      try { volumeRef.current?.releasePointerCapture?.(id); } catch (_) {}
    };
    volumeRef.current?.addEventListener?.('pointermove', move);
    volumeRef.current?.addEventListener?.('pointerup', up);
  }, []);

  // ─────────────────────────────────────────────────────────
  // Auto-hide controls during playback (mouse-inactive 2.5s)
  // ─────────────────────────────────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      // Only hide while playing AND no submenu open AND not hovering bar.
      if (videoRef.current && !videoRef.current.paused) setControlsVisible(false);
    }, 2500);
  }, []);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
  }, []);

  // ─────────────────────────────────────────────────────────
  // Sync UI state from <video> events
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onPlay = () => { setIsPlaying(true); showControls(); };
    const onPause = () => { setIsPlaying(false); setControlsVisible(true); };
    const onTimeUpdate = () => setCurrentTime(v.currentTime || 0);
    const onDurationChange = () => setDuration(v.duration || 0);
    const onVolumeChange = () => { setVolume(v.volume); setMuted(v.muted); };
    const onRateChange = () => setPlaybackRate(v.playbackRate);
    const onProgress = () => {
      try {
        const last = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        setBufferedEnd(last);
      } catch (_) {}
    };
    const onWaiting = () => setIsBuffering(true);
    const onPlayingEv = () => setIsBuffering(false);
    const onCanPlay = () => setIsBuffering(false);
    const onEnterPip = () => setIsPiP(true);
    const onLeavePip = () => setIsPiP(false);

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('loadedmetadata', onDurationChange);
    v.addEventListener('volumechange', onVolumeChange);
    v.addEventListener('ratechange', onRateChange);
    v.addEventListener('progress', onProgress);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlayingEv);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('enterpictureinpicture', onEnterPip);
    v.addEventListener('leavepictureinpicture', onLeavePip);

    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('loadedmetadata', onDurationChange);
      v.removeEventListener('volumechange', onVolumeChange);
      v.removeEventListener('ratechange', onRateChange);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlayingEv);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('enterpictureinpicture', onEnterPip);
      v.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, [showControls]);

  // Fullscreen state sync (changes can come from F11, ESC, native button…)
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ─────────────────────────────────────────────────────────
  // hls.js lifecycle (UNCHANGED — playback engine)
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let disposed = false;
    let hls = null;
    let detachNative = null;

    const attachNative = () => {
      video.src = src;
      const onCanPlay = () => onReadyRef.current?.();
      const onErr = () => {
        if (!disposed) onFatalRef.current?.(video.error || new Error('native HLS error'));
      };
      video.addEventListener('canplay', onCanPlay, { once: true });
      video.addEventListener('error', onErr);
      return () => {
        video.removeEventListener('canplay', onCanPlay);
        video.removeEventListener('error', onErr);
      };
    };

    (async () => {
      try {
        const HlsMod = await import('hls.js');
        const Hls = HlsMod.default;
        if (disposed) return;

        if (Hls && Hls.isSupported()) {
          hls = new Hls({
            // Three magic settings — DO NOT REMOVE — see HANDOFF.md §4.4.
            startPosition: 0,
            liveSyncDurationCount: 0,
            liveMaxLatencyDurationCount: Infinity,
            lowLatencyMode: false,
            maxBufferLength: 60,
            maxMaxBufferLength: 600,
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 1000,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
          });
          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (autoPlay) video.play().catch(() => {});
            onReadyRef.current?.();
          });
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (!data.fatal) return;
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                try { hls.startLoad(); return; } catch (_) {}
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                try { hls.recoverMediaError(); return; } catch (_) {}
                break;
              default: break;
            }
            if (!disposed) onFatalRef.current?.(new Error(`${data.type}/${data.details}`));
          });

          hls.attachMedia(video);
          hls.loadSource(src);
          return;
        }
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          detachNative = attachNative();
          return;
        }
        onFatalRef.current?.(new Error('HLS not supported in this browser'));
      } catch (e) {
        if (disposed) return;
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          detachNative = attachNative();
        } else {
          onFatalRef.current?.(e);
        }
      }
    })();

    return () => {
      disposed = true;
      if (hls) { try { hls.destroy(); } catch (_) {} hlsRef.current = null; }
      if (detachNative) detachNative();
      try { video.removeAttribute('src'); video.load(); } catch (_) {}
    };
  }, [src, autoPlay]);

  // ─────────────────────────────────────────────────────────
  // Derived render values
  // ─────────────────────────────────────────────────────────
  const playedPct = useMemo(() => {
    if (!duration) return 0;
    return Math.min(100, (currentTime / duration) * 100);
  }, [currentTime, duration]);

  const bufferedPct = useMemo(() => {
    if (!duration) return 0;
    return Math.min(100, (bufferedEnd / duration) * 100);
  }, [bufferedEnd, duration]);

  const VolIcon = muted || volume === 0 ? VolumeX : (volume < 0.5 ? Volume1 : Volume2);

  // Keep controls visible while a menu is open
  const effectiveVisible = controlsVisible || !isPlaying || settingsOpen;

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={handleKey}
      onMouseMove={showControls}
      onMouseLeave={() => { if (isPlaying && !settingsOpen) setControlsVisible(false); }}
      className={`relative outline-none select-none group ${className}`}
      style={{ touchAction: 'none' }}
    >
      {/* The <video> itself. controls={false} — we provide our own. */}
      <video
        ref={videoRef}
        playsInline
        poster={poster || undefined}
        onClick={handleVideoClick}
        className="w-full h-full object-contain bg-black"
        style={{ cursor: effectiveVisible ? 'pointer' : 'none' }}
      />

      {/* Center play/pause flash on click toggle */}
      {flash && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <div className="rounded-full bg-black/60 backdrop-blur-md p-5 shadow-2xl streamix-flash">
            {flash === 'play'
              ? <Play size={48} className="text-white fill-white" />
              : <Pause size={48} className="text-white fill-white" />}
          </div>
        </div>
      )}

      {/* Buffering spinner */}
      {isBuffering && isPlaying && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <Loader2 size={56} className="text-white/90 animate-spin drop-shadow-2xl" />
        </div>
      )}

      {/* Big center play button while paused at start */}
      {!isPlaying && currentTime === 0 && (
        <button
          aria-label="Play"
          onClick={togglePlay}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
        >
          <div className="rounded-full bg-white/90 hover:bg-white p-6 shadow-2xl transition-transform hover:scale-110">
            <Play size={48} className="text-black fill-black ml-1" />
          </div>
        </button>
      )}

      {/* ─── Controls overlay ─── */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 transition-opacity duration-300 ${
          effectiveVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Gradient backdrop */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/90 via-black/60 to-transparent" />

        <div className="relative px-4 pb-3 pt-10">
          {/* Scrub bar */}
          <div
            ref={progressRef}
            className="relative h-1.5 hover:h-2.5 transition-all bg-white/20 rounded-full cursor-pointer group/bar"
            onPointerDown={onProgressPointerDown}
            onMouseMove={onProgressMove}
            onMouseLeave={onProgressLeave}
          >
            {/* Buffered */}
            <div
              className="absolute inset-y-0 left-0 bg-white/35 rounded-full"
              style={{ width: `${bufferedPct}%` }}
            />
            {/* Played */}
            <div
              className="absolute inset-y-0 left-0 bg-yellow-400 rounded-full"
              style={{ width: `${playedPct}%` }}
            />
            {/* Scrub handle */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-yellow-400 rounded-full opacity-0 group-hover/bar:opacity-100 transition-opacity shadow-lg"
              style={{ left: `${playedPct}%` }}
            />
            {/* Hover-time tooltip */}
            {hoverTime != null && (
              <div
                className="absolute -top-9 -translate-x-1/2 px-2 py-1 rounded text-xs font-mono bg-black/90 text-white whitespace-nowrap shadow-lg"
                style={{ left: `${hoverTime.x}px` }}
              >
                {formatTime(hoverTime.sec)}
              </div>
            )}
          </div>

          {/* Buttons row */}
          <div className="flex items-center gap-3 mt-2 text-white">
            <button
              aria-label={isPlaying ? 'Pause' : 'Play'}
              onClick={togglePlay}
              className="p-1.5 rounded hover:bg-white/15 transition-colors"
            >
              {isPlaying
                ? <Pause size={22} className="fill-white" />
                : <Play size={22} className="fill-white" />}
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1.5 group/vol">
              <button
                aria-label={muted ? 'Unmute' : 'Mute'}
                onClick={toggleMute}
                className="p-1.5 rounded hover:bg-white/15 transition-colors"
              >
                <VolIcon size={22} />
              </button>
              <div
                ref={volumeRef}
                onPointerDown={onVolumePointerDown}
                className="relative h-1 w-0 group-hover/vol:w-20 transition-all bg-white/20 rounded-full overflow-hidden cursor-pointer"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-white rounded-full"
                  style={{ width: `${(muted ? 0 : volume) * 100}%` }}
                />
              </div>
            </div>

            {/* Time */}
            <div className="text-sm font-mono tabular-nums opacity-90">
              {formatTime(currentTime)} <span className="opacity-60">/ {formatTime(duration)}</span>
            </div>

            <div className="flex-1" />

            {/* Speed shortcut button (shows current speed) */}
            <button
              onClick={() => { setSettingsOpen(true); setSettingsView('speed'); }}
              className="px-2 py-1 rounded text-xs font-medium hover:bg-white/15 transition-colors tabular-nums"
              aria-label="Playback speed"
            >
              {playbackRate}×
            </button>

            {/* Settings */}
            <div className="relative">
              <button
                aria-label="Settings"
                onClick={() => { setSettingsOpen((o) => !o); setSettingsView('main'); }}
                className={`p-1.5 rounded hover:bg-white/15 transition-colors ${settingsOpen ? 'bg-white/15' : ''}`}
              >
                <Settings size={22} className={settingsOpen ? 'rotate-45 transition-transform' : 'transition-transform'} />
              </button>
              {settingsOpen && (
                <div className="absolute bottom-12 right-0 w-56 rounded-lg bg-black/95 backdrop-blur-md text-white shadow-2xl border border-white/10 overflow-hidden">
                  {settingsView === 'main' && (
                    <div className="py-1">
                      <button
                        onClick={() => setSettingsView('speed')}
                        className="flex items-center justify-between w-full px-3 py-2 hover:bg-white/10 text-sm"
                      >
                        <span>Playback speed</span>
                        <span className="opacity-60 tabular-nums">{playbackRate}×</span>
                      </button>
                      <button
                        onClick={() => setSettingsView('quality')}
                        className="flex items-center justify-between w-full px-3 py-2 hover:bg-white/10 text-sm"
                      >
                        <span>Quality</span>
                        <span className="opacity-60 text-xs truncate max-w-[140px]">{qualityLabel}</span>
                      </button>
                    </div>
                  )}
                  {settingsView === 'speed' && (
                    <div className="py-1">
                      <button
                        onClick={() => setSettingsView('main')}
                        className="w-full px-3 py-2 text-xs opacity-60 hover:opacity-100 text-left"
                      >
                        ← Back
                      </button>
                      {SPEEDS.map((s) => (
                        <button
                          key={s}
                          onClick={() => { setSpeed(s); setSettingsOpen(false); }}
                          className={`flex items-center w-full px-3 py-2 hover:bg-white/10 text-sm tabular-nums ${playbackRate === s ? 'bg-white/5' : ''}`}
                        >
                          <span className="w-5">
                            {playbackRate === s && <Check size={14} />}
                          </span>
                          <span>{s === 1 ? 'Normal' : `${s}×`}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {settingsView === 'quality' && (
                    <div className="py-1">
                      <button
                        onClick={() => setSettingsView('main')}
                        className="w-full px-3 py-2 text-xs opacity-60 hover:opacity-100 text-left"
                      >
                        ← Back
                      </button>
                      <div className="px-3 py-2 text-sm flex items-center">
                        <Check size={14} className="mr-2" />
                        {qualityLabel}
                      </div>
                      <div className="px-3 pb-2 pt-1 text-[11px] opacity-50 leading-snug">
                        Multi-bitrate switching not available — this stream is transcoded on-the-fly at a single quality.
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* PiP */}
            <button
              aria-label="Picture-in-picture"
              onClick={togglePiP}
              className={`p-1.5 rounded hover:bg-white/15 transition-colors ${isPiP ? 'bg-white/15' : ''}`}
            >
              <PictureInPicture2 size={22} />
            </button>

            {/* Fullscreen */}
            <button
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              onClick={toggleFullscreen}
              className="p-1.5 rounded hover:bg-white/15 transition-colors"
            >
              {isFullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        .streamix-flash {
          animation: streamix-fade-flash 600ms ease-out forwards;
        }
        @keyframes streamix-fade-flash {
          0%   { opacity: 0; transform: scale(0.6); }
          25%  { opacity: 1; transform: scale(1.0); }
          100% { opacity: 0; transform: scale(1.4); }
        }
      `}</style>
    </div>
  );
}
