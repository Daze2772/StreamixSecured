'use client';

import { useEffect, useRef } from 'react';

/**
 * HlsVideo
 * ========
 * <video> wrapper that plays an HLS playlist via hls.js — or, on browsers
 * with native HLS support (Safari, iOS), just sets the src directly.
 *
 * Designed for our Real-Debrid premium flow: the resolver returns
 * `/api/stream/hls/<session>/index.m3u8` and the server transcodes/remuxes
 * the upstream RD file with ffmpeg, so the source can be any codec the
 * torrent shipped with.
 *
 * Props:
 *   src         playlist URL (.m3u8)
 *   poster      optional <video> poster
 *   className   passed to <video>
 *   onReady     fired when first frame has decoded (≈ canplay)
 *   onFatal     fired when hls.js or <video> can't recover (caller should
 *               fall back to alternates / next streaming server)
 *
 * Why a child component:
 *   - Keeps the hls.js dynamic import + lifecycle out of the giant
 *     VideoPlayer file.
 *   - Re-mounts cleanly when `src` changes (parent passes a new key).
 *   - Lazy-loads hls.js — adds ~200 KB only on premium playback.
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
  // Keep latest callbacks in refs so the effect doesn't re-run on every
  // parent re-render.
  const onReadyRef = useRef(onReady);
  const onFatalRef = useRef(onFatal);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onFatalRef.current = onFatal; }, [onFatal]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let disposed = false;
    let hls = null;

    const attachNative = () => {
      // Safari / iOS — native HLS support
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

    let detachNative = null;

    (async () => {
      // Prefer hls.js (Chrome/FF/Edge); fall back to native (Safari/iOS).
      try {
        const HlsMod = await import('hls.js');
        const Hls = HlsMod.default;
        if (disposed) return;

        if (Hls && Hls.isSupported()) {
          hls = new Hls({
            // ★ Force start at byte 0. Without this, hls.js sees a
            //   growing playlist (ffmpeg is still encoding) without
            //   #EXT-X-ENDLIST and treats it as a live stream — its
            //   default startPosition: -1 means "start at the live
            //   edge", which was making the player jump to ~12 s before
            //   the most-recently-encoded segment every time the
            //   playlist refreshed. We always want to start at 0.
            startPosition: 0,
            // Don't try to keep up with a moving live edge.
            liveSyncDurationCount: 0,
            liveMaxLatencyDurationCount: Infinity,
            lowLatencyMode: false,
            // Buffer aggressively — server is encoding faster than
            // realtime so segments are always available.
            maxBufferLength: 60,
            maxMaxBufferLength: 600,
            // Be patient on the first fragment (ffmpeg may still be
            // ramping up its segment writes).
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 1000,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
          });
          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (autoPlay) video.play().catch(() => { /* gesture-required */ });
            onReadyRef.current?.();
          });

          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (!data.fatal) return;
            // Try to recover transparently before bubbling.
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('[hls] fatal network error, retrying…', data.details);
                try { hls.startLoad(); return; } catch (_) {}
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('[hls] fatal media error, recovering…', data.details);
                try { hls.recoverMediaError(); return; } catch (_) {}
                break;
              default:
                break;
            }
            console.error('[hls] fatal, giving up:', data);
            if (!disposed) onFatalRef.current?.(new Error(`${data.type}/${data.details}`));
          });

          hls.attachMedia(video);
          hls.loadSource(src);
          return;
        }

        // hls.js not supported → try native (Safari etc.)
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          detachNative = attachNative();
          return;
        }
        onFatalRef.current?.(new Error('HLS not supported in this browser'));
      } catch (e) {
        if (disposed) return;
        // Last-ditch attempt with native
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
      try {
        video.removeAttribute('src');
        video.load();
      } catch (_) {}
    };
  }, [src, autoPlay]);

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      poster={poster || undefined}
      className={className}
    />
  );
}
