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

/* ---- API base URLs ---- */
const OPENF1_BASE  = 'https://api.openf1.org/v1';
const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/refresh' && request.method === 'POST') {
      return handleManualRefresh(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

/* ============================================================
   POST /refresh — manual single-event recheck, triggered from
   the admin panel via the Pages Worker's /api/refresh-standings
   proxy. Overwrites standings for one past event even if it
   already has data, to pick up post-hoc corrections (e.g. a
   stewards' appeal reinstating a position after the original
   fetch already succeeded).
   ============================================================ */
async function handleManualRefresh(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!env.ADMIN_PASSWORD || token !== env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Unauthorised' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!body?.key) {
    return new Response(JSON.stringify({ error: 'Missing "key"' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await refreshOneEvent(env, body.key);
    return new Response(JSON.stringify(result), {
      status: result.error ? 404 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Force-recheck a single past event by key, regardless of whether it
 * already has standings. Overwrites only if the fresh result is real
 * (non-empty, not all-zero) and actually differs from what's stored.
 */
async function refreshOneEvent(env, key) {
  const existing  = await env.F1_DATA.get('f1-data', { type: 'json' }) || {};
  const calendar  = existing.calendar || [];
  const standings = existing.standings || {};
  const now = new Date();

  const candidates = getEventsNeedingUpdate(calendar, standings, now, true);
  const event = candidates.find(e => e.key === key);
  if (!event) {
    return { error: `No eligible past event found for "${key}"` };
  }

  const driverMap = await loadDriverRoster(event);
  const fresh = await fetchStandingsForEvent(event, driverMap);
  const hasPoints = fresh && Object.values(fresh).some(d => d.points > 0);

  if (!fresh || Object.keys(fresh).length === 0 || !hasPoints) {
    return { checked: 1, updated: 0, updatedKeys: [], failed: [key] };
  }

  const changed = JSON.stringify(fresh) !== JSON.stringify(standings[key] || null);
  if (!changed) {
    return { checked: 1, updated: 0, updatedKeys: [], failed: [] };
  }

  standings[key] = fresh;
  await saveData(env, {
    season: SEASON,
    lastUpdated: now.toISOString(),
    calendarUpdated: existing.calendarUpdated || null,
    calendar,
    standings,
  });
  return { checked: 1, updated: 1, updatedKeys: [key], failed: [] };
}

const CALENDAR_REFRESH_MS = 7 * 24 * 60 * 60_000; // 7 days

/* ============================================================
   Cron — fetch OpenF1, update KV
   ============================================================ */
async function runCron(env) {
  console.log('[cron] Starting scheduled run');

  let existing = await env.F1_DATA.get('f1-data', { type: 'json' }) || {};
  let calendar = existing.calendar || [];
  let standings = existing.standings || {};
  let calendarUpdated = existing.calendarUpdated || null;

  const now = new Date();
  let needsSave = false;

  // Refresh calendar if empty or older than 7 days
  const calendarAgeMs = calendarUpdated
    ? now.getTime() - new Date(calendarUpdated).getTime()
    : Infinity;

  if (calendar.length === 0 || calendarAgeMs > CALENDAR_REFRESH_MS) {
    const reason = calendar.length === 0 ? 'empty' : 'stale';
    console.log(`[cron] Calendar ${reason} — fetching from Jolpica`);
    const fresh = await fetchCalendar();
    if (fresh.length) {
      calendar = fresh;
      calendarUpdated = now.toISOString();
      needsSave = true;
      console.log(`[cron] Calendar updated: ${fresh.length} rounds`);
    } else if (calendar.length === 0) {
      console.log('[cron] No calendar data available yet');
      return;
    } else {
      console.warn('[cron] Calendar refresh failed — keeping existing calendar');
    }
  }

  // Find events that may have completed and need standings updated
  const eventsToCheck = getEventsNeedingUpdate(calendar, standings, now);

  if (eventsToCheck.length === 0) {
    console.log('[cron] No events to update at this time');
    if (needsSave) {
      await saveData(env, { season: SEASON, lastUpdated: existing.lastUpdated || now.toISOString(), calendarUpdated, calendar, standings });
      console.log('[cron] KV updated (calendar refresh)');
    }
    return;
  }

  console.log(`[cron] Checking ${eventsToCheck.length} event(s)`);

  // Fetch driver roster once — numbers/names are stable across the season
  const driverMap = await loadDriverRoster(eventsToCheck[0]);

  for (const event of eventsToCheck) {
    console.log(`[cron] Fetching standings for ${event.key}`);
    try {
      const newStandings = await fetchStandingsForEvent(event, driverMap);
      const hasPoints = newStandings && Object.values(newStandings).some(d => d.points > 0);
      if (newStandings && Object.keys(newStandings).length > 0 && hasPoints) {
        standings[event.key] = newStandings;
        needsSave = true;
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

  if (needsSave) {
    await saveData(env, {
      season: SEASON,
      lastUpdated: now.toISOString(),
      calendarUpdated,
      calendar,
      standings,
    });
    console.log('[cron] KV updated');
  }
}

/**
 * Returns past events whose standings we don't yet have (or, if forceAll
 * is true, every past event regardless of existing standings — used by
 * the manual /refresh endpoint to look up a specific event by key even
 * if it already has data).
 * Retries indefinitely every cron invocation until data is retrieved —
 * the cron only calls OpenF1 when there is genuinely missing data.
 */
function getEventsNeedingUpdate(calendar, standings, now, forceAll = false) {
  const events = [];
  const minDelayMs = 30 * 60_000; // 30 min OpenF1 free-access delay post-session

  for (const round of calendar) {
    // Sprint session
    if (round.sprintStartUtc) {
      const key    = `${round.round}_sprint`;
      const endMs  = new Date(round.sprintStartUtc).getTime() + 30 * 60_000;

      if (endMs + minDelayMs < now.getTime() && (forceAll || !standings[key])) {
        events.push({ key, round: round.round, type: 'sprint', startUtc: round.sprintStartUtc });
      }
    }

    // Main race
    {
      const key   = String(round.round);
      const endMs = new Date(round.raceStartUtc).getTime() + 120 * 60_000;

      if (endMs + minDelayMs < now.getTime() && (forceAll || !standings[key])) {
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
  // Validate result: no driver should exceed max points for the session type
  // (the beta endpoint sometimes returns cumulative season totals instead of incremental)
  const maxPts = event.type === 'sprint' ? 8 : 25;
  try {
    const result = await fetchOpenF1Championship(sessionKey, driverMap);
    if (result && Object.keys(result).length > 0) {
      if (Object.values(result).every(d => d.points <= maxPts)) return result;
      console.warn(`[cron] championship_drivers returned cumulative data for ${event.key} — using fallback`);
    }
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
 * Fetch the race calendar from Jolpica (Ergast replacement).
 * More reliable than OpenF1 for schedule changes — cancellations and
 * postponements are reflected here sooner, and round numbers are authoritative.
 */
async function fetchCalendar() {
  try {
    const url = `${JOLPICA_BASE}/${SEASON}/races.json?limit=100`;
    const res = await fetchWithTimeout(url, 15_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const races = json?.MRData?.RaceTable?.Races;
    if (!Array.isArray(races) || races.length === 0) throw new Error('No races in response');

    return races.map(race => {
      const sprint = race.Sprint ?? null;
      return {
        round:          Number(race.round),
        name:           race.raceName,
        raceDate:       race.date,
        raceStartUtc:   `${race.date}T${race.time || '00:00:00Z'}`,
        sprintDate:     sprint ? sprint.date : null,
        sprintStartUtc: sprint ? `${sprint.date}T${sprint.time || '00:00:00Z'}` : null,
      };
    });
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
