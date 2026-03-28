require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { initSchema, run, all, get, transaction } = require('./db');
const players   = require('./players.json');
const cricinfo  = require('./cricinfo');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_prod';
const DEADLINE   = process.env.DEADLINE ? new Date(process.env.DEADLINE) : new Date('2026-03-28T14:00:00.000Z');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const loginLimiter    = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
const registerLimiter = rateLimit({ windowMs: 60*60*1000, max: 20 });
const syncLimiter     = rateLimit({ windowMs:  5*60*1000, max:  5, message: { error: 'Too many sync requests. Wait 5 minutes.' } });

// ─── Middleware ───────────────────────────────────────────────────────────
function isDeadlinePassed() { return new Date() > DEADLINE; }

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired. Please login again.' }); }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin auth required' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.user = d; next();
  } catch { res.status(401).json({ error: 'Invalid admin token' }); }
}

// ─── Team validation ──────────────────────────────────────────────────────
function validateTeam(playerNames) {
  const errors = [];
  if (playerNames.length !== 11) { errors.push('Select exactly 11 players'); return errors; }
  const sel = playerNames.map(n => {
    const p = players.find(pl => pl.name === n);
    if (!p) errors.push(`Player not found: ${n}`);
    return p;
  }).filter(Boolean);
  if (errors.length) return errors;
  if (sel.reduce((s,p) => s + p.points, 0) > 1000) errors.push('Total points exceed 1000 limit');
  const os = sel.filter(p => p.nation === 'Overseas').length;
  if (os > 4) errors.push(`Max 4 overseas players (you picked ${os})`);
  const wk   = sel.filter(p => p.type === 'WK-Batter').length;
  const bat  = sel.filter(p => p.type === 'Batter').length;
  const ar   = sel.filter(p => p.type === 'All-Rounder').length;
  const bowl = sel.filter(p => p.type === 'Bowler').length;
  if (wk   < 1 || wk   > 2) errors.push(`WK: 1–2 required (got ${wk})`);
  if (bat  < 3 || bat  > 5) errors.push(`Batters: 3–5 required (got ${bat})`);
  if (ar   < 1 || ar   > 3) errors.push(`All-Rounders: 1–3 required (got ${ar})`);
  if (bowl < 3 || bowl > 5) errors.push(`Bowlers: 3–5 required (got ${bowl})`);
  if (new Set(playerNames).size !== playerNames.length) errors.push('Duplicate players not allowed');
  return errors;
}

// ─── Name matcher ──────────────────────────────────────────────────────────
const NAME_INDEX = (() => {
  const idx = {};
  players.forEach(p => {
    const last = p.name.toLowerCase().split(' ').pop();
    if (!idx[last]) idx[last] = [];
    idx[last].push(p);
  });
  return idx;
})();

function matchPlayerName(cn) {
  if (!cn) return null;
  const clean = cn.trim();
  const exact = players.find(p => p.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.name;
  const parts = clean.toLowerCase().split(' ');
  const last  = parts[parts.length - 1];
  const cands = NAME_INDEX[last] || [];
  if (cands.length === 1) return cands[0].name;
  const byInit = cands.filter(p => p.name.toLowerCase().split(' ')[0].startsWith(parts[0][0]));
  if (byInit.length >= 1) return byInit[0].name;
  return players.find(p => p.name.toLowerCase().includes(last))?.name || null;
}

// ─── Recalculate team totals ───────────────────────────────────────────────
async function recalcTeams() {
  const teams = await all('SELECT id FROM teams');
  for (const team of teams) {
    const rows = await all(`
      SELECT COALESCE(SUM(COALESCE(ps.actual_score, 0)), 0) as total
      FROM team_players tp
      LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
      WHERE tp.team_id = ?`, [team.id]);
    const total = rows[0]?.total || 0;
    await run('UPDATE teams SET total_points = ? WHERE id = ?', [total, team.id]);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { username, password, name, mobile } = req.body;
    if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (!password || password.length < 6)         return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!name || name.trim().length < 2)           return res.status(400).json({ error: 'Full name is required' });
    const u = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (u !== username.trim().toLowerCase()) return res.status(400).json({ error: 'Username: letters, numbers and underscore only' });
    const existing = await get('SELECT id FROM users WHERE username = ?', [u]);
    if (existing) return res.status(400).json({ error: 'Username already taken. Please choose another.' });
    const hash = await bcrypt.hash(password, 10);
    await run('INSERT INTO users (username, password_hash, name, mobile) VALUES (?, ?, ?, ?)', [u, hash, name.trim(), mobile?.trim() || '']);
    const user  = await get('SELECT * FROM users WHERE username = ?', [u]);
    const token = jwt.sign({ userId: user.id, username: u, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, username: u, name: user.name } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await get('SELECT * FROM users WHERE username = ?', [username.trim().toLowerCase()]);
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ userId: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (req.body.username !== ADMIN_USER || req.body.password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid admin credentials' });
  res.json({ success: true, token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }) });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!(await bcrypt.compare(currentPassword, user.password_hash)))
      return res.status(401).json({ error: 'Current password is incorrect' });
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, 10), user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// GENERAL
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/players', (req, res) => res.json(players));

app.get('/api/config', async (req, res) => {
  try {
    const row     = await get('SELECT COUNT(*) as c FROM teams');
    const lastSync = await get('SELECT * FROM match_log ORDER BY synced_at DESC LIMIT 1');
    res.json({ deadline: DEADLINE.toISOString(), deadlinePassed: isDeadlinePassed(), seriesId: cricinfo.SERIES_ID, teamCount: row?.c || 0, lastSync: lastSync || null });
  } catch(e) { res.json({ deadline: DEADLINE.toISOString(), deadlinePassed: isDeadlinePassed(), teamCount: 0, lastSync: null }); }
});

// ══════════════════════════════════════════════════════════════════════════
// TEAM
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/team', authMiddleware, async (req, res) => {
  try {
    if (isDeadlinePassed()) return res.status(400).json({ error: 'Deadline passed. Submissions are closed.' });
    const { teamName, players: pNames } = req.body;
    if (!teamName?.trim())      return res.status(400).json({ error: 'Team name is required' });
    if (!Array.isArray(pNames)) return res.status(400).json({ error: 'Players list required' });
    const errors = validateTeam(pNames);
    if (errors.length) return res.status(400).json({ error: errors.join(' | ') });
    const existing = await get('SELECT id FROM teams WHERE user_id = ?', [req.user.userId]);
    if (existing) return res.status(400).json({ error: 'You already submitted a team. One team per user only.' });
    const sel = pNames.map(n => players.find(p => p.name === n));

    // Insert team + players in one go
    const teamResult = await run('INSERT INTO teams (user_id, team_name, total_points) VALUES (?, ?, 0)', [req.user.userId, teamName.trim()]);
    const teamId = Number(teamResult.lastInsertRowid);
    for (const p of sel) {
      await run('INSERT INTO team_players (team_id, player_name, player_type, player_nation, player_team, fantasy_points) VALUES (?, ?, ?, ?, ?, ?)',
        [teamId, p.name, p.type, p.nation, p.team, p.points]);
    }
    res.json({ success: true, teamId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/team/me', authMiddleware, async (req, res) => {
  try {
    const team = await get('SELECT * FROM teams WHERE user_id = ?', [req.user.userId]);
    if (!team) return res.json({ team: null });
    const teamPlayers = await all(`
      SELECT tp.*, COALESCE(ps.actual_score, 0) as earned_score, COALESCE(ps.matches_played, 0) as matches_played
      FROM team_players tp
      LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
      WHERE tp.team_id = ?`, [team.id]);
    res.json({ team: { ...team, players: teamPlayers } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/teams', adminMiddleware, async (req, res) => {
  try {
    const teams = await all('SELECT t.*, u.name as user_name, u.username FROM teams t JOIN users u ON t.user_id = u.id ORDER BY t.total_points DESC, t.submitted_at ASC');
    for (const t of teams) {
      t.players = await all(`SELECT tp.*, COALESCE(ps.actual_score, 0) as earned_score
        FROM team_players tp LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
        WHERE tp.team_id = ?`, [t.id]);
    }
    res.json({ teams, count: teams.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    res.json({ users: await all('SELECT id, username, name, mobile, created_at FROM users ORDER BY created_at DESC') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reset-password', adminMiddleware, async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) return res.status(400).json({ error: 'username and newPassword required' });
    const user = await get('SELECT id FROM users WHERE username = ?', [username.toLowerCase()]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, 10), user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/scores', adminMiddleware, async (req, res) => {
  try { res.json({ scores: await all('SELECT * FROM player_scores ORDER BY actual_score DESC') }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/scores', adminMiddleware, async (req, res) => {
  try {
    const { scores } = req.body;
    if (!Array.isArray(scores)) return res.status(400).json({ error: 'scores array required' });
    for (const { playerName, score } of scores) {
      await run(`INSERT INTO player_scores (player_name, actual_score, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(player_name) DO UPDATE SET actual_score = excluded.actual_score, updated_at = excluded.updated_at`,
        [playerName, score]);
    }
    await recalcTeams();
    res.json({ success: true, updated: scores.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/match-log', adminMiddleware, async (req, res) => {
  try { res.json({ log: await all('SELECT * FROM match_log ORDER BY synced_at DESC') }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// CRICINFO AUTO-SYNC
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/cricinfo/schedule', adminMiddleware, syncLimiter, async (req, res) => {
  try {
    const matches = await cricinfo.getSchedule();
    const syncedRows = await all('SELECT match_id FROM match_log');
    const synced = syncedRows.map(r => String(r.match_id));
    res.json({ success: true, matches: matches.map(m => ({ ...m, alreadySynced: synced.includes(String(m.matchId)) })) });
  } catch(e) { res.status(500).json({ error: 'ESPNcricinfo unavailable: ' + e.message }); }
});

app.post('/api/admin/cricinfo/sync-match', adminMiddleware, syncLimiter, async (req, res) => {
  try {
    const { matchId, matchTitle } = req.body;
    if (!matchId) return res.status(400).json({ error: 'matchId required' });
    const already = await get('SELECT id FROM match_log WHERE match_id = ?', [String(matchId)]);
    if (already) return res.status(400).json({ error: 'Match already synced. Use Re-sync to overwrite.' });
    const { playerScores } = await cricinfo.getScorecard(matchId);
    const matched = [], unmatched = [];
    for (const [cn, pts] of Object.entries(playerScores)) {
      const our = matchPlayerName(cn);
      if (our) {
        await run(`INSERT INTO player_scores (player_name, actual_score, matches_played, updated_at)
          VALUES (?, ?, 1, datetime('now'))
          ON CONFLICT(player_name) DO UPDATE SET
            actual_score   = actual_score + excluded.actual_score,
            matches_played = matches_played + 1,
            updated_at     = excluded.updated_at`,
          [our, pts]);
        matched.push({ cricName: cn, ourName: our, pts });
      } else { unmatched.push({ cricName: cn, pts }); }
    }
    await run('INSERT INTO match_log (match_id, match_title) VALUES (?, ?)', [String(matchId), matchTitle || '']);
    await recalcTeams();
    res.json({ success: true, matchId, matched: matched.length, unmatched: unmatched.length, matchedPlayers: matched, unmatchedPlayers: unmatched });
  } catch(e) { res.status(500).json({ error: 'Sync failed: ' + e.message }); }
});

app.post('/api/admin/cricinfo/sync-all', adminMiddleware, syncLimiter, async (req, res) => {
  try {
    const allScores = await cricinfo.getAllCompletedScores();
    const matched = [], unmatched = [];
    for (const [cn, pts] of Object.entries(allScores)) {
      const our = matchPlayerName(cn);
      if (our) {
        await run(`INSERT INTO player_scores (player_name, actual_score, matches_played, updated_at)
          VALUES (?, ?, 1, datetime('now'))
          ON CONFLICT(player_name) DO UPDATE SET actual_score = excluded.actual_score, updated_at = excluded.updated_at`,
          [our, pts]);
        matched.push(our);
      } else { unmatched.push(cn); }
    }
    await recalcTeams();
    res.json({ success: true, matched: matched.length, unmatched: unmatched.length, unmatchedPlayers: unmatched });
  } catch(e) { res.status(500).json({ error: 'Sync failed: ' + e.message }); }
});

app.post('/api/admin/cricinfo/remap', adminMiddleware, async (req, res) => {
  try {
    const { mappings } = req.body;
    if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings required' });
    for (const { ourName, pts } of mappings) {
      await run(`INSERT INTO player_scores (player_name, actual_score, matches_played, updated_at)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(player_name) DO UPDATE SET
          actual_score   = actual_score + excluded.actual_score,
          matches_played = matches_played + 1,
          updated_at     = excluded.updated_at`,
        [ourName, pts]);
    }
    await recalcTeams();
    res.json({ success: true, remapped: mappings.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/leaderboard', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    let isAdmin = false;
    if (token) { try { isAdmin = jwt.verify(token, JWT_SECRET).role === 'admin'; } catch {} }
    if (!isDeadlinePassed() && !isAdmin)
      return res.status(403).json({ error: 'Leaderboard unlocks after the deadline' });

    const byParticipants = await all(`
      SELECT t.*, u.name as user_name, u.username,
             RANK() OVER (ORDER BY t.total_points DESC) as rank
      FROM teams t JOIN users u ON t.user_id = u.id
      ORDER BY t.total_points DESC, t.submitted_at ASC`);

    for (const t of byParticipants) {
      t.players = await all(`SELECT tp.*, COALESCE(ps.actual_score, 0) as earned_score
        FROM team_players tp LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
        WHERE tp.team_id = ?`, [t.id]);
    }

    const byPlayers = await all(`
      SELECT tp.player_name, tp.player_team, tp.player_type, tp.player_nation,
             COALESCE(ps.actual_score, 0)    as total_score,
             COALESCE(ps.matches_played, 0)  as matches_played,
             COUNT(DISTINCT tp.team_id)      as picked_by,
             ROUND(100.0 * COUNT(DISTINCT tp.team_id) / MAX(1, (SELECT COUNT(*) FROM teams)), 1) as pick_pct
      FROM team_players tp
      LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
      GROUP BY tp.player_name
      ORDER BY total_score DESC, picked_by DESC`);

    const matchRow = await get('SELECT COUNT(*) as c FROM match_log');
    res.json({ byParticipants, byPlayers, deadlinePassed: isDeadlinePassed(), matchesPlayed: matchRow?.c || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ══════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════
async function start() {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`⚡ Thunder XI | Port: ${PORT} | Deadline: ${DEADLINE.toISOString()}`);
    console.log(`🗄️  Database: ${process.env.TURSO_DB_URL ? 'Turso Cloud ✅' : 'Local SQLite (dev)'}`);
  });
}

start().catch(e => { console.error('Startup failed:', e); process.exit(1); });
