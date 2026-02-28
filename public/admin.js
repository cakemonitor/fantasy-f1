/* ============================================================
   Fantasy F1 2026 — admin.js
   In-app admin panel: authenticate, edit teams, save to KV.
   ============================================================ */

'use strict';

const SESSION_KEY = 'f1_admin_password';

/* ============================================================
   Bootstrap
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('admin-trigger').addEventListener('click', openAdminPanel);
  document.getElementById('admin-close').addEventListener('click', closeAdminPanel);
  document.getElementById('admin-login').addEventListener('click', handleLogin);
  document.getElementById('admin-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleLogin();
  });
  document.getElementById('add-team-btn').addEventListener('click', addTeamRow);
  document.getElementById('save-teams-btn').addEventListener('click', saveTeams);

  // Close dialog when clicking backdrop
  document.getElementById('admin-panel').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAdminPanel();
  });
});

/* ============================================================
   Panel open / close
   ============================================================ */
function openAdminPanel() {
  const dialog = document.getElementById('admin-panel');
  const storedPw = sessionStorage.getItem(SESSION_KEY);

  if (storedPw) {
    // Already authenticated this session
    showEditor(storedPw);
  } else {
    showAuth();
  }

  dialog.showModal();
}

function closeAdminPanel() {
  document.getElementById('admin-panel').close();
}

function showAuth() {
  document.getElementById('admin-auth').hidden   = false;
  document.getElementById('admin-editor').hidden = true;
  document.getElementById('auth-error').hidden   = true;
  document.getElementById('admin-password').value = '';
}

function showEditor(password) {
  document.getElementById('admin-auth').hidden   = true;
  document.getElementById('admin-editor').hidden = false;
  renderTeamEditor();
}

/* ============================================================
   Authentication
   ============================================================ */
async function handleLogin() {
  const pw = document.getElementById('admin-password').value.trim();
  if (!pw) return;

  // Verify password by making a POST with empty teams array
  // (the server validates auth before anything else)
  const btn = document.getElementById('admin-login');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  try {
    const res = await fetch('/api/teams/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pw}`,
      },
      body: JSON.stringify({ verify: true }),
    });

    if (res.ok) {
      sessionStorage.setItem(SESSION_KEY, pw);
      showEditor(pw);
      document.getElementById('auth-error').hidden = true;
    } else {
      document.getElementById('auth-error').hidden = false;
    }
  } catch {
    document.getElementById('auth-error').hidden = false;
    document.getElementById('auth-error').textContent = 'Network error. Try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

/* ============================================================
   Team editor render
   ============================================================ */
function renderTeamEditor() {
  const data  = window.__f1AppData?.() || {};
  const teams = structuredClone(data.teams || []);
  renderTeamList(teams);
}

let _currentTeams = [];

function renderTeamList(teams) {
  _currentTeams = teams;
  const list = document.getElementById('team-editor-list');

  if (teams.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:.9rem">No teams yet. Add one below.</p>';
    return;
  }

  list.innerHTML = teams.map((team, i) => buildTeamCard(team, i)).join('');

  // Attach events
  list.querySelectorAll('.remove-team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _currentTeams.splice(Number(btn.dataset.index), 1);
      renderTeamList(_currentTeams);
    });
  });

  list.querySelectorAll('.team-color-picker').forEach(picker => {
    picker.addEventListener('input', () => {
      const card = picker.closest('.team-editor-card');
      card.querySelector('.team-color-hex').value = picker.value;
      card.style.setProperty('--team-color', picker.value);
    });
  });

  list.querySelectorAll('.team-color-hex').forEach(hex => {
    hex.addEventListener('input', () => {
      const card = hex.closest('.team-editor-card');
      if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) {
        card.querySelector('.team-color-picker').value = hex.value;
        card.style.setProperty('--team-color', hex.value);
      }
    });
  });
}

function buildTeamCard(team, index) {
  const color = team.color || '#888888';
  const d0 = escHtml(team.drivers?.[0] || '');
  const d1 = escHtml(team.drivers?.[1] || '');
  const adj = team.adjustment || 0;

  return `
    <div class="team-editor-card" style="--team-color: ${escHtml(color)}">
      <div class="team-editor-row full">
        <div>
          <div class="field-label">Team Name</div>
          <input type="text" class="team-field" data-index="${index}" data-field="name"
            value="${escHtml(team.name || '')}" placeholder="My Team" />
        </div>
      </div>
      <div class="team-editor-row">
        <div>
          <div class="field-label">Driver 1 Code</div>
          <input type="text" class="team-field driver-code" data-index="${index}" data-field="driver0"
            value="${d0}" placeholder="e.g. VER" maxlength="3" style="text-transform:uppercase" />
        </div>
        <div>
          <div class="field-label">Driver 2 Code</div>
          <input type="text" class="team-field driver-code" data-index="${index}" data-field="driver1"
            value="${d1}" placeholder="e.g. NOR" maxlength="3" style="text-transform:uppercase" />
        </div>
      </div>
      <div class="team-editor-row">
        <div>
          <div class="field-label">Colour</div>
          <div class="color-input-group">
            <input type="color" class="team-color-picker" data-index="${index}"
              value="${escHtml(color)}" />
            <input type="text" class="team-field team-color-hex" data-index="${index}" data-field="color"
              value="${escHtml(color)}" maxlength="7" placeholder="#888888" />
          </div>
        </div>
        <div>
          <div class="field-label">Manual Adjustment (pts)</div>
          <input type="number" class="team-field" data-index="${index}" data-field="adjustment"
            value="${adj}" placeholder="0" />
        </div>
      </div>
      <div class="team-editor-actions">
        <button class="remove-team-btn" data-index="${index}">Remove team</button>
      </div>
    </div>
  `;
}

function addTeamRow() {
  _currentTeams.push({ name: '', drivers: ['', ''], color: '#888888', adjustment: 0 });
  renderTeamList(_currentTeams);
  // Scroll to new card
  document.getElementById('team-editor-list').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

/* ============================================================
   Save teams
   ============================================================ */
async function saveTeams() {
  const pw = sessionStorage.getItem(SESSION_KEY);
  if (!pw) { showAuth(); return; }

  // Collect current field values
  const teams = collectTeamValues();
  const errors = validateTeams(teams);
  if (errors.length > 0) {
    showSaveStatus(errors.join(' '), false);
    return;
  }

  const btn = document.getElementById('save-teams-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await fetch('/api/teams', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pw}`,
      },
      body: JSON.stringify({ teams }),
    });

    if (res.ok) {
      showSaveStatus('Saved successfully.', true);
      // Refresh app data
      if (typeof loadData === 'function') loadData();
    } else if (res.status === 401) {
      sessionStorage.removeItem(SESSION_KEY);
      showAuth();
    } else {
      const body = await res.json().catch(() => ({}));
      showSaveStatus(body.error || `Save failed (HTTP ${res.status}).`, false);
    }
  } catch {
    showSaveStatus('Network error. Try again.', false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

function collectTeamValues() {
  const teams = structuredClone(_currentTeams);
  document.querySelectorAll('.team-field').forEach(input => {
    const index = Number(input.dataset.index);
    const field = input.dataset.field;
    const val   = input.value.trim();
    if (!teams[index]) return;
    if (field === 'driver0') {
      if (!teams[index].drivers) teams[index].drivers = ['', ''];
      teams[index].drivers[0] = val.toUpperCase();
    } else if (field === 'driver1') {
      if (!teams[index].drivers) teams[index].drivers = ['', ''];
      teams[index].drivers[1] = val.toUpperCase();
    } else if (field === 'adjustment') {
      teams[index].adjustment = parseInt(val, 10) || 0;
    } else {
      teams[index][field] = val;
    }
  });
  return teams;
}

function validateTeams(teams) {
  const errors = [];
  if (teams.length > 10) errors.push('Maximum 10 teams allowed.');

  teams.forEach((team, i) => {
    const label = `Team ${i + 1}`;
    if (!team.name) errors.push(`${label}: name is required.`);

    const [d0, d1] = team.drivers || [];
    if (!d0) errors.push(`${label}: Driver 1 code is required.`);
    if (!d1) errors.push(`${label}: Driver 2 code is required.`);

    if (d0 && d1 && d0 === d1) errors.push(`${label}: Both drivers cannot be the same.`);

  });

  return errors;
}

function showSaveStatus(msg, ok) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = `save-status ${ok ? 'ok' : 'err'}`;
  el.hidden = false;
  if (ok) setTimeout(() => { el.hidden = true; }, 4000);
}

/* ---- Escape helper (mirrors app.js) ---- */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
