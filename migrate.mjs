import axios from 'axios';
import pRetry from 'p-retry';
import cliProgress from 'cli-progress';
import 'dotenv/config';

const CONFIG = {
  trakt: {
    baseUrl: 'https://api.trakt.tv',
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': process.env.TRAKT_CLIENT_ID,
      'Authorization': `Bearer ${process.env.TRAKT_ACCESS_TOKEN}`, // Use the NEW token here
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

const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

// Helper for rate-limited requests
const request = (config) => pRetry(() => axios(config), { 
  retries: 3, 
  onFailedAttempt: error => console.log(`\nAttempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`)
});

async function migrateHistory() {
  console.log('--- Migrating Watch History ---');
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const res = await request({
      method: 'get',
      url: `${CONFIG.trakt.baseUrl}/sync/history?limit=100&page=${page}`,
      headers: CONFIG.trakt.headers
    });

    totalPages = parseInt(res.headers['x-pagination-page-count']);
    if (page === 1) bar.start(parseInt(res.headers['x-pagination-item-count']), 0);

    for (const item of res.data) {
      const type = item.type; // 'movie' or 'episode'
      const payload = {
        tmdb_id: type === 'movie' ? item.movie.ids.tmdb : item.show.ids.tmdb,
        media_type: type === 'movie' ? 'movie' : 'tv',
        watched_at: item.watched_at
      };

      if (type === 'episode') {
        payload.season = item.episode.season;
        payload.episode = item.episode.number;
      }

      try {
        await axios.post(`${CONFIG.pmdb.baseUrl}/watched?dedupe=true`, payload, { headers: CONFIG.pmdb.headers });
      } catch (e) {
        // Silently skip errors (usually 429 or invalid IDs)
      }
      bar.increment();
    }
    page++;
  }
  bar.stop();
}

async function migrateRatings() {
  console.log('\n--- Migrating Ratings ---');
  const res = await request({
    method: 'get',
    url: `${CONFIG.trakt.baseUrl}/sync/ratings`,
    headers: CONFIG.trakt.headers
  });

  bar.start(res.data.length, 0);

  for (const r of res.data) {
    const isEpisode = r.type === 'episode';
    const endpoint = isEpisode ? '/episode-ratings' : '/ratings';
    
    const payload = {
      tmdb_id: isEpisode ? r.show.ids.tmdb : r[r.type].ids.tmdb,
      media_type: r.type === 'movie' ? 'movie' : 'tv',
      score: r.rating * 10, // Trakt is 1-10, PMDB is 0-100
    };

    if (isEpisode) {
      payload.season = r.episode.season;
      payload.episode = r.episode.number;
    }

    try {
      await axios.post(`${CONFIG.pmdb.baseUrl}${endpoint}`, payload, { headers: CONFIG.pmdb.headers });
    } catch (e) {}
    bar.increment();
  }
  bar.stop();
}

async function run() {
  try {
    await migrateHistory();
    await migrateRatings();
    console.log('\nMigration Complete! Check your PublicMetaDB dashboard.');
  } catch (err) {
    console.error('Fatal Migration Error:', err.message);
  }
}

run();
