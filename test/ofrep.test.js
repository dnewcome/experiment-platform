/**
 * OFREP (OpenFeature Remote Evaluation Protocol) route tests.
 *
 * Uses Fastify's inject() for in-process HTTP — no real port, no network.
 * Runs against an in-memory SQLite database; the test script in package.json
 * sets DATABASE_PATH=:memory: before any modules are loaded.
 *
 * Coverage:
 *   - Single flag: success, disabled, unknown flag, missing targetingKey
 *   - Reason mapping (allocated → TARGETING_MATCH, flag_disabled → DISABLED,
 *                     no_matching_allocation → DEFAULT)
 *   - Bulk endpoint: success shape, missing targetingKey
 *   - Determinism (same targetingKey → same variant)
 *   - Assignment logging side-effect
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import flagRoutes    from '../routes/flags.js';
import evaluateRoute from '../routes/evaluate.js';
import ofrepRoutes   from '../routes/ofrep.js';

let app;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(flagRoutes,    { prefix: '/api'   });
  await app.register(evaluateRoute, { prefix: '/api'   });
  await app.register(ofrepRoutes,   { prefix: '/ofrep' });
  await app.ready();
});

after(async () => {
  await app.close();
});

let _seq = 0;
const uid = () => `ofrep-flag-${++_seq}`;

async function inject(method, url, body) {
  const res = await app.inject({
    method,
    url,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
}

const GET  = url      => inject('GET',  url);
const POST = (url, b) => inject('POST', url, b);
const PUT  = (url, b) => inject('PUT',  url, b);

// Create a flag with two variants and a 50/50 catch-all allocation
async function makeFullFlag(overrides = {}) {
  const { body: flag } = await POST('/api/flags', {
    key: uid(), name: 'OFREP Test Flag', type: 'boolean', ...overrides,
  });
  await POST(`/api/flags/${flag.id}/variants`, { key: 'control',   value: 'false' });
  await POST(`/api/flags/${flag.id}/variants`, { key: 'treatment', value: 'true'  });
  await POST(`/api/flags/${flag.id}/allocations`, {
    splits: [
      { variant_key: 'control',   weight: 50 },
      { variant_key: 'treatment', weight: 50 },
    ],
    priority: 0,
  });
  const { body: full } = await GET(`/api/flags/${flag.id}`);
  return full;
}

// ---------------------------------------------------------------------------
// Single flag evaluation
// ---------------------------------------------------------------------------

describe('POST /ofrep/v1/evaluate/flags/:key', () => {
  it('evaluates an enabled flag and returns OFREP-shaped response', async () => {
    const flag = await makeFullFlag();
    const { status, body } = await POST(`/ofrep/v1/evaluate/flags/${flag.key}`, {
      context: { targetingKey: 'user-1', country: 'US' },
    });
    assert.equal(status, 200);
    assert.equal(body.key, flag.key);
    assert.ok(['control', 'treatment'].includes(body.variant));
    assert.equal(body.reason, 'TARGETING_MATCH');
    assert.ok(typeof body.value === 'boolean', 'boolean flag value should be coerced');
    assert.ok(body.metadata, 'metadata should be present');
    assert.equal(body.metadata.internal_reason, 'allocated');
    assert.ok(Number.isInteger(body.metadata.bucket));
    assert.ok(body.metadata.allocation_id);
  });

  it('maps flag_disabled to DISABLED reason', async () => {
    const flag = await makeFullFlag();
    await PUT(`/api/flags/${flag.id}`, { name: flag.name, enabled: false });
    const { status, body } = await POST(`/ofrep/v1/evaluate/flags/${flag.key}`, {
      context: { targetingKey: 'user-1' },
    });
    assert.equal(status, 200);
    assert.equal(body.reason, 'DISABLED');
    assert.equal(body.value, null);
    assert.equal(body.metadata.internal_reason, 'flag_disabled');
  });

  it('maps no_matching_allocation to DEFAULT when targeting rules exclude the user', async () => {
    // Create a flag whose single allocation only matches plan = enterprise
    const { body: flag } = await POST('/api/flags', { key: uid(), name: 'F', type: 'boolean' });
    await POST(`/api/flags/${flag.id}/variants`, { key: 'control',   value: 'false' });
    await POST(`/api/flags/${flag.id}/variants`, { key: 'treatment', value: 'true'  });
    await POST(`/api/flags/${flag.id}/allocations`, {
      splits: [
        { variant_key: 'control',   weight: 50 },
        { variant_key: 'treatment', weight: 50 },
      ],
      targeting_rules: { '==': [{ var: 'plan' }, 'enterprise'] },
      priority: 0,
    });
    const { body } = await POST(`/ofrep/v1/evaluate/flags/${flag.key}`, {
      context: { targetingKey: 'user-1', plan: 'starter' },
    });
    assert.equal(body.reason, 'DEFAULT');
    assert.equal(body.metadata.internal_reason, 'no_matching_allocation');
  });

  it('returns 400 with TARGETING_KEY_MISSING when context.targetingKey is absent', async () => {
    const flag = await makeFullFlag();
    const { status, body } = await POST(`/ofrep/v1/evaluate/flags/${flag.key}`, {
      context: { country: 'US' },
    });
    assert.equal(status, 400);
    assert.equal(body.errorCode, 'TARGETING_KEY_MISSING');
    assert.equal(body.key, flag.key);
  });

  it('returns 400 with TARGETING_KEY_MISSING when body is empty', async () => {
    const flag = await makeFullFlag();
    const { status, body } = await POST(`/ofrep/v1/evaluate/flags/${flag.key}`, {});
    assert.equal(status, 400);
    assert.equal(body.errorCode, 'TARGETING_KEY_MISSING');
  });

  it('returns 404 with FLAG_NOT_FOUND for an unknown flag', async () => {
    const { status, body } = await POST('/ofrep/v1/evaluate/flags/does-not-exist-xyz', {
      context: { targetingKey: 'user-1' },
    });
    assert.equal(status, 404);
    assert.equal(body.errorCode, 'FLAG_NOT_FOUND');
    assert.equal(body.key, 'does-not-exist-xyz');
  });

  it('is deterministic — same targetingKey always gets the same variant', async () => {
    const flag = await makeFullFlag();
    const variants = new Set();
    for (let i = 0; i < 5; i++) {
      const { body } = await POST(`/ofrep/v1/evaluate/flags/${flag.key}`, {
        context: { targetingKey: 'stable-user' },
      });
      variants.add(body.variant);
    }
    assert.equal(variants.size, 1, 'same targetingKey should always get the same variant');
  });

  it('uses targetingKey as the assignment user_id when logging', async () => {
    const flag = await makeFullFlag();
    await POST(`/ofrep/v1/evaluate/flags/${flag.key}`, {
      context: { targetingKey: 'ofrep-logged-user', country: 'US' },
    });
    const { body: list } = await GET(`/api/assignments?flag_key=${flag.key}`);
    const hit = list.rows.find(r => r.user_id === 'ofrep-logged-user');
    assert.ok(hit, 'OFREP eval should log an assignment with targetingKey as user_id');
    assert.equal(hit.flag_key, flag.key);
  });
});

// ---------------------------------------------------------------------------
// Bulk evaluation
// ---------------------------------------------------------------------------

describe('POST /ofrep/v1/evaluate/flags', () => {
  it('returns a flags array with one entry per existing flag', async () => {
    // Create at least two flags so we know the bulk endpoint returns multiple
    const a = await makeFullFlag();
    const b = await makeFullFlag();
    const { status, body } = await POST('/ofrep/v1/evaluate/flags', {
      context: { targetingKey: 'bulk-user' },
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.flags));
    const keys = new Set(body.flags.map(f => f.key));
    assert.ok(keys.has(a.key), 'flag a missing from bulk response');
    assert.ok(keys.has(b.key), 'flag b missing from bulk response');
  });

  it('each entry has OFREP shape (key, reason, metadata)', async () => {
    await makeFullFlag();
    const { body } = await POST('/ofrep/v1/evaluate/flags', {
      context: { targetingKey: 'shape-user' },
    });
    for (const entry of body.flags) {
      assert.ok(typeof entry.key === 'string',    'key should be a string');
      assert.ok(typeof entry.reason === 'string', 'reason should be a string');
      assert.ok(entry.metadata, 'metadata should be present');
      assert.ok(typeof entry.metadata.internal_reason === 'string');
    }
  });

  it('returns 400 with TARGETING_KEY_MISSING when context.targetingKey is absent', async () => {
    const { status, body } = await POST('/ofrep/v1/evaluate/flags', { context: {} });
    assert.equal(status, 400);
    assert.equal(body.errorCode, 'TARGETING_KEY_MISSING');
  });
});
