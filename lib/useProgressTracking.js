import { useCallback, useEffect, useRef } from 'react';
import { getClientId } from './clientId';

/**
 * useProgressTracking — Saves playback position to Continue Watching
 *
 * Behavior:
 * - Saves every 15s of playback (debounced)
 * - Doesn't save until user watched >= 30s of REAL playback
 *   (currentTime + sessionStartOffset)
 * - Doesn't save if real-position >= 95% of real-duration
 *   (treats as completed, but sends final save with completed=true)
 * - Saves on unmount / beforeunload (best-effort)
 *
 * § REAL vs SESSION coordinates §
 * The HLS session may have been spawned with ffmpeg `-ss <offset>`
 * (Continue Watching resume, or mid-playback quality swap). In that case
 * the <video> element reports `currentTime=0` at the moment that maps to
 * real-world second `offset` in the source file. We MUST save the
 * real-world position so the next resume lands at the right second:
 *
 *   realPosition  = video.currentTime + sessionStartOffset
 *   realDuration  = video.duration    + sessionStartOffset
 *
 * Saving session-relative values would cause a 30 min watched session
 * that started at offset=60s to come back showing only 30 min from the
 * START of the file (resetting the user's progress).
 *
 * Args:
 * - videoRef: ref to <video> element
 * - metadata: {
 *     mediaType, tmdbId, season, episode, title, episodeTitle,
 *     posterPath, backdropPath, sessionStartOffset (seconds, default 0)
 *   }
 * - enabled: boolean (only track when actually playing Premium/Direct video)
 */
export function useProgressTracking(videoRef, metadata, enabled) {
  const lastSavedTimeRef = useRef(0);
  const hasSavedAnyRef = useRef(false);
  const metadataRef = useRef(metadata);

  // Update metadata ref when it changes
  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

  const saveProgress = useCallback(async (realPosition, realDuration, force = false) => {
    const clientId = getClientId();
    if (!clientId || !metadataRef.current) return;

    const now = Date.now();
    const meta = metadataRef.current;

    // Don't save if:
    // - Real position < 30s (skip false starts)
    // - Less than 15s since last save (debounce), unless forced
    // - Duration not available
    if (realPosition < 30 || realDuration <= 0) return;
    if (!force && (now - lastSavedTimeRef.current) < 15000) return;

    lastSavedTimeRef.current = now;
    hasSavedAnyRef.current = true;

    try {
      await fetch('/api/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          mediaType: meta.mediaType,
          tmdbId: meta.tmdbId,
          season: meta.season || null,
          episode: meta.episode || null,
          position: realPosition,
          duration: realDuration,
          title: meta.title || 'Unknown',
          episodeTitle: meta.episodeTitle || null,
          posterPath: meta.posterPath || null,
          backdropPath: meta.backdropPath || null,
        }),
      });
    } catch (err) {
      console.error('[ProgressTracking] Save error:', err);
    }
  }, []);

  // Listen to timeupdate and save periodically
  useEffect(() => {
    if (!enabled || !videoRef.current) return;

    const video = videoRef.current;

    const handleTimeUpdate = () => {
      // Re-read offset on every tick so a mid-playback quality swap (which
      // mints a new session at a different offset) is reflected immediately.
      const off = (metadataRef.current?.sessionStartOffset) || 0;
      const realPosition = (video.currentTime || 0) + off;
      const realDuration = (video.duration || 0) + off;

      if (
        !realPosition
        || !realDuration
        || !Number.isFinite(realPosition)
        || !Number.isFinite(realDuration)
      ) {
        return;
      }

      // If near the end (>= 95%), save one final time with completed flag,
      // then stop. Threshold is computed in REAL coordinates so that a
      // resume-from-50-min session for a 60-min movie still hits 95% at
      // the right point (real 57:00), not at session-only 95% (real
      // 50 + 0.95 × 10 = 59:30 — too late).
      if (realPosition / realDuration >= 0.95 && hasSavedAnyRef.current) {
        saveProgress(realPosition, realDuration, true);
        video.removeEventListener('timeupdate', handleTimeUpdate);
        return;
      }

      saveProgress(realPosition, realDuration, false);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [enabled, videoRef, saveProgress]);

  // Save on unmount (best-effort)
  useEffect(() => {
    return () => {
      if (!enabled || !videoRef.current || !hasSavedAnyRef.current) return;
      const video = videoRef.current;
      const off = (metadataRef.current?.sessionStartOffset) || 0;
      const realPosition = (video.currentTime || 0) + off;
      const realDuration = (video.duration || 0) + off;
      if (realPosition >= 30 && realDuration > 0) {
        // Fire-and-forget (can't await in cleanup)
        saveProgress(realPosition, realDuration, true);
      }
    };
  }, [enabled, videoRef, saveProgress]);

  // Save on page unload (best-effort with sendBeacon if available)
  useEffect(() => {
    if (!enabled) return;

    const handleBeforeUnload = () => {
      if (!videoRef.current || !hasSavedAnyRef.current) return;
      const video = videoRef.current;
      const off = (metadataRef.current?.sessionStartOffset) || 0;
      const realPosition = (video.currentTime || 0) + off;
      const realDuration = (video.duration || 0) + off;

      if (realPosition < 30 || realDuration <= 0) return;

      const clientId = getClientId();
      const meta = metadataRef.current;
      if (!clientId || !meta) return;

      const payload = JSON.stringify({
        clientId,
        mediaType: meta.mediaType,
        tmdbId: meta.tmdbId,
        season: meta.season || null,
        episode: meta.episode || null,
        position: realPosition,
        duration: realDuration,
        title: meta.title || 'Unknown',
        episodeTitle: meta.episodeTitle || null,
        posterPath: meta.posterPath || null,
        backdropPath: meta.backdropPath || null,
      });

      // Try sendBeacon first (most reliable for unload), fallback to fetch
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon('/api/progress', blob);
      } else {
        fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [enabled, videoRef]);

  return { saveProgress };
}
