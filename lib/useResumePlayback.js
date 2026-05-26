import { useEffect, useRef, useState } from 'react';
import { getClientId } from './clientId';

/**
 * useResumePlayback — Fetches saved position and auto-seeks on load
 * 
 * Returns:
 * - resumeData: { position, duration } | null
 * - applyResume: (videoElement) => void - call this after loadedmetadata
 * - toast: { message, show } - for "Resumed from X:XX" toast
 * - clearToast: () => void
 */
export function useResumePlayback(metadata) {
  const [resumeData, setResumeData] = useState(null);
  const [toast, setToast] = useState({ message: '', show: false });
  const hasAppliedRef = useRef(false);

  // Fetch saved position on mount
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
          // Only resume if position is meaningful and not near end
          if (position >= 30 && position < duration * 0.9) {
            setResumeData({ position, duration });
          }
        }
      } catch (err) {
        console.error('[Resume] Fetch error:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [metadata]);

  const applyResume = (videoElement) => {
    if (!videoElement || !resumeData || hasAppliedRef.current) return;

    // Wait for loadedmetadata if not ready
    if (videoElement.readyState < 1) {
      const handler = () => {
        videoElement.removeEventListener('loadedmetadata', handler);
        applyResumeInternal(videoElement);
      };
      videoElement.addEventListener('loadedmetadata', handler);
      return;
    }

    applyResumeInternal(videoElement);
  };

  const applyResumeInternal = (videoElement) => {
    if (!resumeData || hasAppliedRef.current) return;

    hasAppliedRef.current = true;
    videoElement.currentTime = resumeData.position;

    // Format time for toast (MM:SS)
    const mins = Math.floor(resumeData.position / 60);
    const secs = Math.floor(resumeData.position % 60);
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

    setToast({ message: `Resumed from ${timeStr}`, show: true });

    // Auto-dismiss toast after 3s
    setTimeout(() => {
      setToast((prev) => ({ ...prev, show: false }));
    }, 3000);
  };

  const clearToast = () => {
    setToast({ message: '', show: false });
  };

  return { resumeData, applyResume, toast, clearToast };
}
