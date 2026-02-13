/* ── CMK Club Rugby Tipping — v2 ESPN-style ── */

let currentUser = null;
let token = localStorage.getItem('cmk_token');
let allRounds = [], allTeams = [];
let selectedRound = null;
let tipState = {}; // fixture_id -> { winner_id, margin: 'draw'|'1-12'|'13+' }

// ── API ──
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Auth ──
const authPage = document.getElementById('auth-page');
const appEl = document.getElementById('app');
let isLoginMode = true;

document.getElementById('auth-toggle').addEventListener('click', e => {
  e.preventDefault();
  isLoginMode = !isLoginMode;
  document.getElementById('login-form').classList.toggle('hidden', !isLoginMode);
  document.getElementById('register-form').classList.toggle('hidden', isLoginMode);
  document.getElementById('auth-toggle').textContent = isLoginMode ? 'Sign up' : 'Sign in';
  document.getElementById('auth-toggle-text').textContent = isLoginMode ? "Don't have an account?" : 'Already have an account?';
  if (!isLoginMode) loadTeamsForSignup();
});

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  document.getElementById('login-error').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: document.getElementById('login-email').value, password: document.getElementById('login-password').value })
    });
    handleAuth(data);
  } catch (err) { document.getElementById('login-error').textContent = err.message; }
});

let selectedFavTeam = null;

async function loadTeamsForSignup() {
  if (allTeams.length === 0) allTeams = await api('/api/teams');
  const grid = document.getElementById('team-select-grid');
  grid.innerHTML = allTeams.map(t =>
    `<div class="team-option" data-id="${t.id}" style="border-left: 3px solid ${t.color}">${t.name}</div>`
  ).join('');
  grid.querySelectorAll('.team-option').forEach(el => {
    el.addEventListener('click', () => {
      grid.querySelectorAll('.team-option').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      selectedFavTeam = parseInt(el.dataset.id);
    });
  });
}

document.getElementById('register-form').addEventListener('submit', async e => {
  e.preventDefault();
  document.getElementById('reg-error').textContent = '';
  if (!selectedFavTeam) { document.getElementById('reg-error').textContent = 'Pick your team!'; return; }
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        display_name: document.getElementById('reg-name').value,
        email: document.getElementById('reg-email').value,
        password: document.getElementById('reg-password').value,
        fav_team_id: selectedFavTeam
      })
    });
    handleAuth(data);
  } catch (err) { document.getElementById('reg-error').textContent = err.message; }
});

function handleAuth(data) {
  token = data.token;
  currentUser = data.user;
  localStorage.setItem('cmk_token', token);
  showApp();
}

document.getElementById('btn-logout').addEventListener('click', () => {
  token = null; currentUser = null;
  localStorage.removeItem('cmk_token');
  appEl.classList.add('hidden');
  authPage.style.display = 'flex';
});

async function checkAuth() {
  if (!token) return false;
  try { const d = await api('/api/me'); currentUser = d.user; return true; }
  catch { token = null; localStorage.removeItem('cmk_token'); return false; }
}

async function showApp() {
  authPage.style.display = 'none';
  appEl.classList.remove('hidden');
  document.getElementById('user-name-display').textContent = currentUser.display_name;

  // Admin link
  if (currentUser.is_admin) {
    const nav = document.querySelector('.nav-inner');
    if (!nav.querySelector('[data-page="admin"]')) {
      const a = document.createElement('a');
      a.href = '/admin.html';
      a.className = 'nav-link';
      a.innerHTML = '<span class="nav-icon">⚙️</span> Admin';
      nav.appendChild(a);
    }
  }
  await loadData();
}

// ── Data ──
async function loadData() {
  [allTeams, allRounds] = await Promise.all([api('/api/teams'), api('/api/rounds')]);
  renderRoundBar();
  loadLeaderboard();
  loadGroups();
}

// ── Navigation ──
function setupNav() {
  document.querySelectorAll('[data-page]').forEach(a => {
    if (a.getAttribute('href') === '/admin.html') return;
    a.addEventListener('click', e => {
      e.preventDefault();
      const page = a.dataset.page;
      document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
      document.getElementById(`sec-${page}`).classList.add('active');
      document.querySelectorAll('.nav-link, .mobile-nav a').forEach(x => x.classList.remove('active'));
      document.querySelectorAll(`[data-page="${page}"]`).forEach(x => x.classList.add('active'));
      if (page === 'leaderboard') loadLeaderboard();
      if (page === 'groups') loadGroups();
    });
  });
}
setupNav();

// ── Tipping ──
function renderRoundBar() {
  const bar = document.getElementById('round-bar');
  if (allRounds.length === 0) {
    bar.innerHTML = '';
    document.getElementById('fixtures-grid').innerHTML = '<div class="empty-state"><div class="empty-icon">🏉</div><p>No rounds yet — check back when the season kicks off!</p></div>';
    return;
  }
  bar.innerHTML = allRounds.map(r =>
    `<button class="round-pill ${selectedRound && selectedRound.id === r.id ? 'active' : ''}" data-id="${r.id}">R${r.round_number}</button>`
  ).join('');
  bar.querySelectorAll('.round-pill').forEach(pill => {
    pill.addEventListener('click', () => selectRound(allRounds.find(r => r.id === parseInt(pill.dataset.id))));
  });
  if (!selectedRound) {
    const open = allRounds.find(r => r.status === 'open') || allRounds[allRounds.length - 1];
    selectRound(open);
  }
}

async function selectRound(round) {
  selectedRound = round;
  tipState = {};
  renderRoundBar();

  const strip = document.getElementById('round-strip');
  strip.classList.remove('hidden');
  document.getElementById('round-title').textContent = round.name;
  const badge = document.getElementById('round-badge');
  badge.textContent = round.status;
  badge.className = `status-badge status-${round.status}`;
  document.getElementById('round-deadline').textContent = 'Deadline: ' + formatDate(round.deadline);

  const fixtures = await api(`/api/fixtures/round/${round.id}`);
  let existing = [];
  try { existing = await api(`/api/tips/round/${round.id}`); } catch {}
  existing.forEach(t => {
    tipState[t.fixture_id] = { winner_id: t.predicted_winner_id, margin: marginNumToCategory(t.predicted_margin) };
  });

  renderFixtures(fixtures, round);
}

function marginNumToCategory(n) {
  if (n === 0) return 'draw';
  if (n <= 12) return '1-12';
  return '13+';
}

function marginCategoryToNum(cat) {
  if (cat === 'draw') return 0;
  if (cat === '1-12') return 7;
  return 20;
}

function renderFixtures(fixtures, round) {
  const grid = document.getElementById('fixtures-grid');
  const canTip = round.status === 'open' || round.status === 'upcoming';

  if (fixtures.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No fixtures for this round yet.</p></div>';
    document.getElementById('submit-bar').classList.add('hidden');
    return;
  }

  grid.innerHTML = fixtures.map(f => {
    const tip = tipState[f.id];
    const isComplete = f.status === 'completed';

    return `
      <div class="match-card ${tip ? 'tipped' : ''}" data-fid="${f.id}">
        <div class="match-header">
          <span>${f.venue || 'TBC'}</span>
          <span>${f.kickoff ? formatTime(f.kickoff) : ''}</span>
        </div>
        <div class="match-body">
          <div class="team-row ${tip && tip.winner_id === f.home_team_id ? 'picked' : ''}"
               data-fid="${f.id}" data-tid="${f.home_team_id}" ${canTip ? '' : 'style="cursor:default"'}>
            <div class="team-color-bar" style="background:${f.home_color}"></div>
            <div class="team-info">
              <div class="team-name">${f.home_team}</div>
              <div class="team-record">Home</div>
            </div>
            ${isComplete ? `<div class="team-score">${f.home_score}</div>` : ''}
          </div>
          <div class="team-row ${tip && tip.winner_id === f.away_team_id ? 'picked' : ''}"
               data-fid="${f.id}" data-tid="${f.away_team_id}" ${canTip ? '' : 'style="cursor:default"'}>
            <div class="team-color-bar" style="background:${f.away_color}"></div>
            <div class="team-info">
              <div class="team-name">${f.away_team}</div>
              <div class="team-record">Away</div>
            </div>
            ${isComplete ? `<div class="team-score">${f.away_score}</div>` : ''}
          </div>
          ${canTip ? `
          <div class="margin-selector ${tip ? '' : 'hidden'}" id="margin-${f.id}">
            <button class="margin-btn ${tip && tip.margin === 'draw' ? 'selected' : ''}" data-fid="${f.id}" data-margin="draw">Draw</button>
            <button class="margin-btn ${tip && tip.margin === '1-12' ? 'selected' : ''}" data-fid="${f.id}" data-margin="1-12">1–12</button>
            <button class="margin-btn ${tip && tip.margin === '13+' ? 'selected' : ''}" data-fid="${f.id}" data-margin="13+">13+</button>
          </div>
          <div class="margin-label ${tip ? '' : 'hidden'}" id="mlabel-${f.id}">Predicted winning margin</div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (canTip) {
    // Team pick handlers
    grid.querySelectorAll('.team-row[data-tid]').forEach(el => {
      el.addEventListener('click', () => {
        const fid = parseInt(el.dataset.fid);
        const tid = parseInt(el.dataset.tid);
        if (!tipState[fid]) tipState[fid] = { winner_id: tid, margin: '1-12' };
        else tipState[fid].winner_id = tid;

        const card = el.closest('.match-card');
        card.classList.add('tipped');
        card.querySelectorAll('.team-row').forEach(r => r.classList.remove('picked'));
        el.classList.add('picked');

        const ms = document.getElementById(`margin-${fid}`);
        const ml = document.getElementById(`mlabel-${fid}`);
        if (ms) { ms.classList.remove('hidden'); setMarginUI(fid); }
        if (ml) ml.classList.remove('hidden');
        updateSubmit();
      });
    });

    // Margin handlers
    grid.querySelectorAll('.margin-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fid = parseInt(btn.dataset.fid);
        const margin = btn.dataset.margin;
        if (tipState[fid]) tipState[fid].margin = margin;
        setMarginUI(fid);
      });
    });

    document.getElementById('submit-bar').classList.remove('hidden');
    updateSubmit();
  } else {
    document.getElementById('submit-bar').classList.add('hidden');
  }
}

function setMarginUI(fid) {
  const tip = tipState[fid];
  document.querySelectorAll(`.margin-btn[data-fid="${fid}"]`).forEach(b => {
    b.classList.toggle('selected', b.dataset.margin === tip.margin);
  });
}

function updateSubmit() {
  const btn = document.getElementById('btn-submit');
  const count = Object.keys(tipState).length;
  btn.textContent = count > 0 ? `Lock In ${count} Tip${count > 1 ? 's' : ''}` : 'Lock In Tips';
  btn.disabled = count === 0;
}

document.getElementById('btn-submit').addEventListener('click', async () => {
  const tips = Object.entries(tipState).map(([fid, t]) => ({
    fixture_id: parseInt(fid),
    predicted_winner_id: t.winner_id,
    predicted_margin: marginCategoryToNum(t.margin)
  }));
  try {
    await api('/api/tips', { method: 'POST', body: JSON.stringify({ tips }) });
    showToast('Tips locked in!');
  } catch (err) { showToast('Error: ' + err.message); }
});

// ── Leaderboard ──
async function loadLeaderboard() {
  const rows = await api('/api/leaderboard');
  const me = rows.find(r => r.id === currentUser.id);

  document.getElementById('my-stats').innerHTML = `
    <div class="stat-card"><div class="stat-num">${me ? me.total_points : 0}</div><div class="stat-label">Your Points</div></div>
    <div class="stat-card"><div class="stat-num">${me ? (me.correct_tips || 0) : 0}</div><div class="stat-label">Correct Tips</div></div>
    <div class="stat-card"><div class="stat-num">${me ? (me.total_tips || 0) : 0}</div><div class="stat-label">Total Tips</div></div>
    <div class="stat-card"><div class="stat-num">${me ? (rows.indexOf(me) + 1) : '–'}</div><div class="stat-label">Your Rank</div></div>
  `;

  document.getElementById('lb-table').innerHTML = rows.length === 0
    ? '<div class="empty-state"><div class="empty-icon">🏆</div><p>No tips submitted yet.</p></div>'
    : rows.map((r, i) => `
      <div class="lb-row ${i < 3 ? 'top-3' : ''} ${r.id === currentUser.id ? 'is-me' : ''}">
        <div class="lb-pos">${i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}</div>
        <div class="lb-user-info">
          <div class="lb-username">${r.display_name}${r.id === currentUser.id ? ' <span style="color:var(--blue);font-size:0.7rem">(you)</span>' : ''}</div>
        </div>
        <div class="lb-stats">
          <div class="lb-stat-item"><div class="lb-stat-val">${r.correct_tips || 0}/${r.total_tips || 0}</div><div class="lb-stat-label">Correct</div></div>
          <div class="lb-stat-item"><div class="lb-stat-val primary">${r.total_points}</div><div class="lb-stat-label">Points</div></div>
        </div>
      </div>
    `).join('');
}

// ── Groups ──
async function loadGroups() {
  const groups = await api('/api/groups');
  const grid = document.getElementById('groups-grid');
  const lbSec = document.getElementById('group-lb-section');
  lbSec.classList.add('hidden');
  grid.style.display = '';
  document.querySelector('#sec-groups .page-header').style.display = '';
  document.querySelector('#sec-groups .groups-actions').style.display = '';

  grid.innerHTML = groups.length === 0
    ? '<div class="empty-state"><div class="empty-icon">👥</div><p>No groups yet. Create one and share the code!</p></div>'
    : groups.map(g => `
      <div class="group-card" data-gid="${g.id}" data-gname="${g.name}" data-gcode="${g.code}">
        <div><div class="group-name">${g.name}</div><div class="group-meta">${g.member_count} member${g.member_count !== 1 ? 's' : ''}</div></div>
        <span class="group-code">${g.code}</span>
      </div>
    `).join('');

  grid.querySelectorAll('.group-card').forEach(c => {
    c.addEventListener('click', () => showGroupLB(parseInt(c.dataset.gid), c.dataset.gname, c.dataset.gcode));
  });
}

async function showGroupLB(id, name, code) {
  document.getElementById('groups-grid').style.display = 'none';
  document.querySelector('#sec-groups .page-header').style.display = 'none';
  document.querySelector('#sec-groups .groups-actions').style.display = 'none';
  const sec = document.getElementById('group-lb-section');
  sec.classList.remove('hidden');
  document.getElementById('group-lb-title').textContent = name;
  document.getElementById('group-lb-code').textContent = code;

  const rows = await api(`/api/groups/${id}/leaderboard`);
  document.getElementById('group-lb-table').innerHTML = rows.length === 0
    ? '<div class="empty-state"><p>No members yet.</p></div>'
    : rows.map((r, i) => `
      <div class="lb-row ${i < 3 ? 'top-3' : ''}">
        <div class="lb-pos">${i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}</div>
        <div class="lb-user-info"><div class="lb-username">${r.display_name}</div></div>
        <div class="lb-stats">
          <div class="lb-stat-item"><div class="lb-stat-val">${r.correct_tips || 0}/${r.total_tips || 0}</div><div class="lb-stat-label">Correct</div></div>
          <div class="lb-stat-item"><div class="lb-stat-val primary">${r.total_points}</div><div class="lb-stat-label">Points</div></div>
        </div>
      </div>
    `).join('');
}

document.getElementById('btn-back-groups').addEventListener('click', loadGroups);

document.getElementById('btn-create-group').addEventListener('click', async () => {
  const name = prompt('Group name:');
  if (!name) return;
  try {
    const g = await api('/api/groups/create', { method: 'POST', body: JSON.stringify({ name }) });
    showToast(`Group created! Code: ${g.code}`);
    loadGroups();
  } catch (err) { alert(err.message); }
});

document.getElementById('btn-join-group').addEventListener('click', async () => {
  const code = prompt('Enter group code:');
  if (!code) return;
  try {
    await api('/api/groups/join', { method: 'POST', body: JSON.stringify({ code }) });
    showToast('Joined group!');
    loadGroups();
  } catch (err) { alert(err.message); }
});

// ── Helpers ──
function formatDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
  catch { return d; }
}

function formatTime(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleString('en-NZ', { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
  catch { return d; }
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ── Init ──
(async () => {
  if (await checkAuth()) showApp();
  else authPage.style.display = 'flex';
})();
