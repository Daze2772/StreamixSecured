'use client';

import { useEffect } from 'react';

/**
 * HilltopAdsLoader
 * ================
 * Mounts the HilltopAds popunder ad script into the document head while
 * the component is alive. Used by `VideoPlayer.js` and ONLY rendered when:
 *   • the user is on a watch page
 *   • the Premium tab is the active server
 *   • the user has clicked play (so the player is actually mounted)
 *   • premium resolved successfully (state === 'ok')
 *
 * This gating is deliberate:
 *   • Public Server tabs already monetize via their own iframe ads;
 *     loading a second popunder on top would be doubly annoying
 *   • Home / discover / search pages stay ad-free
 *   • If the user switches AWAY from Premium mid-session, the script is
 *     removed (best-effort) so it doesn't keep firing in the background
 *
 * Failure mode: if the ad script fails to load (adblocker, network glitch,
 * CSP block) we silently no-op. The player itself NEVER depends on this.
 *
 * ⚠️ TESTING-ONLY (as of 2026-05): the /watch CSP in next.config.js has
 * been loosened to permit the ad creative chain. Before going public:
 *   1. Audit Real-Debrid TOS — ad-supported public streaming is forbidden
 *      and gets API keys revoked.
 *   2. Re-tighten CSP — currently allows broad https: for testing.
 */
export function HilltopAdsLoader() {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    let scriptEl = null;
    try {
      // Direct equivalent of the IIFE HilltopAds gave us — we cut out the
      // wrapper and just inject the actual external script tag. Same end
      // result, no inline-eval needed (= friendlier to strict CSP).
      scriptEl = document.createElement('script');
      scriptEl.src =
        '//exalted-engineering.com/cTD.9P6-b/2O5RlXSHWdQp9/NszAAQ4IOhTeEcw/O/Sr0i3FMWDtgs5BM/TJEXzj';
      scriptEl.async = true;
      scriptEl.referrerPolicy = 'no-referrer-when-downgrade';
      // Tag so we can clean up any scripts the ad network injects later.
      scriptEl.setAttribute('data-streamix-ad', 'hilltop');
      scriptEl.onerror = () => {
        // Adblockers usually surface here. Don't surface to the user.
        // eslint-disable-next-line no-console
        console.debug('[ads] HilltopAds script failed to load (adblock/network)');
      };
      document.head.appendChild(scriptEl);
    } catch (_) {
      // Player must never crash because of an ad. Silently swallow.
    }

    return () => {
      // Best-effort cleanup. Some popunder networks attach handlers /
      // timers we can't unregister — those are harmless once the user
      // navigates away because React unmounts the host.
      try {
        if (scriptEl && scriptEl.parentNode) {
          scriptEl.parentNode.removeChild(scriptEl);
        }
        document
          .querySelectorAll('script[data-streamix-ad="hilltop"]')
          .forEach((el) => el.parentNode && el.parentNode.removeChild(el));
      } catch (_) {}
    };
  }, []);

  return null;
}

export default HilltopAdsLoader;
