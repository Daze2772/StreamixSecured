'use client';

import { useEffect, useState } from 'react';

/**
 * DevTools Deterrent
 * ==================
 * Provides mild psychological deterrence against casual DevTools usage.
 * 
 * IMPORTANT CAVEATS:
 * - Easily bypassed by anyone with technical knowledge
 * - Can trigger false positives on mobile devices, split-screen users
 * - Does NOT protect API keys (those should be server-side only)
 * - Does NOT protect streaming URLs (they're in the <video> element anyway)
 * 
 * This is for psychological effect only - NOT real security.
 * 
 * USAGE: Add <DevToolsDeterrent /> to your root layout (production only)
 */

export function DevToolsDeterrent() {
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [showWarning, setShowWarning] = useState(false);

  useEffect(() => {
    // Only run in production
    if (process.env.NODE_ENV !== 'production') {
      return;
    }

    // ── Skip on touch / mobile devices ────────────────────────────────
    // The viewport-delta heuristic below is fundamentally broken on
    // mobile Safari and Chrome:
    //   • The URL bar showing/hiding changes innerHeight by ~80px
    //   • Rotating the device flips outer/inner dimensions
    //   • The on-screen keyboard shrinks innerHeight by ~250px
    //   • PWA install banners, "Open in App" prompts, share sheets, etc.
    //     all temporarily change the viewport math
    // Any of these trips the 160px threshold and fires a false-positive
    // warning that completely blocks the page until dismissed — terrible UX.
    //
    // And opening DevTools on a phone is not even possible without
    // plugging into a desktop and using Safari/Chrome remote inspection.
    // So the deterrent has ~0% security value on touch devices but ~100%
    // UX downside. Just disable it.
    const isTouchDevice = (
      typeof window !== 'undefined' && (
        'ontouchstart' in window ||
        (navigator && navigator.maxTouchPoints > 0) ||
        (window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches)
      )
    );
    if (isTouchDevice) {
      return;
    }

    let threshold = 160; // Width/height difference threshold
    let checkCount = 0;
    const MAX_CHECKS = 3; // Show warning after 3 detections

    const check = () => {
      try {
        const widthThreshold = window.outerWidth - window.innerWidth > threshold;
        const heightThreshold = window.outerHeight - window.innerHeight > threshold;
        
        const isOpen = widthThreshold || heightThreshold;

        if (isOpen) {
          checkCount++;
          if (checkCount >= MAX_CHECKS) {
            setDevtoolsOpen(true);
            setShowWarning(true);
          }
        } else {
          checkCount = Math.max(0, checkCount - 1);
          if (checkCount === 0) {
            setDevtoolsOpen(false);
          }
        }
      } catch (e) {
        // Fail open - never trap users
        console.warn('[DevTools Deterrent] Check failed:', e);
      }
    };

    // Check periodically
    const interval = setInterval(check, 1000);

    // Also check on resize
    window.addEventListener('resize', check);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', check);
    };
  }, []);

  if (!devtoolsOpen || !showWarning) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/95 flex items-center justify-center p-8">
      <div className="max-w-2xl bg-neutral-900 border border-red-500/50 rounded-lg p-8 text-center">
        <div className="text-6xl mb-4">⚠️</div>
        <h1 className="text-3xl font-bold text-red-400 mb-4">
          Developer Tools Detected
        </h1>
        <p className="text-neutral-300 mb-6 leading-relaxed">
          This is a private streaming viewer with content licensed through premium providers.
          <br />
          <br />
          We kindly ask that you <b>don't redistribute or reverse-engineer</b> the service.
          <br />
          <br />
          If you're debugging a legitimate issue, please contact support instead.
        </p>
        <div className="flex gap-4 justify-center">
          <button
            onClick={() => {
              setShowWarning(false);
              setDevtoolsOpen(false);
            }}
            className="px-6 py-3 bg-neutral-700 hover:bg-neutral-600 rounded-lg font-semibold transition"
          >
            I Understand — Continue Anyway
          </button>
          <button
            onClick={() => {
              window.location.href = '/';
            }}
            className="px-6 py-3 bg-red-600 hover:bg-red-500 rounded-lg font-semibold transition"
          >
            Return to Home
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-6">
          Note: This is a deterrent only. We respect developer freedom.
        </p>
      </div>
    </div>
  );
}
