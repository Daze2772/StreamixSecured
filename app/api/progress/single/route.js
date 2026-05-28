import { NextResponse } from 'next/server';
import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.MONGO_URL;

let cachedClient = null;

async function getDb() {
  if (!cachedClient) {
    cachedClient = await MongoClient.connect(MONGO_URL);
  }
  return cachedClient.db(process.env.DB_NAME || 'streamix');
}

/**
 * GET /api/progress/single?clientId=xxx&mediaType=...&tmdbId=...&season=...&episode=...
 * 
 * Returns the specific progress entry for a given title, or null if not found.
 * Used for resume-on-load functionality.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get('clientId');
    const mediaType = searchParams.get('mediaType');
    const tmdbId = searchParams.get('tmdbId');
    const season = searchParams.get('season');
    const episode = searchParams.get('episode');

    if (!clientId || !mediaType || !tmdbId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const db = await getDb();
    const collection = db.collection('watch_progress');

    const filter = {
      clientId,
      mediaType,
      tmdbId: parseInt(tmdbId, 10),
      season: season ? parseInt(season, 10) : null,
      episode: episode ? parseInt(episode, 10) : null,
    };

    const item = await collection.findOne(filter);

    return NextResponse.json({ item });
  } catch (error) {
    console.error('[Progress] GET single error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
