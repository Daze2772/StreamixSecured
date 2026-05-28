/**
 * GET /api/health — Uptime / liveness probe
 * ==========================================
 * Lightweight health endpoint for external uptime monitors
 * (UptimeRobot, BetterUptime, Pingdom, Kubernetes liveness, etc.)
 *
 * Returns HTTP 200 when the process is alive and core deps are reachable.
 * Returns HTTP 503 if any critical dep (MongoDB) is unreachable so monitors
 * can alert. Always responds in < 1s — the Mongo ping uses a short timeout.
 *
 * The response is intentionally minimal and safe to expose publicly:
 *   - No secrets / no API keys leaked
 *   - No client IPs / no user data
 *   - Just process uptime + a coarse "ok"/"degraded" verdict per subsystem
 *
 * Whitelisted in next.config.js CSP / not rate-limited — monitors hit it
 * once a minute.
 */

import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';
import { spawnSync } from 'child_process';
import { getActiveSessionCount } from '@/lib/hls-sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cache the Mongo client across health pings so we don't burn a new socket
// per minute. `serverSelectionTimeoutMS` is kept tight so a dead Mongo
// returns "degraded" in <2s instead of timing out the health check itself.
let cachedClient = null;
async function pingMongo() {
  const start = Date.now();
  try {
    if (!cachedClient) {
      cachedClient = await MongoClient.connect(process.env.MONGO_URL, {
        serverSelectionTimeoutMS: 1500,
        connectTimeoutMS: 1500,
      });
    }
    await cachedClient.db(process.env.DB_NAME || 'streamix').command({ ping: 1 });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, error: e?.message };
  }
}

// Quick ffmpeg presence check — cached for the lifetime of the process
// because the binary doesn't move once the container is up.
let ffmpegStatus = null;
function checkFfmpeg() {
  if (ffmpegStatus) return ffmpegStatus;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 1000 });
    ffmpegStatus = { ok: r.status === 0 };
  } catch (_) {
    ffmpegStatus = { ok: false };
  }
  return ffmpegStatus;
}

export async function GET() {
  const startedAt = Date.now();

  const [mongo, ffmpeg] = await Promise.all([
    pingMongo(),
    Promise.resolve(checkFfmpeg()),
  ]);

  const activeStreams = (() => {
    try { return getActiveSessionCount(); } catch (_) { return null; }
  })();

  const healthy = mongo.ok && ffmpeg.ok;
  const body = {
    status: healthy ? 'ok' : 'degraded',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      mongo,
      ffmpeg,
    },
    streams: {
      active: activeStreams,
    },
    responseMs: Date.now() - startedAt,
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: {
      // Don't let CDNs / browsers cache health responses.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

export async function HEAD() {
  // Some monitors only do HEAD. Run the same checks but return no body.
  const mongo = await pingMongo();
  const ffmpeg = checkFfmpeg();
  const healthy = mongo.ok && ffmpeg.ok;
  return new NextResponse(null, {
    status: healthy ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
