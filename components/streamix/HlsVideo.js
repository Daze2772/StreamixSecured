'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  Play, Pause, Volume2, VolumeX, Volume1, Maximize, Minimize,
  PictureInPicture2, Settings, Check, Loader2, Subtitles as CCIcon,
} from 'lucide-react';
import { useProgressTracking } from '@/lib/useProgressTracking';

/**
 * HlsVideo — custom Tailwind player on top of hls.js
 * ===================================================
 *
 * Why a custom skin instead of native <video controls>:
 *  - Consistent look across Chrome / FF / Safari (native is each-OS-flavored)
 *  - Bigger scrub bar with buffered + played visualization
 *  - Hover-time tooltip
 *  - Speed control (0.5× — 2×)
 *  - Quality display (placeholder until we add multi-bitrate ABR)
 *  - PiP button
 *  - Auto-hiding overlay
 *
 * What's intentionally NOT here:
 *  - Hover-preview thumbnails — would need a server-side sprite-sheet
 *    + WebVTT track from ffmpeg. Deferred (see HANDOFF.md).
 *  - Functional quality switching — our HLS pipeline outputs a single
 *    bitrate, so the menu just SHOWS "Source · 1080p" until we add ABR.
 *  - Subtitle picker — Comet doesn't pass subtitle tracks.
 *
 * Playback engine (hls.js setup) is UNCHANGED from the previous version
 * — the three magic settings (startPosition:0, liveSync*Count:0,
 * liveMaxLatency:Infinity) that prevent the "skip to live edge" bug are
 * still here. If you're rewriting this file, leave the hls.js block alone.
 */

const formatTime = (sec) => {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
};

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

const RES_ORDER = ['2160p', '1080p', '720p', '480p', '360p'];

// 10-second safety net on a user-initiated quality swap. If loadedmetadata
// hasn't fired by then (dead RD link, ffmpeg refused to demux, network
// hang), we surface a toast and revert the player to the previous src.
const SWITCH_TIMEOUT_MS = 10_000;

// Pick the best quality label for "Auto" mode using navigator.connection.downlink
// (Mbps). Falls back to '1080p' when the API is unavailable (Safari/Firefox).
// Returns the label of the highest available quality at-or-below the
// preferred tier, or the highest available overall if nothing is at-or-below.
const pickAutoQualityLabel = (qualityOptions) => {
  if (!qualityOptions || !qualityOptions.length) return null;
  const dl = (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.downlink) || null;
  let preferred;
  if (dl == null) preferred = '1080p';
  else if (dl >= 25) preferred = '2160p';
  else if (dl >= 5)  preferred = '1080p';
  else if (dl >= 2)  preferred = '720p';
  else               preferred = '480p';

  const have = new Set(qualityOptions.map((q) => q.label));
  const startIdx = RES_ORDER.indexOf(preferred);
  // Walk down from `preferred` toward lower resolutions; return first match.
  for (let i = Math.max(0, startIdx); i < RES_ORDER.length; i++) {
    if (have.has(RES_ORDER[i])) return RES_ORDER[i];
  }
  // Nothing at-or-below preferred — fall back to the highest available.
  for (let i = 0; i < RES_ORDER.length; i++) {
    if (have.has(RES_ORDER[i])) return RES_ORDER[i];
  }
  return qualityOptions[0].label;
};

export default function HlsVideo({
  src,
  poster,
  className = '',
  onReady,
  onFatal,
  autoPlay = true,
  qualityLabel = 'Source · 1080p',
  // ── Multi-quality picker (Phase B) ────────────────────────────
  // qualityOptions: [{ label, streamUrl, sizeBytes, filename }] — when
  // present and non-empty, the settings menu shows an Auto row + one row
  // per option. Picking a row calls onQualityChange(label, streamUrl);
  // the parent updates its `src` prop, which this component swaps in-place
  // while preserving the current playback position + play state. When
  // null/empty, the legacy "Source · 1080p" single-quality block renders.
  qualityOptions = null,
  onQualityChange = null,
  // Real-world seconds the current HLS session was spawned at (via
  // ffmpeg `-ss`). 0 = fresh playback. > 0 = Continue Watching resume
  // OR a mid-playback quality swap that minted a fresh session at the
  // user's previous real-world position. The component renders the
  // time/scrubber/saved-progress in REAL coordinates by adding this
  // offset to the <video>'s native currentTime + duration.
  sessionStartOffset = 0,
  // ── Source duration (FIXED denominator) ──────────────────────
  // sourceDuration: float seconds, probed from the source file via
  // ffprobe at session creation. When present, this is used as the FIXED
  // total for time display + scrubber + progress tracking so the
  // denominator doesn't appear to "grow" as the HLS transcoder writes
  // segments on demand. Null if ffprobe failed → fallback to the old
  // growing-duration behavior (video.duration + sessionStartOffset).
  sourceDuration = null,
  // ── Subtitles ────────────────────────────────────────────────
  // subtitleTracks: [{ language, language_name, file_id }]
  // selectedSubtitle: language code ('en', 'es', etc.) or null for off
  // onSubtitleChange: (language) => void
  // subtitlesLoading: boolean - whether subtitles are being fetched
  // subtitlesError: string | null - error message if subtitle fetch failed
  subtitleTracks = null,
  selectedSubtitle = null,
  onSubtitleChange = null,
  subtitlesLoading = false,
  subtitlesError = null,
  // ── Continue Watching metadata ───────────────────────────────
  mediaType = null,
  tmdbId = null,
  season = null,
  episode = null,
  title = null,
  posterPath = null,
  backdropPath = null,
}) {
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const progressRef = useRef(null);
  const volumeRef = useRef(null);
  const hlsRef = useRef(null);

  // ── Latest-callback refs (so the hls effect doesn't re-run on parent re-render)
  const onReadyRef = useRef(onReady);
  const onFatalRef = useRef(onFatal);
  const onQualityChangeRef = useRef(onQualityChange);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { onFatalRef.current = onFatal; }, [onFatal]);
  useEffect(() => { onQualityChangeRef.current = onQualityChange; }, [onQualityChange]);

  // ── Quality swap state ───────────────────────────────────────
  // pendingSeekRef:  pre-swap currentTime captured in the hls-effect cleanup
  //                  before video.load() resets it to 0. Restored on the
  //                  next loadedmetadata.
  // pendingPlayRef:  whether playback was active pre-swap (so we resume).
  // prevSrcRef:      previous src value, to distinguish first-mount from
  //                  an in-place swap.
  // swapStartRef:    {label, prevUrl, prevLabel} captured at the moment the
  //                  user clicked a quality row. Presence of this ref at
  //                  the time of an src change is what marks the swap as
  //                  user-initiated (vs parent-initiated, e.g. the
  //                  fatal-fallback alternates rotation in VideoPlayer).
  // switchTimerRef:  10s safety net handle.
  // revertingRef:    set true while the safety-revert is in flight so the
  //                  resulting src change doesn't re-trigger the overlay.
  const pendingSeekRef = useRef(null);
  const pendingPlayRef = useRef(false);
  const prevSrcRef = useRef(null);
  const swapStartRef = useRef(null);
  const switchTimerRef = useRef(null);
  const revertingRef = useRef(false);
  const switchToastTimerRef = useRef(null);

  const [isSwitching, setIsSwitching] = useState(false);
  const [switchTargetLabel, setSwitchTargetLabel] = useState(null);
  const [switchToast, setSwitchToast] = useState(null);

  // ── Player UI state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState('main'); // main | speed | quality
  const [subtitlesOpen, setSubtitlesOpen] = useState(false); // CC popover state
  const [hoverTime, setHoverTime] = useState(null); // {sec, x} | null
  const [isBuffering, setIsBuffering] = useState(false);

  // ── Continue Watching hooks (progress tracking + resume) ─────
  // metadata.sessionStartOffset is read by useProgressTracking when
  // saving — saved values are in REAL coordinates (currentTime + offset).
  // metadata.sourceDuration is the FIXED total duration passed to
  // useProgressTracking so the saved "duration" field doesn't crawl up
  // over the first 1-2 minutes of playback.
  const metadata = useMemo(() => ({
    mediaType,
    tmdbId,
    season,
    episode,
    title,
    episodeTitle: null, // TV episode title not available in current data flow
    posterPath,
    backdropPath,
    sessionStartOffset,
    sourceDuration,
  }), [mediaType, tmdbId, season, episode, title, posterPath, backdropPath, sessionStartOffset, sourceDuration]);

  // Only track progress when we have essential metadata
  const trackingEnabled = !!(mediaType && tmdbId);
  useProgressTracking(videoRef, metadata, trackingEnabled);

  // Local "Resumed from M:SS" toast. With §10's resume-via-`-ss`
  // architecture the player no longer seeks after loadedmetadata —
  // the ffmpeg session itself starts at the resume point — so the
  // toast fires as soon as we know the player has a non-zero offset
  // (i.e., on first loadedmetadata where sessionStartOffset > 0).
  const [resumeToast, setResumeToast] = useState({ show: false, message: '' });
  const resumeToastShownRef = useRef(false);
  const resumeToastTimerRef = useRef(null);

  // Incoming-offset ref: updated synchronously on every render BEFORE
  // any effect cleanup runs. The hls-effect's cleanup closure (which
  // captured the OLD prop value) compares against this current value
  // to detect "the upcoming src swap is also changing the session
  // offset" — in which case position restoration via pendingSeekRef
  // would land the user at the wrong real-world second.
  const incomingOffsetRef = useRef(sessionStartOffset);
  incomingOffsetRef.current = sessionStartOffset;

  // Click flash (kept from prior version)
  const [flash, setFlash] = useState(null);
  const flashTimerRef = useRef(null);
  const triggerFlash = useCallback((kind) => {
    setFlash(kind);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 600);
  }, []);

  const clickTimerRef = useRef(null);
  const hideTimerRef = useRef(null);

  // ─────────────────────────────────────────────────────────
  // Action handlers
  // ─────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().then(() => triggerFlash('play')).catch(() => {});
    } else {
      v.pause();
      triggerFlash('pause');
    }
  }, [triggerFlash]);

  const toggleFullscreen = useCallback(() => {
    const w = wrapRef.current;
    const v = videoRef.current;
    if (!w || !v) return;
    
    // Exit fullscreen (standard + webkit)
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
      return;
    }
    
    // Enter fullscreen with cascading fallback for iOS Safari
    if (w.requestFullscreen) {
      // Standard Fullscreen API — desktop, iPad, Android Chrome
      w.requestFullscreen().catch(() => {});
    } else if (w.webkitRequestFullscreen) {
      // Older Safari (macOS, iPad) — webkit on container
      w.webkitRequestFullscreen();
    } else if (v.webkitEnterFullscreen) {
      // iPhone Safari only — works on <video> element only
      // Note: iOS will show native video player UI in fullscreen
      v.webkitEnterFullscreen();
    } else {
      console.warn('[Player] No fullscreen support detected');
    }
  }, []);

  const togglePiP = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      }
    } catch (_) { /* ignored */ }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, []);

  const setSpeed = useCallback((r) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = r;
    setPlaybackRate(r);
  }, []);

  const seekTo = useCallback((sec) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, sec));
  }, []);

  // ─────────────────────────────────────────────────────────
  // Click / double-click on the video picture
  // ─────────────────────────────────────────────────────────
  const handleVideoClick = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      toggleFullscreen();
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, 230);
  }, [togglePlay, toggleFullscreen]);

  // ─────────────────────────────────────────────────────────
  // Keyboard shortcuts (wrapper must be focused/hovered)
  // ─────────────────────────────────────────────────────────
  const handleKey = useCallback((e) => {
    const v = videoRef.current;
    if (!v) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.code) {
      case 'Space':
      case 'KeyK':
        e.preventDefault(); togglePlay(); break;
      case 'ArrowRight':
        e.preventDefault(); seekTo(v.currentTime + 5); break;
      case 'ArrowLeft':
        e.preventDefault(); seekTo(v.currentTime - 5); break;
      case 'ArrowUp':
        e.preventDefault();
        v.volume = Math.min(1, v.volume + 0.05); v.muted = false; break;
      case 'ArrowDown':
        e.preventDefault();
        v.volume = Math.max(0, v.volume - 0.05); break;
      case 'KeyF':
        e.preventDefault(); toggleFullscreen(); break;
      case 'KeyM':
        e.preventDefault(); toggleMute(); break;
      case 'KeyP':
        e.preventDefault(); togglePiP(); break;
      default: break;
    }
  }, [togglePlay, toggleFullscreen, toggleMute, togglePiP, seekTo]);

  // ─────────────────────────────────────────────────────────
  // Scrub bar — pointer events with drag support
  //
  // All scrubber math operates in REAL-WORLD coordinates: the bar
  // represents [0, effectiveTotalDuration] where effectiveTotalDuration
  // is sourceDuration (if available) or (video.duration + sessionStartOffset)
  // as a fallback. The `<video>`'s currentTime is session-relative
  // (0 = first segment, which sits at real-world second `sessionStartOffset`),
  // so we add the offset when displaying and subtract it before setting
  // currentTime.
  //
  // Cross-offset-boundary seek (user drags BEFORE `sessionStartOffset`)
  // is not yet supported — we'd need to mint a fresh session at the
  // earlier real-world position. For now we clamp to the offset; the
  // scrubber refuses to go further left. TODO: cross-boundary seek.
  // ─────────────────────────────────────────────────────────
  const computeBarSeek = useCallback((clientX) => {
    const el = progressRef.current;
    const v = videoRef.current;
    if (!el || !v) return 0;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    // Use sourceDuration as denominator when available; else fall back
    // to the session duration + offset (old growing behavior).
    const totalDur = sourceDuration && sourceDuration > 0
      ? sourceDuration
      : (isFinite(v.duration) && v.duration > 0 ? v.duration : 0) + (sessionStartOffset || 0);
    return pct * totalDur;        // REAL-world target time in seconds
  }, [sessionStartOffset, sourceDuration]);

  const onProgressMove = useCallback((e) => {
    const t = computeBarSeek(e.clientX);
    const rect = progressRef.current.getBoundingClientRect();
    setHoverTime({ sec: t, x: e.clientX - rect.left });
  }, [computeBarSeek]);

  const onProgressLeave = useCallback(() => setHoverTime(null), []);

  const seekToReal = useCallback((realSec) => {
    const v = videoRef.current;
    if (!v) return;
    const off = sessionStartOffset || 0;
    if (realSec < off) {
      // Below current session's start — clamp. TODO: mint a new session
      // at `realSec` to enable backward cross-boundary scrubbing.
      seekTo(0);
      return;
    }
    seekTo(realSec - off);
  }, [seekTo, sessionStartOffset]);

  const onProgressPointerDown = useCallback((e) => {
    e.preventDefault();
    const t = computeBarSeek(e.clientX);
    seekToReal(t);
    // Drag-to-scrub: capture pointer and keep updating as user moves.
    const id = e.pointerId;
    progressRef.current?.setPointerCapture?.(id);
    const move = (ev) => seekToReal(computeBarSeek(ev.clientX));
    const up = (ev) => {
      progressRef.current?.removeEventListener?.('pointermove', move);
      progressRef.current?.removeEventListener?.('pointerup', up);
      progressRef.current?.removeEventListener?.('pointercancel', up);
      try { progressRef.current?.releasePointerCapture?.(id); } catch (_) {}
    };
    progressRef.current?.addEventListener?.('pointermove', move);
    progressRef.current?.addEventListener?.('pointerup', up);
    progressRef.current?.addEventListener?.('pointercancel', up);
  }, [computeBarSeek, seekToReal]);

  // ─────────────────────────────────────────────────────────
  // Volume slider — same drag pattern, simpler
  // ─────────────────────────────────────────────────────────
  const onVolumePointerDown = useCallback((e) => {
    e.preventDefault();
    const apply = (clientX) => {
      const el = volumeRef.current;
      const v = videoRef.current;
      if (!el || !v) return;
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      v.volume = pct;
      v.muted = pct === 0;
    };
    apply(e.clientX);
    const id = e.pointerId;
    volumeRef.current?.setPointerCapture?.(id);
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      volumeRef.current?.removeEventListener?.('pointermove', move);
      volumeRef.current?.removeEventListener?.('pointerup', up);
      try { volumeRef.current?.releasePointerCapture?.(id); } catch (_) {}
    };
    volumeRef.current?.addEventListener?.('pointermove', move);
    volumeRef.current?.addEventListener?.('pointerup', up);
  }, []);

  // ─────────────────────────────────────────────────────────
  // Auto-hide controls during playback (mouse-inactive 2.5s)
  // ─────────────────────────────────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      // Only hide while playing AND no submenu open AND not hovering bar.
      if (videoRef.current && !videoRef.current.paused) setControlsVisible(false);
    }, 2500);
  }, []);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
  }, []);

  // ─────────────────────────────────────────────────────────
  // Sync UI state from <video> events
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onPlay = () => { setIsPlaying(true); showControls(); };
    const onPause = () => { setIsPlaying(false); setControlsVisible(true); };
    const onTimeUpdate = () => setCurrentTime(v.currentTime || 0);
    const onDurationChange = () => setDuration(v.duration || 0);
    // loadedmetadata = new source is fully parsed, duration is known, and
    // we can safely seek. This is also where we close the "Switching to X…"
    // overlay (if any) and restore the pre-swap playback position +
    // play state captured by the hls-effect's cleanup.
    const onLoadedMetadata = () => {
      setDuration(v.duration || 0);
      const seek = pendingSeekRef.current;
      const wasPlaying = pendingPlayRef.current;
      pendingSeekRef.current = null;
      pendingPlayRef.current = false;
      if (seek != null && seek > 0.5 && isFinite(v.duration) && v.duration > 0) {
        try {
          v.currentTime = Math.min(seek, Math.max(0, v.duration - 0.5));
        } catch (_) {}
        if (wasPlaying) {
          v.play().catch(() => {});
        }
      }
      // Swap completed before the 10s safety net fired — clear it.
      if (switchTimerRef.current) {
        clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }
      setIsSwitching(false);
      setSwitchTargetLabel(null);

      // Resume toast — "Resumed from M:SS" fired once per mount when the
      // session was spawned with a non-zero startOffset (Continue Watching
      // resume baked into ffmpeg via `-ss`). No client-side seek is needed
      // because the playlist's first segment IS the resume point.
      if (
        !resumeToastShownRef.current
        && sessionStartOffset > 0
      ) {
        resumeToastShownRef.current = true;
        const mins = Math.floor(sessionStartOffset / 60);
        const secs = Math.floor(sessionStartOffset % 60);
        setResumeToast({
          show: true,
          message: `Resumed from ${mins}:${secs.toString().padStart(2, '0')}`,
        });
        if (resumeToastTimerRef.current) clearTimeout(resumeToastTimerRef.current);
        resumeToastTimerRef.current = setTimeout(() => {
          setResumeToast((p) => ({ ...p, show: false }));
        }, 3000);
      }
    };
    const onVolumeChange = () => { setVolume(v.volume); setMuted(v.muted); };
    const onRateChange = () => setPlaybackRate(v.playbackRate);
    const onProgress = () => {
      try {
        const last = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        setBufferedEnd(last);
      } catch (_) {}
    };
    const onWaiting = () => setIsBuffering(true);
    const onPlayingEv = () => setIsBuffering(false);
    const onCanPlay = () => setIsBuffering(false);
    const onEnterPip = () => setIsPiP(true);
    const onLeavePip = () => setIsPiP(false);

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('durationchange', onDurationChange);
    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('volumechange', onVolumeChange);
    v.addEventListener('ratechange', onRateChange);
    v.addEventListener('progress', onProgress);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlayingEv);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('enterpictureinpicture', onEnterPip);
    v.addEventListener('leavepictureinpicture', onLeavePip);

    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('durationchange', onDurationChange);
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('volumechange', onVolumeChange);
      v.removeEventListener('ratechange', onRateChange);
      v.removeEventListener('progress', onProgress);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlayingEv);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('enterpictureinpicture', onEnterPip);
      v.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, [showControls]);

  // Fullscreen state sync (changes can come from F11, ESC, native button…)
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // ─────────────────────────────────────────────────────────
  // Subtitle track management
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !v.textTracks) return;

    // Wait for track to be added to DOM before setting mode
    const timer = setTimeout(() => {
      for (let i = 0; i < v.textTracks.length; i++) {
        const track = v.textTracks[i];
        if (selectedSubtitle && track.language === selectedSubtitle) {
          track.mode = 'showing';
          console.log(`[Subtitles] Enabled track: ${track.language} (${track.label})`);
        } else {
          track.mode = 'disabled';
        }
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [selectedSubtitle]);

  // ─────────────────────────────────────────────────────────
  // Quality swap detection — runs whenever the `src` prop changes.
  // Three cases to handle:
  //   1. First mount: prevSrcRef is null → nothing to do, just remember src.
  //   2. User-initiated swap: handlePickQuality set swapStartRef before
  //      calling onQualityChange. We show the "Switching to X…" overlay
  //      and start a 10s safety timer that reverts via onQualityChange.
  //   3. Parent-initiated swap (e.g., VideoPlayer's fatal-fallback rotates
  //      to an alternate): swapStartRef is null. Show the overlay but
  //      DON'T arm the safety revert — the parent owns that flow.
  //   4. Safety-revert in flight: revertingRef short-circuits the overlay
  //      so the user sees only the toast, not "Switching… Switching…".
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (prevSrcRef.current && prevSrcRef.current !== src) {
      if (revertingRef.current) {
        revertingRef.current = false;
        prevSrcRef.current = src;
        return;
      }
      setIsSwitching(true);
      const pending = swapStartRef.current;
      swapStartRef.current = null;
      if (pending) {
        // User-initiated. Arm 10s safety net.
        if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
        switchTimerRef.current = setTimeout(() => {
          switchTimerRef.current = null;
          // Failure path: revert via parent, hide overlay, surface toast.
          setIsSwitching(false);
          setSwitchTargetLabel(null);
          const failedLabel = pending.label || 'new quality';
          const prevLabel = pending.prevLabel || 'current quality';
          showSwitchToast(`Couldn't switch to ${failedLabel} — staying on ${prevLabel}.`);
          if (pending.prevUrl && onQualityChangeRef.current) {
            revertingRef.current = true;
            // Revert path: pass a minimal target (no directUrl) and
            // realTime=null so the parent treats it as an in-place swap
            // (no new-session creation, no offset change). HlsVideo's
            // pendingSeekRef restores the user to where they were.
            onQualityChangeRef.current(pending.prevLabel, { streamUrl: pending.prevUrl }, null);
          }
        }, SWITCH_TIMEOUT_MS);
      } else {
        // Parent-initiated swap (no target label known to us). The overlay
        // still helps because the user is staring at a blank black square
        // for a few seconds while ffmpeg cold-starts on the new source.
        setSwitchTargetLabel(null);
      }
    }
    prevSrcRef.current = src;
  }, [src]);

  // Unmount-time cleanup for switch-related timers (the loadedmetadata
  // handler clears the safety timer on success; this catches teardown).
  useEffect(() => () => {
    if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    if (switchToastTimerRef.current) clearTimeout(switchToastTimerRef.current);
    if (resumeToastTimerRef.current) clearTimeout(resumeToastTimerRef.current);
  }, []);

  // ─────────────────────────────────────────────────────────
  // Derived quality-menu state — fully derived from props + src so we
  // can't drift out of sync with the parent's source-of-truth.
  // ─────────────────────────────────────────────────────────
  const activeQualityLabel = useMemo(() => {
    if (!qualityOptions || !qualityOptions.length) return null;
    const match = qualityOptions.find((q) => q.streamUrl === src);
    // src isn't in our option list ⇒ user is on the resolver's primary
    // (or an unlisted alternate). Display "Auto" as the active selection.
    return match ? match.label : 'Auto';
  }, [qualityOptions, src]);

  const autoTargetLabel = useMemo(
    () => pickAutoQualityLabel(qualityOptions),
    [qualityOptions],
  );

  // Briefly show a toast (auto-dismiss after 4s).
  const showSwitchToast = useCallback((msg) => {
    setSwitchToast(msg);
    if (switchToastTimerRef.current) clearTimeout(switchToastTimerRef.current);
    switchToastTimerRef.current = setTimeout(() => {
      setSwitchToast(null);
      switchToastTimerRef.current = null;
    }, 4000);
  }, []);

  // User clicked a row in the Quality submenu. Computes the target URL,
  // stashes pre-swap state for revert, closes the menu, and asks the
  // parent to swap `src`. The actual swap is observed by the src-change
  // effect above.
  const handlePickQuality = useCallback((label) => {
    if (!qualityOptions || !qualityOptions.length) return;
    let target;
    if (label === 'Auto') {
      const autoLabel = pickAutoQualityLabel(qualityOptions);
      target = qualityOptions.find((q) => q.label === autoLabel);
      if (!target) return;
    } else {
      target = qualityOptions.find((q) => q.label === label);
      if (!target) return;
    }
    setSettingsOpen(false);
    if (target.streamUrl === src) return; // no-op pick — already on this
    swapStartRef.current = {
      label,                       // what the user clicked (incl. 'Auto')
      prevUrl: src,                // for revert on safety-timer fire
      prevLabel: activeQualityLabel,
    };
    setSwitchTargetLabel(label === 'Auto' ? `Auto · ${target.label}` : label);
    // Real-world second the viewer is currently at — used by the parent
    // to mint a brand-new HLS session that starts exactly there. Null if
    // we can't read the <video> (rare) or the resolver didn't expose a
    // directUrl for this option (legacy); the parent falls back to the
    // pre-built streamUrl in those cases.
    const v = videoRef.current;
    const realTime = v && target.directUrl
      ? (v.currentTime || 0) + (sessionStartOffset || 0)
      : null;
    if (onQualityChangeRef.current) {
      onQualityChangeRef.current(label, target, realTime);
    }
  }, [qualityOptions, src, activeQualityLabel, sessionStartOffset]);

  // ─────────────────────────────────────────────────────────
  // hls.js lifecycle (UNCHANGED — playback engine)
  // ─────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let disposed = false;
    let hls = null;
    let detachNative = null;

    const attachNative = () => {
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

    (async () => {
      try {
        const HlsMod = await import('hls.js');
        const Hls = HlsMod.default;
        if (disposed) return;

        if (Hls && Hls.isSupported()) {
          hls = new Hls({
            // Three magic settings — DO NOT REMOVE — see HANDOFF.md §4.4.
            startPosition: 0,
            liveSyncDurationCount: 0,
            liveMaxLatencyDurationCount: Infinity,
            lowLatencyMode: false,
            maxBufferLength: 60,
            maxMaxBufferLength: 600,
            manifestLoadingTimeOut: 20000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 1000,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
          });
          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (autoPlay) video.play().catch(() => {});
            onReadyRef.current?.();
          });
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (!data.fatal) return;
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                try { hls.startLoad(); return; } catch (_) {}
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                try { hls.recoverMediaError(); return; } catch (_) {}
                break;
              default: break;
            }
            if (!disposed) onFatalRef.current?.(new Error(`${data.type}/${data.details}`));
          });

          hls.attachMedia(video);
          hls.loadSource(src);
          return;
        }
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          detachNative = attachNative();
          return;
        }
        onFatalRef.current?.(new Error('HLS not supported in this browser'));
      } catch (e) {
        if (disposed) return;
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          detachNative = attachNative();
        } else {
          onFatalRef.current?.(e);
        }
      }
    })();

    return () => {
      disposed = true;
      // ── Capture playback position BEFORE we destroy the player ────
      // video.load() (a few lines down) resets currentTime to 0, so if we
      // want to restore it on the next mount (e.g., a quality swap that
      // keeps the SAME session offset) we must snapshot it first.
      // pendingSeekRef is read by the loadedmetadata handler once the new
      // source is ready.
      //
      // Special case: when the upcoming render also changes
      // `sessionStartOffset` (because the parent minted a brand-new HLS
      // session at a different real-world second — see
      // VideoPlayer.onQualityChange's POST /api/stream/hls/session), the
      // new session's `currentTime = 0` ALREADY corresponds to the
      // target real-world second. Restoring the OLD session's
      // `currentTime` would drop the user 30-60 minutes ahead of where
      // they actually are. We detect this by comparing the cleanup's
      // closed-over `sessionStartOffset` (the OLD prop) against
      // `incomingOffsetRef.current` (updated synchronously during the
      // NEW render). If they differ, skip the restore.
      try {
        const v = videoRef.current;
        if (v) {
          const offsetWillChange = incomingOffsetRef.current !== sessionStartOffset;
          if (offsetWillChange) {
            pendingSeekRef.current = null;        // fresh session at new position
            pendingPlayRef.current = !v.paused;   // preserve play/pause
          } else {
            pendingSeekRef.current = v.currentTime || 0;
            pendingPlayRef.current = !v.paused;
          }
        }
      } catch (_) {}
      if (hls) { try { hls.destroy(); } catch (_) {} hlsRef.current = null; }
      if (detachNative) detachNative();
      try { video.removeAttribute('src'); video.load(); } catch (_) {}
    };
  }, [src, autoPlay, sessionStartOffset]);

  // ─────────────────────────────────────────────────────────
  // Derived render values
  // ─────────────────────────────────────────────────────────
  const playedPct = useMemo(() => {
    const off = sessionStartOffset || 0;
    const realTime = currentTime + off;
    // Use sourceDuration as denominator when available; fallback to
    // video.duration + offset (old growing behavior). Gracefully handle
    // null/0/undefined sourceDuration with no NaN or Infinity in display.
    const totalDur = sourceDuration && sourceDuration > 0
      ? sourceDuration
      : (duration > 0 ? duration : 0) + off;
    if (totalDur <= 0) return 0;
    return Math.min(100, (realTime / totalDur) * 100);
  }, [currentTime, duration, sessionStartOffset, sourceDuration]);

  const bufferedPct = useMemo(() => {
    const off = sessionStartOffset || 0;
    const totalDur = sourceDuration && sourceDuration > 0
      ? sourceDuration
      : (duration > 0 ? duration : 0) + off;
    if (totalDur <= 0) return 0;
    return Math.min(100, ((bufferedEnd + off) / totalDur) * 100);
  }, [bufferedEnd, duration, sessionStartOffset, sourceDuration]);

  const VolIcon = muted || volume === 0 ? VolumeX : (volume < 0.5 ? Volume1 : Volume2);

  // True when ANY player menu (CC popover, Settings tree) is open. Used to:
  //  - keep controls visible (effectiveVisible)
  //  - hold off the mouse-leave auto-hide
  //  - render the tap-capture backdrop that closes the menu without
  //    also toggling play/pause on the same tap
  const anyMenuOpen = settingsOpen || subtitlesOpen;
  const closeAllMenus = useCallback(() => {
    setSettingsOpen(false);
    setSubtitlesOpen(false);
  }, []);

  // Keep controls visible while a menu is open
  const effectiveVisible = controlsVisible || !isPlaying || anyMenuOpen;

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={handleKey}
      onMouseMove={showControls}
      onMouseLeave={() => { if (isPlaying && !anyMenuOpen) setControlsVisible(false); }}
      className={`relative outline-none select-none group ${className}`}
      style={{ touchAction: 'none' }}
    >
      {/* The <video> itself. controls={false} — we provide our own. */}
      <video
        ref={videoRef}
        playsInline
        crossOrigin="anonymous"
        poster={poster || undefined}
        onClick={handleVideoClick}
        className="w-full h-full object-contain bg-black"
        style={{ cursor: effectiveVisible ? 'pointer' : 'none' }}
      >
        {/* Subtitle track - only render the selected one */}
        {selectedSubtitle && subtitleTracks && subtitleTracks.length > 0 && (() => {
          const track = subtitleTracks.find(t => t.language === selectedSubtitle);
          if (!track) return null;
          // Subtitle cue times are absolute against the SOURCE file (real
          // world). When the current HLS session was spawned with a
          // non-zero `sessionStartOffset`, the <video>'s currentTime is
          // session-relative, so we must shift the cues by -offset on the
          // server before delivery so they line up with what the user
          // actually sees. /api/subtitles/download honours `?offset=`.
          const offsetParam = (sessionStartOffset || 0) > 0
            ? `&offset=${sessionStartOffset}`
            : '';
          return (
            <track
              // Re-create the track when offset changes so the cues are
              // re-fetched with the new shift applied.
              key={`${track.file_id}-${sessionStartOffset || 0}`}
              kind="subtitles"
              srcLang={track.language}
              label={track.language_name || track.language}
              src={`/api/subtitles/download?file_id=${track.file_id}${offsetParam}`}
              default
            />
          );
        })()}
      </video>

      {/* Center play/pause flash on click toggle */}
      {flash && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <div className="rounded-full bg-black/60 backdrop-blur-md p-5 shadow-2xl streamix-flash">
            {flash === 'play'
              ? <Play size={48} className="text-white fill-white" />
              : <Pause size={48} className="text-white fill-white" />}
          </div>
        </div>
      )}

      {/* Buffering spinner */}
      {isBuffering && isPlaying && !isSwitching && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <Loader2 size={56} className="text-white/90 animate-spin drop-shadow-2xl" />
        </div>
      )}

      {/* Quality-swap overlay — shown while a src swap is in flight.
          Suppresses the buffering spinner (above) to avoid double-spinners.
          Cleared by onLoadedMetadata once the new source is parsed, or by
          the 10s safety net if metadata never arrives. */}
      {isSwitching && (
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center z-20 bg-black/50 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-5 py-3 rounded-lg bg-black/80 border border-white/10 text-white shadow-2xl">
            <Loader2 size={22} className="animate-spin text-amber-300" />
            <span className="text-sm font-medium">
              {switchTargetLabel
                ? `Switching to ${switchTargetLabel}…`
                : 'Switching source…'}
            </span>
          </div>
        </div>
      )}

      {/* Brief switch-failed toast (4s auto-dismiss) */}
      {switchToast && (
        <div
          role="status"
          className="absolute top-3 left-1/2 -translate-x-1/2 z-30 max-w-[90%] px-3 py-2 rounded-md bg-amber-900/85 backdrop-blur border border-amber-700/40 text-amber-100 text-xs shadow-lg"
        >
          {switchToast}
        </div>
      )}

      {/* Resume toast — "Resumed from M:SS" (3s auto-dismiss) */}
      {resumeToast.show && (
        <div
          role="status"
          className="absolute top-3 left-1/2 -translate-x-1/2 z-30 max-w-[90%] px-4 py-2 rounded-md bg-green-900/90 backdrop-blur border border-green-700/50 text-green-100 text-sm font-medium shadow-lg flex items-center gap-2"
        >
          <Play size={14} className="fill-green-300 text-green-300" />
          {resumeToast.message}
        </div>
      )}

      {/* Big center play button while paused at start */}
      {!isPlaying && currentTime === 0 && (
        <button
          aria-label="Play"
          onClick={togglePlay}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
        >
          <div className="rounded-full bg-white/90 hover:bg-white p-6 shadow-2xl transition-transform hover:scale-110">
            <Play size={48} className="text-black fill-black ml-1" />
          </div>
        </button>
      )}

      {/* ─── Tap-capture backdrop while a menu is open ───
          Sits above the <video> (which has the click→play handler) but
          below the controls overlay + popovers. Catches taps anywhere on
          the player surface, closes the menu, and stops propagation so
          play/pause doesn't fire on the same gesture. */}
      {anyMenuOpen && (
        <div
          aria-hidden
          onClick={(e) => { e.stopPropagation(); closeAllMenus(); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute inset-0 z-[15]"
        />
      )}

      {/* ─── Controls overlay ─── */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 transition-opacity duration-300 ${
          effectiveVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Gradient backdrop */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/90 via-black/60 to-transparent" />

        <div className="relative px-4 pb-3 pt-10">
          {/* Scrub bar */}
          <div
            ref={progressRef}
            className="relative h-1.5 hover:h-2.5 transition-all bg-white/20 rounded-full cursor-pointer group/bar"
            onPointerDown={onProgressPointerDown}
            onMouseMove={onProgressMove}
            onMouseLeave={onProgressLeave}
          >
            {/* Buffered */}
            <div
              className="absolute inset-y-0 left-0 bg-white/35 rounded-full"
              style={{ width: `${bufferedPct}%` }}
            />
            {/* Played */}
            <div
              className="absolute inset-y-0 left-0 bg-yellow-400 rounded-full"
              style={{ width: `${playedPct}%` }}
            />
            {/* Scrub handle */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-yellow-400 rounded-full opacity-0 group-hover/bar:opacity-100 transition-opacity shadow-lg"
              style={{ left: `${playedPct}%` }}
            />
            {/* Hover-time tooltip */}
            {hoverTime != null && (
              <div
                className="absolute -top-9 -translate-x-1/2 px-2 py-1 rounded text-xs font-mono bg-black/90 text-white whitespace-nowrap shadow-lg"
                style={{ left: `${hoverTime.x}px` }}
              >
                {formatTime(hoverTime.sec)}
              </div>
            )}
          </div>

          {/* Buttons row */}
          <div className="flex items-center gap-1 sm:gap-3 mt-2 text-white">
            <button
              aria-label={isPlaying ? 'Pause' : 'Play'}
              onClick={togglePlay}
              className="h-11 w-11 sm:h-9 sm:w-9 grid place-items-center rounded hover:bg-white/15 transition-colors"
            >
              {isPlaying
                ? <Pause size={22} className="fill-white" />
                : <Play size={22} className="fill-white" />}
            </button>

            {/* Volume */}
            <div className="flex items-center gap-1.5 group/vol">
              <button
                aria-label={muted ? 'Unmute' : 'Mute'}
                onClick={toggleMute}
                className="h-11 w-11 sm:h-9 sm:w-9 grid place-items-center rounded hover:bg-white/15 transition-colors"
              >
                <VolIcon size={22} />
              </button>
              <div
                ref={volumeRef}
                onPointerDown={onVolumePointerDown}
                className="relative h-1 w-0 group-hover/vol:w-20 transition-all bg-white/20 rounded-full overflow-hidden cursor-pointer"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-white rounded-full"
                  style={{ width: `${(muted ? 0 : volume) * 100}%` }}
                />
              </div>
            </div>

            {/* Time */}
            <div className="text-base sm:text-sm font-mono tabular-nums opacity-90 whitespace-nowrap">
              {formatTime(currentTime + (sessionStartOffset || 0))} <span className="opacity-60">/ {formatTime(
                sourceDuration && sourceDuration > 0
                  ? sourceDuration
                  : (duration > 0 ? duration : 0) + (sessionStartOffset || 0)
              )}</span>
            </div>

            <div className="flex-1" />

            {/* Speed shortcut button (shows current speed) */}
            <button
              onClick={() => { setSettingsOpen(true); setSubtitlesOpen(false); setSettingsView('speed'); }}
              className="h-11 sm:h-9 px-3 sm:px-2 rounded text-sm sm:text-xs font-medium hover:bg-white/15 transition-colors tabular-nums"
              aria-label="Playback speed"
            >
              {playbackRate}×
            </button>

            {/* CC/Subtitles popover - ALWAYS render */}
            <div className="relative">
              <button
                aria-label="Subtitles"
                onClick={() => { setSubtitlesOpen((o) => !o); setSettingsOpen(false); }}
                className={`h-11 w-11 sm:h-9 sm:w-9 grid place-items-center rounded hover:bg-white/15 transition-colors ${
                  selectedSubtitle ? 'bg-amber-500/20 text-amber-300' : 'opacity-60 hover:opacity-100'
                } ${subtitlesLoading ? 'opacity-50' : ''}`}
                disabled={subtitlesLoading}
                title={selectedSubtitle 
                  ? `Subtitles: ${subtitleTracks?.find(t => t.language === selectedSubtitle)?.language_name || selectedSubtitle}` 
                  : 'Subtitles'}
              >
                <CCIcon size={22} />
              </button>
              
              {/* CC Popover */}
              {subtitlesOpen && (
                <div className="absolute bottom-12 right-0 w-56 max-sm:max-w-[calc(100vw-2rem)] max-sm:max-h-[60vh] rounded-lg bg-black/95 backdrop-blur-md text-white shadow-2xl border border-white/10 overflow-hidden">
                  <div className="py-2 max-sm:overflow-y-auto max-sm:max-h-[60vh] overscroll-contain">
                    {/* Loading state */}
                    {subtitlesLoading && (
                      <div className="px-3 py-4 text-center text-sm opacity-60 flex items-center justify-center gap-2">
                        <Loader2 size={16} className="animate-spin" />
                        Loading subtitles...
                      </div>
                    )}
                    
                    {/* Error state */}
                    {!subtitlesLoading && subtitlesError && (
                      <div className="px-3 py-4 text-center text-sm text-yellow-400 leading-snug">
                        {subtitlesError}
                      </div>
                    )}
                    
                    {/* Empty state */}
                    {!subtitlesLoading && !subtitlesError && (!subtitleTracks || subtitleTracks.length === 0) && (
                      <div className="px-3 py-4 text-center text-sm opacity-60">
                        No subtitles available for this title
                      </div>
                    )}
                    
                    {/* Loaded state with options */}
                    {!subtitlesLoading && !subtitlesError && subtitleTracks && subtitleTracks.length > 0 && (
                      <>
                        {/* Off option */}
                        <button
                          onClick={() => { 
                            if (onSubtitleChange) onSubtitleChange(null);
                            setSubtitlesOpen(false);
                          }}
                          className={`flex items-center w-full px-3 py-2 hover:bg-white/10 text-sm ${!selectedSubtitle ? 'bg-white/5' : ''}`}
                        >
                          <span className="w-5">
                            {!selectedSubtitle && <Check size={14} />}
                          </span>
                          <span>Off</span>
                        </button>
                        
                        {/* Language options - sorted by downloads desc */}
                        {[...subtitleTracks]
                          .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
                          .map((track) => (
                            <button
                              key={track.language}
                              onClick={() => { 
                                if (onSubtitleChange) onSubtitleChange(track.language);
                                setSubtitlesOpen(false);
                              }}
                              className={`flex items-center w-full px-3 py-2 hover:bg-white/10 text-sm ${selectedSubtitle === track.language ? 'bg-white/5' : ''}`}
                              title={`${track.downloads.toLocaleString()} downloads`}
                            >
                              <span className="w-5">
                                {selectedSubtitle === track.language && <Check size={14} />}
                              </span>
                              <span className="flex-1 text-left truncate">{track.language_name || track.language}</span>
                            </button>
                          ))}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Settings */}
            <div className="relative">
              <button
                aria-label="Settings"
                onClick={() => { setSettingsOpen((o) => !o); setSubtitlesOpen(false); setSettingsView('main'); }}
                className={`h-11 w-11 sm:h-9 sm:w-9 grid place-items-center rounded hover:bg-white/15 transition-colors ${settingsOpen ? 'bg-white/15' : ''}`}
              >
                <Settings size={22} className={settingsOpen ? 'rotate-45 transition-transform' : 'transition-transform'} />
              </button>
              {settingsOpen && (
                <div className="absolute bottom-12 right-0 w-56 rounded-lg bg-black/95 backdrop-blur-md text-white shadow-2xl border border-white/10 overflow-hidden">
                  {settingsView === 'main' && (
                    <div className="py-1">
                      <button
                        onClick={() => setSettingsView('speed')}
                        className="flex items-center justify-between w-full px-3 py-2 hover:bg-white/10 text-sm"
                      >
                        <span>Playback speed</span>
                        <span className="opacity-60 tabular-nums">{playbackRate}×</span>
                      </button>
                      <button
                        onClick={() => setSettingsView('quality')}
                        className="flex items-center justify-between w-full px-3 py-2 hover:bg-white/10 text-sm"
                      >
                        <span>Quality</span>
                        <span className="opacity-60 text-xs truncate max-w-[140px]">
                          {qualityOptions && qualityOptions.length > 0
                            ? (activeQualityLabel === 'Auto'
                                ? (autoTargetLabel ? `Auto · ${autoTargetLabel}` : 'Auto')
                                : activeQualityLabel)
                            : qualityLabel}
                        </span>
                      </button>
                    </div>
                  )}
                  {settingsView === 'speed' && (
                    <div className="py-1">
                      <button
                        onClick={() => setSettingsView('main')}
                        className="w-full px-3 py-2 text-xs opacity-60 hover:opacity-100 text-left"
                      >
                        ← Back
                      </button>
                      {SPEEDS.map((s) => (
                        <button
                          key={s}
                          onClick={() => { setSpeed(s); setSettingsOpen(false); }}
                          className={`flex items-center w-full px-3 py-2 hover:bg-white/10 text-sm tabular-nums ${playbackRate === s ? 'bg-white/5' : ''}`}
                        >
                          <span className="w-5">
                            {playbackRate === s && <Check size={14} />}
                          </span>
                          <span>{s === 1 ? 'Normal' : `${s}×`}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {settingsView === 'quality' && (
                    <div className="py-1">
                      <button
                        onClick={() => setSettingsView('main')}
                        className="w-full px-3 py-2 text-xs opacity-60 hover:opacity-100 text-left"
                      >
                        ← Back
                      </button>
                      {qualityOptions && qualityOptions.length > 0 ? (
                        <>
                          {/* Auto row */}
                          <button
                            onClick={() => handlePickQuality('Auto')}
                            className={`flex items-center w-full px-3 py-2 hover:bg-white/10 text-sm ${activeQualityLabel === 'Auto' ? 'bg-white/5' : ''}`}
                          >
                            <span className="w-5">
                              {activeQualityLabel === 'Auto' && <Check size={14} />}
                            </span>
                            <span className="flex-1 text-left">Auto</span>
                            <span className="opacity-60 text-[11px]">
                              {autoTargetLabel || ''}
                            </span>
                          </button>
                          {/* Resolution rows */}
                          {qualityOptions.map((q) => (
                            <button
                              key={q.label}
                              onClick={() => handlePickQuality(q.label)}
                              className={`flex items-center w-full px-3 py-2 hover:bg-white/10 text-sm ${activeQualityLabel === q.label ? 'bg-white/5' : ''}`}
                              title={q.filename || ''}
                            >
                              <span className="w-5">
                                {activeQualityLabel === q.label && <Check size={14} />}
                              </span>
                              <span className="flex-1 text-left">{q.label}</span>
                            </button>
                          ))}
                        </>
                      ) : (
                        <>
                          <div className="px-3 py-2 text-sm flex items-center">
                            <Check size={14} className="mr-2" />
                            {qualityLabel}
                          </div>
                          <div className="px-3 pb-2 pt-1 text-[11px] opacity-50 leading-snug">
                            Multi-bitrate switching not available — this stream is transcoded on-the-fly at a single quality.
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* PiP — hidden on phones (no multi-window value, saves space) */}
            <button
              aria-label="Picture-in-picture"
              onClick={togglePiP}
              className={`hidden sm:grid sm:h-9 sm:w-9 place-items-center rounded hover:bg-white/15 transition-colors ${isPiP ? 'bg-white/15' : ''}`}
            >
              <PictureInPicture2 size={22} />
            </button>

            {/* Fullscreen */}
            <button
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              onClick={toggleFullscreen}
              className="h-11 w-11 sm:h-9 sm:w-9 grid place-items-center rounded hover:bg-white/15 transition-colors"
            >
              {isFullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        .streamix-flash {
          animation: streamix-fade-flash 600ms ease-out forwards;
        }
        @keyframes streamix-fade-flash {
          0%   { opacity: 0; transform: scale(0.6); }
          25%  { opacity: 1; transform: scale(1.0); }
          100% { opacity: 0; transform: scale(1.4); }
        }
      `}</style>
    </div>
  );
}
