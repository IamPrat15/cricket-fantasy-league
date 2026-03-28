const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'fantasy.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      mobile TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      team_name TEXT NOT NULL,
      captain TEXT,
      vice_captain TEXT,
      total_points INTEGER DEFAULT 0,
      submitted_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS team_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      player_name TEXT NOT NULL,
      player_type TEXT NOT NULL,
      player_nation TEXT NOT NULL,
      player_team TEXT NOT NULL,
      fantasy_points INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS player_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_name TEXT UNIQUE NOT NULL,
      actual_score INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { getDb };
