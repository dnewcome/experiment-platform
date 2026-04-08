/**
 * Core flag evaluation logic — shared by the API route and the Node.js SDK.
 *
 * Both consumers import from here so the bucketing algorithm and split
 * assignment logic can never silently diverge.
 */

import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const jsonLogic = require('json-logic-js');

/**
 * Map a userId+flagKey pair to a stable bucket in [0, 99].
 * Uses the first 32 bits of an MD5 hash so the distribution is uniform
 * and independent across flags (different flag keys produce unrelated buckets
 * for the same user).
 */
export function getBucket(userId, flagKey) {
  const hash = crypto.createHash('md5').update(`${flagKey}/${userId}`).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % 100;
}

/**
 * Coerce a raw variant value string to the flag's declared type.
 */
export function parseValue(rawValue, type) {
  switch (type) {
    case 'boolean': return rawValue === 'true' || rawValue === true;
    case 'json':    try { return JSON.parse(rawValue); } catch { return rawValue; }
    default:        return rawValue;
  }
}

/**
 * Evaluate a flag for a given user.
 *
 * @param {object}   flag              Full flag object as returned by GET /api/flags/:id
 *                                     (variants and allocations already parsed from JSON)
 * @param {string}   userId
 * @param {object}  [attributes={}]    Targeting context passed by the caller
 * @returns {{ variant: string|null, value: *, reason: string, bucket?: number, allocation_id?: number }}
 *
 * Reason codes:
 *   allocated              — user matched an allocation and landed in a split
 *   flag_disabled          — flag.enabled is false
 *   no_matching_allocation — no allocation's targeting rules matched
 *   split_exhausted        — targeting matched but splits don't cover bucket (misconfiguration)
 */
export function evaluateFlag(flag, userId, attributes = {}) {
  if (!flag.enabled) {
    return { variant: null, value: null, reason: 'flag_disabled' };
  }

  const bucket = getBucket(userId, flag.key);
  const ctx    = { ...attributes, user_id: userId };

  for (const alloc of flag.allocations) {
    if (alloc.targeting_rules) {
      const matched = jsonLogic.apply(alloc.targeting_rules, ctx);
      if (!matched) continue;
    }

    let cursor = 0;
    for (const split of alloc.splits) {
      cursor += split.weight;
      if (bucket < cursor) {
        const variant = flag.variants.find(v => v.key === split.variant_key);
        return {
          variant:       split.variant_key,
          value:         variant ? parseValue(variant.value, flag.type) : null,
          reason:        'allocated',
          bucket,
          allocation_id: alloc.id,
        };
      }
    }

    return { variant: null, value: null, reason: 'split_exhausted', bucket };
  }

  return { variant: null, value: null, reason: 'no_matching_allocation', bucket };
}
