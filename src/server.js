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

const loginLimiter    = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
const registerLimiter = rateLimit({ windowMs: 60*60*1000, max: 20 });
const syncLimiter     = rateLimit({ windowMs:  5*60*1000, max:  5, message: { error: 'Too many sync requests. Wait 5 minutes.' } });

// ─── Helpers ──────────────────────────────────────────────────────────────
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

function validateTeam(playerNames) {
  const errors = [];
  if (playerNames.length !== 11) { errors.push('Select exactly 11 players'); return errors; }
  const sel = playerNames.map(n => {
    const p = players.find(pl => pl.name === n);
    if (!p) errors.push(`Player not found: ${n}`);
    return p;
  }).filter(Boolean);
  if (errors.length) return errors;
  const total = sel.reduce((s, p) => s + p.points, 0);
  if (total > 1000) errors.push(`Total ${total} pts exceeds 1000 limit`);
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

// ─── Name matcher ─────────────────────────────────────────────────────────
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
  const last = parts[parts.length - 1];
  const cands = NAME_INDEX[last] || [];
  if (cands.length === 1) return cands[0].name;
  const byInit = cands.filter(p => p.name.toLowerCase().split(' ')[0].startsWith(parts[0][0]));
  if (byInit.length >= 1) return byInit[0].name;
  return players.find(p => p.name.toLowerCase().includes(last))?.name || null;
}

// ─── Recalculate all team totals from player_scores ───────────────────────
function recalcTeams(db) {
  db.prepare(`
    UPDATE teams SET total_points = (
      SELECT COALESCE(SUM(COALESCE(ps.actual_score, 0)), 0)
      FROM team_players tp
      LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
      WHERE tp.team_id = teams.id
    )
  `).run();
}

// ══════════════════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { username, password, name, mobile } = req.body;
  if (!username || username.trim().length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!name || name.trim().length < 2)
    return res.status(400).json({ error: 'Full name is required' });
  const u = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (u !== username.trim().toLowerCase())
    return res.status(400).json({ error: 'Username: letters, numbers and underscore only' });
  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE username=?').get(u))
    return res.status(400).json({ error: 'Username already taken. Please choose another.' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (username,password_hash,name,mobile) VALUES (?,?,?,?)').run(u, hash, name.trim(), mobile?.trim()||'');
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(u);
  const token = jwt.sign({ userId: user.id, username: u, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.id, username: u, name: user.name } });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ userId: user.id, username: user.username, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name } });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (req.body.username !== ADMIN_USER || req.body.password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid admin credentials' });
  res.json({ success: true, token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }) });
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!(await bcrypt.compare(currentPassword, user.password_hash)))
    return res.status(401).json({ error: 'Current password is incorrect' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(newPassword, 10), user.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════
// GENERAL
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/players', (req, res) => res.json(players));

app.get('/api/config', (req, res) => {
  const db = getDb();
  const teamCount = db.prepare('SELECT COUNT(*) as c FROM teams').get()?.c || 0;
  const lastSync  = db.prepare('SELECT * FROM match_log ORDER BY synced_at DESC LIMIT 1').get();
  res.json({
    deadline: DEADLINE.toISOString(),
    deadlinePassed: isDeadlinePassed(),
    seriesId: cricinfo.SERIES_ID,
    teamCount,
    lastSync: lastSync || null
  });
});

// ══════════════════════════════════════════════════════════════════════════
// TEAM
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/team', authMiddleware, (req, res) => {
  if (isDeadlinePassed()) return res.status(400).json({ error: 'Deadline passed. Submissions are closed.' });
  const { teamName, players: pNames } = req.body;
  if (!teamName?.trim()) return res.status(400).json({ error: 'Team name is required' });
  if (!Array.isArray(pNames)) return res.status(400).json({ error: 'Players list required' });
  const errors = validateTeam(pNames);
  if (errors.length) return res.status(400).json({ error: errors.join(' | ') });
  const db = getDb();
  if (db.prepare('SELECT id FROM teams WHERE user_id=?').get(req.user.userId))
    return res.status(400).json({ error: 'You already submitted a team. One team per user only.' });
  const sel   = pNames.map(n => players.find(p => p.name === n));
  const total = sel.reduce((s, p) => s + p.points, 0);
  const teamId = db.transaction(() => {
    const r = db.prepare('INSERT INTO teams (user_id,team_name,total_points) VALUES (?,?,0)').run(req.user.userId, teamName.trim());
    for (const p of sel)
      db.prepare('INSERT INTO team_players (team_id,player_name,player_type,player_nation,player_team,fantasy_points) VALUES (?,?,?,?,?,?)').run(r.lastInsertRowid, p.name, p.type, p.nation, p.team, p.points);
    return r.lastInsertRowid;
  })();
  res.json({ success: true, teamId, selectionPoints: total });
});

app.get('/api/team/me', authMiddleware, (req, res) => {
  const db = getDb();
  const team = db.prepare('SELECT * FROM teams WHERE user_id=?').get(req.user.userId);
  if (!team) return res.json({ team: null });
  const teamPlayers = db.prepare(`
    SELECT tp.*, COALESCE(ps.actual_score, 0) as earned_score, ps.matches_played
    FROM team_players tp
    LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
    WHERE tp.team_id = ?
  `).all(team.id);
  res.json({ team: { ...team, players: teamPlayers } });
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/teams', adminMiddleware, (req, res) => {
  const db = getDb();
  const teams = db.prepare('SELECT t.*,u.name as user_name,u.username FROM teams t JOIN users u ON t.user_id=u.id ORDER BY t.total_points DESC, t.submitted_at ASC').all()
    .map(t => ({ ...t, players: db.prepare('SELECT tp.*,COALESCE(ps.actual_score,0) as earned_score FROM team_players tp LEFT JOIN player_scores ps ON tp.player_name=ps.player_name WHERE tp.team_id=?').all(t.id) }));
  res.json({ teams, count: teams.length });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const db = getDb();
  res.json({ users: db.prepare('SELECT id,username,name,mobile,created_at FROM users ORDER BY created_at DESC').all() });
});

app.post('/api/admin/reset-password', adminMiddleware, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'username and newPassword required' });
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE username=?').get(username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(newPassword, 10), user.id);
  res.json({ success: true });
});

// Manual score update
app.post('/api/admin/scores', adminMiddleware, (req, res) => {
  const { scores } = req.body;
  if (!Array.isArray(scores)) return res.status(400).json({ error: 'scores array required' });
  const db = getDb();
  const upsert = db.prepare(`INSERT INTO player_scores (player_name,actual_score,updated_at) VALUES (?,?,datetime('now'))
    ON CONFLICT(player_name) DO UPDATE SET actual_score=excluded.actual_score, updated_at=excluded.updated_at`);
  db.transaction(() => { for (const { playerName, score } of scores) upsert.run(playerName, score); })();
  recalcTeams(db);
  res.json({ success: true, updated: scores.length });
});

app.get('/api/admin/scores', adminMiddleware, (req, res) => {
  const db = getDb();
  res.json({ scores: db.prepare('SELECT * FROM player_scores ORDER BY actual_score DESC').all() });
});

app.get('/api/admin/match-log', adminMiddleware, (req, res) => {
  const db = getDb();
  res.json({ log: db.prepare('SELECT * FROM match_log ORDER BY synced_at DESC').all() });
});

// ══════════════════════════════════════════════════════════════════════════
// CRICINFO AUTO-SYNC
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/cricinfo/schedule', adminMiddleware, syncLimiter, async (req, res) => {
  try {
    const matches = await cricinfo.getSchedule();
    const db = getDb();
    const synced = db.prepare('SELECT match_id FROM match_log').all().map(r => r.match_id);
    res.json({ success: true, matches: matches.map(m => ({ ...m, alreadySynced: synced.includes(String(m.matchId)) })) });
  } catch (e) { res.status(500).json({ error: 'ESPNcricinfo unavailable: ' + e.message }); }
});

app.post('/api/admin/cricinfo/sync-match', adminMiddleware, syncLimiter, async (req, res) => {
  const { matchId, matchTitle } = req.body;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });
  const db = getDb();

  // Prevent double-syncing same match
  if (db.prepare('SELECT id FROM match_log WHERE match_id=?').get(String(matchId)))
    return res.status(400).json({ error: 'This match has already been synced. Use "Re-sync" to overwrite.' });

  try {
    const { playerScores } = await cricinfo.getScorecard(matchId);
    // Accumulate scores (add to existing)
    const upsert = db.prepare(`INSERT INTO player_scores (player_name,actual_score,matches_played,updated_at)
      VALUES (?,?,1,datetime('now'))
      ON CONFLICT(player_name) DO UPDATE SET
        actual_score = actual_score + excluded.actual_score,
        matches_played = matches_played + 1,
        updated_at = excluded.updated_at`);
    const matched = [], unmatched = [];
    db.transaction(() => {
      Object.entries(playerScores).forEach(([cn, pts]) => {
        const our = matchPlayerName(cn);
        if (our) { upsert.run(our, pts); matched.push({ cricName: cn, ourName: our, pts }); }
        else unmatched.push({ cricName: cn, pts });
      });
      db.prepare('INSERT INTO match_log (match_id,match_title) VALUES (?,?)').run(String(matchId), matchTitle || '');
    })();
    recalcTeams(db);
    res.json({ success: true, matchId, matched: matched.length, unmatched: unmatched.length, matchedPlayers: matched, unmatchedPlayers: unmatched });
  } catch (e) { res.status(500).json({ error: 'Sync failed: ' + e.message }); }
});

// Re-sync a match (subtract old scores first, then add new)
app.post('/api/admin/cricinfo/resync-match', adminMiddleware, syncLimiter, async (req, res) => {
  const { matchId, matchTitle } = req.body;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });
  const db = getDb();
  try {
    const { playerScores } = await cricinfo.getScorecard(matchId);
    const upsert = db.prepare(`INSERT INTO player_scores (player_name,actual_score,matches_played,updated_at)
      VALUES (?,?,1,datetime('now'))
      ON CONFLICT(player_name) DO UPDATE SET
        actual_score = actual_score + excluded.actual_score,
        matches_played = matches_played + 1,
        updated_at = excluded.updated_at`);
    const matched = [], unmatched = [];
    db.transaction(() => {
      // Remove old log entry
      db.prepare('DELETE FROM match_log WHERE match_id=?').run(String(matchId));
      Object.entries(playerScores).forEach(([cn, pts]) => {
        const our = matchPlayerName(cn);
        if (our) { upsert.run(our, pts); matched.push({ cricName: cn, ourName: our, pts }); }
        else unmatched.push({ cricName: cn, pts });
      });
      db.prepare('INSERT INTO match_log (match_id,match_title) VALUES (?,?)').run(String(matchId), matchTitle || '');
    })();
    recalcTeams(db);
    res.json({ success: true, matchId, matched: matched.length, unmatched: unmatched.length, unmatchedPlayers: unmatched });
  } catch (e) { res.status(500).json({ error: 'Re-sync failed: ' + e.message }); }
});

app.post('/api/admin/cricinfo/remap', adminMiddleware, (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings required' });
  const db = getDb();
  const upsert = db.prepare(`INSERT INTO player_scores (player_name,actual_score,matches_played,updated_at)
    VALUES (?,?,1,datetime('now'))
    ON CONFLICT(player_name) DO UPDATE SET
      actual_score = actual_score + excluded.actual_score,
      matches_played = matches_played + 1,
      updated_at = excluded.updated_at`);
  db.transaction(() => { for (const { ourName, pts } of mappings) upsert.run(ourName, pts); })();
  recalcTeams(db);
  res.json({ success: true, remapped: mappings.length });
});

// ══════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/leaderboard', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  let isAdmin = false;
  if (token) { try { isAdmin = jwt.verify(token, JWT_SECRET).role === 'admin'; } catch {} }
  if (!isDeadlinePassed() && !isAdmin)
    return res.status(403).json({ error: 'Leaderboard unlocks after the deadline' });
  const db = getDb();
  const byParticipants = db.prepare(`
    SELECT t.*, u.name as user_name, u.username,
           RANK() OVER (ORDER BY t.total_points DESC) as rank
    FROM teams t JOIN users u ON t.user_id=u.id
    ORDER BY t.total_points DESC, t.submitted_at ASC
  `).all().map(t => ({
    ...t,
    players: db.prepare(`SELECT tp.*,COALESCE(ps.actual_score,0) as earned_score
      FROM team_players tp LEFT JOIN player_scores ps ON tp.player_name=ps.player_name
      WHERE tp.team_id=?`).all(t.id)
  }));
  const byPlayers = db.prepare(`
    SELECT tp.player_name, tp.player_team, tp.player_type, tp.player_nation,
           COALESCE(ps.actual_score, 0) as total_score,
           COALESCE(ps.matches_played, 0) as matches_played,
           COUNT(DISTINCT tp.team_id) as picked_by,
           ROUND(100.0 * COUNT(DISTINCT tp.team_id) / MAX(1,(SELECT COUNT(*) FROM teams)), 1) as pick_pct
    FROM team_players tp
    LEFT JOIN player_scores ps ON tp.player_name = ps.player_name
    GROUP BY tp.player_name
    ORDER BY total_score DESC, picked_by DESC
  `).all();
  const matchesPlayed = db.prepare('SELECT COUNT(*) as c FROM match_log').get()?.c || 0;
  res.json({ byParticipants, byPlayers, deadlinePassed: isDeadlinePassed(), matchesPlayed });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`⚡ Thunder XI | Port: ${PORT} | Deadline: ${DEADLINE.toISOString()}`);
  console.log(`📅 Tournament mode: scores accumulate across all ${74} matches`);
});
