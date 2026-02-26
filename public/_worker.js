/**
 * Fantasy F1 2026 — Cloudflare Pages Worker
 *
 * Routes:
 *   GET  /api/data          → serve standings + calendar + teams from KV
 *   POST /api/teams         → password-protected team config save to KV
 *   POST /api/teams/verify  → password verification only (no write)
 *   Cron scheduled handler  → fetch OpenF1, update KV
 */

const SEASON = 2026;

/* ---- Points systems ---- */
const RACE_POINTS   = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

/* ---- OpenF1 base URL ---- */
const OPENF1_BASE = 'https://api.openf1.org/v1';

/* ---- Jolpi (Ergast proxy) fallback ---- */
const JOLPI_BASE = 'https://api.jolpi.ca/ergast/f1';

/* ============================================================
   Main fetch handler (Pages Functions entry point)
   ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data' && request.method === 'GET') {
      return handleGetData(env);
    }

    if (url.pathname === '/api/teams' && request.method === 'POST') {
      return handleSaveTeams(request, env);
    }

    if (url.pathname === '/api/teams/verify' && request.method === 'POST') {
      return handleVerifyPassword(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

/* ============================================================
   GET /api/data
   ============================================================ */
async function handleGetData(env) {
  try {
    const [f1DataRaw, f1TeamsRaw] = await Promise.all([
      env.F1_DATA.get('f1-data', { type: 'json' }),
      env.F1_DATA.get('f1-teams', { type: 'json' }),
    ]);

    const payload = {
      season:      SEASON,
      lastUpdated: f1DataRaw?.lastUpdated || null,
      calendar:    f1DataRaw?.calendar    || [],
      standings:   f1DataRaw?.standings   || {},
      teams:       f1TeamsRaw?.teams      || [],
    };

    return jsonResponse(payload, {
      'Cache-Control': 'public, max-age=300', // 5-minute browser cache
    });
  } catch (err) {
    return errorResponse(`Failed to read data: ${err.message}`, 500);
  }
}

/* ============================================================
   POST /api/teams
   ============================================================ */
async function handleSaveTeams(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const { teams } = body;
  const validationError = validateTeams(teams);
  if (validationError) return errorResponse(validationError, 400);

  try {
    await env.F1_DATA.put('f1-teams', JSON.stringify({ teams }));
    return jsonResponse({ success: true });
  } catch (err) {
    return errorResponse(`Failed to save teams: ${err.message}`, 500);
  }
}

/* ============================================================
   POST /api/teams/verify  — auth check only, no write
   ============================================================ */
async function handleVerifyPassword(request, env) {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;
  return jsonResponse({ ok: true });
}

/* ============================================================
   Auth helper
   ============================================================ */
function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Unauthorised' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

/* ============================================================
   Team validation (server-side mirror of client validation)
   ============================================================ */
function validateTeams(teams) {
  if (!Array.isArray(teams)) return 'teams must be an array';
  if (teams.length > 10)     return 'Maximum 10 teams allowed';

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    if (!t.name || typeof t.name !== 'string') return `Team ${i + 1}: name is required`;
    if (!Array.isArray(t.drivers) || t.drivers.length !== 2) return `Team ${i + 1}: drivers must be an array of 2 codes`;
    if (!t.drivers[0] || !t.drivers[1]) return `Team ${i + 1}: both driver codes are required`;
    if (t.color && !/^#[0-9a-fA-F]{6}$/.test(t.color)) return `Team ${i + 1}: invalid hex colour`;
    if (t.adjustment !== undefined && typeof t.adjustment !== 'number') return `Team ${i + 1}: adjustment must be a number`;
  }
  return null;
}

/* ============================================================
   Cron — fetch OpenF1, update KV
   ============================================================ */
async function runCron(env) {
  console.log('[cron] Starting scheduled run');

  // Load existing data
  let existing = await env.F1_DATA.get('f1-data', { type: 'json' }) || {};
  let calendar = existing.calendar || [];
  let standings = existing.standings || {};

  // Refresh calendar at start of season or if empty
  if (calendar.length === 0) {
    console.log('[cron] Calendar empty — fetching from OpenF1');
    calendar = await fetchCalendar();
    if (!calendar.length) {
      console.log('[cron] No calendar data available yet');
      return;
    }
  }

  const now = new Date();

  // Find events that may have completed and need standings updated
  const eventsToCheck = getEventsNeedingUpdate(calendar, standings, now);

  if (eventsToCheck.length === 0) {
    console.log('[cron] No events to update at this time');
    // Still save refreshed calendar if we fetched it
    if (!existing.calendar?.length) {
      await saveData(env, { ...existing, calendar, standings });
    }
    return;
  }

  console.log(`[cron] Checking ${eventsToCheck.length} event(s)`);

  let changed = false;

  for (const event of eventsToCheck) {
    console.log(`[cron] Fetching standings for ${event.key} (session: ${event.sessionKey})`);
    try {
      const newStandings = await fetchStandingsForEvent(event, standings);
      if (newStandings && Object.keys(newStandings).length > 0) {
        standings[event.key] = newStandings;
        changed = true;
        console.log(`[cron] Updated standings for ${event.key} (${Object.keys(newStandings).length} drivers)`);
      }
    } catch (err) {
      console.error(`[cron] Error fetching ${event.key}: ${err.message}`);
    }
  }

  if (changed || !existing.calendar?.length) {
    await saveData(env, {
      season: SEASON,
      lastUpdated: now.toISOString(),
      calendar,
      standings,
    });
    console.log('[cron] KV updated');
  }
}

/**
 * Returns events that have recently ended but whose standings we don't yet have.
 * Looks back up to 4 hours to catch events we may have missed.
 */
function getEventsNeedingUpdate(calendar, standings, now) {
  const events = [];
  const lookbackMs  = 4 * 60 * 60_000;   // 4 hours
  const minDelayMs  = 30 * 60_000;        // 30 min (OpenF1 free access delay)

  for (const round of calendar) {
    // Sprint session
    if (round.sprintStartUtc) {
      const key       = `${round.round}_sprint`;
      const sessionMs = new Date(round.sprintStartUtc).getTime();
      const endMs     = sessionMs + 30 * 60_000;
      const nowMs     = now.getTime();

      if (
        endMs + minDelayMs < nowMs &&      // session ended + delay passed
        nowMs - endMs < lookbackMs &&      // within lookback window
        !standings[key]                    // no data yet
      ) {
        events.push({ key, round: round.round, type: 'sprint', startUtc: round.sprintStartUtc });
      }
    }

    // Main race
    {
      const key       = String(round.round);
      const sessionMs = new Date(round.raceStartUtc).getTime();
      const endMs     = sessionMs + 120 * 60_000;
      const nowMs     = now.getTime();

      if (
        endMs + minDelayMs < nowMs &&
        nowMs - endMs < lookbackMs &&
        !standings[key]
      ) {
        events.push({ key, round: round.round, type: 'race', startUtc: round.raceStartUtc });
      }
    }
  }

  return events;
}

/**
 * Fetch standings for a single event from OpenF1 championship_drivers (beta).
 * Falls back to computing from race results if that fails.
 */
async function fetchStandingsForEvent(event, existingStandings) {
  // Try OpenF1 championship_drivers endpoint
  try {
    const result = await fetchOpenF1Championship(event);
    if (result && Object.keys(result).length > 0) return result;
  } catch (err) {
    console.warn(`[cron] OpenF1 championship failed for ${event.key}: ${err.message}`);
  }

  // Fallback: compute from race/sprint results
  console.log(`[cron] Falling back to results computation for ${event.key}`);
  try {
    return await computeStandingsFromResults(event, existingStandings);
  } catch (err) {
    console.error(`[cron] Fallback also failed for ${event.key}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch from OpenF1 championship_drivers (beta endpoint).
 * Returns { [driverCode]: { name, points } } or null.
 */
async function fetchOpenF1Championship(event) {
  const url = `${OPENF1_BASE}/championship_drivers?season=${SEASON}`;
  const res = await fetchWithTimeout(url, 10_000);
  if (!res.ok) throw new Error(`OpenF1 championship HTTP ${res.status}`);
  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) return null;

  // OpenF1 returns cumulative standings — we need to find the incremental points
  // for this specific round vs the previous round.
  // For now, return cumulative standings keyed by driver code.
  // app.js sums across rounds, so we store per-round increments.
  // If the endpoint doesn't support per-round data, we store total and recompute later.
  // TODO: revisit once the beta endpoint is documented more fully.

  const result = {};
  for (const driver of data) {
    const code = driver.driver_number ? await resolveDriverCode(driver.driver_number) : driver.broadcast_name;
    if (!code) continue;
    result[code] = {
      name:   `${driver.first_name || ''} ${driver.last_name || ''}`.trim(),
      points: driver.points || 0,
    };
  }
  return result;
}

/**
 * Compute standings for a round from OpenF1 race/sprint results.
 * Returns incremental points for this round only.
 */
async function computeStandingsFromResults(event, existingStandings) {
  const sessionType = event.type === 'sprint' ? 'sprint' : 'race';

  // Fetch session key from OpenF1 sessions
  const sessionsUrl = `${OPENF1_BASE}/sessions?year=${SEASON}&circuit_short_name=&session_type=${sessionType}&date_start>=${event.startUtc.slice(0,10)}`;
  const sessRes = await fetchWithTimeout(sessionsUrl, 10_000);
  if (!sessRes.ok) throw new Error(`OpenF1 sessions HTTP ${sessRes.status}`);
  const sessions = await sessRes.json();

  // Find the closest session to our event date
  const eventDate = new Date(event.startUtc).getTime();
  const session = sessions
    .map(s => ({ ...s, _diff: Math.abs(new Date(s.date_start).getTime() - eventDate) }))
    .sort((a, b) => a._diff - b._diff)[0];

  if (!session) throw new Error('No matching session found');

  // Fetch race results (position data)
  const resultsUrl = `${OPENF1_BASE}/position?session_key=${session.session_key}`;
  const resRes = await fetchWithTimeout(resultsUrl, 15_000);
  if (!resRes.ok) throw new Error(`OpenF1 position HTTP ${resRes.status}`);
  const positions = await resRes.json();

  // Get final positions (last position update per driver)
  const finalPositions = {};
  for (const pos of positions) {
    const driverNum = pos.driver_number;
    if (!finalPositions[driverNum] || new Date(pos.date) > new Date(finalPositions[driverNum].date)) {
      finalPositions[driverNum] = pos;
    }
  }

  // Fetch driver info for this session
  const driversUrl = `${OPENF1_BASE}/drivers?session_key=${session.session_key}`;
  const drRes = await fetchWithTimeout(driversUrl, 10_000);
  if (!drRes.ok) throw new Error(`OpenF1 drivers HTTP ${drRes.status}`);
  const drivers = await drRes.json();

  const driverMap = {};
  for (const d of drivers) {
    driverMap[d.driver_number] = d;
  }

  const pointsTable = event.type === 'sprint' ? SPRINT_POINTS : RACE_POINTS;
  const result = {};

  for (const [driverNum, pos] of Object.entries(finalPositions)) {
    const driver = driverMap[driverNum];
    if (!driver) continue;
    const code = driver.name_acronym;
    const position = pos.position;
    const pts = position >= 1 && position <= pointsTable.length ? pointsTable[position - 1] : 0;
    result[code] = {
      name:   `${driver.first_name || ''} ${driver.last_name || ''}`.trim(),
      points: pts,
    };
  }

  return result;
}

/**
 * Fetch the race calendar from OpenF1 sessions for the current season.
 */
async function fetchCalendar() {
  try {
    const url = `${OPENF1_BASE}/sessions?year=${SEASON}&session_type=race`;
    const res = await fetchWithTimeout(url, 15_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sessions = await res.json();

    // Also fetch sprint sessions
    const sprintUrl = `${OPENF1_BASE}/sessions?year=${SEASON}&session_type=sprint`;
    const sprintRes = await fetchWithTimeout(sprintUrl, 15_000);
    const sprintSessions = sprintRes.ok ? await sprintRes.json() : [];

    // Group by circuit/meeting
    const sprintByMeeting = {};
    for (const s of sprintSessions) {
      sprintByMeeting[s.meeting_key] = s;
    }

    // Build calendar entries
    const calendar = [];
    let round = 1;

    // Sort race sessions by date
    sessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

    for (const session of sessions) {
      const sprint = sprintByMeeting[session.meeting_key];
      calendar.push({
        round,
        name:            session.meeting_name || session.circuit_short_name || `Round ${round}`,
        raceDate:        session.date_start.slice(0, 10),
        raceStartUtc:    session.date_start,
        sprintDate:      sprint ? sprint.date_start.slice(0, 10) : null,
        sprintStartUtc:  sprint ? sprint.date_start : null,
      });
      round++;
    }

    return calendar;
  } catch (err) {
    console.error(`[cron] Calendar fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Resolve a driver number to a 3-letter acronym using OpenF1 drivers endpoint.
 * This is a best-effort helper; returns null if not found.
 */
async function resolveDriverCode(driverNumber) {
  try {
    const url = `${OPENF1_BASE}/drivers?driver_number=${driverNumber}&season=${SEASON}`;
    const res = await fetchWithTimeout(url, 5_000);
    if (!res.ok) return null;
    const drivers = await res.json();
    return drivers[0]?.name_acronym || null;
  } catch {
    return null;
  }
}

/* ============================================================
   Utilities
   ============================================================ */
async function saveData(env, data) {
  await env.F1_DATA.put('f1-data', JSON.stringify(data));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
