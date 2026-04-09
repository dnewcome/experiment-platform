/**
 * Warehouse analysis routes.
 *
 * Eppo-style "facts table" analysis: the caller provides SQL snippets that
 * define where their assignment and metric data live.  The server composes
 * them into a single CTE query that:
 *   1. Reads assignments from the caller's SQL (must yield entity_id, variant,
 *      assigned_at).
 *   2. Reads metric events from the caller's SQL (must yield entity_id, value,
 *      event_at — event_at may be NULL to include all events).
 *   3. Joins on entity_id, filtering to post-assignment events.
 *   4. Aggregates per-user then per-variant, returning the statistics needed
 *      for delta-method confidence intervals.
 *
 * The query runs against whatever database adapter is configured (SQLite,
 * Postgres, or BigQuery), so "warehouse" data just means whatever is
 * reachable from that adapter's connection.
 *
 * SQL snippets run without bound parameters — use literal values.
 */

import db from '../db/index.js';

export default async function analysisRoutes(app) {

  // ── Preview ───────────────────────────────────────────────────────────────

  // POST /analysis/preview
  // Body: { sql }
  // Wraps the user's SQL in a subquery and returns the first 10 rows.
  // Useful for verifying column names / shape before running a full analysis.
  app.post('/analysis/preview', async (req, reply) => {
    const { sql } = req.body ?? {};
    if (!sql?.trim()) return reply.code(400).send({ error: 'sql is required' });

    // Subquery alias is required by Postgres; harmless on SQLite and BigQuery.
    const previewSql = `SELECT * FROM (\n${sql}\n) AS _preview LIMIT 10`;

    try {
      const rows = await db.all(previewSql);
      return { rows };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── Run ───────────────────────────────────────────────────────────────────

  // POST /analysis/run
  // Body: { assignment_sql, metric_sql, metric_name? }
  // Returns per-variant: assigned, converted, rate, mean, variance, total_value
  app.post('/analysis/run', async (req, reply) => {
    const { assignment_sql, metric_sql, metric_name = 'metric' } = req.body ?? {};
    if (!assignment_sql?.trim()) return reply.code(400).send({ error: 'assignment_sql is required' });
    if (!metric_sql?.trim())    return reply.code(400).send({ error: 'metric_sql is required' });

    // Compose the analysis query from the two user-supplied CTEs.
    // per_user rolls up each entity to a single value so variance is computed
    // across all assigned users (non-converters contribute 0).
    const sql = `
      WITH assignments AS (
        ${assignment_sql}
      ),
      metric_raw AS (
        ${metric_sql}
      ),
      per_user AS (
        SELECT
          a.variant,
          a.entity_id,
          COALESCE(SUM(m.value), 0) AS user_value
        FROM assignments a
        LEFT JOIN metric_raw m
          ON  m.entity_id = a.entity_id
          AND (m.event_at   IS NULL
               OR a.assigned_at IS NULL
               OR m.event_at >= a.assigned_at)
        GROUP BY a.variant, a.entity_id
      )
      SELECT
        variant,
        COUNT(*)                                          AS assigned,
        COUNT(CASE WHEN user_value > 0 THEN 1 END)       AS converted,
        COALESCE(SUM(user_value),         0)              AS total_value,
        COALESCE(SUM(user_value * user_value), 0)         AS sum_sq_value
      FROM per_user
      GROUP BY variant
      ORDER BY variant
    `;

    try {
      const rows = await db.all(sql);
      return {
        metric_name,
        variants: rows.map(r => {
          const n        = Number(r.assigned);
          const conv     = Number(r.converted);
          const total    = Number(r.total_value);
          const sumSq    = Number(r.sum_sq_value);
          const mean     = n > 0 ? total / n : 0;
          const variance = n > 1
            ? (sumSq / n - mean * mean) * (n / (n - 1))
            : mean * (1 - mean);
          return {
            variant:     r.variant,
            assigned:    n,
            converted:   conv,
            rate:        n > 0 ? Math.round((conv / n) * 10000) / 10000 : 0,
            mean:        Math.round(mean     * 1e6) / 1e6,
            variance:    Math.round(variance * 1e6) / 1e6,
            total_value: total,
          };
        }),
      };
    } catch (err) {
      let msg = err.message;
      if (/entity_id/i.test(msg)) {
        msg = `Column 'entity_id' not found. Both assignment_sql and metric_sql must alias the user/entity id column as entity_id, e.g.:\n  SELECT user_id AS entity_id, ...\n\nOriginal error: ${msg}`;
      }
      return reply.code(400).send({ error: msg });
    }
  });

  // ── Configs ───────────────────────────────────────────────────────────────

  // GET /analysis/configs
  app.get('/analysis/configs', async () => {
    const rows = await db.all('SELECT * FROM warehouse_configs ORDER BY created_at DESC');
    return rows.map(r => ({ ...r, metrics: JSON.parse(r.metrics ?? '[]') }));
  });

  // POST /analysis/configs
  app.post('/analysis/configs', async (req, reply) => {
    const { name, assignment_sql, metrics } = req.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const result = await db.run(
      `INSERT INTO warehouse_configs (name, assignment_sql, metrics, created_at)
       VALUES (?, ?, ?, ?)`,
      [name, assignment_sql ?? '', JSON.stringify(metrics ?? []), now],
    );
    return { id: result.lastInsertRowid, ok: true };
  });

  // PUT /analysis/configs/:id
  app.put('/analysis/configs/:id', async (req, reply) => {
    const { name, assignment_sql, metrics } = req.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' });
    await db.run(
      `UPDATE warehouse_configs SET name = ?, assignment_sql = ?, metrics = ? WHERE id = ?`,
      [name, assignment_sql ?? '', JSON.stringify(metrics ?? []), req.params.id],
    );
    return { ok: true };
  });

  // DELETE /analysis/configs/:id
  app.delete('/analysis/configs/:id', async (req, reply) => {
    await db.run('DELETE FROM warehouse_configs WHERE id = ?', [req.params.id]);
    return { ok: true };
  });
}
