import axios from 'axios';
import pRetry from 'p-retry';
import 'dotenv/config';

// Use a custom User-Agent so PMDB/Cloudflare doesn't block GitHub Actions as a spam bot
const customUserAgent = 'Trakt-PMDB-Sync/1.0 (GitHub Actions; Node.js)';

const CONFIG = {
  trakt: {
    baseUrl: 'https://api.trakt.tv',
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': process.env.TRAKT_CLIENT_ID,
      'Authorization': `Bearer ${process.env.TRAKT_ACCESS_TOKEN}`,
      'User-Agent': customUserAgent
    }
  },
  pmdb: {
    baseUrl: 'https://publicmetadb.com/api/external',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.PMDB_API_KEY}`,
      'User-Agent': customUserAgent
    }
  }
};

// --- Smart Network Helper ---
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

// --- 1. Fetch Master State from Trakt ---
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
      
      // Hash includes the exact timestamp to track multiple watches of the same movie
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

// --- 2. Fetch Current State from PMDB ---
async function getPMDBHistory() {
  console.log('📡 Fetching Current State from PMDB...');
  let page = 1;
  let hasMore = true;
  const history = new Map();

  while (hasMore) {
    const res = await requestWithRetry({
      method: 'get',
      // Max perPage is 500 according to PMDB docs
      url: `${CONFIG.pmdb.baseUrl}/watched?page=${page}&perPage=500`, 
      headers: CONFIG.pmdb.headers
    });

    const items = res.data;
    if (items.length === 0) {
      hasMore = false;
      break;
    }

    for (const item of items) {
      const uniqueKey = item.media_type === 'movie'
        ? `movie_${item.tmdb_id}_${item.watched_at}`
        : `tv_${item.tmdb_id}_s${item.season}e${item.episode}_${item.watched_at}`;
      
      // Store the PMDB internal ID so we can delete it if necessary
      history.set(uniqueKey, { pmdb_internal_id: item.id });
    }

    // If PMDB returned less than 500 items, we've hit the last page
    if (items.length < 500) hasMore = false;
    page++;
  }
  
  return history;
}

// --- 3. Execute Exact Sync ---
async function runExactSync() {
  try {
    const traktMap = await getTraktHistory();
    const pmdbMap = await getPMDBHistory();

    const toAdd = [];
    const toDelete = [];

    // Find what is in Trakt but missing in PMDB
    for (const [key, payload] of traktMap.entries()) {
      if (!pmdbMap.has(key)) toAdd.push(payload);
    }

    // Find what is in PMDB but missing in Trakt
    for (const [key, pmdbPayload] of pmdbMap.entries()) {
      if (!traktMap.has(key)) toDelete.push(pmdbPayload.pmdb_internal_id);
    }

    console.log(`\n📊 Sync Analysis: ${toAdd.length} to ADD | ${toDelete.length} to DELETE\n`);

    if (toAdd.length === 0 && toDelete.length === 0) {
      console.log('✅ Databases are completely identical. No sync needed.');
      return;
    }

    // 4. Process Additions
    let addedCount = 0;
    for (const payload of toAdd) {
      try {
        await requestWithRetry({
          method: 'post',
          url: `${CONFIG.pmdb.baseUrl}/watched?dedupe=true`,
          headers: CONFIG.pmdb.headers,
          data: payload
        });
        addedCount++;
      } catch (e) {
        // Silently skip individual errors (like missing TMDB IDs)
      }
    }

    // 5. Process Deletions (Uses the precise endpoint from PMDB docs)
    let deletedCount = 0;
    for (const internalId of toDelete) {
      try {
        await requestWithRetry({
          method: 'delete',
          url: `${CONFIG.pmdb.baseUrl}/watched/${internalId}`,
          headers: CONFIG.pmdb.headers
        });
        deletedCount++;
      } catch (e) {}
    }

    console.log(`✅ Exact Sync Complete! Added: ${addedCount} | Deleted: ${deletedCount}`);
  } catch (err) {
    console.error('❌ Sync Failed:', err.message);
    process.exit(1);
  }
}

runExactSync();
