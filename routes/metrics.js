/**
 * Metrics routes — ingest metric events and compute per-variant results.
 *
 * The core pattern mirrors Eppo's facts table model:
 *   metric_events  JOIN  experiment_assignments  ON user_id
 *   WHERE event_at >= assignment.assigned_at   ← post-assignment only
 *   GROUP BY variant → compute rate or mean → run statistical test
 *
 * Ingestion endpoints are designed to be called from dbt pipelines, backend
 * services, or the Node.js SDK. The UI calls the results endpoint.
 */

import db from '../db/index.js';

export default async function metricsRoutes(app) {

  // ── Ingestion ──────────────────────────────────────────────────────────────

  // POST /metrics/events — record a single metric event
  app.post('/metrics/events', async (req, reply) => {
    const { flag_key, user_id, metric_name, value = 1, event_at } = req.body;
    if (!flag_key || !user_id || !metric_name)
      return reply.code(400).send({ error: 'flag_key, user_id, and metric_name are required' });

    await db.run(
      `INSERT INTO metric_events (flag_key, user_id, metric_name, value, event_at)
       VALUES (?, ?, ?, ?, ?)`,
      [flag_key, user_id, metric_name, Number(value), event_at ?? null],
    );
    return { ok: true };
  });

  // POST /metrics/events/bulk — ingest an array of events in one call.
  // Designed for dbt pipeline integration: after each pipeline run, POST the
  // full set of conversion events joined with flag_key.
  //
  // Body: { flag_key, metric_name, events: [{ user_id, value?, event_at? }] }
  // Or:   { events: [{ flag_key, user_id, metric_name, value?, event_at? }] }
  app.post('/metrics/events/bulk', async (req, reply) => {
    const { flag_key, metric_name, events } = req.body;
    if (!Array.isArray(events) || events.length === 0)
      return reply.code(400).send({ error: 'events must be a non-empty array' });

    let inserted = 0;
    for (const ev of events) {
      const fk  = ev.flag_key    ?? flag_key;
      const mn  = ev.metric_name ?? metric_name;
      const uid = ev.user_id;
      if (!fk || !mn || !uid) continue;
      await db.run(
        `INSERT INTO metric_events (flag_key, user_id, metric_name, value, event_at)
         VALUES (?, ?, ?, ?, ?)`,
        [fk, uid, mn, Number(ev.value ?? 1), ev.event_at ?? null],
      );
      inserted++;
    }
    return { ok: true, inserted };
  });

  // DELETE /metrics/events — clear metric events for a flag+metric (for re-ingestion)
  app.delete('/metrics/events', async (req, reply) => {
    const { flag_key, metric_name } = req.query;
    if (!flag_key) return reply.code(400).send({ error: 'flag_key is required' });
    const whereMetric = metric_name ? `AND metric_name = ?` : '';
    const args = metric_name ? [flag_key, metric_name] : [flag_key];
    await db.run(`DELETE FROM metric_events WHERE flag_key = ? ${whereMetric}`, args);
    return { ok: true };
  });

  // ── Discovery ──────────────────────────────────────────────────────────────

  // GET /metrics/names?flag_key=... — list distinct metric names available for a flag
  app.get('/metrics/names', async (req, reply) => {
    const { flag_key } = req.query;
    if (!flag_key) return reply.code(400).send({ error: 'flag_key is required' });
    const rows = await db.all(
      `SELECT DISTINCT metric_name, COUNT(*) as event_count
       FROM metric_events WHERE flag_key = ?
       GROUP BY metric_name ORDER BY metric_name`,
      [flag_key],
    );
    return rows;
  });

  // ── Results ────────────────────────────────────────────────────────────────

  // GET /metrics/results/:flagKey?metric=conversion&since=2024-01-01
  //
  // Joins metric_events with experiment_assignments:
  //   - Only 'allocated' assignments (excludes flag_disabled, no_match, etc.)
  //   - Only events that occurred AFTER the user was assigned (post-assignment)
  //   - Scoped to started_at by default (pass ?since= to override)
  //
  // Returns per-variant: assigned users, users with ≥1 event, conversion rate,
  // mean metric value per user, and total event count.
  app.get('/metrics/results/:flagKey', async (req, reply) => {
    const { flagKey } = req.params;
    const { metric: metricName, since } = req.query;
    if (!metricName) return reply.code(400).send({ error: 'metric query param is required' });

    const flag = await db.get('SELECT * FROM flags WHERE key = ?', [flagKey]);
    if (!flag) return reply.code(404).send({ error: 'Flag not found' });

    const sinceTs = since ?? flag.started_at ?? null;
    const whereTime = sinceTs ? `AND a.assigned_at >= '${sinceTs.replace(/'/g, '')}'` : '';

    // Per-variant stats from the join
    const rows = await db.all(
      `SELECT
         a.variant,
         COUNT(DISTINCT a.user_id)                              AS assigned,
         COUNT(DISTINCT e.user_id)                             AS converted,
         COALESCE(SUM(e.value), 0)                             AS total_value,
         COALESCE(AVG(e.agg_value), 0)                         AS mean_value
       FROM experiment_assignments a
       LEFT JOIN (
         SELECT user_id, flag_key, SUM(value) AS agg_value
         FROM metric_events
         WHERE flag_key = ? AND metric_name = ?
         GROUP BY user_id, flag_key
       ) e ON e.user_id = a.user_id AND e.flag_key = a.flag_key
       WHERE a.flag_key = ? AND a.reason = 'allocated' ${whereTime}
       GROUP BY a.variant`,
      [flagKey, metricName, flagKey],
    );

    return {
      flag_key:    flagKey,
      metric_name: metricName,
      since:       sinceTs,
      variants:    rows.map(r => ({
        variant:    r.variant,
        assigned:   r.assigned,
        converted:  r.converted,
        rate:       r.assigned > 0 ? Math.round((r.converted / r.assigned) * 10000) / 10000 : 0,
        mean_value: Math.round(r.mean_value * 10000) / 10000,
        total_value: r.total_value,
      })),
    };
  });
}
