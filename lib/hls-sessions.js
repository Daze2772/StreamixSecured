/**
 * HLS Session Manager
 * ===================
 * Spawns one ffmpeg process per playback session. Each session converts a
 * Real-Debrid (or other) URL into an HLS playlist + .ts segments on disk,
 * which our /api/stream/hls/[sessionId]/[file] route then serves.
 *
 * Why this design:
 *   - Browser-universal: HLS is supported in every browser via hls.js,
 *     and natively in Safari. No codec roulette.
 *   - Transcode-on-demand: we use `ffprobe` to inspect the source, then
 *     either `-c copy` it (lossless remux, ~5% CPU) if it's already a
 *     browser-friendly profile, or transcode video to H.264 baseline (the
 *     universal fallback). Audio is always coerced to AAC.
 *   - Stateful but cheap: a single in-memory Map holds each session's
 *     ffmpeg process + temp dir. Sessions auto-clean after `IDLE_TTL_MS`
 *     of no segment requests.
 *
 * Session lifecycle:
 *   1. resolver creates a session with createSession(rdUrl, filename)
 *   2. browser GETs /api/stream/hls/<id>/master.m3u8 → first hit triggers
 *      ensureFfmpeg() which probes codecs + spawns ffmpeg writing into
 *      `<HLS_ROOT>/<id>/`
 *   3. browser GETs /api/stream/hls/<id>/<segment>.ts → served from disk
 *   4. inactivity → killSession() kills ffmpeg and rms the temp dir
 *
 * Concurrency note: ffmpeg uses ~50–100% of one CPU core for video
 * transcode, ~5% for remux. We have 8 cores so several concurrent sessions
 * are fine. Beyond that we'd need a queue / load-shed strategy.
 */

import { spawn, spawnSync } from 'child_process';
import { promises as fsp } from 'fs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const HLS_ROOT = path.join(os.tmpdir(), 'streamix-hls');
const IDLE_TTL_MS = 5 * 60 * 1000;     // kill session after 5 min idle
const READY_TIMEOUT_MS = 30 * 1000;    // wait up to 30 s for first segment

// Codecs that the browser <video> can play natively when delivered via HLS.
// Anything outside this set will trigger a transcode.
const BROWSER_FRIENDLY_VIDEO = new Set(['h264']);
const BROWSER_FRIENDLY_AUDIO = new Set(['aac', 'mp3']);

// ── ffmpeg binary discovery ─────────────────────────────────────────
// In some hosting environments the container's apt-installed ffmpeg gets
// wiped on restart. We look in PATH first, then a persistent fallback at
// /app/bin, and finally try to install it via apt if it's missing.
function findFfmpegBin() {
  const tries = ['ffmpeg', '/usr/bin/ffmpeg', '/app/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const p of tries) {
    try {
      const r = spawnSync(p, ['-version'], { stdio: 'ignore' });
      if (r.status === 0) return p;
    } catch (_) { /* keep trying */ }
  }
  // Try one-shot apt install
  try {
    console.log('[HLS] ffmpeg missing — attempting apt-get install…');
    spawnSync('apt-get', ['install', '-y', 'ffmpeg'], { stdio: 'ignore' });
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    if (r.status === 0) return 'ffmpeg';
  } catch (_) {}
  return null;
}
let FFMPEG = globalThis.__streamixFfmpegBin || findFfmpegBin();
globalThis.__streamixFfmpegBin = FFMPEG;
const FFPROBE = FFMPEG ? FFMPEG.replace(/ffmpeg$/, 'ffprobe') : null;

// Detect ffmpeg version once at startup. We need to know if the host has
// ffmpeg ≥ 5.1 because that's when the `hevc_metadata` bsf gained the
// `remove_dovi_rpu` option (used below to strip Dolby Vision NAL units
// from HEVC sources). On older ffmpeg builds we fall back to plain
// `-err_detect ignore_err` which is usually enough but less robust.
function detectFfmpegFeatures(bin) {
  if (!bin) return { hasRemoveDoviRpu: false, version: null };
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/ffmpeg version (\S+)/i);
    const ver = m ? m[1] : null;
    // Parse "5.1.4-0ubuntu1" / "n6.0" / "git" → major.minor
    const num = ver ? ver.replace(/^n/, '').match(/^(\d+)\.(\d+)/) : null;
    const major = num ? parseInt(num[1], 10) : 0;
    const minor = num ? parseInt(num[2], 10) : 0;
    const hasRemoveDoviRpu = (major > 5) || (major === 5 && minor >= 1);
    return { hasRemoveDoviRpu, version: ver };
  } catch (_) {
    return { hasRemoveDoviRpu: false, version: null };
  }
}
const FFMPEG_FEATURES = globalThis.__streamixFfmpegFeatures ||
  (globalThis.__streamixFfmpegFeatures = detectFfmpegFeatures(FFMPEG));
console.log(`[HLS] ffmpeg=${FFMPEG} ffprobe=${FFPROBE} version=${FFMPEG_FEATURES.version || 'unknown'} dovi-rpu-strip=${FFMPEG_FEATURES.hasRemoveDoviRpu}`);

// process-wide singleton map (this module is loaded once per Node process)
const sessions = globalThis.__streamixHlsSessions ||
  (globalThis.__streamixHlsSessions = new Map());

// ── Source-URL probe cache ───────────────────────────────────────────
// ffprobe on a premium backend CDN URL (with the deep analyze settings we
// pass in probeCodecs) takes 5–15s because it has to download enough
// bytes to enumerate audio streams. The resolver ALREADY probes each
// source once at session creation, but mid-playback audio / quality
// switches re-spawn a session for the same source — without this cache
// each switch repeats the slow probe.
//
// Keyed by sourceUrl (the premium playback URL). TTL = 30 min — long
// enough for a single watch session, short enough that stale URLs
// (which expire) eventually evict.
//
// LRU eviction: Cap at 500 entries to prevent unbounded memory growth.
const PROBE_CACHE_TTL_MS = 30 * 60 * 1000;
const PROBE_CACHE_MAX_SIZE = 500;
const sourceProbeCache = globalThis.__streamixProbeCache ||
  (globalThis.__streamixProbeCache = new Map());

function getCachedProbeInternal(sourceUrl) {
  if (!sourceUrl) return null;
  const entry = sourceProbeCache.get(sourceUrl);
  if (!entry) return null;
  if (Date.now() - entry.ts > PROBE_CACHE_TTL_MS) {
    sourceProbeCache.delete(sourceUrl);
    return null;
  }
  // LRU: Move to end (most recently used)
  sourceProbeCache.delete(sourceUrl);
  sourceProbeCache.set(sourceUrl, entry);
  return entry.codecs;
}

function setCachedProbe(sourceUrl, codecs) {
  if (!sourceUrl || !codecs) return;
  
  // LRU eviction: if cache is full, remove oldest entry (first in Map)
  if (sourceProbeCache.size >= PROBE_CACHE_MAX_SIZE) {
    const oldestKey = sourceProbeCache.keys().next().value;
    sourceProbeCache.delete(oldestKey);
  }
  
  sourceProbeCache.set(sourceUrl, { codecs, ts: Date.now() });
}

/** Public accessor — used by /api/stream/hls/session/route.js to take
 *  the fast path on audio/quality switches without awaiting ffmpeg. */
export function getCachedProbe(sourceUrl) {
  return getCachedProbeInternal(sourceUrl);
}

/**
 * Probe a source URL without spawning ffmpeg.
 *
 * Used by the resolver to fetch duration + audio metadata for the response
 * payload WITHOUT committing to a full ffmpeg session startup. This is
 * critical for problematic sources (DOVI HEVC, weird codecs) where the
 * ffmpeg startup probe can take 10+ seconds — when called via
 * `ensureFfmpeg(session, 5000)` and it times out, ffmpeg gets SIGKILL'd
 * AND the session's startupPromise gets cached as rejected, so the
 * subsequent browser playlist GET can never recover.
 *
 * With this approach, the resolver gets duration via ffprobe (fast, never
 * spawns ffmpeg), and ffmpeg starts lazily on the first /index.m3u8 GET
 * with the full 30s timeout window.
 *
 * Returns the same shape as probeCodecs(), or null on failure.
 */
export async function probeSourceOnly(sourceUrl, timeoutMs = 12000) {
  return probeCodecs(sourceUrl, timeoutMs);
}

// Best-effort root-dir bootstrap
try { fs.mkdirSync(HLS_ROOT, { recursive: true }); } catch (_) {}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function probeCodecs(url, timeoutMs = 10000) {
  // Cache lookup — Real-Debrid CDN probes are slow (5-15s on RD/Comet URLs
  // due to -analyzeduration + -probesize), and audio/quality switches mid-
  // playback hit this function repeatedly with the SAME sourceUrl. The
  // cache shaves ~5-15s off every switch after the resolver's initial probe.
  const cached = getCachedProbeInternal(url);
  if (cached) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve) => {
    if (!FFPROBE) return resolve(null);
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      // -show_format adds container-level metadata to the JSON output,
      // most importantly `format.duration` — the source file's total
      // runtime in seconds. We use it to give the frontend a FIXED
      // denominator for the time display + scrubber (otherwise the HLS
      // transcoder's growing playlist makes video.duration crawl up over
      // the first 1-2 min of playback and the displayed total appears
      // to expand mid-watch).
      '-show_format',
      '-analyzeduration', '5000000',
      '-probesize', '5000000',
      url,
    ];
    const ff = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch(_) {} }, timeoutMs);
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.on('exit', () => {
      clearTimeout(to);
      try {
        const j = JSON.parse(out);
        const allStreams = j.streams || [];
        const v = allStreams.find((s) => s.codec_type === 'video');

        // Enumerate every audio stream in source order. The position in this
        // filtered list is exactly what ffmpeg's `-map 0:a:N` syntax expects
        // (N counts audio streams, not absolute stream indexes).
        const audioStreams = allStreams
          .filter((s) => s.codec_type === 'audio')
          .map((s, i) => ({
            audioIndex: i,
            codec: s.codec_name,
            profile: s.profile,
            channels: s.channels,
            language: (s.tags?.language || '').toLowerCase() || null,
            title: s.tags?.title || null,
          }));

        // English-first selection (handles "eng" 3-letter and "en" 2-letter tags).
        const englishAudio = audioStreams.find(
          (a) => a.language === 'eng' || a.language === 'en'
        );
        const chosenAudio = englishAudio || audioStreams[0] || null;

        const codecsResult = {
          video: v ? { codec: v.codec_name, profile: v.profile, pix_fmt: v.pix_fmt } : null,
          // `audio` reflects the CHOSEN stream so canCopyAudio in
          // chooseFfmpegArgs evaluates compat against the right codec/channels.
          audio: chosenAudio
            ? { codec: chosenAudio.codec, profile: chosenAudio.profile, channels: chosenAudio.channels }
            : null,
          audioStreams,                                   // full list for diagnostics
          selectedAudioIndex: chosenAudio?.audioIndex ?? 0,
          selectedAudioLanguage: chosenAudio?.language || (audioStreams.length ? 'unknown' : null),
          selectedAudioReason: englishAudio ? 'eng-tag' : (audioStreams.length ? 'fallback-first' : 'none'),
          duration: parseFloat(j.format?.duration || '0') || null,
        };
        // Populate cache so the next audio/quality switch on the same
        // sourceUrl skips ffprobe entirely.
        setCachedProbe(url, codecsResult);
        resolve(codecsResult);
      } catch (_) { resolve(null); }
    });
    ff.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

function chooseFfmpegArgs(url, codecs, outDir, startOffset = 0) {
  const segmentPattern = path.join(outDir, 'seg_%05d.ts');
  const playlist = path.join(outDir, 'index.m3u8');

  // Stream-copy is ~20× cheaper than re-encode. We use it when:
  //  - video is h264 with a yuv420p / yuv420p10 pix_fmt AND profile != Hi10p
  //  - (audio compatibility we can always fix with aac re-encode separately)
  const v = codecs?.video;
  const canCopyVideo = v && BROWSER_FRIENDLY_VIDEO.has(v.codec)
    && (v.pix_fmt || '').startsWith('yuv420p')
    && !(v.pix_fmt || '').includes('10le')   // exclude Hi10P
    && !/hi10|high\s*10/i.test(v.profile || '');

  const a = codecs?.audio;
  const canCopyAudio = a && BROWSER_FRIENDLY_AUDIO.has(a.codec) && (a.channels || 2) <= 2;

  // Source is HEVC? Dolby Vision content is almost always HEVC and ships
  // with malformed/proprietary RPU (Reference Picture Unit) NAL units that
  // crash ffmpeg's HEVC parser with "Error parsing DOVI NAL unit / RPU
  // validation failed". We apply two layers of defense:
  //   1) `-err_detect ignore_err` + `-fflags +discardcorrupt` (below) — tells
  //      ffmpeg to keep going on parse errors instead of aborting.
  //   2) Input-side bitstream filter `hevc_metadata=remove_dovi_rpu=1`
  //      (added below for HEVC sources) — strips DOVI RPU NAL units before
  //      the parser sees them. Requires ffmpeg ≥ 5.1.
  const isHevc = v?.codec === 'hevc' || v?.codec === 'h265';

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // Real-Debrid likes a real-ish UA on its CDN
    '-user_agent', 'Streamix/1.0 (+ffmpeg HLS)',
    // Robust network reads
    '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    // ─── Error tolerance ────────────────────────────────────────
    // Many torrent rips have malformed packets, especially Dolby Vision
    // (DOVI) HEVC sources. Without these flags ffmpeg aborts on the first
    // bad NAL unit (e.g., "Error parsing DOVI NAL unit / RPU validation
    // failed") and our session dies before producing a playlist.
    //
    //   -err_detect ignore_err  → don't abort on decode errors
    //   -fflags +discardcorrupt → drop corrupt packets entirely
    //   -fflags +genpts         → regenerate timestamps when source PTS
    //                             are non-monotonic (also common in DOVI rips)
    '-err_detect', 'ignore_err',
    '-fflags', '+discardcorrupt+genpts+igndts',
  ];

  // ─── DOVI RPU stripping (HEVC sources only) ──────────────────
  // The hevc_metadata bitstream filter (ffmpeg 5.1+) can remove Dolby
  // Vision RPU NAL units before the decoder sees them. Applied as an
  // INPUT-side bsf so it runs during demux, not after re-encode. On
  // older ffmpeg builds we just rely on -err_detect ignore_err above.
  if (isHevc && FFMPEG_FEATURES.hasRemoveDoviRpu) {
    args.push('-bsf:v', 'hevc_metadata=remove_dovi_rpu=1');
  }

  // ─── Resume offset (Continue Watching) ───────────────────────
  // When startOffset > 0, we ask ffmpeg to seek the INPUT to that timestamp
  // before any demuxing. `-ss` BEFORE `-i` is the input-side seek — fast
  // and reasonably accurate on streamable inputs (RD/HTTP). The resulting
  // playlist's segment 00000 corresponds to real-world `startOffset`
  // seconds in the source file. Crucially: this MUST go before -i;
  // putting it after -i would re-encode-and-discard everything before
  // startOffset (slow, defeats the purpose). All audio-mapping / codec
  // selection below is unchanged and still applies AFTER -i.
  if (startOffset > 0) {
    args.push('-ss', String(startOffset));
  }

  args.push(
    '-i', url,
    // Explicit stream selection — ffmpeg's default audio picker tends to
    // grab the first / loudest track, which for multi-audio releases
    // ("Dual Audio English Hindi", "[Ukr.Eng]") is frequently NOT English.
    // probeCodecs() already chose the right audio index (eng-tagged when
    // available, else first audio). The `?` makes each map optional so
    // an audio-less or video-less source still spawns rather than fails.
    '-map', '0:v:0?',
    '-map', `0:a:${codecs?.selectedAudioIndex ?? 0}?`,
  );

  // Video
  if (canCopyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-level', '4.0',
      '-pix_fmt', 'yuv420p',
      '-crf', '22',
      '-maxrate', '6000k', '-bufsize', '8000k',
      '-g', '96',         // keyframe every ~4s @ 24fps for clean HLS cuts
      '-sc_threshold', '0',
    );
  }

  // Audio
  if (canCopyAudio) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '160k');
  }

  // HLS muxer.
  // We use playlist_type 'event' from ffmpeg (forces incremental writes).
  // Our route handler then REWRITES the playlist on-the-fly to
  // `#EXT-X-PLAYLIST-TYPE:VOD` (and adds `#EXT-X-ENDLIST` once ffmpeg
  // finishes) before serving to hls.js. This gets us the best of both:
  //   - incremental playlist writes (event semantics on disk)
  //   - VOD playback in the browser (no auto-seek to "live edge", which
  //     was making the player jump 30 minutes ahead as ffmpeg encoded).
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segmentPattern,
    '-hls_flags', 'independent_segments',
    '-start_number', '0',
    playlist,
  );

  return { args, copyMode: canCopyVideo && canCopyAudio };
}

async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch (_) {}
}

function waitForPlaylist(playlistPath, timeoutMs = READY_TIMEOUT_MS, minSegments = 1) {
  // ffmpeg writes the playlist + first segment(s) after a few seconds of
  // ingestion. We poll until both exist and the playlist references ≥
  // `minSegments` segments. Returns ok=true/false.
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const txt = await fsp.readFile(playlistPath, 'utf8');
        const segs = (txt.match(/seg_\d+\.ts/g) || []).length;
        if (segs >= minSegments && /#EXTINF/.test(txt)) {
          return resolve(true);
        }
      } catch (_) { /* not ready yet */ }
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

// ─────────────────────────────────────────────────────────────────────
// public API
// ─────────────────────────────────────────────────────────────────────

export function createSession(sourceUrl, meta = {}, startOffset = 0, audioIndex = null) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(HLS_ROOT, id);
  const normalizedOffset = Math.max(0, Number(startOffset) || 0);
  const normalizedAudioIndex = typeof audioIndex === 'number' && audioIndex >= 0 
    ? Math.floor(audioIndex) 
    : null;
  const sess = {
    id,
    sourceUrl,
    dir,
    meta,                  // { filename, sizeBytes, quality } for diagnostics
    startOffset: normalizedOffset,  // seconds — passed to ffmpeg as `-ss` before `-i`
    requestedAudioIndex: normalizedAudioIndex,  // user-requested audio track override (or null = auto-detect English)
    ffmpeg: null,
    ffmpegStartedAt: null,
    ready: false,
    error: null,
    copyMode: null,
    lastAccess: Date.now(),
    // pending startup promise so concurrent requests don't double-spawn
    startupPromise: null,
  };
  sessions.set(id, sess);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[HLS] createSession ${id} startOffset=${normalizedOffset} audioIndex=${normalizedAudioIndex ?? 'auto'} src=${sourceUrl.slice(0, 80)}`);
  return sess;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function touchSession(id) {
  const s = sessions.get(id);
  if (s) s.lastAccess = Date.now();
}

export async function ensureFfmpeg(session, timeoutMs = READY_TIMEOUT_MS) {
  // If we already started, just return the same promise.
  if (session.startupPromise) return session.startupPromise;

  session.startupPromise = (async () => {
    // 1) probe codecs (so we know if we can stream-copy)
    const codecs = await probeCodecs(session.sourceUrl);
    console.log(`[HLS] ${session.id} probed:`, codecs);

    // Audio selection summary — one-line so it's easy to grep.
    // Shape: [HLS] <id> audio: idx=N lang=eng (eng-tag) of M tracks [eng@0 hin@1 ...]
    if (codecs?.audioStreams?.length) {
      const summary = codecs.audioStreams
        .map((a) => `${a.language || '??'}@${a.audioIndex}`)
        .join(' ');
      
      // Phase 2: Override audio selection if requestedAudioIndex is valid
      if (
        session.requestedAudioIndex !== null &&
        session.requestedAudioIndex < codecs.audioStreams.length
      ) {
        codecs.selectedAudioIndex = session.requestedAudioIndex;
        const chosenStream = codecs.audioStreams[session.requestedAudioIndex];
        codecs.selectedAudioLanguage = chosenStream?.language || 'unknown';
        codecs.selectedAudioReason = 'user-override';
        codecs.audio = chosenStream
          ? { codec: chosenStream.codec, profile: chosenStream.profile, channels: chosenStream.channels }
          : codecs.audio;
      }
      
      console.log(
        `[HLS] ${session.id} audio: idx=${codecs.selectedAudioIndex} ` +
        `lang=${codecs.selectedAudioLanguage} (${codecs.selectedAudioReason}) ` +
        `of ${codecs.audioStreams.length} tracks [${summary}]`
      );
    } else {
      console.log(`[HLS] ${session.id} audio: no audio streams detected`);
    }

    // Store audio metadata on session for API responses
    session.audioStreams = codecs?.audioStreams || [];
    session.selectedAudioIndex = codecs?.selectedAudioIndex ?? 0;

    // 2) store source duration (for fixed-denominator time display)
    session.sourceDuration = codecs?.duration || null;
    if (session.sourceDuration) {
      console.log(`[HLS] ${session.id} source duration: ${session.sourceDuration}s`);
    } else {
      console.log(`[HLS] ${session.id} source duration: unavailable (ffprobe failed)`);
    }

    // 3) build ffmpeg args
    const { args, copyMode } = chooseFfmpegArgs(session.sourceUrl, codecs, session.dir, session.startOffset || 0);
    session.copyMode = copyMode;
    session.codecs = codecs;
    console.log(`[HLS] ${session.id} spawning ffmpeg (copyMode=${copyMode})`);

    // 4) spawn ffmpeg
    if (!FFMPEG) {
      throw new Error('ffmpeg binary not found on host');
    }
    console.log(`[HLS] ${session.id} ffmpeg ARGS:`, JSON.stringify(args));
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    session.ffmpeg = proc;
    session.ffmpegStartedAt = Date.now();

    let stderrBuf = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderrBuf += s;
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      // log only if it smells like an error
      if (/error|invalid|failed|cannot|unable/i.test(s)) {
        console.log(`[HLS] ${session.id} ffmpeg:`, s.trim().slice(0, 200));
      }
    });
    proc.on('exit', (code, sig) => {
      session.ffmpegExited = { code, sig, at: Date.now() };
      console.log(`[HLS] ${session.id} ffmpeg exited code=${code} sig=${sig}`);
    });
    proc.on('error', (e) => {
      session.error = `ffmpeg spawn error: ${e.message}`;
      console.log(`[HLS] ${session.id} ffmpeg error:`, e.message);
    });

    // 4) wait for the first segment to appear (playlist + ≥1 .ts file)
    const playlistPath = path.join(session.dir, 'index.m3u8');
    const ok = await waitForPlaylist(playlistPath, timeoutMs);
    if (!ok) {
      session.error = `ffmpeg did not produce playlist in ${timeoutMs}ms. last stderr: ${stderrBuf.slice(-500)}`;
      console.log(`[HLS] ${session.id} READY TIMEOUT. stderr tail:`, stderrBuf.slice(-500));
      try { proc.kill('SIGKILL'); } catch (_) {}
      throw new Error(session.error);
    }
    session.ready = true;
    console.log(`[HLS] ${session.id} READY in ${Date.now() - session.ffmpegStartedAt}ms`);
    return session;
  })();
  return session.startupPromise;
}

export async function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  console.log(`[HLS] killSession ${id}`);
  try { s.ffmpeg?.kill('SIGKILL'); } catch (_) {}
  await rmrf(s.dir);
  sessions.delete(id);
}

// idle-session reaper
if (!globalThis.__streamixHlsReaper) {
  globalThis.__streamixHlsReaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions.entries()) {
      if (now - s.lastAccess > IDLE_TTL_MS) {
        killSession(id);
      }
    }
  }, 60 * 1000);
}

export function stats() {
  return {
    count: sessions.size,
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      ready: s.ready,
      copyMode: s.copyMode,
      idleSec: Math.round((Date.now() - s.lastAccess) / 1000),
      error: s.error,
    })),
  };
}

/**
 * Get count of active sessions (for rate limiting / capacity management)
 */
export function getActiveSessionCount() {
  return sessions.size;
}

// ── Process cleanup on shutdown ──────────────────────────────────────
// Kill all active ffmpeg processes when the Node process exits to prevent
// orphaned processes eating CPU after server restart
if (!globalThis.__streamixProcessCleanupInstalled) {
  globalThis.__streamixProcessCleanupInstalled = true;

  const cleanupAll = () => {
    console.log('[HLS] Shutting down — killing all active ffmpeg processes...');
    for (const [id, session] of sessions.entries()) {
      try {
        if (session.ffmpeg && !session.ffmpeg.killed) {
          session.ffmpeg.kill('SIGKILL');
        }
      } catch (e) {
        console.warn(`[HLS] Failed to kill session ${id}:`, e.message);
      }
    }
    sessions.clear();
  };

  process.on('SIGTERM', cleanupAll);
  process.on('SIGINT', cleanupAll);
  process.on('exit', cleanupAll);

  console.log('[HLS] Process cleanup handlers installed');
}

// ── Background disk cleanup ──────────────────────────────────────────
// Sessions auto-clean their own dirs on idle-TTL kill, but a few edge cases
// can leave orphaned segment directories on disk:
//   • the Node process was SIGKILL'd (no cleanup hook ran)
//   • a session crashed before being registered in the `sessions` Map
//   • the host rebooted and /tmp wasn't wiped
// Without cleanup, /tmp/streamix-hls/ accumulates GBs of stale .ts files
// over a few days of 24/7 use, eventually filling the disk and breaking
// ffmpeg spawn. This sweeper runs every 30 minutes and rms any session
// dir under HLS_ROOT whose mtime is older than 60 minutes AND which is
// NOT currently tracked in the live `sessions` Map.
const DISK_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const DISK_DIR_TTL_MS        = 60 * 60 * 1000; // 1h old → reclaim

async function sweepStaleSessionDirs() {
  let entries;
  try {
    entries = await fsp.readdir(HLS_ROOT, { withFileTypes: true });
  } catch (_) {
    return; // HLS_ROOT doesn't exist yet (no sessions ever) — nothing to do.
  }

  const cutoff = Date.now() - DISK_DIR_TTL_MS;
  let reclaimedBytes = 0;
  let reclaimedDirs  = 0;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dirName = ent.name;

    // Live session? Leave alone.
    if (sessions.has(dirName)) continue;

    const dirPath = path.join(HLS_ROOT, dirName);
    let stat;
    try {
      stat = await fsp.stat(dirPath);
    } catch (_) {
      continue; // raced with another cleaner
    }

    // Skip directories that were touched recently — could be an in-flight
    // session that just hasn't reached the Map yet.
    if (stat.mtimeMs > cutoff) continue;

    // Tally size for logging (best-effort, swallow errors)
    try {
      const files = await fsp.readdir(dirPath);
      for (const f of files) {
        try {
          const s = await fsp.stat(path.join(dirPath, f));
          reclaimedBytes += s.size || 0;
        } catch (_) {}
      }
    } catch (_) {}

    try {
      await rmrf(dirPath);
      reclaimedDirs += 1;
    } catch (e) {
      console.warn(`[HLS] disk sweep failed to remove ${dirPath}: ${e.message}`);
    }
  }

  if (reclaimedDirs > 0) {
    const mb = (reclaimedBytes / (1024 * 1024)).toFixed(1);
    console.log(
      `[HLS] disk sweep reclaimed ${reclaimedDirs} stale session dir(s), ` +
      `~${mb} MB`,
    );
  }
}

if (!globalThis.__streamixDiskSweeper) {
  // Run once on startup (skip first 30s so the server isn't doing housekeeping
  // during the cold-start window), then every DISK_SWEEP_INTERVAL_MS.
  setTimeout(() => {
    sweepStaleSessionDirs().catch((e) =>
      console.warn(`[HLS] initial disk sweep failed: ${e?.message}`),
    );
  }, 30 * 1000);

  globalThis.__streamixDiskSweeper = setInterval(() => {
    sweepStaleSessionDirs().catch((e) =>
      console.warn(`[HLS] disk sweep failed: ${e?.message}`),
    );
  }, DISK_SWEEP_INTERVAL_MS);

  console.log(
    `[HLS] Disk sweeper installed ` +
    `(interval=${DISK_SWEEP_INTERVAL_MS / 60000}min, ttl=${DISK_DIR_TTL_MS / 60000}min)`,
  );
}

