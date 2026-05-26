import { useEffect, useRef, useState } from 'react';
import { getClientId } from './clientId';

/**
 * useResumePlayback — Surfaces saved Continue Watching progress as plain
 * data the caller can act on (no DOM side-effects).
 *
 * §10 — The OLD applyResume(videoEl) seek-after-loadedmetadata path is
 * gone. The HLS transcoder's growing-playlist meant a `videoEl.currentTime
 * = savedPos` at loadedmetadata silently failed (segments past 30s didn't
 * exist yet). The new architecture mints the HLS session itself at the
 * resume offset via ffmpeg `-ss <savedPos>`, so playback starts AT the
 * right second with no client-side seek needed. The Continue Watching
 * card simply threads `?resume=<seconds>` into the watch-page URL, which
 * the page reads and passes to the resolver as `&start=`.
 *
 * This hook remains available for entry points OTHER than the CW card
 * (e.g., user clicks Play from search results — no URL `?resume=`). The
 * consumer can read `resumeSec` and pass it to the resolver if it wants
 * server-side resume in those flows.
 *
 * Returns:
 * - resumeSec:    number (seconds) | 0 — saved position from the API
 * - hasResume:    boolean — true when resumeSec >= 30 and not completed
 * - clearResume:  () => void — caller dismisses the resume affordance
 * - toast:        { show, message } — "Resumed from M:SS" once consumed
 */
export function useResumePlayback(metadata) {
  const [resumeSec, setResumeSec] = useState(0);
  const [hasResume, setHasResume] = useState(false);
  const [toast, setToast] = useState({ show: false, message: '' });
  const toastTimerRef = useRef(null);

  // Fetch saved position whenever metadata identity changes
  useEffect(() => {
    if (!metadata || !metadata.mediaType || !metadata.tmdbId) return;

    const clientId = getClientId();
    if (!clientId) return;

    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({
          clientId,
          mediaType: metadata.mediaType,
          tmdbId: String(metadata.tmdbId),
        });
        if (metadata.season) params.append('season', String(metadata.season));
        if (metadata.episode) params.append('episode', String(metadata.episode));

        const res = await fetch(`/api/progress/single?${params.toString()}`);
        const data = await res.json();
        if (cancelled) return;

        if (data.item && data.item.position && !data.item.completed) {
          const { position, duration } = data.item;
          // Only surface as a resume opportunity when the saved position
          // is past the early-exit threshold AND below the near-complete
          // threshold (matches the save-side gating in useProgressTracking).
          if (position >= 30 && (!duration || position < duration * 0.95)) {
            setResumeSec(position);
            setHasResume(true);
            const mins = Math.floor(position / 60);
            const secs = Math.floor(position % 60);
            setToast({
              show: true,
              message: `Resumed from ${mins}:${secs.toString().padStart(2, '0')}`,
            });
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            toastTimerRef.current = setTimeout(() => {
              setToast((prev) => ({ ...prev, show: false }));
            }, 3000);
          }
        }
      } catch (err) {
        console.error('[Resume] Fetch error:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [metadata]);

  const clearResume = () => {
    setResumeSec(0);
    setHasResume(false);
    setToast({ show: false, message: '' });
  };

  return { resumeSec, hasResume, clearResume, toast };
}
