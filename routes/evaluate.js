import db from '../db/index.js';
import { getBucket, parseValue, evaluateFlag } from '../lib/evaluate.js';

// ---------------------------------------------------------------------------
// Chi-squared goodness-of-fit for Sample Ratio Mismatch detection.
// Compares observed variant counts to expected counts from split weights.
// Returns { srm: bool, pValue, observed, expected, chiSq }
// ---------------------------------------------------------------------------

function chiSquaredCDF(x, df) {
  // Regularised incomplete gamma function via series expansion (accurate for df <= 20)
  if (x <= 0) return 0;
  let sum = 1, term = 1;
  const k = df / 2;
  for (let i = 1; i <= 200; i++) {
    term *= x / (2 * (k + i));
    sum  += term;
    if (term < 1e-10) break;
  }
  // Gamma(k) approximation via Stirling for normalisation
  const logGammaK = (k - 0.5) * Math.log(k) - k + 0.5 * Math.log(2 * Math.PI);
  return Math.min(1, (Math.exp(-x / 2) * Math.pow(x / 2, k) * sum) / Math.exp(logGammaK));
}

function srmTest(observedMap, splitWeights) {
  const total    = Object.values(observedMap).reduce((s, n) => s + n, 0);
  const totalW   = splitWeights.reduce((s, sp) => s + sp.weight, 0);
  let   chiSq    = 0;
  const observed = {}, expected = {};

  for (const sp of splitWeights) {
    const exp = total * (sp.weight / totalW);
    const obs = observedMap[sp.variant_key] ?? 0;
    observed[sp.variant_key] = obs;
    expected[sp.variant_key] = Math.round(exp * 10) / 10;
    if (exp > 0) chiSq += (obs - exp) ** 2 / exp;
  }

  const df     = splitWeights.length - 1;
  const pValue = df > 0 ? 1 - chiSquaredCDF(chiSq, df) : 1;

  return { srm: pValue < 0.01, pValue: Math.round(pValue * 10000) / 10000, chiSq: Math.round(chiSq * 100) / 100, observed, expected, total };
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

  // GET /srm/:flagKey — Sample Ratio Mismatch check for a flag's first allocation
  app.get('/srm/:flagKey', async (req, reply) => {
    const flag = await db.get('SELECT * FROM flags WHERE key = ?', [req.params.flagKey]);
    if (!flag) return reply.code(404).send({ error: 'Flag not found' });

    const allocs = await db.all('SELECT * FROM allocations WHERE flag_id = ? ORDER BY priority ASC', [flag.id]);
    if (!allocs.length) return reply.code(400).send({ error: 'No allocations on this flag' });

    const splits = JSON.parse(allocs[0].splits);
    const since  = req.query.since ?? flag.started_at ?? null;
    const whereTime = since ? `AND assigned_at >= '${since.replace(/'/g, '')}'` : '';

    const rows = await db.all(
      `SELECT variant, COUNT(*) as n FROM experiment_assignments
       WHERE flag_key = ? AND reason = 'allocated' ${whereTime}
       GROUP BY variant`,
      [flag.key],
    );

    const observedMap = {};
    for (const r of rows) if (r.variant) observedMap[r.variant] = r.n;

    const result = srmTest(observedMap, splits);
    return { flag_key: flag.key, since, allocation_id: allocs[0].id, ...result };
  });

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
