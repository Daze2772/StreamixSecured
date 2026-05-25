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
            // Start a bit conservative — server is still encoding ahead.
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            // Be patient: ffmpeg might not have segment N+5 ready yet.
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 1000,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
            // Refresh the playlist often so newly-encoded segments show up
            // for live-ish playback while transcoding.
            liveSyncDuration: 8,
            liveMaxLatencyDuration: 20,
            lowLatencyMode: false,
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
