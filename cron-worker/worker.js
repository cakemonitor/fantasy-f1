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

  // Fetch driver roster once — numbers/names are stable across the season
  const driverMap = await loadDriverRoster(eventsToCheck[0]);

  let changed = false;

  for (const event of eventsToCheck) {
    console.log(`[cron] Fetching standings for ${event.key}`);
    try {
      const newStandings = await fetchStandingsForEvent(event, driverMap);
      const hasPoints = newStandings && Object.values(newStandings).some(d => d.points > 0);
      if (newStandings && Object.keys(newStandings).length > 0 && hasPoints) {
        standings[event.key] = newStandings;
        changed = true;
        console.log(`[cron] Updated standings for ${event.key} (${Object.keys(newStandings).length} drivers)`);
      } else if (newStandings && !hasPoints) {
        console.warn(`[cron] Standings for ${event.key} all-zero — data not ready yet, will retry`);
      }
    } catch (err) {
      console.error(`[cron] Error fetching ${event.key}: ${err.message}`);
    }
    // Respect OpenF1 free tier rate limit (3 req/s, 30 req/min)
    await new Promise(r => setTimeout(r, 2000));
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
 * Fetch driver roster once for the season.
 * driver_number → driver info (name_acronym, first_name, last_name).
 * Uses any event's session to find a valid session_key.
 */
async function loadDriverRoster(anyEvent) {
  try {
    const sessionKey = await resolveSessionKey(anyEvent);
    if (!sessionKey) return {};
    const res = await fetchWithTimeout(`${OPENF1_BASE}/drivers?session_key=${sessionKey}`, 10_000);
    if (!res.ok) return {};
    const drivers = await res.json();
    const map = {};
    for (const d of drivers) {
      if (d.driver_number) map[d.driver_number] = d;
    }
    console.log(`[cron] Loaded roster: ${Object.keys(map).length} drivers`);
    return map;
  } catch (err) {
    console.warn(`[cron] Could not load driver roster: ${err.message}`);
    return {};
  }
}

/**
 * Fetch standings for a single event from OpenF1 championship_drivers (beta).
 * Falls back to computing from race results if that fails.
 */
async function fetchStandingsForEvent(event, driverMap) {
  // Resolve session key once — shared by both methods below
  let sessionKey;
  try {
    sessionKey = await resolveSessionKey(event);
  } catch (err) {
    console.error(`[cron] Failed to resolve session key for ${event.key}: ${err.message}`);
    return null;
  }
  if (!sessionKey) {
    console.warn(`[cron] No session found for ${event.key}`);
    return null;
  }

  // Try OpenF1 championship_drivers endpoint
  try {
    const result = await fetchOpenF1Championship(sessionKey, driverMap);
    if (result && Object.keys(result).length > 0) return result;
  } catch (err) {
    console.warn(`[cron] OpenF1 championship failed for ${event.key}: ${err.message}`);
  }

  // Fallback: compute from race/sprint results
  console.log(`[cron] Falling back to results computation for ${event.key}`);
  try {
    return await computeStandingsFromResults(sessionKey, event.type, driverMap);
  } catch (err) {
    console.error(`[cron] Fallback also failed for ${event.key}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve the OpenF1 session_key for an event.
 */
async function resolveSessionKey(event) {
  const sessionName = event.type === 'sprint' ? 'Sprint' : 'Race';
  const url = `${OPENF1_BASE}/sessions?year=${SEASON}&session_type=Race&session_name=${sessionName}&date_start>=${event.startUtc.slice(0, 10)}`;
  const res = await fetchWithTimeout(url, 10_000);
  if (!res.ok) throw new Error(`OpenF1 sessions HTTP ${res.status}`);
  const sessions = await res.json();

  const eventDate = new Date(event.startUtc).getTime();
  const session = sessions
    .map(s => ({ ...s, _diff: Math.abs(new Date(s.date_start).getTime() - eventDate) }))
    .sort((a, b) => a._diff - b._diff)[0];

  return session?.session_key ?? null;
}

/**
 * Fetch from OpenF1 championship_drivers (beta endpoint).
 * Returns { [driverCode]: { name, points } } or null.
 * Points are incremental for this session: points_current - points_start.
 */
async function fetchOpenF1Championship(sessionKey, driverMap) {
  // Only fetch driver info if we don't already have the season roster
  const resolvedDriverMap = Object.keys(driverMap).length > 0
    ? driverMap
    : await fetchSessionDriverMap(sessionKey);

  const champRes = await fetchWithTimeout(`${OPENF1_BASE}/championship_drivers?session_key=${sessionKey}`, 10_000);
  if (!champRes.ok) throw new Error(`OpenF1 championship HTTP ${champRes.status}`);

  const data = await champRes.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const result = {};
  for (const entry of data) {
    const driver = resolvedDriverMap[entry.driver_number];
    if (!driver?.name_acronym) {
      // Driver raced earlier in the season but not this session (e.g. mid-season replacement)
      console.warn(`[cron] No session entry for driver_number=${entry.driver_number} — skipping`);
      continue;
    }
    result[driver.name_acronym] = {
      name:   `${driver.first_name || ''} ${driver.last_name || ''}`.trim(),
      points: (entry.points_current || 0) - (entry.points_start || 0),
    };
  }
  return result;
}

/**
 * Fetch driver_number → driver info for a specific session.
 * Used as a fallback when no pre-loaded roster is available.
 */
async function fetchSessionDriverMap(sessionKey) {
  const res = await fetchWithTimeout(`${OPENF1_BASE}/drivers?session_key=${sessionKey}`, 10_000);
  if (!res.ok) throw new Error(`OpenF1 drivers HTTP ${res.status}`);
  const drivers = await res.json();
  const map = {};
  for (const d of drivers) {
    if (d.driver_number) map[d.driver_number] = d;
  }
  return map;
}

/**
 * Compute standings for a round from OpenF1 race/sprint results.
 * Returns incremental points for this round only.
 */
async function computeStandingsFromResults(sessionKey, eventType, driverMap) {
  // Fetch race results (position data)
  const resultsUrl = `${OPENF1_BASE}/position?session_key=${sessionKey}`;
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

  // Use pre-loaded roster if available, otherwise fetch for this session
  const resolvedDriverMap = Object.keys(driverMap).length > 0
    ? driverMap
    : await fetchSessionDriverMap(sessionKey);

  const pointsTable = eventType === 'sprint' ? SPRINT_POINTS : RACE_POINTS;
  const result = {};

  for (const [driverNum, pos] of Object.entries(finalPositions)) {
    const driver = resolvedDriverMap[driverNum];
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
    // OpenF1 uses session_type=Race (capitalised) for both races and sprints;
    // session_name distinguishes them ('Race' vs 'Sprint').
    const url = `${OPENF1_BASE}/sessions?year=${SEASON}&session_type=Race`;
    const res = await fetchWithTimeout(url, 15_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();

    const raceSessions   = all.filter(s => s.session_name === 'Race');
    const sprintSessions = all.filter(s => s.session_name === 'Sprint');

    // Group sprints by meeting_key for easy lookup
    const sprintByMeeting = {};
    for (const s of sprintSessions) {
      sprintByMeeting[s.meeting_key] = s;
    }

    // Build calendar entries
    const calendar = [];
    let round = 1;

    // Sort race sessions by date
    raceSessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

    for (const session of raceSessions) {
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
