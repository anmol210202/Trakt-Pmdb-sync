import axios from 'axios';
import pRetry from 'p-retry';
import 'dotenv/config';

const CONFIG = {
  trakt: {
    baseUrl: 'https://api.trakt.tv',
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': process.env.TRAKT_CLIENT_ID,
      'Authorization': `Bearer ${process.env.TRAKT_ACCESS_TOKEN}`,
    }
  },
  pmdb: {
    baseUrl: 'https://publicmetadb.com/api/external',
    headers: {
      'Authorization': `Bearer ${process.env.PMDB_API_KEY}`,
      'Content-Type': 'application/json'
    }
  }
};

// 1. Smart Network Helper (Handles 429 Rate Limits automatically)
const requestWithRetry = async (config) => {
  return pRetry(async () => {
    try {
      return await axios(config);
    } catch (error) {
      if (error.response?.status === 429) {
        const wait = parseInt(error.response.headers['retry-after'] || '5', 10);
        console.warn(`⏳ Rate limit hit. Pausing for ${wait} seconds...`);
        await new Promise(res => setTimeout(res, wait * 1000));
        throw new Error('Rate Limited - Retrying');
      }
      throw error;
    }
  }, { retries: 3 });
};

// 2. Fetch Master State from Trakt
async function getTraktHistory() {
  console.log('📡 Fetching Master State from Trakt...');
  let page = 1;
  let totalPages = 1;
  const history = new Map();

  while (page <= totalPages) {
    const res = await requestWithRetry({
      method: 'get',
      url: `${CONFIG.trakt.baseUrl}/sync/history?limit=100&page=${page}`,
      headers: CONFIG.trakt.headers
    });
    
    if (page === 1) totalPages = parseInt(res.headers['x-pagination-page-count'] || 1);
    
    for (const item of res.data) {
      const isMovie = item.type === 'movie';
      const tmdb_id = isMovie ? item.movie.ids.tmdb : item.show.ids.tmdb;
      
      // Create a unique hash for exact matching (e.g., "movie_123_2026-05-19T...Z")
      const uniqueKey = isMovie 
        ? `movie_${tmdb_id}_${item.watched_at}` 
        : `tv_${tmdb_id}_s${item.episode.season}e${item.episode.number}_${item.watched_at}`;

      history.set(uniqueKey, {
        tmdb_id: tmdb_id,
        media_type: isMovie ? 'movie' : 'tv',
        season: !isMovie ? item.episode.season : undefined,
        episode: !isMovie ? item.episode.number : undefined,
        watched_at: item.watched_at
      });
    }
    page++;
  }
  return history;
}

// 3. Fetch Current State from PMDB
async function getPMDBHistory() {
  console.log('📡 Fetching Current State from PMDB...');
  // Note: Adjust this URL if PMDB uses a different endpoint for fetching history
  const res = await requestWithRetry({
    method: 'get',
    url: `${CONFIG.pmdb.baseUrl}/watched`, 
    headers: CONFIG.pmdb.headers
  });

  const history = new Map();
  for (const item of res.data) {
    const uniqueKey = item.media_type === 'movie'
      ? `movie_${item.tmdb_id}_${item.watched_at}`
      : `tv_${item.tmdb_id}_s${item.season}e${item.episode}_${item.watched_at}`;
    
    history.set(uniqueKey, item);
  }
  return history;
}

// 4. Calculate Diff & Sync
async function runExactSync() {
  try {
    const traktMap = await getTraktHistory();
    const pmdbMap = await getPMDBHistory();

    const toAdd = [];
    const toDelete = [];

    // Find Additions
    for (const [key, payload] of traktMap.entries()) {
      if (!pmdbMap.has(key)) toAdd.push(payload);
    }

    // Find Deletions
    for (const [key, pmdbItem] of pmdbMap.entries()) {
      if (!traktMap.has(key)) toDelete.push(pmdbItem);
    }

    console.log(`\n📊 Sync Analysis: ${toAdd.length} to ADD | ${toDelete.length} to DELETE\n`);

    if (toAdd.length === 0 && toDelete.length === 0) {
      console.log('✅ Trakt and PMDB are already perfectly synced.');
      return;
    }

    // Process Additions
    for (const payload of toAdd) {
      await requestWithRetry({
        method: 'post',
        url: `${CONFIG.pmdb.baseUrl}/watched?dedupe=true`,
        headers: CONFIG.pmdb.headers,
        data: payload
      });
    }

    // Process Deletions
    for (const item of toDelete) {
      // Note: Adjust this URL if PMDB uses a different format for deleting an item
      await requestWithRetry({
        method: 'delete',
        url: `${CONFIG.pmdb.baseUrl}/watched`, 
        headers: CONFIG.pmdb.headers,
        data: { tmdb_id: item.tmdb_id, media_type: item.media_type }
      });
    }

    console.log('✅ Exact Sync Complete! PMDB is a perfect mirror of Trakt.');
  } catch (err) {
    console.error('❌ Sync Failed:', err.message);
    process.exit(1);
  }
}

runExactSync();
