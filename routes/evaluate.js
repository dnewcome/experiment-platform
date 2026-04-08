import { createRequire } from 'module';
import crypto from 'crypto';
import db from '../db.js';

const require = createRequire(import.meta.url);
const jsonLogic = require('json-logic-js');

function getBucket(userId, flagKey) {
  const hash = crypto.createHash('md5').update(`${flagKey}/${userId}`).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % 100;
}

const insertAssignment = db.prepare(`
  INSERT INTO experiment_assignments
    (flag_key, user_id, variant, value, reason, bucket, allocation_id, attributes)
  VALUES
    (@flag_key, @user_id, @variant, @value, @reason, @bucket, @allocation_id, @attributes)
`);

function logAssignment(flagKey, userId, attributes, result) {
  try {
    insertAssignment.run({
      flag_key:      flagKey,
      user_id:       userId,
      variant:       result.variant ?? null,
      value:         result.value !== undefined ? JSON.stringify(result.value) : null,
      reason:        result.reason,
      bucket:        result.bucket ?? null,
      allocation_id: result.allocation_id ?? null,
      attributes:    JSON.stringify(attributes),
    });
  } catch (e) {
    console.error('Failed to log assignment:', e.message);
  }
}

function parseValue(rawValue, type) {
  switch (type) {
    case 'boolean': return rawValue === 'true' || rawValue === true;
    case 'json':    try { return JSON.parse(rawValue); } catch { return rawValue; }
    default:        return rawValue; // string
  }
}

export default async function evaluateRoute(app) {
  app.get('/assignments', async (req) => {
    const limit  = Math.min(Number(req.query.limit  ?? 200), 1000);
    const offset = Number(req.query.offset ?? 0);
    const flag   = req.query.flag_key ?? null;

    const where = flag ? 'WHERE flag_key = ?' : '';
    const args  = flag ? [flag, limit, offset] : [limit, offset];

    const rows = db.prepare(
      `SELECT * FROM experiment_assignments ${where} ORDER BY assigned_at DESC LIMIT ? OFFSET ?`
    ).all(...args);

    const total = db.prepare(
      `SELECT COUNT(*) as n FROM experiment_assignments ${where}`
    ).get(...(flag ? [flag] : [])).n;

    return { rows, total, limit, offset };
  });

  app.delete('/assignments', async () => {
    db.prepare('DELETE FROM experiment_assignments').run();
    return { ok: true };
  });

  app.post('/evaluate', async (req, reply) => {
    const { flag_key, user_id, attributes = {} } = req.body;
    if (!flag_key || !user_id)
      return reply.code(400).send({ error: 'flag_key and user_id are required' });

    const flag = db.prepare('SELECT * FROM flags WHERE key = ?').get(flag_key);
    if (!flag) return reply.code(404).send({ error: `Flag "${flag_key}" not found` });
    if (!flag.enabled) {
      const r = { variant: null, value: null, reason: 'flag_disabled' };
      logAssignment(flag_key, user_id, attributes, r);
      return r;
    }

    const allocations = db.prepare(
      'SELECT * FROM allocations WHERE flag_id = ? ORDER BY priority ASC'
    ).all(flag.id);

    const variants = db.prepare('SELECT * FROM variants WHERE flag_id = ?').all(flag.id);
    const bucket   = getBucket(user_id, flag_key);
    const ctx      = { ...attributes, user_id };

    for (const alloc of allocations) {
      // Targeting check
      if (alloc.targeting_rules) {
        const rules   = JSON.parse(alloc.targeting_rules);
        const matched = jsonLogic.apply(rules, ctx);
        if (!matched) continue;
      }

      // Walk splits as contiguous ranges within 0–99
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
          logAssignment(flag_key, user_id, attributes, r);
          return r;
        }
      }

      // Targeting matched but splits exhausted (shouldn't happen if weights sum to 100)
      const rExhausted = { variant: null, value: null, reason: 'split_exhausted', bucket };
      logAssignment(flag_key, user_id, attributes, rExhausted);
      return rExhausted;
    }

    const rNoMatch = { variant: null, value: null, reason: 'no_matching_allocation', bucket };
    logAssignment(flag_key, user_id, attributes, rNoMatch);
    return rNoMatch;
  });
}
