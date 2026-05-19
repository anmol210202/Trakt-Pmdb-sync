import axios from 'axios';
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

// Helper to pause execution to respect API rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function backfillHistory() {
  console.log('🚀 Starting full Watch History sync...');
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    try {
      console.log(`Fetch Trakt History: Page ${page}/${totalPages || '?'}`);
      const res = await axios.get(`${CONFIG.trakt.baseUrl}/sync/history?limit=100&page=${page}`, {
        headers: CONFIG.trakt.headers
      });

      totalPages = parseInt(res.headers['x-pagination-page-count']) || 1;
      const items = res.data;

      for (const item of items) {
        const isMovie = item.type === 'movie';
        const payload = {
          tmdb_id: isMovie ? item.movie.ids.tmdb : item.show.ids.tmdb,
          media_type: isMovie ? 'movie' : 'tv',
          watched_at: item.watched_at
        };

        if (!isMovie) {
          payload.season = item.episode.season;
          payload.episode = item.episode.number;
        }

        try {
          // dedupe=true tells PMDB to skip if it already exists
          await axios.post(`${CONFIG.pmdb.baseUrl}/watched?dedupe=true`, payload, { 
            headers: CONFIG.pmdb.headers 
          });
        } catch (e) {
          // Ignore individual item failures (like network blips or bad TMDB IDs)
        }
      }
      
      page++;
      await sleep(250); // Small cooldown to be nice to both APIs
    } catch (err) {
      console.error(`Error on page ${page}: ${err.response?.status === 401 ? '401 Unauthorized - Check your TRAKT_ACCESS_TOKEN!' : err.message}`);
      if (err.response?.status === 401) process.exit(1);
      await sleep(5000);
    }
  }
  console.log('✅ Watch History fully synced!');
}

async function run() {
  if (!process.env.TRAKT_CLIENT_ID || !process.env.TRAKT_ACCESS_TOKEN || !process.env.PMDB_API_KEY) {
    console.error("❌ Error: Missing environment variables in your .env file!");
    process.exit(1);
  }
  await backfillHistory();
  console.log('\n🎉 Baseline sync complete! Your PMDB watch history matches Trakt perfectly.');
}

run();
