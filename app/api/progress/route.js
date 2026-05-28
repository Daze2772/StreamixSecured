import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL;

let cachedClient = null;

async function getDb() {
  if (!cachedClient) {
    cachedClient = await MongoClient.connect(MONGO_URL);
  }
  return cachedClient.db('streamix');
}

/**
 * POST /api/progress — Upsert watch progress
 * 
 * Body: {
 *   clientId, mediaType, tmdbId, season?, episode?,
 *   position, duration, title, episodeTitle?, posterPath, backdropPath
 * }
 * 
 * SECURITY: Caps progress entries at 100 per clientId to prevent unbounded DB growth
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const {
      clientId, mediaType, tmdbId, season, episode,
      position, duration, title, episodeTitle, posterPath, backdropPath
    } = body;

    if (!clientId || !mediaType || !tmdbId || position == null || duration == null) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const db = await getDb();
    const collection = db.collection('watch_progress');

    // Ensure unique index on (clientId, mediaType, tmdbId, season, episode)
    await collection.createIndex(
      { clientId: 1, mediaType: 1, tmdbId: 1, season: 1, episode: 1 },
      { unique: true }
    );

    // TTL index: auto-delete entries older than 90 days
    await collection.createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: 90 * 24 * 60 * 60 }
    );

    // Compute completed flag
    const completed = duration > 0 ? (position / duration) >= 0.9 : false;

    const filter = {
      clientId,
      mediaType,
      tmdbId,
      season: season ?? null,
      episode: episode ?? null,
    };

    const update = {
      $set: {
        position,
        duration,
        title,
        episodeTitle: episodeTitle ?? null,
        posterPath: posterPath ?? null,
        backdropPath: backdropPath ?? null,
        completed,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        ...filter,
      },
    };

    const result = await collection.findOneAndUpdate(
      filter,
      update,
      { upsert: true, returnDocument: 'after' }
    );

    // ── SECURITY: Cap entries per clientId ────────────────────────────────
    // Prevent unbounded growth: keep only 100 most recent entries per clientId
    const MAX_ENTRIES_PER_CLIENT = 100;
    const count = await collection.countDocuments({ clientId });
    
    if (count > MAX_ENTRIES_PER_CLIENT) {
      // Find oldest entries to delete
      const toDelete = await collection
        .find({ clientId })
        .sort({ updatedAt: 1 })
        .limit(count - MAX_ENTRIES_PER_CLIENT)
        .toArray();
      
      const idsToDelete = toDelete.map((doc) => doc._id);
      if (idsToDelete.length > 0) {
        await collection.deleteMany({ _id: { $in: idsToDelete } });
      }
    }

    return NextResponse.json({ success: true, item: result });
  } catch (error) {
    console.error('[Progress] POST error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * GET /api/progress?clientId=xxx&limit=20 — List in-progress titles
 * 
 * Filters:
 * - clientId matches
 * - completed = false
 * - position > 30 (skip accidental starts)
 * 
 * For TV shows, returns ONE entry per show (most recent episode).
 * Uses aggregation pipeline to group by (mediaType, tmdbId) and pick latest.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get('clientId');
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    if (!clientId) {
      return NextResponse.json({ error: 'clientId required' }, { status: 400 });
    }

    const db = await getDb();
    const collection = db.collection('watch_progress');

    // Aggregation pipeline:
    // 1. Match: clientId, not completed, position > 30
    // 2. Sort: updatedAt desc
    // 3. Group by (mediaType, tmdbId), keep first (most recent)
    // 4. Sort again by updatedAt desc
    // 5. Limit
    const pipeline = [
      {
        $match: {
          clientId,
          completed: false,
          position: { $gt: 30 },
        },
      },
      {
        $sort: { updatedAt: -1 },
      },
      {
        $group: {
          _id: { mediaType: '$mediaType', tmdbId: '$tmdbId' },
          doc: { $first: '$$ROOT' },
        },
      },
      {
        $replaceRoot: { newRoot: '$doc' },
      },
      {
        $sort: { updatedAt: -1 },
      },
      {
        $limit: limit,
      },
    ];

    const items = await collection.aggregate(pipeline).toArray();

    return NextResponse.json({ items });
  } catch (error) {
    console.error('[Progress] GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/progress — Remove title from Continue Watching
 * 
 * Body: { clientId, mediaType, tmdbId, season?, episode? }
 * 
 * If TV and no season/episode → delete ALL episodes of that show for that client
 */
export async function DELETE(request) {
  try {
    const body = await request.json();
    const { clientId, mediaType, tmdbId, season, episode } = body;

    if (!clientId || !mediaType || !tmdbId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const db = await getDb();
    const collection = db.collection('watch_progress');

    let filter = { clientId, mediaType, tmdbId };

    // If TV with specific season/episode, delete only that entry
    if (mediaType === 'tv' && season != null && episode != null) {
      filter.season = season;
      filter.episode = episode;
    }
    // Otherwise (movie or TV without season/episode), delete all matching tmdbId

    const result = await collection.deleteMany(filter);

    return NextResponse.json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('[Progress] DELETE error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
