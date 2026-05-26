import { useCallback, useEffect, useRef } from 'react';
import { getClientId } from './clientId';

/**
 * useProgressTracking — Saves playback position to Continue Watching
 * 
 * Behavior:
 * - Saves every 15s of playback (debounced)
 * - Doesn't save until user watched >= 30s
 * - Doesn't save if position >= 95% (treats as completed, but sends final save with completed=true)
 * - Saves on unmount / beforeunload (best-effort)
 * 
 * Args:
 * - videoRef: ref to <video> element
 * - metadata: { mediaType, tmdbId, season, episode, title, episodeTitle, posterPath, backdropPath }
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

  const saveProgress = useCallback(async (position, duration, force = false) => {
    const clientId = getClientId();
    if (!clientId || !metadataRef.current) return;

    const now = Date.now();
    const meta = metadataRef.current;

    // Don't save if:
    // - Position < 30s (skip false starts)
    // - Less than 15s since last save (debounce), unless forced
    // - Duration not available
    if (position < 30 || duration <= 0) return;
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
          position,
          duration,
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
      const position = video.currentTime;
      const duration = video.duration;
      
      if (!position || !duration || !Number.isFinite(position) || !Number.isFinite(duration)) {
        return;
      }

      // If near the end (>= 95%), save one final time with completed flag, then stop
      if (position / duration >= 0.95 && hasSavedAnyRef.current) {
        saveProgress(position, duration, true);
        video.removeEventListener('timeupdate', handleTimeUpdate);
        return;
      }

      saveProgress(position, duration, false);
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
      const position = video.currentTime;
      const duration = video.duration;
      if (position >= 30 && duration > 0) {
        // Fire-and-forget (can't await in cleanup)
        saveProgress(position, duration, true);
      }
    };
  }, [enabled, videoRef, saveProgress]);

  // Save on page unload (best-effort with sendBeacon if available)
  useEffect(() => {
    if (!enabled) return;

    const handleBeforeUnload = () => {
      if (!videoRef.current || !hasSavedAnyRef.current) return;
      const video = videoRef.current;
      const position = video.currentTime;
      const duration = video.duration;
      
      if (position < 30 || duration <= 0) return;

      const clientId = getClientId();
      const meta = metadataRef.current;
      if (!clientId || !meta) return;

      const payload = JSON.stringify({
        clientId,
        mediaType: meta.mediaType,
        tmdbId: meta.tmdbId,
        season: meta.season || null,
        episode: meta.episode || null,
        position,
        duration,
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
