#!/usr/bin/env node
/**
 * Pushes the 2026 race calendar to KV.
 *
 * Usage (local dev):  node scripts/push-calendar.js --local
 * Usage (production): node scripts/push-calendar.js
 *
 * Race times from f1calendar.com. Sprint races are always the Saturday
 * before the Sunday race, at the time listed.
 */

'use strict';

const { execSync } = require('child_process');

const NAMESPACE_ID = '1b52376370bc41ef8ce405ed3aabab5f';

// Sprint weekends: China, Miami, Canada, Britain, Netherlands, Singapore
// Sprint date = day before race date; sprint time from f1calendar.com
const CALENDAR = [
  { round:  1, name: "Australian GP",     race: "2026-03-08T04:00:00Z", sprint: null },
  { round:  2, name: "Chinese GP",        race: "2026-03-15T07:00:00Z", sprint: "2026-03-14T03:00:00Z" },
  { round:  3, name: "Japanese GP",       race: "2026-03-29T05:00:00Z", sprint: null },
  { round:  4, name: "Bahrain GP",        race: "2026-04-12T15:00:00Z", sprint: null },
  { round:  5, name: "Saudi Arabian GP",  race: "2026-04-19T17:00:00Z", sprint: null },
  { round:  6, name: "Miami GP",          race: "2026-05-03T20:00:00Z", sprint: "2026-05-02T16:00:00Z" },
  { round:  7, name: "Canadian GP",       race: "2026-05-24T20:00:00Z", sprint: "2026-05-23T16:00:00Z" },
  { round:  8, name: "Monaco GP",         race: "2026-06-07T13:00:00Z", sprint: null },
  { round:  9, name: "Spanish GP",        race: "2026-06-14T13:00:00Z", sprint: null },
  { round: 10, name: "Austrian GP",       race: "2026-06-28T13:00:00Z", sprint: null },
  { round: 11, name: "British GP",        race: "2026-07-05T14:00:00Z", sprint: "2026-07-04T11:00:00Z" },
  { round: 12, name: "Belgian GP",        race: "2026-07-19T13:00:00Z", sprint: null },
  { round: 13, name: "Hungarian GP",      race: "2026-07-26T13:00:00Z", sprint: null },
  { round: 14, name: "Dutch GP",          race: "2026-08-23T13:00:00Z", sprint: "2026-08-22T10:00:00Z" },
  { round: 15, name: "Italian GP",        race: "2026-09-06T13:00:00Z", sprint: null },
  { round: 16, name: "Madrid GP",         race: "2026-09-13T13:00:00Z", sprint: null },
  { round: 17, name: "Azerbaijan GP",     race: "2026-09-27T11:00:00Z", sprint: null },
  { round: 18, name: "Singapore GP",      race: "2026-10-11T12:00:00Z", sprint: "2026-10-10T09:00:00Z" },
  { round: 19, name: "United States GP",  race: "2026-10-25T20:00:00Z", sprint: null },
  { round: 20, name: "Mexican GP",        race: "2026-11-01T20:00:00Z", sprint: null },
  { round: 21, name: "Brazilian GP",      race: "2026-11-08T17:00:00Z", sprint: null },
  { round: 22, name: "Las Vegas GP",      race: "2026-11-22T04:00:00Z", sprint: null },
  { round: 23, name: "Qatar GP",          race: "2026-11-29T16:00:00Z", sprint: null },
  { round: 24, name: "Abu Dhabi GP",      race: "2026-12-06T13:00:00Z", sprint: null },
];

function buildCalendarEntries() {
  return CALENDAR.map(r => ({
    round:          r.round,
    name:           r.name,
    raceDate:       r.race.slice(0, 10),
    raceStartUtc:   r.race,
    sprintDate:     r.sprint ? r.sprint.slice(0, 10) : null,
    sprintStartUtc: r.sprint,
  }));
}

function main() {
  const args = process.argv.slice(2);
  const isLocal = args.includes('--local');

  const calendar = buildCalendarEntries();

  // Read existing f1-data if present and merge calendar in
  let existing = { season: 2026, standings: {} };

  const data = {
    ...existing,
    lastUpdated: new Date().toISOString(),
    calendar,
  };

  const json = JSON.stringify(data);

  console.log(`Pushing 2026 calendar (${calendar.length} rounds, ${calendar.filter(r => r.sprintStartUtc).length} sprint weekends)...`);
  calendar.forEach(r => {
    const sprint = r.sprintStartUtc ? ` + Sprint ${r.sprintStartUtc}` : '';
    console.log(`  R${String(r.round).padStart(2, '0')} ${r.name.padEnd(20)} ${r.raceStartUtc}${sprint}`);
  });

  const target = isLocal
    ? `--binding=F1_DATA --local --preview false`
    : `--namespace-id=${NAMESPACE_ID} --remote`;

  const cmd = `npx wrangler kv key put ${target} "f1-data" '${json.replace(/'/g, "'\\''")}'`;

  console.log(`\nWriting to KV (${isLocal ? 'local' : 'remote'})...`);
  execSync(cmd, { stdio: 'inherit' });
  console.log('Done.');
}

main();
