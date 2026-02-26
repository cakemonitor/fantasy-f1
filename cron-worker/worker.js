/**
 * Fantasy F1 2026 — Cron Worker
 *
 * Runs on a schedule to fetch OpenF1 race results and update the F1_DATA KV store.
 * Deployed as a standalone Cloudflare Worker (not a Pages Function).
 */

const SEASON = 2026;

/* ---- Points systems ---- */
const RACE_POINTS   = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

/* ---- OpenF1 base URL ---- */
const OPENF1_BASE = 'https://api.openf1.org/v1';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

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
 * Returns past events whose standings we don't yet have.
 * Retries indefinitely every cron invocation until data is retrieved —
 * the cron only calls OpenF1 when there is genuinely missing data.
 */
function getEventsNeedingUpdate(calendar, standings, now) {
  const events = [];
  const minDelayMs = 30 * 60_000; // 30 min OpenF1 free-access delay post-session

  for (const round of calendar) {
    // Sprint session
    if (round.sprintStartUtc) {
      const key    = `${round.round}_sprint`;
      const endMs  = new Date(round.sprintStartUtc).getTime() + 30 * 60_000;

      if (endMs + minDelayMs < now.getTime() && !standings[key]) {
        events.push({ key, round: round.round, type: 'sprint', startUtc: round.sprintStartUtc });
      }
    }

    // Main race
    {
      const key   = String(round.round);
      const endMs = new Date(round.raceStartUtc).getTime() + 120 * 60_000;

      if (endMs + minDelayMs < now.getTime() && !standings[key]) {
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
  // Fetch championship standings and driver acronyms in parallel
  const [champRes, driversRes] = await Promise.all([
    fetchWithTimeout(`${OPENF1_BASE}/championship_drivers?season=${SEASON}`, 10_000),
    fetchWithTimeout(`${OPENF1_BASE}/drivers?season=${SEASON}`, 10_000),
  ]);
  if (!champRes.ok) throw new Error(`OpenF1 championship HTTP ${champRes.status}`);
  if (!driversRes.ok) throw new Error(`OpenF1 drivers HTTP ${driversRes.status}`);

  const data = await champRes.json();
  const driversData = await driversRes.json();

  if (!Array.isArray(data) || data.length === 0) return null;

  // Build driver_number → name_acronym lookup
  const acronymMap = {};
  for (const d of driversData) {
    if (d.driver_number && d.name_acronym) acronymMap[d.driver_number] = d.name_acronym;
  }

  // OpenF1 returns cumulative standings — we need to find the incremental points
  // for this specific round vs the previous round.
  // For now, return cumulative standings keyed by driver code.
  // app.js sums across rounds, so we store per-round increments.
  // If the endpoint doesn't support per-round data, we store total and recompute later.
  // TODO: revisit once the beta endpoint is documented more fully.

  const result = {};
  for (const driver of data) {
    const code = acronymMap[driver.driver_number];
    if (!code) throw new Error(`No acronym found for driver number ${driver.driver_number}`);
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
