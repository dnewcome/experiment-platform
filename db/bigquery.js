/**
 * BigQuery adapter.
 *
 * Environment variables:
 *   BIGQUERY_KEYFILE   — path to a GCP service account JSON file (required unless
 *                        using Application Default Credentials)
 *   BIGQUERY_PROJECT   — GCP project ID (defaults to project_id in keyfile)
 *   BIGQUERY_DATASET   — BigQuery dataset name (default: experiment_platform)
 *   BIGQUERY_LOCATION  — dataset location (default: US)
 *
 * Limitations vs SQLite/Postgres:
 *   - No AUTOINCREMENT: IDs are generated in the adapter using crypto.randomInt.
 *   - No UNIQUE enforcement: BigQuery does not enforce unique constraints.
 *   - No real transactions: transaction() runs fn sequentially without rollback.
 *   - No CREATE INDEX: BigQuery manages indexing internally.
 */

import { BigQuery } from '@google-cloud/bigquery';
import { readFileSync } from 'fs';
import { randomInt } from 'crypto';

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

const keyFile   = process.env.BIGQUERY_KEYFILE;
const datasetId = process.env.BIGQUERY_DATASET ?? 'experiment_platform';

let projectId = process.env.BIGQUERY_PROJECT;
if (!projectId && keyFile) {
  projectId = JSON.parse(readFileSync(keyFile, 'utf8')).project_id;
}

const bqOptions = { projectId };
if (keyFile) bqOptions.keyFilename = keyFile;

const bq = new BigQuery(bqOptions);
const location = process.env.BIGQUERY_LOCATION ?? 'US';

// Ensure dataset exists
const [dsExists] = await bq.dataset(datasetId).exists();
if (!dsExists) {
  await bq.createDataset(datasetId, { location });
  console.log(`BigQuery: created dataset ${projectId}.${datasetId}`);
}

// ---------------------------------------------------------------------------
// Query helper
// ---------------------------------------------------------------------------

// INT64 column names in this schema. String params that look like integers are
// coerced to Number when the SQL shows they target one of these columns.
// This is needed because route params (req.params.id etc.) are always strings,
// but BigQuery won't implicitly coerce STRING to INT64 in comparisons.
const INT64_COLUMNS = new Set(['id', 'flag_id', 'allocation_id', 'bucket', 'priority', 'enabled']);

// Single-pass param preparation:
//   - null/undefined → inline SQL NULL literal (BigQuery can't type-infer nulls)
//   - string integer for an INT64 column → Number (BigQuery strict typing)
function prepareParams(sql, params) {
  if (!params.length) return { sql, params };
  const segments = sql.split('?');
  let outSql = '';
  const outParams = [];

  params.forEach((v, i) => {
    const seg = segments[i];

    if (v === null || v === undefined) {
      outSql += seg + 'NULL';
      return;
    }

    if (typeof v === 'string' && /^\d+$/.test(v)) {
      // Check the column name immediately before this ? (handles col = ? patterns)
      const m = seg.match(/\b(\w+)\s*=\s*$/i);
      if (m && INT64_COLUMNS.has(m[1].toLowerCase())) {
        v = Number(v);
      }
    }

    outSql += seg + '?';
    outParams.push(v);
  });

  outSql += segments[params.length];
  return { sql: outSql, params: outParams };
}

async function runQuery(sql, params = []) {
  const { sql: finalSql, params: finalParams } = prepareParams(sql, params);
  const options = {
    query: finalSql,
    defaultDataset: { datasetId, projectId },
    location,
  };
  if (finalParams.length > 0) {
    options.params        = finalParams;
    options.parameterMode = 'POSITIONAL';
  }
  const [rows] = await bq.query(options);
  return (rows ?? []).map(normalizeRow);
}

// BigQuery returns INT64 as JS BigInt. Coerce all BigInt fields to Number so
// route code can use them in arithmetic without surprises.
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Timestamps stored as STRING for lexicographic comparison compatibility with
// the SQLite adapter (routes compare with string literals in WHERE clauses).
// DEFAULT and NOT NULL are omitted — BigQuery's query API does not support
// DEFAULT expressions in CREATE TABLE DDL. Missing defaults are injected by
// the adapter's run() method instead.

await runQuery(`
  CREATE TABLE IF NOT EXISTS flags (
    id          INT64,
    key         STRING,
    name        STRING,
    description STRING,
    type        STRING,
    enabled     INT64,
    fields      STRING,
    status      STRING,
    started_at  STRING,
    created_at  STRING
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS variants (
    id       INT64,
    flag_id  INT64,
    key      STRING,
    value    STRING
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS allocations (
    id               INT64,
    flag_id          INT64,
    splits           STRING,
    targeting_rules  STRING,
    priority         INT64
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS experiment_assignments (
    id            INT64,
    flag_key      STRING,
    user_id       STRING,
    variant       STRING,
    value         STRING,
    reason        STRING,
    bucket        INT64,
    allocation_id INT64,
    attributes    STRING,
    assigned_at   STRING
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS metric_events (
    id          INT64,
    flag_key    STRING,
    user_id     STRING,
    metric_name STRING,
    value       FLOAT64,
    event_at    STRING
  )
`);

// ---------------------------------------------------------------------------
// INSERT default injection
//
// BigQuery has no AUTOINCREMENT and the query API doesn't support column
// DEFAULT expressions. For every INSERT we:
//   1. Generate a random id.
//   2. Inject any table-specific defaults for columns absent from the statement.
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Columns to inject when absent from the INSERT, keyed by table name.
// Values that are functions are called at insert time.
const TABLE_DEFAULTS = {
  flags: {
    enabled:    1,
    status:     'draft',
    created_at: now,
  },
  experiment_assignments: {
    assigned_at: now,
  },
};

function injectDefaults(sql, params) {
  // Match: INSERT INTO <table> (<cols>) VALUES (<placeholders>)
  const m = sql.match(/^(\s*INSERT\s+INTO\s+(\S+)\s*)\(([^)]*)\)(\s*VALUES\s*)\(([^)]*)\)/i);
  if (!m) return { sql, params, insertedId: null };

  const table     = m[2].toLowerCase();
  const existCols = m[3].split(',').map(c => c.trim().toLowerCase());

  // Skip if id is already present
  if (existCols.includes('id')) return { sql, params, insertedId: null };

  const id       = randomInt(1, 2 ** 48); // crypto.randomInt max range is 2^48
  const addCols  = ['id'];
  const addVals  = [id];

  for (const [col, val] of Object.entries(TABLE_DEFAULTS[table] ?? {})) {
    if (!existCols.includes(col)) {
      addCols.push(col);
      addVals.push(typeof val === 'function' ? val() : val);
    }
  }

  const newCols  = [...addCols, ...m[3].split(',').map(c => c.trim())];
  const newVals  = [...addVals.map(() => '?'), ...m[5].split(',').map(c => c.trim())];
  const newSql   = `${m[1]}(${newCols.join(', ')})${m[4]}(${newVals.join(', ')})`;

  return { sql: newSql, params: [...addVals, ...params], insertedId: id };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const db = {
  dialect: 'bigquery',

  async get(sql, params = []) {
    const rows = await runQuery(sql, params);
    return rows[0] ?? null;
  },

  async all(sql, params = []) {
    return runQuery(sql, params);
  },

  // For INSERT: injects a generated id, returns { lastInsertRowid, changes: 1 }.
  // For UPDATE/DELETE: returns { lastInsertRowid: null, changes: affectedRows }.
  async run(sql, params = []) {
    const trimmed = sql.trimStart().toUpperCase();
    if (trimmed.startsWith('INSERT')) {
      const { sql: rewritten, params: rewrittenParams, insertedId } = injectDefaults(sql, params);
      await runQuery(rewritten, rewrittenParams);
      return { lastInsertRowid: insertedId, changes: 1 };
    }
    // DML responses from BigQuery don't include affected row counts via the
    // query API; return 0 as a safe default.
    await runQuery(sql, params);
    return { lastInsertRowid: null, changes: 0 };
  },

  async exec(sql) {
    await runQuery(sql);
  },

  // BigQuery does not support client-driven transactions via the query API.
  // Operations run sequentially; there is no rollback on failure.
  async transaction(fn) {
    return fn(db);
  },
};

export default db;
