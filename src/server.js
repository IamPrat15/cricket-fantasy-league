require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./db');
const players = require('./players.json');
const cricinfo = require('./cricinfo');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_in_prod';
const DEADLINE = process.env.DEADLINE ? new Date(process.env.DEADLINE) : new Date('2026-03-28T14:00:00.000Z');
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';

const jwt = require('jsonwebtoken');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 3, message: { error: 'Too many OTP requests. Try again in 10 minutes.' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const syncLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 5, message: { error: 'Too many sync requests. Wait 5 minutes.' } });

// ─── Helpers ───────────────────────────────────────────────────────────────
function isDeadlinePassed() { return new Date() > DEADLINE; }

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin auth required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Invalid admin token' }); }
}

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
  if (overseas > 4) errors.push(`Max 4 overseas (selected ${overseas})`);
  const wk = selected.filter(p => p.type === 'WK-Batter').length;
  const bat = selected.filter(p => p.type === 'Batter').length;
  const ar = selected.filter(p => p.type === 'All-Rounder').length;
  const bowl = selected.filter(p => p.type === 'Bowler').length;
  if (wk < 1 || wk > 2) errors.push(`WK: need 1-2, got ${wk}`);
  if (bat < 3 || bat > 5) errors.push(`Batters: need 3-5, got ${bat}`);
  if (ar < 1 || ar > 3) errors.push(`All-Rounders: need 1-3, got ${ar}`);
  if (bowl < 3 || bowl > 5) errors.push(`Bowlers: need 3-5, got ${bowl}`);
  if (new Set(playerNames).size !== playerNames.length) errors.push('Duplicate players not allowed');
  return errors;
}

// ─── Fuzzy name matcher: ESPNcricinfo name → our player list name ───────────
function buildNameIndex() {
  const idx = {};
  players.forEach(p => {
    const parts = p.name.toLowerCase().split(' ');
    const last = parts[parts.length - 1];
    if (!idx[last]) idx[last] = [];
    idx[last].push(p);
  });
  return idx;
}
const NAME_INDEX = buildNameIndex();

function matchPlayerName(cricName) {
  if (!cricName) return null;
  const clean = cricName.trim();
  // 1. Exact
  const exact = players.find(p => p.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.name;
  // 2. Last name
  const parts = clean.toLowerCase().split(' ');
  const last = parts[parts.length - 1];
  const candidates = NAME_INDEX[last] || [];
  if (candidates.length === 1) return candidates[0].name;
  // 3. First initial match
  const first = parts[0];
  const byInit = candidates.filter(p => p.name.toLowerCase().split(' ')[0].startsWith(first[0]));
  if (byInit.length === 1) return byInit[0].name;
  if (byInit.length > 1) return byInit[0].name;
  // 4. Substring
  const sub = players.find(p => p.name.toLowerCase().includes(last));
  return sub ? sub.name : null;
}

// ─── Recalculate team totals ────────────────────────────────────────────────
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

// ─── OTP ───────────────────────────────────────────────────────────────────
async function sendOtp(mobile, code) {
  if (process.env.TWILIO_ACCOUNT_SID?.startsWith('AC')) {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({
      body: `Your IPL Fantasy League OTP is: ${code}. Valid for 10 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: mobile
    });
  } else {
    console.log(`[DEV OTP] ${mobile} → ${code}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/players', (req, res) => res.json(players));
app.get('/api/config', (req, res) => res.json({ deadline: DEADLINE.toISOString(), deadlinePassed: isDeadlinePassed(), seriesId: cricinfo.SERIES_ID }));

// Auth
app.post('/api/auth/send-otp', otpLimiter, async (req, res) => {
  const { mobile } = req.body;
  if (!mobile || !/^\+?[0-9]{10,15}$/.test(mobile.replace(/\s/g, '')))
    return res.status(400).json({ error: 'Valid mobile number required' });
  const m = mobile.replace(/\s/g, '');
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const db = getDb();
  db.prepare("UPDATE otp_codes SET used=1 WHERE mobile=? AND used=0").run(m);
  db.prepare("INSERT INTO otp_codes (mobile, code, expires_at) VALUES (?,?,?)").run(m, code, exp);
  try { await sendOtp(m, code); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'OTP failed: ' + e.message }); }
});

app.post('/api/auth/verify-otp', authLimiter, (req, res) => {
  const { mobile, code, name } = req.body;
  if (!mobile || !code) return res.status(400).json({ error: 'Mobile and OTP required' });
  const m = mobile.replace(/\s/g, '');
  const db = getDb();
  const otp = db.prepare("SELECT * FROM otp_codes WHERE mobile=? AND code=? AND used=0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(m, code);
  if (!otp) return res.status(400).json({ error: 'Invalid or expired OTP' });
  db.prepare("UPDATE otp_codes SET used=1 WHERE id=?").run(otp.id);
  let user = db.prepare("SELECT * FROM users WHERE mobile=?").get(m);
  if (!user) { db.prepare("INSERT INTO users (mobile, name, verified) VALUES (?,?,1)").run(m, name || ''); user = db.prepare("SELECT * FROM users WHERE mobile=?").get(m); }
  else if (name) { db.prepare("UPDATE users SET name=?, verified=1 WHERE id=?").run(name, user.id); user = db.prepare("SELECT * FROM users WHERE mobile=?").get(m); }
  const token = jwt.sign({ userId: user.id, mobile: m, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, token, user: { id: user.id, mobile: m, name: user.name } });
});

app.post('/api/admin/login', authLimiter, (req, res) => {
  if (req.body.username !== ADMIN_USER || req.body.password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ success: true, token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }) });
});

// Team
app.post('/api/team', authMiddleware, (req, res) => {
  if (isDeadlinePassed()) return res.status(400).json({ error: 'Deadline passed. Submissions closed.' });
  const { teamName, players: pNames, captain, viceCaptain } = req.body;
  if (!teamName?.trim()) return res.status(400).json({ error: 'Team name required' });
  if (!Array.isArray(pNames)) return res.status(400).json({ error: 'Players list required' });
  if (!captain || !viceCaptain) return res.status(400).json({ error: 'Captain and VC required' });
  if (!pNames.includes(captain)) return res.status(400).json({ error: 'Captain must be in team' });
  if (!pNames.includes(viceCaptain)) return res.status(400).json({ error: 'VC must be in team' });
  if (captain === viceCaptain) return res.status(400).json({ error: 'Captain and VC must differ' });
  const errors = validateTeam(pNames);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const db = getDb();
  if (db.prepare("SELECT id FROM teams WHERE user_id=?").get(req.user.userId))
    return res.status(400).json({ error: 'One team per user only.' });
  const sel = pNames.map(n => players.find(p => p.name === n));
  const total = sel.reduce((s, p) => s + p.points, 0);
  const teamId = db.transaction(() => {
    const r = db.prepare("INSERT INTO teams (user_id, team_name, captain, vice_captain, total_points) VALUES (?,?,?,?,?)").run(req.user.userId, teamName.trim(), captain, viceCaptain, total);
    for (const p of sel) db.prepare("INSERT INTO team_players (team_id, player_name, player_type, player_nation, player_team, fantasy_points) VALUES (?,?,?,?,?,?)").run(r.lastInsertRowid, p.name, p.type, p.nation, p.team, p.points);
    return r.lastInsertRowid;
  })();
  res.json({ success: true, teamId, totalPoints: total });
});

app.get('/api/team/me', authMiddleware, (req, res) => {
  const db = getDb();
  const team = db.prepare("SELECT * FROM teams WHERE user_id=?").get(req.user.userId);
  if (!team) return res.json({ team: null });
  res.json({ team: { ...team, players: db.prepare("SELECT * FROM team_players WHERE team_id=?").all(team.id) } });
});

// Admin: all teams
app.get('/api/admin/teams', adminMiddleware, (req, res) => {
  const db = getDb();
  const teams = db.prepare("SELECT t.*, u.name as user_name, u.mobile FROM teams t JOIN users u ON t.user_id=u.id ORDER BY t.submitted_at DESC").all()
    .map(t => ({ ...t, players: db.prepare("SELECT * FROM team_players WHERE team_id=?").all(t.id) }));
  res.json({ teams, count: teams.length });
});

// Admin: get current scores
app.get('/api/admin/scores', adminMiddleware, (req, res) => {
  const db = getDb();
  res.json({ scores: db.prepare("SELECT * FROM player_scores ORDER BY actual_score DESC").all() });
});

// Admin: manual score update
app.post('/api/admin/scores', adminMiddleware, (req, res) => {
  const { scores } = req.body;
  if (!Array.isArray(scores)) return res.status(400).json({ error: 'scores array required' });
  const db = getDb();
  const upsert = db.prepare("INSERT INTO player_scores (player_name, actual_score, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(player_name) DO UPDATE SET actual_score=excluded.actual_score, updated_at=excluded.updated_at");
  db.transaction(() => { for (const { playerName, score } of scores) upsert.run(playerName, score); })();
  recalculateTeams(db);
  res.json({ success: true, updated: scores.length });
});

// ══ AUTO-SYNC ROUTES ═══════════════════════════════════════════════════════

// 1. Get IPL 2026 match schedule from ESPNcricinfo
app.get('/api/admin/cricinfo/schedule', adminMiddleware, syncLimiter, async (req, res) => {
  try {
    const matches = await cricinfo.getSchedule();
    res.json({ success: true, matches, total: matches.length });
  } catch (e) {
    res.status(500).json({ error: 'ESPNcricinfo unavailable: ' + e.message, tip: 'Check server logs. ESPNcricinfo may have changed their API structure.' });
  }
});

// 2. Sync a single match scorecard
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
  } catch (e) {
    res.status(500).json({ error: 'Match sync failed: ' + e.message });
  }
});

// 3. Sync ALL completed matches (full season)
app.post('/api/admin/cricinfo/sync-all', adminMiddleware, syncLimiter, async (req, res) => {
  try {
    if (req.body?.reset) getDb().prepare("DELETE FROM player_scores").run();
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
  } catch (e) {
    res.status(500).json({ error: 'Full sync failed: ' + e.message });
  }
});

// 4. Manual remap: fix unmatched player names
app.post('/api/admin/cricinfo/remap', adminMiddleware, (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings required' });
  const db = getDb();
  const upsert = db.prepare("INSERT INTO player_scores (player_name, actual_score, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(player_name) DO UPDATE SET actual_score = actual_score + excluded.actual_score, updated_at = excluded.updated_at");
  db.transaction(() => { for (const { ourName, pts } of mappings) upsert.run(ourName, pts); })();
  recalculateTeams(db);
  res.json({ success: true, remapped: mappings.length });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  let isAdmin = false;
  if (token) { try { isAdmin = jwt.verify(token, JWT_SECRET).role === 'admin'; } catch {} }
  if (!isDeadlinePassed() && !isAdmin) return res.status(403).json({ error: 'Leaderboard visible after deadline only' });
  const db = getDb();
  const byParticipants = db.prepare("SELECT t.*, u.name as user_name, u.mobile, RANK() OVER (ORDER BY t.total_points DESC) as rank FROM teams t JOIN users u ON t.user_id=u.id ORDER BY t.total_points DESC, t.submitted_at ASC").all();
  const byPlayers = db.prepare("SELECT tp.player_name, tp.player_team, tp.player_type, COALESCE(ps.actual_score, tp.fantasy_points) as score, ps.updated_at, COUNT(tp.id) as picked_by, ROUND(100.0 * COUNT(tp.id) / MAX(1,(SELECT COUNT(*) FROM teams)), 1) as pick_pct FROM team_players tp LEFT JOIN player_scores ps ON tp.player_name = ps.player_name GROUP BY tp.player_name ORDER BY score DESC").all();
  res.json({ byParticipants, byPlayers, deadlinePassed: isDeadlinePassed() });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`⚡ Thunder XI running on port ${PORT}`);
  console.log(`📅 Deadline: ${DEADLINE.toISOString()}`);
  console.log(`🏏 ESPNcricinfo Series ID: ${cricinfo.SERIES_ID}`);
});
