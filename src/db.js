/**
 * Database layer — uses Turso (libSQL) for persistent cloud storage.
 * Falls back to local SQLite file if TURSO_DB_URL is not set (for local dev).
 *
 * Turso is a drop-in replacement for SQLite — same SQL syntax, free tier.
 * Set these env vars on Render:
 *   TURSO_DB_URL   = libsql://your-db-name-yourname.turso.io
 *   TURSO_DB_TOKEN = your-auth-token
 */

const { createClient } = require('@libsql/client');

let client = null;

function getDb() {
  if (!client) {
    const url   = process.env.TURSO_DB_URL;
    const token = process.env.TURSO_DB_TOKEN;

    if (url && token) {
      // Production — Turso cloud database (persistent across restarts)
      client = createClient({ url, authToken: token });
      console.log('🗄️  Connected to Turso cloud database');
    } else {
      // Local dev fallback — SQLite file
      client = createClient({ url: 'file:fantasy.db' });
      console.log('🗄️  Using local SQLite file (dev mode)');
    }
  }
  return client;
}

// ─── Schema initialiser ───────────────────────────────────────────────────
// Turso uses async execute() unlike better-sqlite3's sync exec()
// We run all CREATE TABLE statements on startup

async function initSchema() {
  const db = getDb();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      username  TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name      TEXT,
      mobile    TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS teams (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      team_name    TEXT NOT NULL,
      total_points INTEGER DEFAULT 0,
      submitted_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS team_players (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id        INTEGER NOT NULL REFERENCES teams(id),
      player_name    TEXT NOT NULL,
      player_type    TEXT NOT NULL,
      player_nation  TEXT NOT NULL,
      player_team    TEXT NOT NULL,
      fantasy_points INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS player_scores (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name    TEXT UNIQUE NOT NULL,
      actual_score   INTEGER DEFAULT 0,
      matches_played INTEGER DEFAULT 0,
      updated_at     TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS match_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id    TEXT NOT NULL,
      match_title TEXT,
      synced_at   TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const sql of statements) {
    await db.execute(sql);
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────
// Turso returns { rows: [...] } where each row is array-like.
// These helpers make it look like better-sqlite3's API.

async function run(sql, args = []) {
  const db = getDb();
  return await db.execute({ sql, args });
}

async function all(sql, args = []) {
  const db = getDb();
  const result = await db.execute({ sql, args });
  return result.rows.map(rowToObj(result.columns));
}

async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0] || null;
}

async function transaction(fn) {
  const db = getDb();
  // Turso supports interactive transactions
  const tx = await db.transaction('write');
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

// Turso returns column names separately — zip them with row values
function rowToObj(columns) {
  return (row) => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  };
}

module.exports = { getDb, initSchema, run, all, get, transaction };
