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
console.log(`[HLS] ffmpeg=${FFMPEG} ffprobe=${FFPROBE}`);

// process-wide singleton map (this module is loaded once per Node process)
const sessions = globalThis.__streamixHlsSessions ||
  (globalThis.__streamixHlsSessions = new Map());

// Best-effort root-dir bootstrap
try { fs.mkdirSync(HLS_ROOT, { recursive: true }); } catch (_) {}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function probeCodecs(url, timeoutMs = 10000) {
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

        resolve({
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
        });
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

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // Real-Debrid likes a real-ish UA on its CDN
    '-user_agent', 'Streamix/1.0 (+ffmpeg HLS)',
    // Robust network reads
    '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];

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

export function createSession(sourceUrl, meta = {}, startOffset = 0) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(HLS_ROOT, id);
  const normalizedOffset = Math.max(0, Number(startOffset) || 0);
  const sess = {
    id,
    sourceUrl,
    dir,
    meta,                  // { filename, sizeBytes, quality } for diagnostics
    startOffset: normalizedOffset,  // seconds — passed to ffmpeg as `-ss` before `-i`
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
  console.log(`[HLS] createSession ${id} startOffset=${normalizedOffset} src=${sourceUrl.slice(0, 80)}`);
  return sess;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function touchSession(id) {
  const s = sessions.get(id);
  if (s) s.lastAccess = Date.now();
}

export async function ensureFfmpeg(session) {
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
      console.log(
        `[HLS] ${session.id} audio: idx=${codecs.selectedAudioIndex} ` +
        `lang=${codecs.selectedAudioLanguage} (${codecs.selectedAudioReason}) ` +
        `of ${codecs.audioStreams.length} tracks [${summary}]`
      );
    } else {
      console.log(`[HLS] ${session.id} audio: no audio streams detected`);
    }

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
    const ok = await waitForPlaylist(playlistPath);
    if (!ok) {
      session.error = `ffmpeg did not produce playlist in ${READY_TIMEOUT_MS}ms. last stderr: ${stderrBuf.slice(-500)}`;
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
