'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * HlsVideo
 * ========
 * <video> wrapper that plays an HLS playlist via hls.js (Chrome/Firefox/
 * Edge) or natively (Safari/iOS). Adds the kind of UX every modern
 * streaming UI ships with:
 *
 *   • Click anywhere on the picture → toggle play/pause
 *   • Double-click → toggle fullscreen
 *   • Brief play/pause icon flash so the click feels intentional
 *   • Spacebar → toggle play/pause (when player has focus)
 *   • ←/→ arrow keys → seek 5 s
 *   • Native HTML5 controls remain visible for scrubbing/volume/etc.
 *
 * The whole thing is one component so VideoPlayer.js doesn't need to grow
 * any wider. hls.js is dynamically imported (~200 KB) only when premium
 * is selected, so the homepage bundle stays small.
 */

export default function HlsVideo({
  src,
  poster,
  className = '',
  onReady,
  onFatal,
  autoPlay = true,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const wrapRef = useRef(null);

  // Latest-callback refs (effect doesn't re-run on every parent render)
  const onReadyRef = useRef(onReady);
  const onFatalRef = useRef(onFatal);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onFatalRef.current = onFatal; }, [onFatal]);

  // Click-toggle UX: briefly flash a big icon when the user toggles
  // play/pause via the picture. `flash` is the icon kind ('play'|'pause').
  const [flash, setFlash] = useState(null);
  const flashTimerRef = useRef(null);
  const triggerFlash = useCallback((kind) => {
    setFlash(kind);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 600);
  }, []);

  // Defer/debounce single vs double click so a double-click doesn't also
  // trigger a play/pause toggle.
  const clickTimerRef = useRef(null);

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

  // Single click → toggle play. Double click → fullscreen. We do this with
  // a 230 ms timer so a true double-click cancels the play toggle.
  const handleClick = useCallback((e) => {
    // Ignore clicks that landed on the native browser controls. Most
    // browsers route control clicks through the shadow DOM so e.target ===
    // the <video> element when the user clicks the picture area, and ===
    // the <video> too when they click on the control bar — but the
    // browser handles the bar's clicks before our React handler runs, and
    // we still get fired. Filter by bottom 60 px of the video frame: that
    // strip is reserved for native controls.
    const v = videoRef.current;
    if (!v) return;
    const rect = v.getBoundingClientRect();
    const yFromBottom = rect.bottom - e.clientY;
    if (yFromBottom <= 60) return;

    if (clickTimerRef.current) {
      // double-click: cancel pending play toggle, do fullscreen
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

  // Keyboard shortcuts (Space, ←/→, F). Active only when the wrapper has
  // focus, so it never fights other inputs on the page.
  const handleKey = useCallback((e) => {
    const v = videoRef.current;
    if (!v) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      v.currentTime = Math.min((v.duration || Infinity), v.currentTime + 5);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      v.currentTime = Math.max(0, v.currentTime - 5);
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.code === 'KeyM') {
      e.preventDefault();
      v.muted = !v.muted;
    }
  }, [togglePlay, toggleFullscreen]);

  // ── HLS lifecycle ─────────────────────────────────────────────
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
            // Force start at byte 0. Without this hls.js's default of
            // -1 ("live edge") makes it skip to ~12 s before the most-
            // recently-encoded segment every time the playlist refreshes
            // while ffmpeg is still transcoding.
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
              default:
                break;
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
      if (hls) {
        try { hls.destroy(); } catch (_) {}
        hlsRef.current = null;
      }
      if (detachNative) detachNative();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      try {
        video.removeAttribute('src');
        video.load();
      } catch (_) {}
    };
  }, [src, autoPlay]);

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={handleKey}
      className={`relative outline-none group ${className}`}
      style={{ position: 'relative' }}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        poster={poster || undefined}
        onClick={handleClick}
        className="w-full h-full object-contain bg-black"
        style={{ cursor: 'pointer' }}
      />

      {/* Brief play/pause icon flash to make click feedback feel intentional. */}
      {flash && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div
            className="rounded-full bg-black/60 backdrop-blur-md p-5 shadow-2xl"
            style={{
              animation: 'streamix-fade-flash 600ms ease-out forwards',
            }}
          >
            {flash === 'play' ? (
              <svg width="48" height="48" viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg width="48" height="48" viewBox="0 0 24 24" fill="white">
                <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
              </svg>
            )}
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes streamix-fade-flash {
          0%   { opacity: 0; transform: scale(0.6); }
          25%  { opacity: 1; transform: scale(1.0); }
          100% { opacity: 0; transform: scale(1.4); }
        }
      `}</style>
    </div>
  );
}
