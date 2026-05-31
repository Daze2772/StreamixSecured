'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2, X, CheckCircle, AlertCircle, Users, HardDrive, Crown } from 'lucide-react';

/**
 * Jackett Results Overlay
 * 
 * Shows torrents found by Jackett when Comet has nothing.
 * Users can add uncached torrents to Real-Debrid and wait for download.
 */

export function JackettResultsOverlay({ results, onAddTorrent, onClose }) {
  const [adding, setAdding] = useState(null); // torrent hash being added
  const [progress, setProgress] = useState(null); // { torrentId, progress, status }

  const handleAddTorrent = async (torrent) => {
    if (adding) return; // Already adding something
    
    setAdding(torrent.infoHash);
    
    try {
      // Step 1: Add torrent to Real-Debrid
      const addRes = await fetch('/api/realdebrid/add-torrent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ magnet: torrent.magnetUri }),
      });

      const addData = await addRes.json();
      
      if (!addRes.ok || !addData.torrentId) {
        throw new Error(addData.error || 'Failed to add torrent');
      }

      console.log('[Jackett] Torrent added:', addData.torrentId);
      
      setProgress({
        torrentId: addData.torrentId,
        progress: addData.progress || 0,
        status: addData.status || 'downloading',
        filename: addData.filename || torrent.title,
      });

      // Step 2: Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/realdebrid/add-torrent?torrentId=${addData.torrentId}`);
          const statusData = await statusRes.json();

          if (statusRes.ok) {
            setProgress({
              torrentId: statusData.torrentId,
              progress: statusData.progress || 0,
              status: statusData.status || 'downloading',
              filename: statusData.filename || torrent.title,
            });

            // Check if download is complete
            if (statusData.isComplete && statusData.links && statusData.links.length > 0) {
              clearInterval(pollInterval);
              console.log('[Jackett] Download complete! RD URL:', statusData.links[0].url);
              
              // TODO: Trigger Premium playback with the RD URL
              // For now, just show success and let user reload
              setProgress({
                ...statusData,
                complete: true,
              });
            }
          }
        } catch (e) {
          console.error('[Jackett] Poll error:', e);
        }
      }, 3000); // Poll every 3 seconds

      // Stop polling after 10 minutes
      setTimeout(() => clearInterval(pollInterval), 10 * 60 * 1000);

    } catch (error) {
      console.error('[Jackett] Add torrent error:', error);
      alert(`Failed to add torrent: ${error.message}`);
      setAdding(null);
      setProgress(null);
    }
  };

  // If showing progress, render progress UI
  if (progress) {
    return (
      <div className="absolute inset-0 grid place-items-center bg-black/90 backdrop-blur px-6">
        <div className="max-w-lg w-full bg-gradient-to-br from-neutral-900 to-neutral-950 rounded-lg border border-amber-500/30 p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-amber-100 flex items-center gap-2">
                {progress.complete ? (
                  <>
                    <CheckCircle className="w-5 h-5 text-green-400" />
                    Download Complete!
                  </>
                ) : (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
                    Adding to Real-Debrid
                  </>
                )}
              </h3>
              <p className="text-xs text-neutral-400 mt-1">{progress.filename}</p>
            </div>
            <button
              onClick={() => {
                setProgress(null);
                setAdding(null);
              }}
              className="text-neutral-500 hover:text-neutral-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {!progress.complete && (
            <>
              <div className="mb-2">
                <div className="flex justify-between text-xs text-neutral-400 mb-1">
                  <span>Progress</span>
                  <span>{progress.progress.toFixed(0)}%</span>
                </div>
                <div className="h-2 bg-neutral-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-yellow-600 transition-all duration-500"
                    style={{ width: `${progress.progress}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-neutral-500 text-center mt-3">
                This usually takes 2-5 minutes depending on torrent size and seeders
              </p>
            </>
          )}

          {progress.complete && (
            <div className="mt-4">
              <p className="text-sm text-green-300 text-center mb-4">
                ✓ Torrent downloaded to Real-Debrid! Reload the page to play.
              </p>
              <Button
                onClick={() => window.location.reload()}
                className="w-full bg-gradient-to-r from-green-600 to-green-700 hover:from-green-500 hover:to-green-600 text-white"
              >
                Reload & Play
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Main Jackett results list
  const cachedResults = results.filter(r => r.cached);
  const uncachedResults = results.filter(r => !r.cached);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/90 backdrop-blur px-4 py-6 overflow-y-auto">
      <div className="max-w-3xl w-full bg-gradient-to-br from-neutral-900 to-neutral-950 rounded-lg border border-amber-500/30 shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-800 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-amber-100 flex items-center gap-2">
              <Crown className="w-5 h-5 text-amber-400" />
              Alternative Premium Sources
            </h2>
            <p className="text-sm text-neutral-400 mt-1">
              Comet didn't find this title, but Jackett found {results.length} torrent{results.length !== 1 ? 's' : ''} across 50+ indexers
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Cached torrents (instant play) */}
        {cachedResults.length > 0 && (
          <div className="px-6 py-4 border-b border-neutral-800">
            <h3 className="text-sm font-semibold text-green-400 mb-3 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              Ready to Stream ({cachedResults.length})
            </h3>
            <div className="space-y-2">
              {cachedResults.map((torrent) => (
                <TorrentItem
                  key={torrent.infoHash}
                  torrent={torrent}
                  cached={true}
                  onAdd={handleAddTorrent}
                  disabled={!!adding}
                />
              ))}
            </div>
          </div>
        )}

        {/* Uncached torrents (need to add & wait) */}
        {uncachedResults.length > 0 && (
          <div className="px-6 py-4">
            <h3 className="text-sm font-semibold text-amber-400 mb-3 flex items-center gap-2">
              <Download className="w-4 h-4" />
              Add & Wait (2-5 min) ({uncachedResults.length})
            </h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {uncachedResults.slice(0, 10).map((torrent) => (
                <TorrentItem
                  key={torrent.infoHash}
                  torrent={torrent}
                  cached={false}
                  onAdd={handleAddTorrent}
                  disabled={!!adding}
                />
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 bg-neutral-950/50 border-t border-neutral-800 rounded-b-lg">
          <p className="text-xs text-neutral-500 text-center">
            💡 <b className="text-neutral-400">Tip:</b> Cached torrents play instantly. Uncached ones need 2-5 min to download to Real-Debrid first.
          </p>
        </div>
      </div>
    </div>
  );
}

function TorrentItem({ torrent, cached, onAdd, disabled }) {
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    setIsAdding(true);
    try {
      await onAdd(torrent);
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <div className="flex items-center gap-3 p-3 bg-neutral-800/40 hover:bg-neutral-800/60 rounded border border-neutral-700/50 transition">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-neutral-200 truncate">
          {torrent.title}
        </p>
        <div className="flex items-center gap-3 text-xs text-neutral-500 mt-1">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${
            torrent.quality === '2160p' ? 'bg-purple-500/20 text-purple-300' :
            torrent.quality === '1080p' ? 'bg-blue-500/20 text-blue-300' :
            torrent.quality === '720p' ? 'bg-green-500/20 text-green-300' :
            'bg-neutral-600/20 text-neutral-400'
          }`}>
            {torrent.quality || 'Unknown'}
          </span>
          <span className="inline-flex items-center gap-1">
            <HardDrive className="w-3 h-3" />
            {torrent.sizeFormatted}
          </span>
          <span className="inline-flex items-center gap-1">
            <Users className="w-3 h-3" />
            {torrent.seeders || 0}
          </span>
          <span className="text-neutral-600">{torrent.indexer}</span>
        </div>
      </div>
      {cached ? (
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={disabled || isAdding}
          className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-500 hover:to-green-600 text-white"
        >
          {isAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Play Now'}
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={disabled || isAdding}
          className="bg-gradient-to-r from-amber-600 to-yellow-700 hover:from-amber-500 hover:to-yellow-600 text-white"
        >
          {isAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Add & Wait'}
        </Button>
      )}
    </div>
  );
}
