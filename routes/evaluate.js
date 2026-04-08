import db from '../db/index.js';
import { getBucket, parseValue, evaluateFlag } from '../lib/evaluate.js';

async function logAssignment(flagKey, userId, attributes, result) {
  try {
    await db.run(
      `INSERT INTO experiment_assignments
        (flag_key, user_id, variant, value, reason, bucket, allocation_id, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        flagKey,
        userId,
        result.variant ?? null,
        result.value !== undefined ? JSON.stringify(result.value) : null,
        result.reason,
        result.bucket ?? null,
        result.allocation_id ?? null,
        JSON.stringify(attributes),
      ],
    );
  } catch (e) {
    console.error('Failed to log assignment:', e.message);
  }
}

export default async function evaluateRoute(app) {

  app.get('/assignments', async (req) => {
    const limit    = Math.min(Number(req.query.limit  ?? 200), 1000);
    const offset   = Number(req.query.offset ?? 0);
    const flagKey  = req.query.flag_key ?? null;
    const where    = flagKey ? 'WHERE flag_key = ?' : '';
    const baseArgs = flagKey ? [flagKey] : [];

    const rows  = await db.all(`SELECT * FROM experiment_assignments ${where} ORDER BY assigned_at DESC LIMIT ? OFFSET ?`, [...baseArgs, limit, offset]);
    const total = (await db.get(`SELECT COUNT(*) as n FROM experiment_assignments ${where}`, baseArgs)).n;

    return { rows, total, limit, offset };
  });

  app.delete('/assignments', async () => {
    await db.run('DELETE FROM experiment_assignments');
    return { ok: true };
  });

  // POST /assignments — log a pre-computed assignment from the SDK.
  // The SDK evaluates locally; this endpoint records the result without re-evaluating.
  app.post('/assignments', async (req, reply) => {
    const { flag_key, user_id, variant, value, reason, bucket, allocation_id, attributes } = req.body;
    if (!flag_key || !user_id || !reason)
      return reply.code(400).send({ error: 'flag_key, user_id, and reason are required' });
    await db.run(
      `INSERT INTO experiment_assignments
         (flag_key, user_id, variant, value, reason, bucket, allocation_id, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        flag_key,
        user_id,
        variant      ?? null,
        value        !== undefined ? JSON.stringify(value) : null,
        reason,
        bucket       ?? null,
        allocation_id ?? null,
        JSON.stringify(attributes ?? {}),
      ],
    );
    return { ok: true };
  });

  app.post('/evaluate', async (req, reply) => {
    const { flag_key, user_id, attributes = {} } = req.body;
    if (!flag_key || !user_id)
      return reply.code(400).send({ error: 'flag_key and user_id are required' });

    const row = await db.get('SELECT * FROM flags WHERE key = ?', [flag_key]);
    if (!row) return reply.code(404).send({ error: `Flag "${flag_key}" not found` });

    const variants    = await db.all('SELECT * FROM variants WHERE flag_id = ?', [row.id]);
    const allocations = await db.all('SELECT * FROM allocations WHERE flag_id = ? ORDER BY priority ASC', [row.id]);

    // Build the same shape that the SDK cache holds (parsed JSON fields)
    const flag = {
      ...row,
      enabled:     !!row.enabled,
      variants,
      allocations: allocations.map(a => ({
        ...a,
        splits:          JSON.parse(a.splits),
        targeting_rules: a.targeting_rules ? JSON.parse(a.targeting_rules) : null,
      })),
    };

    const r = evaluateFlag(flag, user_id, attributes);
    await logAssignment(flag_key, user_id, attributes, r);
    return r;
  });
}
