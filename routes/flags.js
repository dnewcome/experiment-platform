import db from '../db.js';

const DEFAULT_FIELDS = JSON.stringify([
  { name: 'user_id',          label: 'User ID',            inputType: 'text'   },
  { name: 'email',            label: 'Email',              inputType: 'text'   },
  { name: 'country',          label: 'Country',            inputType: 'text'   },
  { name: 'plan',             label: 'Plan',               inputType: 'text'   },
  { name: 'account_age_days', label: 'Account Age (days)', inputType: 'number' },
  { name: 'company',          label: 'Company',            inputType: 'text'   },
]);

function parseFlag(row) {
  return { ...row, enabled: !!row.enabled, fields: JSON.parse(row.fields) };
}

function parseAllocation(row) {
  return {
    ...row,
    splits:          JSON.parse(row.splits),
    targeting_rules: row.targeting_rules ? JSON.parse(row.targeting_rules) : null,
  };
}

export default async function flagRoutes(app) {

  // ── Flags ──────────────────────────────────────────────────────────────────

  app.get('/flags', async () => {
    return db.prepare('SELECT * FROM flags ORDER BY created_at DESC').all().map(parseFlag);
  });

  app.post('/flags', async (req, reply) => {
    const { key, name, description, type = 'boolean' } = req.body;
    if (!key || !name) return reply.code(400).send({ error: 'key and name are required' });
    if (!['boolean', 'string', 'json'].includes(type))
      return reply.code(400).send({ error: 'type must be boolean, string, or json' });
    try {
      const r = db.prepare(
        'INSERT INTO flags (key, name, description, type, fields) VALUES (?, ?, ?, ?, ?)'
      ).run(key.trim(), name.trim(), description ?? null, type, DEFAULT_FIELDS);
      return parseFlag(db.prepare('SELECT * FROM flags WHERE id = ?').get(r.lastInsertRowid));
    } catch (e) {
      if (e.message.includes('UNIQUE')) return reply.code(409).send({ error: `Flag key "${key}" already exists` });
      throw e;
    }
  });

  app.get('/flags/:id', async (req, reply) => {
    const flag = db.prepare('SELECT * FROM flags WHERE id = ?').get(req.params.id);
    if (!flag) return reply.code(404).send({ error: 'Not found' });
    const variants    = db.prepare('SELECT * FROM variants WHERE flag_id = ?').all(flag.id);
    const allocations = db.prepare('SELECT * FROM allocations WHERE flag_id = ? ORDER BY priority ASC').all(flag.id);
    return { ...parseFlag(flag), variants, allocations: allocations.map(parseAllocation) };
  });

  app.put('/flags/:id', async (req, reply) => {
    const flag = db.prepare('SELECT * FROM flags WHERE id = ?').get(req.params.id);
    if (!flag) return reply.code(404).send({ error: 'Not found' });
    const { name, description, enabled, fields, type } = req.body;
    db.prepare(
      'UPDATE flags SET name = ?, description = ?, enabled = ?, fields = ?, type = ? WHERE id = ?'
    ).run(
      name        ?? flag.name,
      description !== undefined ? description : flag.description,
      enabled     !== undefined ? (enabled ? 1 : 0) : flag.enabled,
      fields      !== undefined ? JSON.stringify(fields) : flag.fields,
      type        ?? flag.type,
      flag.id,
    );
    return parseFlag(db.prepare('SELECT * FROM flags WHERE id = ?').get(flag.id));
  });

  app.delete('/flags/:id', async (req, reply) => {
    const flag = db.prepare('SELECT * FROM flags WHERE id = ?').get(req.params.id);
    if (!flag) return reply.code(404).send({ error: 'Not found' });
    db.prepare('DELETE FROM flags WHERE id = ?').run(flag.id);
    return { ok: true };
  });

  // ── Variants ───────────────────────────────────────────────────────────────

  app.post('/flags/:id/variants', async (req, reply) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return reply.code(400).send({ error: 'key and value are required' });
    const r = db.prepare(
      'INSERT INTO variants (flag_id, key, value) VALUES (?, ?, ?)'
    ).run(req.params.id, key.trim(), String(value));
    return db.prepare('SELECT * FROM variants WHERE id = ?').get(r.lastInsertRowid);
  });

  app.delete('/flags/:flagId/variants/:variantId', async (req, reply) => {
    const v = db.prepare('SELECT * FROM variants WHERE id = ? AND flag_id = ?')
      .get(req.params.variantId, req.params.flagId);
    if (!v) return reply.code(404).send({ error: 'Not found' });
    db.prepare('DELETE FROM variants WHERE id = ?').run(v.id);
    return { ok: true };
  });

  // ── Allocations ────────────────────────────────────────────────────────────

  app.post('/flags/:id/allocations', async (req, reply) => {
    const { splits, targeting_rules, priority } = req.body;
    if (!splits?.length) return reply.code(400).send({ error: 'splits is required' });
    const total = splits.reduce((s, x) => s + x.weight, 0);
    if (total !== 100) return reply.code(400).send({ error: `Split weights must sum to 100, got ${total}` });

    const r = db.prepare(
      'INSERT INTO allocations (flag_id, splits, targeting_rules, priority) VALUES (?, ?, ?, ?)'
    ).run(
      req.params.id,
      JSON.stringify(splits),
      targeting_rules ? JSON.stringify(targeting_rules) : null,
      priority ?? 0,
    );
    return parseAllocation(db.prepare('SELECT * FROM allocations WHERE id = ?').get(r.lastInsertRowid));
  });

  app.put('/flags/:flagId/allocations/:allocId', async (req, reply) => {
    const alloc = db.prepare('SELECT * FROM allocations WHERE id = ? AND flag_id = ?')
      .get(req.params.allocId, req.params.flagId);
    if (!alloc) return reply.code(404).send({ error: 'Not found' });

    const { splits, targeting_rules, priority } = req.body;
    if (splits) {
      const total = splits.reduce((s, x) => s + x.weight, 0);
      if (total !== 100) return reply.code(400).send({ error: `Split weights must sum to 100, got ${total}` });
    }

    db.prepare(
      'UPDATE allocations SET splits = ?, targeting_rules = ?, priority = ? WHERE id = ?'
    ).run(
      splits          ? JSON.stringify(splits) : alloc.splits,
      targeting_rules !== undefined
        ? (targeting_rules ? JSON.stringify(targeting_rules) : null)
        : alloc.targeting_rules,
      priority ?? alloc.priority,
      alloc.id,
    );
    return parseAllocation(db.prepare('SELECT * FROM allocations WHERE id = ?').get(alloc.id));
  });

  app.delete('/flags/:flagId/allocations/:allocId', async (req, reply) => {
    const alloc = db.prepare('SELECT * FROM allocations WHERE id = ? AND flag_id = ?')
      .get(req.params.allocId, req.params.flagId);
    if (!alloc) return reply.code(404).send({ error: 'Not found' });
    db.prepare('DELETE FROM allocations WHERE id = ?').run(alloc.id);
    return { ok: true };
  });
}
