'use client';

/**
 * getClientId — Device-level identifier for watch progress tracking.
 * 
 * Since there's no user auth, progress is stored per-device. This
 * generates a UUID on first visit and persists it in localStorage.
 * One device = one "user" for Continue Watching purposes.
 */
export function getClientId() {
  if (typeof window === 'undefined') return null;
  
  let id = localStorage.getItem('streamix.clientId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('streamix.clientId', id);
  }
  
  return id;
}
