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

async function runQuery(sql, params = []) {
  const options = {
    query: sql,
    defaultDataset: { datasetId, projectId },
    location,
  };
  if (params.length > 0) {
    options.params  = params;
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

const TIMESTAMP_DEFAULT = "FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', CURRENT_TIMESTAMP())";

// Timestamps are stored as STRING to preserve lexicographic comparison
// compatibility with the SQLite adapter (routes use string literals in WHERE).

await runQuery(`
  CREATE TABLE IF NOT EXISTS flags (
    id          INT64,
    key         STRING NOT NULL,
    name        STRING NOT NULL,
    description STRING,
    type        STRING NOT NULL DEFAULT 'boolean',
    enabled     INT64  NOT NULL DEFAULT 1,
    fields      STRING NOT NULL DEFAULT '[]',
    status      STRING NOT NULL DEFAULT 'draft',
    started_at  STRING,
    created_at  STRING NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS variants (
    id       INT64,
    flag_id  INT64  NOT NULL,
    key      STRING NOT NULL,
    value    STRING NOT NULL
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS allocations (
    id               INT64,
    flag_id          INT64  NOT NULL,
    splits           STRING NOT NULL DEFAULT '[]',
    targeting_rules  STRING,
    priority         INT64  NOT NULL DEFAULT 0
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS experiment_assignments (
    id            INT64,
    flag_key      STRING NOT NULL,
    user_id       STRING NOT NULL,
    variant       STRING,
    value         STRING,
    reason        STRING NOT NULL,
    bucket        INT64,
    allocation_id INT64,
    attributes    STRING,
    assigned_at   STRING NOT NULL DEFAULT (${TIMESTAMP_DEFAULT})
  )
`);

await runQuery(`
  CREATE TABLE IF NOT EXISTS metric_events (
    id          INT64,
    flag_key    STRING NOT NULL,
    user_id     STRING NOT NULL,
    metric_name STRING NOT NULL,
    value       FLOAT64 NOT NULL DEFAULT 1.0,
    event_at    STRING DEFAULT (${TIMESTAMP_DEFAULT})
  )
`);

// ---------------------------------------------------------------------------
// INSERT id injection
// BigQuery has no AUTOINCREMENT. For every INSERT that omits the id column,
// we generate a random INT64 and prepend it to the column list and params.
// ---------------------------------------------------------------------------

function injectId(sql, params) {
  // Match: INSERT INTO <table> (<cols>) VALUES (<placeholders>)
  const m = sql.match(/^(\s*INSERT\s+INTO\s+\S+\s*)\(([^)]*)\)(\s*VALUES\s*)\(([^)]*)\)/i);
  if (!m || /\bid\b/i.test(m[2])) {
    return { sql, params, insertedId: null };
  }
  const id = randomInt(1, 2 ** 50); // safe JS integer, fits INT64
  const newSql = `${m[1]}(id, ${m[2].trim()})${m[3]}(?, ${m[4].trim()})`;
  return { sql: newSql, params: [id, ...params], insertedId: id };
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
      const { sql: rewritten, params: rewrittenParams, insertedId } = injectId(sql, params);
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
