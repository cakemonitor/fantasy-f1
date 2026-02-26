#!/usr/bin/env node
/**
 * Quick smoke-test for the championship_drivers endpoint fix.
 * Uses 2025 Abu Dhabi (session_key=9839) — known to have data.
 *
 * Usage: node scripts/test-championship-endpoint.js
 */

'use strict';

const https = require('https');

const OPENF1_BASE = 'https://api.openf1.org/v1';
const SESSION_KEY = 9839; // 2025 Abu Dhabi GP

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log(`Testing championship_drivers + drivers for session_key=${SESSION_KEY}\n`);

  const [champData, driversData] = await Promise.all([
    fetchJson(`${OPENF1_BASE}/championship_drivers?session_key=${SESSION_KEY}`),
    fetchJson(`${OPENF1_BASE}/drivers?session_key=${SESSION_KEY}`),
  ]);

  console.log(`championship_drivers: ${champData.length} entries`);
  console.log(`drivers:              ${driversData.length} entries\n`);

  // Build driverMap
  const driverMap = {};
  for (const d of driversData) {
    if (d.driver_number) driverMap[d.driver_number] = d;
  }

  // Compute incremental standings
  const result = {};
  for (const entry of champData) {
    const driver = driverMap[entry.driver_number];
    if (!driver?.name_acronym) {
      console.warn(`  No acronym for driver_number=${entry.driver_number}`);
      continue;
    }
    result[driver.name_acronym] = {
      name:   `${driver.first_name || ''} ${driver.last_name || ''}`.trim(),
      points: (entry.points_current || 0) - (entry.points_start || 0),
    };
  }

  // Print sorted by points desc
  const sorted = Object.entries(result).sort((a, b) => b[1].points - a[1].points);
  console.log('Incremental points for Abu Dhabi 2025 (points_current - points_start):');
  for (const [code, { name, points }] of sorted) {
    console.log(`  ${code.padEnd(4)} ${name.padEnd(25)} ${points}`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
