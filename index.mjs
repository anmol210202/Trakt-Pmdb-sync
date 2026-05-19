#!/usr/bin/env node

import { Command } from 'commander';
import Conf from 'conf';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import pRetry from 'p-retry';
import cliProgress from 'cli-progress';

// --- Configuration ---
const config = new Conf({ projectName: 'trakt-to-pmdb' });
const program = new Command();

const TRAKT_CLIENT_ID = 'e1103543415340f7c680625712410e3cfab97e7dea88ed5ae737076b2aa0acae';
const TRAKT_CLIENT_SECRET = '08c5a2d034f5b5c9d25d7813e637d8d8b3c8a614e09542d241885c0599814e24';

const pmdbRequest = (path, data, apiKey) => axios.post(`https://publicmetadb.com/api/external${path}`, data, {
  headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
});

// --- Auth Logic ---
async function login() {
  const { pmdbKey } = await inquirer.prompt([{
    type: 'input',
    name: 'pmdbKey',
    message: 'Enter your PublicMetaDB API Key:',
    validate: (input) => input.startsWith('pm-') ? true : 'Invalid key format. Should start with "pm-"'
  }]);

  const spinner = ora('Initializing Trakt Device Auth...').start();
  
  try {
    const deviceCodeRes = await axios.post('https://api.trakt.tv/oauth/device/code', { client_id: TRAKT_CLIENT_ID });
    const { device_code, user_code, verification_url, interval } = deviceCodeRes.data;

    spinner.stop();
    console.log(chalk.yellow(`\n1. Go to: ${chalk.bold(verification_url)}`));
    console.log(chalk.yellow(`2. Enter code: ${chalk.bold.green(user_code)}\n`));

    const pollSpinner = ora('Waiting for authorization...').start();

    return new Promise((resolve) => {
      const poll = setInterval(async () => {
        try {
          const res = await axios.post('https://api.trakt.tv/oauth/device/token', {
            code: device_code,
            client_id: TRAKT_CLIENT_ID,
            client_secret: TRAKT_CLIENT_SECRET
          });

          if (res.status === 200) {
            clearInterval(poll);
            config.set('trakt_token', res.data.access_token);
            config.set('pmdb_key', pmdbKey);
            pollSpinner.succeed(chalk.green('Successfully authenticated!'));
            resolve(true);
          }
        } catch (e) {
          if (e.response?.status !== 400) {
            clearInterval(poll);
            pollSpinner.fail('Auth failed.');
            resolve(false);
          }
        }
      }, interval * 1000);
    });
  } catch (err) {
    spinner.fail('Could not connect to Trakt.');
    return false;
  }
}

// --- Sync Logic ---
async function startSync() {
  const traktToken = config.get('trakt_token');
  const pmdbKey = config.get('pmdb_key');

  if (!traktToken || !pmdbKey) {
    console.log(chalk.red('Missing credentials. Running login...'));
    const success = await login();
    if (!success) return;
    return startSync(); // Retry sync after login
  }

  const traktHeaders = {
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID,
    'Authorization': `Bearer ${traktToken}`
  };

  console.log(chalk.cyan('\n🚀 Starting Migration...'));

  // Sync History
  let page = 1;
  let totalPages = 1;
  const bar = new cliProgress.SingleBar({ format: 'History |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Items' }, cliProgress.Presets.shades_classic);

  try {
    while (page <= totalPages) {
      const res = await pRetry(() => axios.get(`https://api.trakt.tv/sync/history?limit=50&page=${page}`, { headers: traktHeaders }), { retries: 3 });
      totalPages = parseInt(res.headers['x-pagination-page-count']);
      
      if (page === 1) bar.start(parseInt(res.headers['x-pagination-item-count']), 0);

      for (const item of res.data) {
        const isMovie = item.type === 'movie';
        const payload = {
          tmdb_id: isMovie ? item.movie.ids.tmdb : item.show.ids.tmdb,
          media_type: isMovie ? 'movie' : 'tv',
          watched_at: item.watched_at
        };
        if (!isMovie) { payload.season = item.episode.season; payload.episode = item.episode.number; }

        try {
          await pmdbRequest('/watched?dedupe=true', payload, pmdbKey);
        } catch (e) {} // Ignore single item failures (duplicates/invalid IDs)
        bar.increment();
      }
      page++;
    }
    bar.stop();
    console.log(chalk.green('✔ History migrated.'));
  } catch (err) {
    console.error(chalk.red('\nFatal sync error:'), err.message);
  }
}

// --- CLI Commands ---
program
  .name('trakt-to-pmdb')
  .description('Sync your Trakt history to PublicMetaDB')
  .version('1.0.0');

program
  .command('login')
  .description('Authenticate with Trakt and PublicMetaDB')
  .action(login);

program
  .command('sync')
  .description('Run the migration')
  .action(startSync);

program
  .command('logout')
  .description('Clear local credentials')
  .action(() => {
    config.clear();
    console.log(chalk.yellow('Credentials cleared.'));
  });

program.parse();
