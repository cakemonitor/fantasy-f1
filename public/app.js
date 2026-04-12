/* ============================================================
   Fantasy F1 2026 — app.js
   Fetches /api/data, renders event panel, leaderboard, chart.
   ============================================================ */

'use strict';

/* ---- Constants ---- */
const API_URL = '/api/data';
const UK_TZ   = 'Europe/London';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/* ---- Module state ---- */
let appData   = null;   // last fetched payload
let chartInst = null;   // Chart.js instance

/* ============================================================
   Bootstrap
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setInterval(loadData, REFRESH_INTERVAL_MS);
});

async function loadData() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    appData = await res.json();
    hideError();
    render(appData);
  } catch (err) {
    showError(`Failed to load data: ${err.message}`);
  }
}

/* ============================================================
   Top-level render
   ============================================================ */
function render(data) {
  renderEventPanel(data);
  renderLeaderboard(data);
  renderChart(data);
}

/* ============================================================
   Event panel
   Three rows:
     1. Most recent event — ✓ confirmed | ⏳ pending
     2. Next upcoming event
     3. Event after that (if exists)
   ============================================================ */
function renderEventPanel(data) {
  const { calendar = [], standings = {} } = data;
  const container = document.getElementById('event-rows');

  // Expand calendar into individual point-scoring events (sprint + race)
  const events = [];
  for (const round of calendar) {
    if (round.sprintStartUtc) {
      events.push({
        round: round.round,
        key: `${round.round}_sprint`,
        name: round.name,
        type: 'Sprint',
        startUtc: round.sprintStartUtc,
        durationMinutes: 30,
      });
    }
    events.push({
      round: round.round,
      key: String(round.round),
      name: round.name,
      type: 'Race',
      startUtc: round.raceStartUtc,
      durationMinutes: 120,
    });
  }

  events.sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc));

  const now = Date.now();

  // Partition into past and future
  const past   = events.filter(e => new Date(e.startUtc).getTime() + e.durationMinutes * 60_000 < now);
  const future = events.filter(e => new Date(e.startUtc).getTime() + e.durationMinutes * 60_000 >= now);

  const rows = [];

  // Most recent past event — only shown while data is still pending
  const lastEvent = past.at(-1);
  let upcomingCount = 3;
  if (lastEvent) {
    const hasData  = Boolean(standings[lastEvent.key] && Object.keys(standings[lastEvent.key]).length > 0);
    const sessionEnd = new Date(lastEvent.startUtc).getTime() + lastEvent.durationMinutes * 60_000;
    const withinPendingWindow = now - sessionEnd < 2 * 60 * 60_000; // 2 hours

    if (!hasData) {
      const detail = withinPendingWindow ? 'Data pending' : 'Data not yet available';
      rows.push({ event: lastEvent, status: 'pending', icon: '⏳', detail, past: true });
      upcomingCount = 2;
    }
  }

  // Upcoming events — 3 if last race is confirmed, 2 if it's still pending
  for (const upcomingEvent of future.slice(0, upcomingCount)) {
    rows.push({
      event: upcomingEvent,
      status: 'upcoming',
      icon: '🗓️',
      detail: formatUkDatetime(upcomingEvent.startUtc),
      past: false,
    });
  }

  if (rows.length === 0) {
    container.innerHTML = '<div class="event-row"><span class="event-detail" style="grid-column:1/-1">No calendar data available.</span></div>';
    return;
  }

  container.innerHTML = rows.map(({ event, status, icon, detail, past: isPast }) => `
    <div class="event-row status-${status}${isPast ? ' past' : ''}">
      <span class="event-icon" aria-hidden="true">${icon}</span>
      <span class="event-name">
        ${escHtml(event.name)}
        ${event.type === 'Sprint' ? '<span class="event-type-badge">Sprint</span>' : ''}
      </span>
      <span class="event-detail">${escHtml(detail)}</span>
    </div>
  `).join('');
}

/* ============================================================
   Leaderboard
   ============================================================ */
function renderLeaderboard(data) {
  const { teams = [], standings = {} } = data;

  // Compute total championship points per team
  const scored = teams.map(team => {
    const driverPoints = computeTeamPoints(team, standings);
    const total = driverPoints + (team.adjustment || 0);
    return { team, driverPoints, total };
  });

  scored.sort((a, b) => b.total - a.total);

  const container = document.getElementById('team-cards');

  if (scored.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:.9rem">No teams configured yet.</p>';
    return;
  }

  container.innerHTML = scored.map(({ team, driverPoints, total }, i) => {
    const rank = i + 1;
    const rankClass = rank <= 3 ? ` rank-${rank}` : '';
    const adj = team.adjustment || 0;
    const adjNote = adj !== 0 ? `<div class="adjustment-note">${adj > 0 ? '+' : ''}${adj} manual adjustment</div>` : '';

    return `
      <div class="team-card" style="--team-color: ${escHtml(team.color || '#444')}">
        <div class="team-rank${rankClass}">${rank}</div>
        <div class="team-info">
          <div class="team-name">${escHtml(team.name)}</div>
          <div class="team-drivers">${team.drivers.map(code => {
            const pts = Object.values(standings).reduce((sum, r) => sum + (r[code]?.points || 0), 0);
            return `${escHtml(code)} <span class="driver-pts">(${pts})</span>`;
          }).join(' · ')}</div>
        </div>
        <div class="team-points">
          <div class="points-value">${total}</div>
          <div class="points-label">pts</div>
          ${adjNote}
        </div>
      </div>
    `;
  }).join('');
}

/* ============================================================
   Chart — points progression
   ============================================================ */
function renderChart(data) {
  const { calendar = [], teams = [], standings = {} } = data;

  // Build list of completed rounds in order
  const completedRounds = getCompletedEvents(calendar, standings);

  if (completedRounds.length === 0) {
    // Nothing to chart yet
    const wrap = document.getElementById('chart-container');
    if (!chartInst) {
      wrap.querySelector('.chart-wrap').innerHTML =
        '<p style="color:var(--text-muted);font-size:.9rem;padding:1rem 0">No race data yet for this season.</p>';
    }
    return;
  }

  const labels = completedRounds.map(e => e.type === 'Sprint' ? `${e.name} (S)` : e.name);

  const datasets = teams.map(team => {
    let cumulative = 0;
    const dataPoints = completedRounds.map(event => {
      const s = standings[event.key] || {};
      cumulative += (team.drivers || []).reduce((sum, code) => sum + ((s[code]?.points) || 0), 0);
      return cumulative;
    });
    // Add manual adjustment to last data point
    if (dataPoints.length > 0 && team.adjustment) {
      dataPoints[dataPoints.length - 1] += (team.adjustment || 0);
    }

    const color = team.color || '#888888';
    return {
      label: team.name,
      data: dataPoints,
      borderColor: color,
      backgroundColor: hexToRgba(color, 0.12),
      pointBackgroundColor: color,
      pointRadius: 3,
      pointHoverRadius: 5,
      tension: 0.3,
      fill: false,
    };
  });

  const ctx = document.getElementById('points-chart');

  if (chartInst) {
    // Update in place
    chartInst.data.labels   = labels;
    chartInst.data.datasets = datasets;
    chartInst.update();
    return;
  }

  chartInst = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          labels: {
            color: '#8891aa',
            font: { size: 12 },
            boxWidth: 12,
          },
        },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2e3349',
          borderWidth: 1,
          titleColor: '#e8eaf0',
          bodyColor: '#8891aa',
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y} pts`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#8891aa', font: { size: 11 }, maxRotation: 45 },
          grid:  { color: '#2e3349' },
        },
        y: {
          ticks: { color: '#8891aa', font: { size: 11 } },
          grid:  { color: '#2e3349' },
          beginAtZero: true,
        },
      },
    },
  });
}

/* ============================================================
   Helpers
   ============================================================ */

/**
 * Sum championship points for a team's drivers across all standings rounds.
 * Returns the raw (pre-adjustment) total.
 */
function computeTeamPoints(team, standings) {
  let total = 0;
  for (const roundData of Object.values(standings)) {
    for (const code of (team.drivers || [])) {
      total += roundData[code]?.points || 0;
    }
  }
  return total;
}

/**
 * Returns completed events (past + data present in standings) in chronological order.
 */
function getCompletedEvents(calendar, standings) {
  const events = [];
  const now = Date.now();

  for (const round of calendar) {
    if (round.sprintStartUtc) {
      const key = `${round.round}_sprint`;
      const sessionEnd = new Date(round.sprintStartUtc).getTime() + 30 * 60_000;
      if (sessionEnd < now && standings[key] && Object.keys(standings[key]).length > 0) {
        events.push({ key, name: round.name, type: 'Sprint', startUtc: round.sprintStartUtc });
      }
    }
    const key = String(round.round);
    const sessionEnd = new Date(round.raceStartUtc).getTime() + 120 * 60_000;
    if (sessionEnd < now && standings[key] && Object.keys(standings[key]).length > 0) {
      events.push({ key, name: round.name, type: 'Race', startUtc: round.raceStartUtc });
    }
  }

  events.sort((a, b) => new Date(a.startUtc) - new Date(b.startUtc));
  return events;
}

/**
 * Format a UTC ISO string as a human-readable UK time.
 * e.g. "Sun 15 Mar, 06:00 GMT"
 */
function formatUkDatetime(isoString) {
  const d = new Date(isoString);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: UK_TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/** Convert #rrggbb to rgba(r,g,b,alpha) */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Minimal HTML escaping */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-message').textContent = msg;
  banner.hidden = false;
}

function hideError() {
  document.getElementById('error-banner').hidden = true;
}

/* Expose appData for admin.js */
window.__f1AppData = () => appData;
