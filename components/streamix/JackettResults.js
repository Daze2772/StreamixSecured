'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, X, CheckCircle, Users, HardDrive, Crown, Zap, Clock } from 'lucide-react';

/**
 * Jackett Results Overlay — user-friendly "alternate version" picker.
 *
 * Shown when our default library has nothing for a title but the
 * indexer fallback found other releases. UX goals:
 *   - Hide all the implementation jargon ("torrents", "Jackett", "Real-Debrid",
 *     "uncached", indexer names). Users don't need to know.
 *   - Make the two paths obvious: instant-play vs prepare-then-play.
 *   - Filter out dead releases (0 seeders) — RD can't download them and
 *     they'd just hang forever at 0% progress.
 *   - Show meaningful progress messages tied to RD's actual status field,
 *     not just a generic "downloading" bar that stays at 0% for 5 minutes
 *     while RD is actually still searching for peers.
 */

// RD status → user-friendly label + whether it's still in-flight.
// See https://api.real-debrid.com/ for the full list.
const RD_STATUS_LABELS = {
  magnet_conversion: { label: 'Looking up the release…', live: true },
  waiting_files_selection: { label: 'Preparing files…', live: true },
  queued: { label: 'Queued for download…', live: true },
  downloading: { label: 'Downloading…', live: true },
  compressing: { label: 'Finalising…', live: true },
  uploading: { label: 'Finalising…', live: true },
  downloaded: { label: 'Ready to play!', live: false, done: true },
  error: { label: 'This version is unavailable', live: false, error: true },
  magnet_error: { label: 'Invalid release — try another', live: false, error: true },
  virus: { label: 'This release was flagged — try another', live: false, error: true },
  dead: { label: 'No active peers — try another version', live: false, error: true },
};

export function JackettResultsOverlay({ results, onAddTorrent, onPreparedReady, onClose }) {
  const [adding, setAdding] = useState(null); // torrent infoHash being added
  const [progress, setProgress] = useState(null);
  const pollRef = useRef(null);
  const lastProgressChangeRef = useRef(Date.now());

  // Cleanup polling when unmounted / progress reset
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const handleAddTorrent = async (torrent) => {
    if (adding) return;
    setAdding(torrent.infoHash);
    lastProgressChangeRef.current = Date.now();

    try {
      const addRes = await fetch('/api/realdebrid/add-torrent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: torrent.magnetUri }),
      });
      const addData = await addRes.json();

      if (!addRes.ok || !addData.torrentId) {
        throw new Error(addData.error || 'Could not start this version');
      }

      const initial = {
        torrentId: addData.torrentId,
        progress: addData.progress || 0,
        status: addData.status || 'queued',
        filename: addData.filename || torrent.title,
        speed: addData.speed || 0,
        seeders: addData.seeders ?? torrent.seeders ?? 0,
      };
      setProgress(initial);

      let lastProgress = initial.progress;

      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/realdebrid/add-torrent?torrentId=${addData.torrentId}`);
          const statusData = await statusRes.json();

          if (statusRes.ok) {
            // Track when progress last advanced — used to detect stalls
            if ((statusData.progress || 0) > lastProgress) {
              lastProgress = statusData.progress;
              lastProgressChangeRef.current = Date.now();
            }

            const newProgress = {
              torrentId: statusData.torrentId,
              progress: statusData.progress || 0,
              status: statusData.status || 'queued',
              filename: statusData.filename || torrent.title,
              speed: statusData.speed || 0,
              seeders: statusData.seeders ?? torrent.seeders ?? 0,
              stalled: Date.now() - lastProgressChangeRef.current > 60_000,
            };

            if (statusData.isComplete && statusData.links?.length > 0) {
              clearInterval(pollRef.current);
              newProgress.complete = true;
              newProgress.playUrl = statusData.links[0].url;
            }

            // Terminal error states from RD → stop polling
            const meta = RD_STATUS_LABELS[newProgress.status];
            if (meta && (meta.error || meta.done) && !newProgress.complete) {
              clearInterval(pollRef.current);
            }

            setProgress(newProgress);
          }
        } catch (_e) { /* keep polling */ }
      }, 3000);

      // Hard stop after 10 minutes
      setTimeout(() => pollRef.current && clearInterval(pollRef.current), 10 * 60 * 1000);

    } catch (error) {
      console.error('[AltVersion] Add error:', error);
      setProgress({
        torrentId: null,
        progress: 0,
        status: 'error',
        filename: torrent.title,
        seeders: torrent.seeders ?? 0,
        errorMessage: error.message,
      });
      setAdding(null);
    }
  };

  const resetProgress = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setProgress(null);
    setAdding(null);
  };

  // ─── Progress / status view ────────────────────────────────
  if (progress) {
    const meta = RD_STATUS_LABELS[progress.status] || { label: 'Preparing…', live: true };
    const isError = meta.error;
    const isDone = progress.complete || meta.done;
    const showStalledNote = progress.stalled && meta.live && progress.progress === 0;

    return (
      <div className="absolute inset-0 grid place-items-center bg-black/90 backdrop-blur px-6">
        <div className="max-w-lg w-full bg-gradient-to-br from-neutral-900 to-neutral-950 rounded-lg border border-amber-500/30 p-6">
          <div className="flex items-start justify-between mb-4">
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-amber-100 flex items-center gap-2">
                {isDone ? (
                  <>
                    <CheckCircle className="w-5 h-5 text-green-400" />
                    Ready to play
                  </>
                ) : isError ? (
                  <>
                    <X className="w-5 h-5 text-red-400" />
                    Unavailable
                  </>
                ) : (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                    Preparing your video
                  </>
                )}
              </h3>
              <p className="text-xs text-neutral-400 mt-1 truncate">{progress.filename}</p>
            </div>
            <button
              onClick={resetProgress}
              className="text-neutral-500 hover:text-neutral-200 flex-none ml-3"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {!isDone && !isError && (
            <>
              <div className="mb-2">
                <div className="flex justify-between text-xs text-neutral-400 mb-1.5">
                  <span>{meta.label}</span>
                  <span className="tabular-nums">{(progress.progress || 0).toFixed(0)}%</span>
                </div>
                <div className="h-2 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-yellow-600 transition-all duration-500"
                    style={{ width: `${progress.progress || 0}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-neutral-500 text-center mt-3 leading-relaxed">
                {showStalledNote ? (
                  <>
                    Still searching for peers… this version may not be reachable.
                    You can <button onClick={resetProgress} className="underline text-amber-300">pick another</button>.
                  </>
                ) : (
                  <>This usually takes 1–5 minutes.</>
                )}
              </p>
            </>
          )}

          {isError && (
            <div className="mt-3 text-center">
              <p className="text-sm text-red-300/90 mb-3">
                {progress.errorMessage || meta.label}
              </p>
              <Button
                onClick={resetProgress}
                className="bg-amber-600 hover:bg-amber-500 text-white"
              >
                Try another version
              </Button>
            </div>
          )}

          {isDone && (
            <div className="mt-4 text-center">
              <p className="text-sm text-green-300 mb-4">
                Your video is ready to play.
              </p>
              <Button
                onClick={() => {
                  // Hand the prepared torrent off to the parent VideoPlayer
                  // which will hit /api/realdebrid/play-from-torrent and
                  // start a fresh HLS session against the now-cached file.
                  if (onPreparedReady && progress.torrentId) {
                    onPreparedReady(progress.torrentId);
                  } else {
                    // Fallback only if the integration wiring is missing
                    window.location.reload();
                  }
                }}
                className="w-full bg-gradient-to-r from-green-600 to-green-700 hover:from-green-500 hover:to-green-600 text-white"
              >
                Play now
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Result list view ──────────────────────────────────────
  // We keep ALL torrents visible (including 0-seed) so users see options
  // for niche/older titles where everything is barely-seeded. Dead-seed
  // releases just get the "May be unavailable" peer-health label so the
  // user can make an informed pick. The actual download fallback (60s
  // stall detector in the progress view + ranker bottom-sort) handles
  // the failure gracefully if they pick one.
  const all = results || [];
  const instant = all.filter(r => r.cached);
  const prepare = all
    .filter(r => !r.cached)
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  const totalShown = instant.length + Math.min(prepare.length, 15);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/90 backdrop-blur px-4 py-6 overflow-y-auto">
      <div className="max-w-3xl w-full bg-gradient-to-br from-neutral-900 to-neutral-950 rounded-lg border border-amber-500/30 shadow-2xl">
        {/* Header */}
        <div className="px-6 py-5 border-b border-neutral-800 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-amber-100 flex items-center gap-2">
              <Crown className="w-5 h-5 text-amber-400" />
              We found other versions of this title
            </h2>
            <p className="text-sm text-neutral-400 mt-1.5 leading-relaxed">
              Our main library doesn't have this one — but we found {totalShown} alternative {totalShown === 1 ? 'version' : 'versions'} you can watch.
              {instant.length > 0 && ' Some play instantly; others need a quick prep.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 transition flex-none ml-3"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Empty state */}
        {totalShown === 0 && (
          <div className="px-6 py-10 text-center">
            <p className="text-neutral-300">
              No working versions found for this title right now.
            </p>
            <p className="text-xs text-neutral-500 mt-2">
              Try a different episode, or come back later — new releases appear regularly.
            </p>
          </div>
        )}

        {/* Instant-play */}
        {instant.length > 0 && (
          <div className="px-6 py-4 border-b border-neutral-800">
            <h3 className="text-sm font-semibold text-green-400 mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4" />
              Play instantly ({instant.length})
            </h3>
            <div className="space-y-2">
              {instant.map((t) => (
                <VersionItem
                  key={t.infoHash}
                  torrent={t}
                  instant={true}
                  onAdd={handleAddTorrent}
                  disabled={!!adding}
                />
              ))}
            </div>
          </div>
        )}

        {/* Needs prep */}
        {prepare.length > 0 && (
          <div className="px-6 py-4">
            <h3 className="text-sm font-semibold text-amber-400 mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Available with a short prep ({Math.min(prepare.length, 15)})
            </h3>
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {prepare.slice(0, 15).map((t) => (
                <VersionItem
                  key={t.infoHash}
                  torrent={t}
                  instant={false}
                  onAdd={handleAddTorrent}
                  disabled={!!adding}
                />
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 bg-neutral-950/50 border-t border-neutral-800 rounded-b-lg">
          <p className="text-xs text-neutral-500 text-center leading-relaxed">
            Pick the version with the highest quality and most active peers for the best result.
          </p>
        </div>
      </div>
    </div>
  );
}

function VersionItem({ torrent, instant, onAdd, disabled }) {
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    setIsAdding(true);
    try {
      await onAdd(torrent);
    } finally {
      setIsAdding(false);
    }
  };

  const quality = (torrent.quality && torrent.quality !== 'unknown') ? torrent.quality : null;
  const peers = torrent.seeders || 0;

  // "Health" hint based on peers — gives the user a signal without exposing
  // raw seeder numbers (which need context: 50 is good, 0 is dead).
  const peerHint =
    peers >= 30 ? { label: 'High availability', tone: 'text-green-300' } :
    peers >= 5  ? { label: 'Good availability', tone: 'text-emerald-300' } :
    peers >= 1  ? { label: 'Limited availability', tone: 'text-amber-300' } :
                  { label: 'May be unavailable', tone: 'text-neutral-400' };

  return (
    <div className="flex items-center gap-3 p-3 bg-neutral-800/40 hover:bg-neutral-800/60 rounded border border-neutral-700/50 transition">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-neutral-200 truncate">
          {torrent.title}
        </p>
        <div className="flex items-center gap-3 text-xs text-neutral-500 mt-1 flex-wrap">
          {quality && (
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded ${
              quality === '2160p' ? 'bg-purple-500/20 text-purple-300' :
              quality === '1080p' ? 'bg-blue-500/20 text-blue-300' :
              quality === '720p' ? 'bg-green-500/20 text-green-300' :
              'bg-neutral-600/20 text-neutral-400'
            }`}>
              {quality}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <HardDrive className="w-3 h-3" />
            {torrent.sizeFormatted}
          </span>
          <span className={`inline-flex items-center gap-1 ${peerHint.tone}`}>
            <Users className="w-3 h-3" />
            {peerHint.label}
          </span>
        </div>
      </div>
      {instant ? (
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={disabled || isAdding}
          className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-500 hover:to-green-600 text-white whitespace-nowrap"
        >
          {isAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Play'}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={disabled || isAdding}
          className="bg-gradient-to-r from-amber-600 to-yellow-700 hover:from-amber-500 hover:to-yellow-600 text-white whitespace-nowrap"
        >
          {isAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Prepare'}
        </Button>
      )}
    </div>
  );
}
