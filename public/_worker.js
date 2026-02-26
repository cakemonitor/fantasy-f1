/**
 * Fantasy F1 2026 — Cloudflare Pages Worker
 *
 * Routes:
 *   GET  /api/data          → serve standings + calendar + teams from KV
 *   POST /api/teams         → password-protected team config save to KV
 *   POST /api/teams/verify  → password verification only (no write)
 *
 * Cron is handled by the standalone fantasy-f1-cron Worker (cron-worker/).
 */

const SEASON = 2026;

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

    // Seed endpoint — password-protected, useful in dev and for manual data loading
    if (url.pathname === '/api/seed' && request.method === 'POST') {
      const authErr = checkAuth(request, env);
      if (authErr) return authErr;
      return handleSeed(request, env);
    }

    // Fall through to static assets (Pages CDN)
    return env.ASSETS.fetch(request);
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
   Dev-only seed handler
   ============================================================ */
async function handleSeed(request, env) {
  let body;
  try { body = await request.json(); } catch { return errorResponse('Invalid JSON', 400); }
  if (body['f1-data'])  await env.F1_DATA.put('f1-data',  JSON.stringify(body['f1-data']));
  if (body['f1-teams']) await env.F1_DATA.put('f1-teams', JSON.stringify(body['f1-teams']));
  return jsonResponse({ seeded: true });
}

/* ============================================================
   Utilities
   ============================================================ */
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
