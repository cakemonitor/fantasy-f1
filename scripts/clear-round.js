#!/usr/bin/env node
/**
 * Usage: node scripts/clear-round.js <round_key> [--remote]
 * Example: node scripts/clear-round.js 1 --remote
 *          node scripts/clear-round.js 1_sprint --remote
 *
 * Removes a standings entry for the given round key so the cron will re-fetch it.
 */
import { execSync } from 'child_process';

const key = process.argv[2];
const remote = process.argv.includes('--remote');

if (!key) {
  console.error('Usage: node scripts/clear-round.js <round_key> [--remote]');
  process.exit(1);
}

const kvFlags = `--binding F1_DATA${remote ? ' --remote --preview false' : ''}`;
const raw = execSync(`npx wrangler kv key get f1-data ${kvFlags}`, { encoding: 'utf8' });
const data = JSON.parse(raw);

if (!data.standings?.[key]) {
  console.log(`No standings entry for round "${key}" — nothing to clear.`);
  process.exit(0);
}

delete data.standings[key];

const json = JSON.stringify(data);
execSync(`npx wrangler kv key put f1-data '${json.replace(/'/g, "'\\''")}' ${kvFlags}`);
console.log(`Cleared standings["${key}"] — cron will re-fetch on next run.`);
