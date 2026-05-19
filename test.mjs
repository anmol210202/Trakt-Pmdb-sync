import 'dotenv/config';
import axios from 'axios';

async function testPMDB() {
  console.log('Testing PMDB Read Access...');
  try {
    const res = await axios.get('https://publicmetadb.com/api/external/watched?page=1&perPage=5', {
      headers: {
        'Authorization': `Bearer ${process.env.PMDB_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Trakt-PMDB-Sync/1.0'
      }
    });
    console.log('✅ Success! PMDB returned data.');
    console.log(`Found ${res.data.length} items in the first page.`);
  } catch (err) {
    console.error(`❌ Request Failed: ${err.response?.status} ${err.response?.statusText}`);
    console.error('Error Details:', err.response?.data || err.message);
  }
}

testPMDB();
