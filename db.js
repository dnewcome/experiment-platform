import Database from 'better-sqlite3';

const db = new Database('flags.db');

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema bootstrap ────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS flags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    type        TEXT NOT NULL DEFAULT 'boolean',
    enabled     INTEGER NOT NULL DEFAULT 1,
    fields      TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS variants (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_id  INTEGER NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS allocations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_id          INTEGER NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
    splits           TEXT NOT NULL DEFAULT '[]',
    targeting_rules  TEXT,
    priority         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS experiment_assignments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_key      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    variant       TEXT,
    value         TEXT,
    reason        TEXT NOT NULL,
    bucket        INTEGER,
    allocation_id INTEGER,
    attributes    TEXT,
    assigned_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_flag_user
    ON experiment_assignments (flag_key, user_id);

  CREATE INDEX IF NOT EXISTS idx_assignments_assigned_at
    ON experiment_assignments (assigned_at);
`);

// ── Migrations (safe to run repeatedly) ─────────────────────────────────────

const version = db.pragma('user_version', { simple: true });

if (version < 1) {
  db.exec(`BEGIN`);
  try {
    // Add type column to flags if missing (pre-v1 DBs had no type column)
    try { db.exec(`ALTER TABLE flags ADD COLUMN type TEXT NOT NULL DEFAULT 'boolean'`); } catch {}

    // Recreate allocations with splits-based schema if it has the old variant_key column
    const cols = db.pragma(`table_info(allocations)`).map(c => c.name);
    if (cols.includes('variant_key')) {
      db.exec(`DROP TABLE allocations`);
      db.exec(`
        CREATE TABLE allocations (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          flag_id          INTEGER NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
          splits           TEXT NOT NULL DEFAULT '[]',
          targeting_rules  TEXT,
          priority         INTEGER NOT NULL DEFAULT 0
        )
      `);
    }

    db.pragma(`user_version = 1`);
    db.exec(`COMMIT`);
  } catch (e) {
    db.exec(`ROLLBACK`);
    throw e;
  }
}

export default db;
