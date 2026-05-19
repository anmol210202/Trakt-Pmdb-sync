import axios from 'axios';
import 'dotenv/config';

const CLIENT_ID = process.env.TRAKT_CLIENT_ID;

async function getToken() {
  // 1. Get the device code
  const deviceCodeRes = await axios.post('https://api.trakt.tv/oauth/device/code', {
    client_id: CLIENT_ID
  });

  const { device_code, user_code, verification_url, interval, expires_in } = deviceCodeRes.data;

  console.log(`\n1. Go to: ${verification_url}`);
  console.log(`2. Enter this code: ${user_code}\n`);
  console.log(`Waiting for you to authorize... (Expires in ${expires_in}s)`);

  // 2. Poll for the token
  const poll = setInterval(async () => {
    try {
      const tokenRes = await axios.post('https://api.trakt.tv/oauth/device/token', {
        code: device_code,
        client_id: CLIENT_ID,
        client_secret: process.env.TRAKT_ACCESS_TOKEN // This is actually your secret right now
      });

      if (tokenRes.status === 200) {
        clearInterval(poll);
        console.log('\n✅ Success! Copy this Access Token into your .env file:');
        console.log(`\x1b[32m${tokenRes.data.access_token}\x1b[0m\n`);
      }
    } catch (err) {
      if (err.response?.status === 400) {
        // Still pending...
      } else {
        clearInterval(poll);
        console.error('Error polling for token:', err.response?.data || err.message);
      }
    }
  }, interval * 1000);
}

getToken();
