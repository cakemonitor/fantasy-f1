#!/usr/bin/env node
/**
 * Seed local dev server with the real 2025 calendar + dummy standings for cron testing.
 *
 * Fetches the 2025 calendar from OpenF1, pre-populates plausible standings for all
 * but the last 3 rounds, then seeds the dev server. The cron worker (with SEASON=2025)
 * only needs to fetch those 3 rounds — 3–6 API calls instead of a full season.
 *
 * Usage:
 *   1. Start dev server:   npm run dev
 *   2. Run:                ADMIN_PASSWORD=dev node scripts/seed-2025-test.js
 */

'use strict';

const http  = require('http');
const https = require('https');

const DEV_PORT    = 8788;
const OPENF1_BASE = 'https://api.openf1.org/v1';
const LEAVE_EMPTY = 3; // leave last N rounds for the cron to fetch

/* ---- Plausible 2025 top-10 drivers (dummy data only) ---- */
const DRIVERS = [
  { code: 'NOR', name: 'Lando Norris'    },
  { code: 'VER', name: 'Max Verstappen'  },
  { code: 'LEC', name: 'Charles Leclerc' },
  { code: 'PIA', name: 'Oscar Piastri'   },
  { code: 'SAI', name: 'Carlos Sainz'    },
  { code: 'RUS', name: 'George Russell'  },
  { code: 'HAM', name: 'Lewis Hamilton'  },
  { code: 'ANT', name: 'Kimi Antonelli'  },
  { code: 'ALO', name: 'Fernando Alonso' },
  { code: 'STR', name: 'Lance Stroll'    },
];

const RACE_POINTS   = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

/* ============================================================
   Helpers
   ============================================================ */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// Rotate finishing order by round so standings aren't identical every race
function generateStandings(pointsTable, roundOffset) {
  const result = {};
  pointsTable.forEach((pts, i) => {
    const driver = DRIVERS[(i + roundOffset) % DRIVERS.length];
    result[driver.code] = { name: driver.name, points: pts };
  });
  return result;
}

/* ============================================================
   Fetch real 2025 calendar from OpenF1
   ============================================================ */
async function fetchCalendar() {
  console.log('Fetching 2025 calendar from OpenF1...');
  const all = await fetchJson(`${OPENF1_BASE}/sessions?year=2025&session_type=Race`);

  const races   = all.filter(s => s.session_name === 'Race')
                     .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
  const sprints = all.filter(s => s.session_name === 'Sprint');

  const sprintByMeeting = {};
  for (const s of sprints) sprintByMeeting[s.meeting_key] = s;

  return races.map((session, i) => {
    const round  = i + 1;
    const sprint = sprintByMeeting[session.meeting_key];
    return {
      round,
      name:           session.circuit_short_name || `Round ${round}`,
      raceDate:       session.date_start.slice(0, 10),
      raceStartUtc:   session.date_start,
      sprintDate:     sprint ? sprint.date_start.slice(0, 10) : null,
      sprintStartUtc: sprint ? sprint.date_start : null,
    };
  });
}

/* ============================================================
   Build dummy standings (all rounds except last LEAVE_EMPTY)
   ============================================================ */
function buildStandings(calendar) {
  const standings  = {};
  const fillUpTo   = calendar.length - LEAVE_EMPTY;

  for (let i = 0; i < fillUpTo; i++) {
    const round = calendar[i];
    if (round.sprintStartUtc) {
      standings[`${round.round}_sprint`] = generateStandings(SPRINT_POINTS, i);
    }
    standings[String(round.round)] = generateStandings(RACE_POINTS, i);
  }

  return standings;
}

/* ============================================================
   POST to dev server /api/seed
   ============================================================ */
function postSeed(payload) {
  const password = process.env.ADMIN_PASSWORD || 'dev';
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = http.request(
      { hostname: 'localhost', port: DEV_PORT, path: '/api/seed', method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   'Content-Length': Buffer.byteLength(body),
                   'Authorization': `Bearer ${password}` } },
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

/* ============================================================
   Main
   ============================================================ */
async function main() {
  const calendar = await fetchCalendar();
  console.log(`Got ${calendar.length} rounds.`);

  const standings = buildStandings(calendar);
  const filled    = calendar.length - LEAVE_EMPTY;
  console.log(`Pre-populated dummy standings for rounds 1–${filled}.`);

  console.log(`\nLeaving empty for cron to fetch:`);
  for (const r of calendar.slice(-LEAVE_EMPTY)) {
    const sprint = r.sprintStartUtc ? ' (sprint weekend)' : '';
    console.log(`  Round ${r.round}: ${r.name}  ${r.raceDate}${sprint}`);
  }

  const f1Data = {
    season:      2025,
    lastUpdated: new Date().toISOString(),
    calendar,
    standings,
  };

  const f1Teams = {
    teams: [
      { name: 'Team Norris',     drivers: ['NOR', 'PIA'], color: '#f59e0b', adjustment: 0 },
      { name: 'Team Verstappen', drivers: ['VER', 'SAI'], color: '#3b82f6', adjustment: 0 },
      { name: 'Silver Arrows',   drivers: ['RUS', 'HAM'], color: '#6b7280', adjustment: 0 },
      { name: 'Scuderia',        drivers: ['LEC', 'ANT'], color: '#e8002d', adjustment: 0 },
    ],
  };

  console.log('\nSeeding dev server...');
  try {
    await postSeed({ 'f1-data': f1Data, 'f1-teams': f1Teams });
    console.log('Done. Now trigger the cron (SEASON must be 2025 in cron-worker/worker.js):');
    console.log('  npx wrangler dev cron-worker/worker.js --test-scheduled');
    console.log('  curl "http://localhost:8787/__scheduled?cron=*%2F10+*+*+*+*"');
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error('Error: dev server not running. Start it first with: npm run dev');
    } else {
      console.error('Seed failed:', err.message);
    }
    process.exit(1);
  }
}

main();
