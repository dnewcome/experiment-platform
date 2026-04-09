import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => console.error('Postgres pool error:', err));

// Convert SQLite-style ? placeholders to Postgres $1, $2, ...
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function bootstrap() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flags (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      type        TEXT NOT NULL DEFAULT 'boolean',
      enabled     INTEGER NOT NULL DEFAULT 1,
      fields      TEXT NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS variants (
      id       SERIAL PRIMARY KEY,
      flag_id  INTEGER NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
      key      TEXT NOT NULL,
      value    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS allocations (
      id               SERIAL PRIMARY KEY,
      flag_id          INTEGER NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
      splits           TEXT NOT NULL DEFAULT '[]',
      targeting_rules  TEXT,
      priority         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS experiment_assignments (
      id            SERIAL PRIMARY KEY,
      flag_key      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      variant       TEXT,
      value         TEXT,
      reason        TEXT NOT NULL,
      bucket        INTEGER,
      allocation_id INTEGER,
      attributes    TEXT,
      assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_assignments_flag_user
      ON experiment_assignments (flag_key, user_id);

    CREATE INDEX IF NOT EXISTS idx_assignments_assigned_at
      ON experiment_assignments (assigned_at);

    CREATE TABLE IF NOT EXISTS warehouse_configs (
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL,
      assignment_sql TEXT NOT NULL DEFAULT '',
      metrics        TEXT NOT NULL DEFAULT '[]',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sim_assignments (
      run_id      TEXT NOT NULL,
      seed        INTEGER NOT NULL,
      flag_key    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      variant     TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sim_facts (
      run_id      TEXT NOT NULL,
      seed        INTEGER NOT NULL,
      flag_key    TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      variant     TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      value       REAL NOT NULL,
      event_at    TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0);
  `);

  // Seed schema_version row if empty
  await pool.query(`
    INSERT INTO schema_version (version)
    SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version)
  `);
}

await bootstrap();

// ---------------------------------------------------------------------------
// Async adapter
// ---------------------------------------------------------------------------

const db = {
  dialect: 'postgres',

  async get(sql, params = []) {
    const { rows } = await pool.query(toPositional(sql), params);
    return rows[0] ?? null;
  },

  async all(sql, params = []) {
    const { rows } = await pool.query(toPositional(sql), params);
    return rows;
  },

  // Automatically appends RETURNING id to INSERT statements so that
  // lastInsertRowid is always populated, matching the SQLite adapter.
  async run(sql, params = []) {
    const trimmed = sql.trimStart().toUpperCase();
    let q = toPositional(sql);
    if (trimmed.startsWith('INSERT') && !trimmed.includes('RETURNING')) {
      q += ' RETURNING id';
    }
    const result = await pool.query(q, params);
    return {
      lastInsertRowid: result.rows[0]?.id ?? null,
      changes: result.rowCount,
    };
  },

  async exec(sql) {
    await pool.query(sql);
  },

  async transaction(fn) {
    const client = await pool.connect();
    // Build a transaction-scoped sub-adapter that uses the checked-out client
    const txDb = {
      dialect: 'postgres',
      get:  async (sql, p = []) => { const r = await client.query(toPositional(sql), p); return r.rows[0] ?? null; },
      all:  async (sql, p = []) => { const r = await client.query(toPositional(sql), p); return r.rows; },
      run:  async (sql, p = []) => {
        const trimmed = sql.trimStart().toUpperCase();
        let q = toPositional(sql);
        if (trimmed.startsWith('INSERT') && !trimmed.includes('RETURNING')) q += ' RETURNING id';
        const r = await client.query(q, p);
        return { lastInsertRowid: r.rows[0]?.id ?? null, changes: r.rowCount };
      },
      exec: async (sql) => client.query(sql),
    };
    try {
      await client.query('BEGIN');
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
};

export default db;
