#!/usr/bin/env node
/**
 * Seed local dev server KV with mock F1 data.
 *
 * Scenarios covered:
 *   A. Round 1 (Australia) — race complete, standings present → ✓ confirmed
 *   B. Round 2 sprint (China) — sprint complete, NO standings yet → ⏳ pending
 *   C. Round 2 race (China) — upcoming → 🗓 scheduled
 *
 * Usage:
 *   1. Start dev server first:  npm run dev
 *   2. Run seed:                npm run seed
 *
 * Posts to /api/seed (only available when ADMIN_PASSWORD env var is unset).
 */

'use strict';

const http = require('http');
const DEV_PORT = 8788;

// ---------------------------------------------------------------------------
// Clock reference — set these to control what "now" is in the mock.
// The seed data uses real 2026 calendar dates so the app's time comparisons
// work correctly. We place:
//   - Australia race end:  2026-03-15 07:00 UTC  (race start 05:00 + 2h)
//   - China sprint end:    2026-03-21 08:00 UTC  (sprint start 07:30 + 30m)
//   - China race start:    2026-03-22 07:00 UTC  (upcoming)
//
// "now" in the app is real wall-clock time, so we anchor races in the past.
// ---------------------------------------------------------------------------

const MOCK_DATA = {
  season: 2026,
  lastUpdated: new Date().toISOString(),
  calendar: [
    {
      round: 1,
      name: "Australian GP",
      raceDate: "2026-03-15",
      raceStartUtc: "2026-03-15T05:00:00Z",
      sprintDate: null,
      sprintStartUtc: null,
    },
    {
      round: 2,
      name: "Chinese GP",
      raceDate: "2026-03-22",
      raceStartUtc: "2026-03-22T07:00:00Z",
      sprintDate: "2026-03-21",
      sprintStartUtc: "2026-03-21T07:30:00Z",
    },
    {
      round: 3,
      name: "Japanese GP",
      raceDate: "2026-04-05",
      raceStartUtc: "2026-04-05T05:00:00Z",
      sprintDate: null,
      sprintStartUtc: null,
    },
  ],
  standings: {
    // Round 1 race — data present (scenario A: ✓ confirmed)
    "1": {
      VER: { name: "Max Verstappen",  points: 25 },
      NOR: { name: "Lando Norris",    points: 18 },
      LEC: { name: "Charles Leclerc", points: 15 },
      PIA: { name: "Oscar Piastri",   points: 12 },
      SAI: { name: "Carlos Sainz",    points: 10 },
      RUS: { name: "George Russell",  points: 8  },
      HAM: { name: "Lewis Hamilton",  points: 6  },
      ANT: { name: "Kimi Antonelli",  points: 4  },
      ALO: { name: "Fernando Alonso", points: 2  },
      STR: { name: "Lance Stroll",    points: 1  },
    },
    // Round 2 sprint — intentionally omitted (scenario B: ⏳ pending)
    // "2_sprint": { ... }  ← missing to trigger pending state

    // Round 2 race — intentionally omitted (scenario C: upcoming / no data)
  },
};

const MOCK_TEAMS = {
  teams: [
    {
      name: "Verstappen Vipers",
      drivers: ["VER", "SAI"],
      color: "#3b82f6",
      adjustment: 0,
    },
    {
      name: "Norris Nation",
      drivers: ["NOR", "PIA"],
      color: "#f59e0b",
      adjustment: 5,
    },
    {
      name: "Silver Bullets",
      drivers: ["RUS", "HAM"],
      color: "#6b7280",
      adjustment: 0,
    },
    {
      name: "Scuderia Dream",
      drivers: ["LEC", "ANT"],
      color: "#e8002d",
      adjustment: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario variant: use "recent" timestamps so the app sees them as
// "past + delay passed" rather than "upcoming". We set Australia race
// start to be ~2 hours before a known-past time so that both
//   endMs + 30min delay < now   AND   now - endMs < 4h lookback
// are satisfied ... but since we can't modify wall-clock time in the browser,
// we instead rely on the fact that the app uses calendar dates to classify
// events as past/future, and the standings presence/absence to determine
// confirmed/pending.
//
// To make the sprint PENDING (no standings), we need the sprint to appear
// "past" in the event panel. Since 2026-03-21 is already in the past relative
// to today (2026-02-26... wait, 2026-03-21 is in the FUTURE!
//
// The current date is 2026-02-26, so ALL 2026 race dates are in the future.
// We need to adjust the mock calendar to put some events in the past.
// ---------------------------------------------------------------------------

function buildScenarioDates() {
  const now = new Date();

  // Round 1 race: ended 3 hours ago (past, data available → ✓)
  const r1RaceStart = new Date(now.getTime() - 5 * 60 * 60_000); // 5h ago

  // Round 2 sprint: ended 45 minutes ago (past, data absent → ⏳)
  const r2SprintStart = new Date(now.getTime() - 75 * 60_000); // 75 min ago

  // Round 2 race: 6 hours from now (upcoming → 🗓)
  const r2RaceStart = new Date(now.getTime() + 6 * 60 * 60_000);

  // Round 3: 2 weeks from now
  const r3RaceStart = new Date(now.getTime() + 14 * 24 * 60 * 60_000);

  return { r1RaceStart, r2SprintStart, r2RaceStart, r3RaceStart };
}

function buildMockData() {
  const { r1RaceStart, r2SprintStart, r2RaceStart, r3RaceStart } = buildScenarioDates();

  const data = structuredClone(MOCK_DATA);
  data.lastUpdated = new Date().toISOString();
  data.calendar = [
    {
      round: 1,
      name: "Australian GP",
      raceDate: r1RaceStart.toISOString().slice(0, 10),
      raceStartUtc: r1RaceStart.toISOString(),
      sprintDate: null,
      sprintStartUtc: null,
    },
    {
      round: 2,
      name: "Chinese GP",
      raceDate: r2RaceStart.toISOString().slice(0, 10),
      raceStartUtc: r2RaceStart.toISOString(),
      sprintDate: r2SprintStart.toISOString().slice(0, 10),
      sprintStartUtc: r2SprintStart.toISOString(),
    },
    {
      round: 3,
      name: "Japanese GP",
      raceDate: r3RaceStart.toISOString().slice(0, 10),
      raceStartUtc: r3RaceStart.toISOString(),
      sprintDate: null,
      sprintStartUtc: null,
    },
  ];

  return data;
}

// ---------------------------------------------------------------------------
// POST mock data to /api/seed on the running dev server
// ---------------------------------------------------------------------------

function postSeed(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { hostname: 'localhost', port: DEV_PORT, path: '/api/seed', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve(JSON.parse(data));
          else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Seeding local dev KV with mock F1 data...\n');

  const data = buildMockData();

  console.log('Calendar events:');
  for (const r of data.calendar) {
    console.log(`  Round ${r.round}: ${r.name}`);
    console.log(`    Race:   ${r.raceStartUtc}`);
    if (r.sprintStartUtc) {
      console.log(`    Sprint: ${r.sprintStartUtc}`);
    }
  }
  console.log('\nStandings keys present:', Object.keys(data.standings).join(', ') || '(none)');
  console.log('(Round "2_sprint" intentionally absent → ⏳ pending state)\n');

  try {
    const result = await postSeed({ 'f1-data': data, 'f1-teams': MOCK_TEAMS });
    console.log('Seed response:', result);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('Error: dev server not running. Start it first with: npm run dev');
    } else {
      console.error('Seed failed:', err.message);
    }
    process.exit(1);
  }

  console.log('\nDone! Refresh http://localhost:8788 to see the mock data.\n');
  console.log('Expected event panel:');
  console.log('  ✓  Australian GP          (race complete, data present)');
  console.log('  ⏳ Chinese GP  [Sprint]   (sprint ended ~45min ago, no data yet)');
  console.log('  🗓 Chinese GP             (race upcoming, ~6h from now)');
}

main();
