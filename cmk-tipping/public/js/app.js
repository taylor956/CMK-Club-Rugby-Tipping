/* ── CMK Club Rugby Tipping — Frontend ── */

const API = '';
let currentUser = null;
let token = localStorage.getItem('cmk_token');
let allRounds = [];
let allTeams = [];
let selectedRound = null;
let tipState = {}; // fixture_id -> { winner_id, margin }

// ── API Helper ──────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Auth ─────────────────────────────────────────────────────────────────

const authPage = document.getElementById('auth-page');
const appEl = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const regForm = document.getElementById('register-form');
const authToggle = document.getElementById('auth-toggle');
const authToggleText = document.getElementById('auth-toggle-text');
let isLoginMode = true;

authToggle.addEventListener('click', e => {
  e.preventDefault();
  isLoginMode = !isLoginMode;
  loginForm.classList.toggle('hidden', !isLoginMode);
  regForm.classList.toggle('hidden', isLoginMode);
  authToggle.textContent = isLoginMode ? 'Sign up' : 'Sign in';
  authToggleText.textContent = isLoginMode ? "Don't have an account?" : 'Already have an account?';
});

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  document.getElementById('login-error').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
      })
    });
    handleAuth(data);
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
});

regForm.addEventListener('submit', async e => {
  e.preventDefault();
  document.getElementById('reg-error').textContent = '';
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        display_name: document.getElementById('reg-name').value,
        email: document.getElementById('reg-email').value,
        password: document.getElementById('reg-password').value
      })
    });
    handleAuth(data);
  } catch (err) {
    document.getElementById('reg-error').textContent = err.message;
  }
});

function handleAuth(data) {
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('cmk_token', token);
  showApp();
}

document.getElementById('btn-logout').addEventListener('click', () => {
  token = null;
  currentUser = null;
  localStorage.removeItem('cmk_token');
  appEl.classList.add('hidden');
  authPage.style.display = 'flex';
});

async function checkAuth() {
  if (!token) return false;
  try {
    const data = await api('/api/me');
    currentUser = data.user;
    return true;
  } catch {
    token = null;
    localStorage.removeItem('cmk_token');
    return false;
  }
}

async function showApp() {
  authPage.style.display = 'none';
  appEl.classList.remove('hidden');
  document.getElementById('user-name-badge').textContent = currentUser.display_name;

  // Check if admin — show link if so
  const nav = document.querySelector('.nav-bar');
  const existingAdmin = nav.querySelector('[data-page="admin"]');
  if (currentUser.is_admin && !existingAdmin) {
    const a = document.createElement('a');
    a.href = '/admin.html';
    a.innerHTML = '<span class="nav-icon">⚙️</span>Admin';
    nav.appendChild(a);
  }

  await loadData();
}

// ── Data Loading ────────────────────────────────────────────────────────

async function loadData() {
  [allTeams, allRounds] = await Promise.all([
    api('/api/teams'),
    api('/api/rounds')
  ]);
  renderRoundSelector();
  loadLeaderboard();
  loadGroups();
}

// ── Navigation ──────────────────────────────────────────────────────────

document.querySelectorAll('.nav-bar a[data-page]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    const page = a.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll('.nav-bar a').forEach(x => x.classList.remove('active'));
    a.classList.add('active');
    if (page === 'leaderboard') loadLeaderboard();
    if (page === 'groups') loadGroups();
  });
});

// ── Tipping ─────────────────────────────────────────────────────────────

function renderRoundSelector() {
  const el = document.getElementById('round-selector');
  if (allRounds.length === 0) {
    el.innerHTML = '';
    document.getElementById('fixtures-list').innerHTML = `
      <div class="empty-state">
        <div class="icon">🏉</div>
        <p>No rounds yet — check back soon!</p>
      </div>
    `;
    return;
  }
  el.innerHTML = allRounds.map(r => `
    <button class="round-chip ${selectedRound && selectedRound.id === r.id ? 'active' : ''}"
            data-round-id="${r.id}">
      R${r.round_number}
    </button>
  `).join('');

  el.querySelectorAll('.round-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const round = allRounds.find(r => r.id === parseInt(chip.dataset.roundId));
      selectRound(round);
    });
  });

  // Auto-select first open round, or the latest
  if (!selectedRound) {
    const open = allRounds.find(r => r.status === 'open') || allRounds[allRounds.length - 1];
    selectRound(open);
  }
}

async function selectRound(round) {
  selectedRound = round;
  tipState = {};
  renderRoundSelector();

  // Show round info
  const infoEl = document.getElementById('round-info');
  infoEl.classList.remove('hidden');
  document.getElementById('round-title').textContent = round.name;
  const badge = document.getElementById('round-badge');
  badge.textContent = round.status;
  badge.className = `card-badge badge-${round.status}`;
  document.getElementById('round-deadline').textContent = formatDate(round.deadline);

  // Load fixtures
  const fixtures = await api(`/api/fixtures/round/${round.id}`);

  // Load existing tips
  let existingTips = [];
  try {
    existingTips = await api(`/api/tips/round/${round.id}`);
  } catch {}

  existingTips.forEach(t => {
    tipState[t.fixture_id] = { winner_id: t.predicted_winner_id, margin: t.predicted_margin };
  });

  renderFixtures(fixtures, round);
}

function renderFixtures(fixtures, round) {
  const list = document.getElementById('fixtures-list');
  const canTip = round.status === 'open' || round.status === 'upcoming';
  const isCompleted = round.status === 'completed' || round.status === 'closed';

  if (fixtures.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">📋</div>
        <p>No fixtures for this round yet.</p>
      </div>
    `;
    document.getElementById('btn-submit-tips').classList.add('hidden');
    return;
  }

  list.innerHTML = fixtures.map(f => {
    const tip = tipState[f.id];
    const homeWin = f.home_score !== null && f.home_score > f.away_score;
    const awayWin = f.home_score !== null && f.away_score > f.home_score;

    return `
      <div class="fixture ${tip ? 'selected' : ''}" data-fixture-id="${f.id}">
        <div class="fixture-teams">
          <div class="fixture-team ${tip && tip.winner_id === f.home_team_id ? 'picked' : ''}"
               data-team-id="${f.home_team_id}" data-fixture-id="${f.id}"
               style="--team-color:${f.home_color}">
            <div class="team-name">${f.home_team}</div>
            <div class="team-short">${f.home_short}</div>
            ${f.status === 'completed' ? `<div class="fixture-score">${f.home_score}</div>` : ''}
          </div>
          <div class="fixture-vs">${f.status === 'completed' ? '—' : 'vs'}</div>
          <div class="fixture-team ${tip && tip.winner_id === f.away_team_id ? 'picked' : ''}"
               data-team-id="${f.away_team_id}" data-fixture-id="${f.id}"
               style="--team-color:${f.away_color}">
            <div class="team-name">${f.away_team}</div>
            <div class="team-short">${f.away_short}</div>
            ${f.status === 'completed' ? `<div class="fixture-score">${f.away_score}</div>` : ''}
          </div>
        </div>
        ${canTip ? `
        <div class="margin-input ${tip ? '' : 'hidden'}" id="margin-${f.id}">
          <label>Winning margin:</label>
          <input type="number" min="0" max="100" value="${tip ? tip.margin : 0}"
                 data-fixture-id="${f.id}" placeholder="0">
        </div>
        ` : ''}
        <div class="fixture-meta">
          <span>${f.venue || ''}</span>
          <span>${f.kickoff ? formatTime(f.kickoff) : ''}</span>
        </div>
      </div>
    `;
  }).join('');

  // Team selection click handlers
  if (canTip) {
    list.querySelectorAll('.fixture-team').forEach(el => {
      el.addEventListener('click', () => {
        const fid = parseInt(el.dataset.fixtureId);
        const tid = parseInt(el.dataset.teamId);

        if (!tipState[fid]) tipState[fid] = { winner_id: tid, margin: 0 };
        else tipState[fid].winner_id = tid;

        // Update UI
        const fixtureEl = el.closest('.fixture');
        fixtureEl.classList.add('selected');
        fixtureEl.querySelectorAll('.fixture-team').forEach(t => t.classList.remove('picked'));
        el.classList.add('picked');
        const marginEl = document.getElementById(`margin-${fid}`);
        if (marginEl) marginEl.classList.remove('hidden');

        updateSubmitButton();
      });
    });

    // Margin input handlers
    list.querySelectorAll('.margin-input input').forEach(input => {
      input.addEventListener('change', () => {
        const fid = parseInt(input.dataset.fixtureId);
        if (tipState[fid]) tipState[fid].margin = parseInt(input.value) || 0;
      });
    });

    document.getElementById('btn-submit-tips').classList.remove('hidden');
    updateSubmitButton();
  } else {
    document.getElementById('btn-submit-tips').classList.add('hidden');
  }
}

function updateSubmitButton() {
  const btn = document.getElementById('btn-submit-tips');
  const count = Object.keys(tipState).length;
  btn.textContent = count > 0 ? `Lock In ${count} Tip${count > 1 ? 's' : ''}` : 'Lock In Tips';
  btn.disabled = count === 0;
}

document.getElementById('btn-submit-tips').addEventListener('click', async () => {
  const tips = Object.entries(tipState).map(([fid, t]) => ({
    fixture_id: parseInt(fid),
    predicted_winner_id: t.winner_id,
    predicted_margin: t.margin || 0
  }));
  try {
    await api('/api/tips', { method: 'POST', body: JSON.stringify({ tips }) });
    showToast('Tips locked in!');
  } catch (err) {
    showToast('Error: ' + err.message);
  }
});

// ── Leaderboard ─────────────────────────────────────────────────────────

async function loadLeaderboard() {
  const rows = await api('/api/leaderboard');
  const list = document.getElementById('leaderboard-list');

  // Find current user's points
  const me = rows.find(r => r.id === currentUser.id);
  document.getElementById('my-total-points').textContent = me ? me.total_points : 0;

  if (rows.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">🏆</div>
        <p>No tips submitted yet. Be the first!</p>
      </div>
    `;
    return;
  }

  list.innerHTML = rows.map((r, i) => `
    <div class="leaderboard-row ${i < 3 ? 'top-3' : ''} ${r.id === currentUser.id ? 'selected' : ''}">
      <div class="lb-rank">${i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}</div>
      <div class="lb-name">
        ${r.display_name}
        ${r.id === currentUser.id ? '<span style="font-size:0.7rem;color:var(--accent)"> (you)</span>' : ''}
      </div>
      <div>
        <div class="lb-points">${r.total_points} pts</div>
        <div class="lb-detail">${r.correct_tips || 0}/${r.total_tips || 0} correct</div>
      </div>
    </div>
  `).join('');
}

// ── Groups ──────────────────────────────────────────────────────────────

async function loadGroups() {
  const groups = await api('/api/groups');
  const list = document.getElementById('groups-list');
  const lbSection = document.getElementById('group-leaderboard-section');
  lbSection.classList.add('hidden');
  list.parentElement.querySelectorAll('.page-title, .page-subtitle, .flex').forEach(e => e.style.display = '');

  if (groups.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">👥</div>
        <p>No groups yet. Create one and share the code with your mates!</p>
      </div>
    `;
    return;
  }

  list.innerHTML = groups.map(g => `
    <div class="group-card" data-group-id="${g.id}" data-group-name="${g.name}" data-group-code="${g.code}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:700">${g.name}</div>
          <div style="font-size:0.8rem;color:var(--text-dim)">${g.member_count} member${g.member_count !== 1 ? 's' : ''}</div>
        </div>
        <span class="group-code">${g.code}</span>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.group-card').forEach(card => {
    card.addEventListener('click', () => {
      showGroupLeaderboard(
        parseInt(card.dataset.groupId),
        card.dataset.groupName,
        card.dataset.groupCode
      );
    });
  });
}

async function showGroupLeaderboard(groupId, name, code) {
  const list = document.getElementById('groups-list');
  list.innerHTML = '';
  list.parentElement.querySelectorAll('.page-title, .page-subtitle, .flex').forEach(e => e.style.display = 'none');

  const lbSection = document.getElementById('group-leaderboard-section');
  lbSection.classList.remove('hidden');
  document.getElementById('group-lb-title').textContent = name;
  document.getElementById('group-lb-code-val').textContent = code;

  const rows = await api(`/api/groups/${groupId}/leaderboard`);
  const lbList = document.getElementById('group-leaderboard-list');

  if (rows.length === 0) {
    lbList.innerHTML = '<div class="empty-state"><p>No members yet.</p></div>';
    return;
  }

  lbList.innerHTML = rows.map((r, i) => `
    <div class="leaderboard-row ${i < 3 ? 'top-3' : ''}">
      <div class="lb-rank">${i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}</div>
      <div class="lb-name">${r.display_name}</div>
      <div>
        <div class="lb-points">${r.total_points} pts</div>
        <div class="lb-detail">${r.correct_tips || 0}/${r.total_tips || 0} correct</div>
      </div>
    </div>
  `).join('');
}

document.getElementById('btn-back-groups').addEventListener('click', () => loadGroups());

document.getElementById('btn-create-group').addEventListener('click', async () => {
  const name = prompt('Enter a group name:');
  if (!name) return;
  try {
    const group = await api('/api/groups/create', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    showToast(`Group created! Code: ${group.code}`);
    loadGroups();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('btn-join-group').addEventListener('click', async () => {
  const code = prompt('Enter group code:');
  if (!code) return;
  try {
    await api('/api/groups/join', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    showToast('Joined group!');
    loadGroups();
  } catch (err) {
    alert(err.message);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-NZ', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit'
    });
  } catch { return d; }
}

function formatTime(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('en-NZ', {
      hour: 'numeric', minute: '2-digit'
    });
  } catch { return d; }
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ── Init ─────────────────────────────────────────────────────────────────

(async () => {
  if (await checkAuth()) {
    showApp();
  } else {
    authPage.style.display = 'flex';
  }
})();
