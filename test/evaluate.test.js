/**
 * Tests for lib/evaluate.js — the shared evaluation logic used by both the
 * API route (routes/evaluate.js) and the Node.js SDK (sdk/index.js).
 *
 * Because both consumers import from the same module, these tests guarantee
 * that the server and SDK can never produce different results for the same input.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getBucket, parseValue, evaluateFlag } from '../lib/evaluate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlag(overrides = {}) {
  return {
    key:         'test-flag',
    enabled:     true,
    type:        'boolean',
    variants: [
      { key: 'control',   value: 'false' },
      { key: 'treatment', value: 'true'  },
    ],
    allocations: [
      {
        id:               1,
        splits:           [{ variant_key: 'control', weight: 50 }, { variant_key: 'treatment', weight: 50 }],
        targeting_rules:  null,
        priority:         0,
      },
    ],
    ...overrides,
  };
}

// Find a userId whose bucket falls in [lo, hi) for the given flagKey
function findUserInBucketRange(flagKey, lo, hi, prefix = 'user') {
  for (let i = 0; i < 10_000; i++) {
    const id = `${prefix}-${i}`;
    const b  = getBucket(id, flagKey);
    if (b >= lo && b < hi) return id;
  }
  throw new Error(`No user found in bucket range [${lo}, ${hi}) after 10 000 tries`);
}

// ---------------------------------------------------------------------------
// getBucket
// ---------------------------------------------------------------------------

describe('getBucket', () => {
  it('returns a number in [0, 99]', () => {
    for (let i = 0; i < 100; i++) {
      const b = getBucket(`user-${i}`, 'some-flag');
      assert.ok(b >= 0 && b <= 99, `bucket ${b} out of range for user-${i}`);
    }
  });

  it('is deterministic — same inputs always produce the same bucket', () => {
    const b1 = getBucket('user-abc', 'flag-x');
    const b2 = getBucket('user-abc', 'flag-x');
    assert.equal(b1, b2);
  });

  it('is sensitive to userId — different users get different buckets', () => {
    const buckets = new Set(
      Array.from({ length: 200 }, (_, i) => getBucket(`user-${i}`, 'flag-x'))
    );
    // With 200 users and 100 buckets we expect close to full coverage
    assert.ok(buckets.size > 80, `only ${buckets.size} distinct buckets across 200 users`);
  });

  it('is sensitive to flagKey — same user gets independent buckets per flag', () => {
    // It would be extremely unlikely (but not impossible) for a user to have
    // the same bucket across 10 different flags if hashing is flag-independent
    const userId   = 'user-test';
    const buckets  = new Set(
      Array.from({ length: 10 }, (_, i) => getBucket(userId, `flag-${i}`))
    );
    assert.ok(buckets.size > 1, 'all flags produced the same bucket — hashing is not flag-aware');
  });

  it('matches known values (regression)', () => {
    // Computed from the server — if these change, the bucketing algorithm changed
    assert.equal(getBucket('user-1', 'json-flag-1'), 39);
    assert.equal(getBucket('user-3', 'json-flag-1'), 72);
  });
});

// ---------------------------------------------------------------------------
// parseValue
// ---------------------------------------------------------------------------

describe('parseValue', () => {
  it('boolean: coerces "true" string to true', () => {
    assert.equal(parseValue('true', 'boolean'), true);
  });

  it('boolean: coerces "false" string to false', () => {
    assert.equal(parseValue('false', 'boolean'), false);
  });

  it('boolean: passes through actual boolean true', () => {
    assert.equal(parseValue(true, 'boolean'), true);
  });

  it('json: parses valid JSON string', () => {
    assert.deepEqual(parseValue('{"a":1}', 'json'), { a: 1 });
  });

  it('json: returns raw string on invalid JSON', () => {
    assert.equal(parseValue('not-json', 'json'), 'not-json');
  });

  it('string: returns value unchanged', () => {
    assert.equal(parseValue('hello', 'string'), 'hello');
  });

  it('unknown type: returns value unchanged', () => {
    assert.equal(parseValue('xyz', 'unknown-type'), 'xyz');
  });
});

// ---------------------------------------------------------------------------
// evaluateFlag
// ---------------------------------------------------------------------------

describe('evaluateFlag', () => {

  describe('flag_disabled', () => {
    it('returns flag_disabled when enabled is false', () => {
      const flag   = makeFlag({ enabled: false });
      const result = evaluateFlag(flag, 'user-1');
      assert.equal(result.reason,  'flag_disabled');
      assert.equal(result.variant, null);
      assert.equal(result.value,   null);
    });
  });

  describe('no allocations', () => {
    it('returns no_matching_allocation when allocations array is empty', () => {
      const flag   = makeFlag({ allocations: [] });
      const result = evaluateFlag(flag, 'user-1');
      assert.equal(result.reason, 'no_matching_allocation');
    });
  });

  describe('split assignment', () => {
    it('assigns control to user whose bucket is in [0, 50)', () => {
      const flag   = makeFlag();
      const userId = findUserInBucketRange(flag.key, 0, 50);
      const result = evaluateFlag(flag, userId);
      assert.equal(result.reason,  'allocated');
      assert.equal(result.variant, 'control');
      assert.equal(result.value,   false);       // parseValue('false', 'boolean')
      assert.ok(result.bucket < 50);
    });

    it('assigns treatment to user whose bucket is in [50, 100)', () => {
      const flag   = makeFlag();
      const userId = findUserInBucketRange(flag.key, 50, 100);
      const result = evaluateFlag(flag, userId);
      assert.equal(result.reason,  'allocated');
      assert.equal(result.variant, 'treatment');
      assert.equal(result.value,   true);
      assert.ok(result.bucket >= 50);
    });

    it('includes bucket and allocation_id in result', () => {
      const flag   = makeFlag();
      const userId = findUserInBucketRange(flag.key, 0, 100);
      const result = evaluateFlag(flag, userId);
      assert.equal(typeof result.bucket, 'number');
      assert.equal(result.allocation_id, 1);
    });

    it('result bucket matches getBucket()', () => {
      const flag   = makeFlag();
      const userId = 'user-determinism-check';
      const result = evaluateFlag(flag, userId);
      assert.equal(result.bucket, getBucket(userId, flag.key));
    });
  });

  describe('split_exhausted', () => {
    it('returns split_exhausted when splits sum to less than 100 and bucket falls in the gap', () => {
      const flag = makeFlag({
        allocations: [{
          id:              1,
          splits:          [{ variant_key: 'control', weight: 10 }], // only covers buckets 0-9
          targeting_rules: null,
          priority:        0,
        }],
      });
      // Find a user in the gap (bucket >= 10)
      const userId = findUserInBucketRange(flag.key, 10, 100);
      const result = evaluateFlag(flag, userId);
      assert.equal(result.reason, 'split_exhausted');
    });
  });

  describe('targeting rules', () => {
    const flagWithTargeting = makeFlag({
      allocations: [{
        id:              1,
        splits:          [{ variant_key: 'control', weight: 50 }, { variant_key: 'treatment', weight: 50 }],
        targeting_rules: { '==': [{ var: 'country' }, 'US'] },
        priority:        0,
      }],
    });

    it('assigns user when targeting rule matches', () => {
      const userId = findUserInBucketRange(flagWithTargeting.key, 0, 100);
      const result = evaluateFlag(flagWithTargeting, userId, { country: 'US' });
      assert.equal(result.reason, 'allocated');
    });

    it('returns no_matching_allocation when targeting rule does not match', () => {
      const result = evaluateFlag(flagWithTargeting, 'user-1', { country: 'CA' });
      assert.equal(result.reason, 'no_matching_allocation');
    });

    it('merges user_id into targeting context automatically', () => {
      const flag = makeFlag({
        allocations: [{
          id:              1,
          splits:          [{ variant_key: 'control', weight: 100 }],
          targeting_rules: { '==': [{ var: 'user_id' }, 'special-user'] },
          priority:        0,
        }],
      });
      assert.equal(evaluateFlag(flag, 'special-user').reason,  'allocated');
      assert.equal(evaluateFlag(flag, 'other-user').reason,    'no_matching_allocation');
    });
  });

  describe('allocation priority', () => {
    it('evaluates allocations in priority order and returns first match', () => {
      const flag = makeFlag({
        allocations: [
          {
            id:              10,
            splits:          [{ variant_key: 'treatment', weight: 100 }],
            targeting_rules: { '==': [{ var: 'plan' }, 'enterprise'] },
            priority:        0,  // evaluated first
          },
          {
            id:              20,
            splits:          [{ variant_key: 'control', weight: 100 }],
            targeting_rules: null,  // catch-all
            priority:        1,
          },
        ],
      });

      const enterprise = evaluateFlag(flag, 'user-1', { plan: 'enterprise' });
      assert.equal(enterprise.variant,       'treatment');
      assert.equal(enterprise.allocation_id, 10);

      const other = evaluateFlag(flag, 'user-1', { plan: 'free' });
      assert.equal(other.variant,       'control');
      assert.equal(other.allocation_id, 20);
    });
  });

  describe('variant not found in splits', () => {
    it('returns null value when split references a non-existent variant key', () => {
      const flag = makeFlag({
        allocations: [{
          id:              1,
          splits:          [{ variant_key: 'ghost-variant', weight: 100 }],
          targeting_rules: null,
          priority:        0,
        }],
      });
      const result = evaluateFlag(flag, 'user-1');
      assert.equal(result.variant, 'ghost-variant');
      assert.equal(result.value,   null);
      assert.equal(result.reason,  'allocated');
    });
  });
});
