import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = new Database(join(__dirname, '..', 'flags.db'));

raw.pragma('journal_mode = WAL');
raw.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

raw.exec(`
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

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const version = raw.pragma('user_version', { simple: true });

if (version < 1) {
  raw.exec(`BEGIN`);
  try {
    try { raw.exec(`ALTER TABLE flags ADD COLUMN type TEXT NOT NULL DEFAULT 'boolean'`); } catch {}

    const cols = raw.pragma(`table_info(allocations)`).map(c => c.name);
    if (cols.includes('variant_key')) {
      raw.exec(`DROP TABLE allocations`);
      raw.exec(`
        CREATE TABLE allocations (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          flag_id          INTEGER NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
          splits           TEXT NOT NULL DEFAULT '[]',
          targeting_rules  TEXT,
          priority         INTEGER NOT NULL DEFAULT 0
        )
      `);
    }

    raw.pragma(`user_version = 1`);
    raw.exec(`COMMIT`);
  } catch (e) {
    raw.exec(`ROLLBACK`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// SQLite type coercion
// SQLite cannot bind JS booleans — convert them to 1/0 so route code
// can use booleans freely without worrying about the storage layer.
// ---------------------------------------------------------------------------

function coerce(params) {
  return params.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

// ---------------------------------------------------------------------------
// Async adapter (wraps synchronous better-sqlite3)
// ---------------------------------------------------------------------------

const db = {
  dialect: 'sqlite',

  async get(sql, params = []) {
    return raw.prepare(sql).get(coerce(params)) ?? null;
  },

  async all(sql, params = []) {
    return raw.prepare(sql).all(coerce(params));
  },

  // Returns { lastInsertRowid, changes }
  async run(sql, params = []) {
    const info = raw.prepare(sql).run(coerce(params));
    return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
  },

  async exec(sql) {
    raw.exec(sql);
  },

  // fn receives the same db interface, runs inside a SQLite transaction
  async transaction(fn) {
    return raw.transaction(() => fn(db))();
  },
};

export default db;
