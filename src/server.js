require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('./db');
const players = require('./players.json');
const cricinfo = require('./cricinfo');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_prod';
const DEADLINE = process.env.DEADLINE ? new Date(process.env.DEADLINE) : new Date('2026-03-28T14:00:00.000Z');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rate limiters
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: 'Too many registrations from this IP.' } });
const syncLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 5, message: { error: 'Too many sync requests. Wait 5 minutes.' } });

// ─── Middleware ─────────────────────────────────────────────────────────────
function isDeadlinePassed() { return new Date() > DEADLINE; }

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired session. Please login again.' }); }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin auth required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.user = decoded; next();
  } catch { res.status(401).json({ error: 'Invalid admin token' }); }
}

// ─── Team validation ────────────────────────────────────────────────────────
function validateTeam(playerNames) {
  const errors = [];
  if (playerNames.length !== 11) { errors.push('Team must have exactly 11 players'); return errors; }
  const selected = playerNames.map(name => {
    const p = players.find(pl => pl.name === name);
    if (!p) errors.push(`Player not found: ${name}`);
    return p;
  }).filter(Boolean);
  if (errors.length) return errors;
  const totalPts = selected.reduce((s, p) => s + p.points, 0);
  if (totalPts > 1000) errors.push(`Total points ${totalPts} exceeds 1000 limit`);
  const overseas = selected.filter(p => p.nation === 'Overseas').length;
  if (overseas > 4) errors.push(`Max 4 overseas players (selected ${overseas})`);
  const wk = selected.filter(p => p.type === 'WK-Batter').length;
  const bat = selected.filter(p => p.type === 'Batter').length;
  const ar = selected.filter(p => p.type === 'All-Rounder').length;
  const bowl = selected.filter(p => p.type === 'Bowler').length;
  if (wk < 1 || wk > 2)   errors.push(`WK: need 1-2, got ${wk}`);
  if (bat < 3 || bat > 5)  errors.push(`Batters: need 3-5, got ${bat}`);
  if (ar < 1 || ar > 3)    errors.push(`All-Rounders: need 1-3, got ${ar}`);
  if (bowl < 3 || bowl > 5) errors.push(`Bowlers: need 3-5, got ${bowl}`);
  if (new Set(playerNames).size !== playerNames.length) errors.push('Duplicate players not allowed');
  return errors;
}

// ─── Name matcher for ESPNcricinfo ─────────────────────────────────────────
function buildNameIndex() {
  const idx = {};
  players.forEach(p => {
    const last = p.name.toLowerCase().split(' ').pop();
    if (!idx[last]) idx[last] = [];
    idx[last].push(p);
  });
  return idx;
}
const NAME_INDEX = buildNameIndex();

function matchPlayerName(cricName) {
  if (!cricName) return null;
  const clean = cricName.trim();
  const exact = players.find(p => p.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.name;
  const parts = clean.toLowerCase().split(' ');
  const last = parts[parts.length - 1];
  const candidates = NAME_INDEX[last] || [];
  if (candidates.length === 1) return candidates[0].name;
  const byInit = candidates.filter(p => p.name.toLowerCase().split(' ')[0].startsWith(parts[0][0]));
  if (byInit.length >= 1) return byInit[0].name;
  const sub = players.find(p => p.name.toLowerCase().includes(last));
  return sub ? sub.name : null;
}

function recalculateTeams(db) {
  db.prepare(`
    UPDATE teams SET total_points = (
      SELECT COALESCE(SUM(COALESCE(ps.actual_score, tp.fantasy_points)), 0)
      FROM team_players tp
      LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
      WHERE tp.team_id = teams.id
    )
  `).run();
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES — Username / Password
// ══════════════════════════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { username, password, name, mobile } = req.body;

  if (!username || username.trim().length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!name || name.trim().length < 2)
    return res.status(400).json({ error: 'Full name is required' });

  // Sanitise username — alphanumeric + underscore only
  const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (cleanUsername !== username.trim().toLowerCase())
    return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) return res.status(400).json({ error: 'Username already taken. Please choose another.' });

  const password_hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (username, password_hash, name, mobile) VALUES (?, ?, ?, ?)')
    .run(cleanUsername, password_hash, name.trim(), mobile?.trim() || '');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername);
  const token = jwt.sign({ userId: user.id, username: cleanUsername, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.id, username: cleanUsername, name: user.name } });
});

// Login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ userId: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name } });
});

// Admin login
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid admin credentials' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ success: true, token });
});

// Change password
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ success: true, message: 'Password changed successfully' });
});

// ══════════════════════════════════════════════════════════════════════════════
// GENERAL ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/players', (req, res) => res.json(players));
app.get('/api/config', (req, res) => res.json({
  deadline: DEADLINE.toISOString(),
  deadlinePassed: isDeadlinePassed(),
  seriesId: cricinfo.SERIES_ID,
}));

// ─── Team ───────────────────────────────────────────────────────────────────
app.post('/api/team', authMiddleware, (req, res) => {
  if (isDeadlinePassed()) return res.status(400).json({ error: 'Deadline passed. Submissions are closed.' });
  const { teamName, players: pNames, captain, viceCaptain } = req.body;
  if (!teamName?.trim()) return res.status(400).json({ error: 'Team name required' });
  if (!Array.isArray(pNames)) return res.status(400).json({ error: 'Players list required' });
  if (!captain || !viceCaptain) return res.status(400).json({ error: 'Captain and Vice-Captain required' });
  if (!pNames.includes(captain)) return res.status(400).json({ error: 'Captain must be in your team' });
  if (!pNames.includes(viceCaptain)) return res.status(400).json({ error: 'Vice-Captain must be in your team' });
  if (captain === viceCaptain) return res.status(400).json({ error: 'Captain and VC must be different players' });
  const errors = validateTeam(pNames);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const db = getDb();
  if (db.prepare('SELECT id FROM teams WHERE user_id = ?').get(req.user.userId))
    return res.status(400).json({ error: 'You have already submitted a team. One team per user only.' });
  const sel = pNames.map(n => players.find(p => p.name === n));
  const total = sel.reduce((s, p) => s + p.points, 0);
  const teamId = db.transaction(() => {
    const r = db.prepare('INSERT INTO teams (user_id, team_name, captain, vice_captain, total_points) VALUES (?,?,?,?,?)').run(req.user.userId, teamName.trim(), captain, viceCaptain, total);
    for (const p of sel) db.prepare('INSERT INTO team_players (team_id, player_name, player_type, player_nation, player_team, fantasy_points) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, p.name, p.type, p.nation, p.team, p.points);
    return r.lastInsertRowid;
  })();
  res.json({ success: true, teamId, totalPoints: total });
});

app.get('/api/team/me', authMiddleware, (req, res) => {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE user_id = ?').get(req.user.userId);
  if (!team) return res.json({ team: null });
  res.json({ team: { ...team, players: db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(team.id) } });
});

// ─── Admin ──────────────────────────────────────────────────────────────────
app.get('/api/admin/teams', adminMiddleware, (req, res) => {
  const db = getDb();
  const teams = db.prepare('SELECT t.*, u.name as user_name, u.username, u.mobile FROM teams t JOIN users u ON t.user_id=u.id ORDER BY t.submitted_at DESC').all()
    .map(t => ({ ...t, players: db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(t.id) }));
  res.json({ teams, count: teams.length });
});

// Admin: list all users
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, name, mobile, created_at FROM users ORDER BY created_at DESC').all();
  res.json({ users, count: users.length });
});

// Admin: reset a user's password
app.post('/api/admin/reset-password', adminMiddleware, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'username and newPassword required' });
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ success: true, message: `Password reset for ${username}` });
});

app.get('/api/admin/scores', adminMiddleware, (req, res) => {
  const db = getDb();
  res.json({ scores: db.prepare('SELECT * FROM player_scores ORDER BY actual_score DESC').all() });
});

app.post('/api/admin/scores', adminMiddleware, (req, res) => {
  const { scores } = req.body;
  if (!Array.isArray(scores)) return res.status(400).json({ error: 'scores array required' });
  const db = getDb();
  const upsert = db.prepare("INSERT INTO player_scores (player_name, actual_score, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(player_name) DO UPDATE SET actual_score=excluded.actual_score, updated_at=excluded.updated_at");
  db.transaction(() => { for (const { playerName, score } of scores) upsert.run(playerName, score); })();
  recalculateTeams(db);
  res.json({ success: true, updated: scores.length });
});

// ─── Auto-sync routes ────────────────────────────────────────────────────────
app.get('/api/admin/cricinfo/schedule', adminMiddleware, syncLimiter, async (req, res) => {
  try { res.json({ success: true, matches: await cricinfo.getSchedule() }); }
  catch (e) { res.status(500).json({ error: 'ESPNcricinfo fetch failed: ' + e.message }); }
});

app.post('/api/admin/cricinfo/sync-match', adminMiddleware, syncLimiter, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });
  try {
    const { playerScores } = await cricinfo.getScorecard(matchId);
    const db = getDb();
    const upsert = db.prepare("INSERT INTO player_scores (player_name, actual_score, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(player_name) DO UPDATE SET actual_score = actual_score + excluded.actual_score, updated_at = excluded.updated_at");
    const matched = [], unmatched = [];
    db.transaction(() => {
      Object.entries(playerScores).forEach(([cn, pts]) => {
        const our = matchPlayerName(cn);
        if (our) { upsert.run(our, pts); matched.push({ cricName: cn, ourName: our, pts }); }
        else unmatched.push({ cricName: cn, pts });
      });
    })();
    recalculateTeams(db);
    res.json({ success: true, matchId, matched: matched.length, unmatched: unmatched.length, matchedPlayers: matched, unmatchedPlayers: unmatched });
  } catch (e) { res.status(500).json({ error: 'Sync failed: ' + e.message }); }
});

app.post('/api/admin/cricinfo/sync-all', adminMiddleware, syncLimiter, async (req, res) => {
  try {
    if (req.body?.reset) getDb().prepare('DELETE FROM player_scores').run();
    const allScores = await cricinfo.getAllCompletedScores();
    const db = getDb();
    const upsert = db.prepare("INSERT INTO player_scores (player_name, actual_score, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(player_name) DO UPDATE SET actual_score=excluded.actual_score, updated_at=excluded.updated_at");
    const matched = [], unmatched = [];
    db.transaction(() => {
      Object.entries(allScores).forEach(([cn, pts]) => {
        const our = matchPlayerName(cn);
        if (our) { upsert.run(our, pts); matched.push(our); }
        else unmatched.push(cn);
      });
    })();
    recalculateTeams(db);
    res.json({ success: true, matched: matched.length, unmatched: unmatched.length, unmatchedPlayers: unmatched });
  } catch (e) { res.status(500).json({ error: 'Full sync failed: ' + e.message }); }
});

app.post('/api/admin/cricinfo/remap', adminMiddleware, (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings required' });
  const db = getDb();
  const upsert = db.prepare("INSERT INTO player_scores (player_name, actual_score, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(player_name) DO UPDATE SET actual_score = actual_score + excluded.actual_score, updated_at = excluded.updated_at");
  db.transaction(() => { for (const { ourName, pts } of mappings) upsert.run(ourName, pts); })();
  recalculateTeams(db);
  res.json({ success: true, remapped: mappings.length });
});

// ─── Leaderboard ─────────────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  let isAdmin = false;
  if (token) { try { isAdmin = jwt.verify(token, JWT_SECRET).role === 'admin'; } catch {} }
  if (!isDeadlinePassed() && !isAdmin) return res.status(403).json({ error: 'Leaderboard is locked until the deadline' });
  const db = getDb();
  const byParticipants = db.prepare('SELECT t.*, u.name as user_name, u.username, RANK() OVER (ORDER BY t.total_points DESC) as rank FROM teams t JOIN users u ON t.user_id=u.id ORDER BY t.total_points DESC, t.submitted_at ASC').all();
  const byPlayers = db.prepare('SELECT tp.player_name, tp.player_team, tp.player_type, COALESCE(ps.actual_score, tp.fantasy_points) as score, ps.updated_at, COUNT(tp.id) as picked_by, ROUND(100.0 * COUNT(tp.id) / MAX(1,(SELECT COUNT(*) FROM teams)), 1) as pick_pct FROM team_players tp LEFT JOIN player_scores ps ON tp.player_name = ps.player_name GROUP BY tp.player_name ORDER BY score DESC').all();
  res.json({ byParticipants, byPlayers, deadlinePassed: isDeadlinePassed() });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`⚡ Thunder XI on port ${PORT}`);
  console.log(`📅 Deadline: ${DEADLINE.toISOString()}`);
  console.log(`🔐 Auth: Username + Password (no OTP)`);
});
