import axios from 'axios';
import pRetry from 'p-retry';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const customUserAgent = 'Trakt-PMDB-Sync/1.0';

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

// HELPER: Normalizes dates to Unix seconds to ignore formatting/millisecond differences
const normalizeDate = (dateStr) => {
  if (!dateStr) return 'unknown';
  return Math.floor(new Date(dateStr).getTime() / 1000);
};

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
    
    const items = Array.isArray(res.data) ? res.data : (res.data.data || res.data.items || []);
    
    for (const item of items) {
      const isMovie = item.type === 'movie';
      const tmdb_id = isMovie ? item.movie.ids.tmdb : item.show.ids.tmdb;
      const timeKey = normalizeDate(item.watched_at);
      
      const uniqueKey = isMovie 
        ? `movie_${tmdb_id}_${timeKey}` 
        : `tv_${tmdb_id}_s${item.episode.season}e${item.episode.number}_${timeKey}`;

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

async function getPMDBHistory() {
  console.log('📡 Fetching Current State from PMDB...');
  let page = 1;
  let hasMore = true;
  const history = new Map();

  while (hasMore) {
    const res = await requestWithRetry({
      method: 'get',
      url: `${CONFIG.pmdb.baseUrl}/watched?page=${page}&perPage=500`, 
      headers: CONFIG.pmdb.headers
    });

    const items = Array.isArray(res.data) ? res.data : (res.data.data || res.data.items || []);
    
    if (items.length === 0) {
      hasMore = false;
      break;
    }

    for (const item of items) {
      const timeKey = normalizeDate(item.watched_at);
      const uniqueKey = item.media_type === 'movie'
        ? `movie_${item.tmdb_id}_${timeKey}`
        : `tv_${item.tmdb_id}_s${item.season}e${item.episode}_${timeKey}`;
      
      history.set(uniqueKey, { pmdb_internal_id: item.id });
    }

    if (items.length < 500) hasMore = false;
    page++;
  }
  
  return history;
}

async function runExactSync() {
  try {
    const traktMap = await getTraktHistory();
    const pmdbMap = await getPMDBHistory();

    const toAdd = [];
    const toDelete = [];

    for (const [key, payload] of traktMap.entries()) {
      if (!pmdbMap.has(key)) toAdd.push(payload);
    }

    for (const [key, pmdbPayload] of pmdbMap.entries()) {
      if (!traktMap.has(key)) toDelete.push(pmdbPayload.pmdb_internal_id);
    }

    console.log(`\n📊 Sync Analysis: ${toAdd.length} to ADD | ${toDelete.length} to DELETE\n`);

    if (toAdd.length === 0 && toDelete.length === 0) {
      console.log('✅ Databases are completely identical. No sync needed.');
      return;
    }

    // Failsafe: Prevent massive deletions if something goes wrong
    if (toDelete.length > 100) {
      console.warn(`⚠️ WARNING: Attempting to delete ${toDelete.length} items. Aborting to protect your PMDB history. If this is expected, temporarily remove this failsafe from the code.`);
      return;
    }

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
      } catch (e) {}
    }

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
