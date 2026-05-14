import db from '../db/index.js';
import { evaluateFlag } from '../lib/evaluate.js';

// OFREP — OpenFeature Remote Evaluation Protocol.
// Lets any OpenFeature SDK (Node, Go, Python, Java, .NET, web) talk to this
// server using the standard provider, no custom integration required.
//
//   POST /ofrep/v1/evaluate/flags/:key   single flag evaluation
//   POST /ofrep/v1/evaluate/flags        bulk evaluation (all flags)
//
// Request:  { context: { targetingKey, ...attributes } }
// Success:  { key, value, reason, variant, metadata }
// Error:    { key, errorCode, errorDetails }   (HTTP 4xx)

const REASON_MAP = {
  allocated:              'TARGETING_MATCH',
  flag_disabled:          'DISABLED',
  no_matching_allocation: 'DEFAULT',
  split_exhausted:        'ERROR',
};

async function loadFlagByKey(key) {
  const row = await db.get('SELECT * FROM flags WHERE key = ?', [key]);
  if (!row) return null;
  const variants    = await db.all('SELECT * FROM variants WHERE flag_id = ?', [row.id]);
  const allocations = await db.all('SELECT * FROM allocations WHERE flag_id = ? ORDER BY priority ASC', [row.id]);
  return {
    ...row,
    enabled:     !!row.enabled,
    variants,
    allocations: allocations.map(a => ({
      ...a,
      splits:          JSON.parse(a.splits),
      targeting_rules: a.targeting_rules ? JSON.parse(a.targeting_rules) : null,
    })),
  };
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

function toOfrepResult(flagKey, internal) {
  return {
    key:     flagKey,
    value:   internal.value,
    reason:  REASON_MAP[internal.reason] ?? 'UNKNOWN',
    variant: internal.variant ?? undefined,
    metadata: {
      bucket:          internal.bucket,
      allocation_id:   internal.allocation_id,
      internal_reason: internal.reason,
    },
  };
}

export default async function ofrepRoutes(app) {

  // POST /ofrep/v1/evaluate/flags/:key — single flag evaluation
  app.post('/v1/evaluate/flags/:key', async (req, reply) => {
    const { key } = req.params;
    const context = req.body?.context ?? {};
    const { targetingKey, ...attributes } = context;

    if (!targetingKey) {
      return reply.code(400).send({
        key,
        errorCode:    'TARGETING_KEY_MISSING',
        errorDetails: 'OFREP request requires context.targetingKey',
      });
    }

    const flag = await loadFlagByKey(key);
    if (!flag) {
      return reply.code(404).send({
        key,
        errorCode:    'FLAG_NOT_FOUND',
        errorDetails: `Flag "${key}" not found`,
      });
    }

    const result = evaluateFlag(flag, targetingKey, attributes);
    await logAssignment(key, targetingKey, attributes, result);
    return toOfrepResult(key, result);
  });

  // POST /ofrep/v1/evaluate/flags — bulk evaluation of every flag
  app.post('/v1/evaluate/flags', async (req, reply) => {
    const context = req.body?.context ?? {};
    const { targetingKey, ...attributes } = context;

    if (!targetingKey) {
      return reply.code(400).send({
        errorCode:    'TARGETING_KEY_MISSING',
        errorDetails: 'OFREP request requires context.targetingKey',
      });
    }

    const rows  = await db.all('SELECT key FROM flags');
    const flags = [];
    for (const { key } of rows) {
      const flag   = await loadFlagByKey(key);
      const result = evaluateFlag(flag, targetingKey, attributes);
      await logAssignment(key, targetingKey, attributes, result);
      flags.push(toOfrepResult(key, result));
    }
    return { flags };
  });
}
