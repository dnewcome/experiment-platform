import { createRequire } from 'module';
import crypto from 'crypto';
import db from '../db/index.js';

const require = createRequire(import.meta.url);
const jsonLogic = require('json-logic-js');

function getBucket(userId, flagKey) {
  const hash = crypto.createHash('md5').update(`${flagKey}/${userId}`).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % 100;
}

function parseValue(rawValue, type) {
  switch (type) {
    case 'boolean': return rawValue === 'true' || rawValue === true;
    case 'json':    try { return JSON.parse(rawValue); } catch { return rawValue; }
    default:        return rawValue;
  }
}

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

  app.post('/evaluate', async (req, reply) => {
    const { flag_key, user_id, attributes = {} } = req.body;
    if (!flag_key || !user_id)
      return reply.code(400).send({ error: 'flag_key and user_id are required' });

    const flag = await db.get('SELECT * FROM flags WHERE key = ?', [flag_key]);
    if (!flag) return reply.code(404).send({ error: `Flag "${flag_key}" not found` });

    if (!flag.enabled) {
      const r = { variant: null, value: null, reason: 'flag_disabled' };
      await logAssignment(flag_key, user_id, attributes, r);
      return r;
    }

    const allocations = await db.all('SELECT * FROM allocations WHERE flag_id = ? ORDER BY priority ASC', [flag.id]);
    const variants    = await db.all('SELECT * FROM variants WHERE flag_id = ?', [flag.id]);
    const bucket      = getBucket(user_id, flag_key);
    const ctx         = { ...attributes, user_id };

    for (const alloc of allocations) {
      if (alloc.targeting_rules) {
        const matched = jsonLogic.apply(JSON.parse(alloc.targeting_rules), ctx);
        if (!matched) continue;
      }

      const splits = JSON.parse(alloc.splits);
      let cursor = 0;
      for (const split of splits) {
        cursor += split.weight;
        if (bucket < cursor) {
          const variant = variants.find(v => v.key === split.variant_key);
          const r = {
            variant:       split.variant_key,
            value:         variant ? parseValue(variant.value, flag.type) : null,
            reason:        'allocated',
            bucket,
            allocation_id: alloc.id,
          };
          await logAssignment(flag_key, user_id, attributes, r);
          return r;
        }
      }

      const r = { variant: null, value: null, reason: 'split_exhausted', bucket };
      await logAssignment(flag_key, user_id, attributes, r);
      return r;
    }

    const r = { variant: null, value: null, reason: 'no_matching_allocation', bucket };
    await logAssignment(flag_key, user_id, attributes, r);
    return r;
  });
}
