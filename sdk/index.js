/**
 * Experiment Platform — Node.js SDK
 *
 * Evaluates feature flags locally against a cached copy of the server config.
 * Assignment logging is explicit — call logAssignment() yourself after evaluating.
 *
 * Usage:
 *   import { ExperimentClient } from './sdk/index.js';
 *
 *   const client = new ExperimentClient({ host: 'http://localhost:3000' });
 *   await client.init();
 *
 *   const result = client.evaluate('my-flag', 'user-123', { country: 'US' });
 *   client.logAssignment('my-flag', 'user-123', result, { country: 'US' });
 *
 *   client.close(); // stop polling
 */

import { evaluateFlag } from '../lib/evaluate.js';

// ---------------------------------------------------------------------------
// ExperimentClient
// ---------------------------------------------------------------------------

export class ExperimentClient {
  #host;
  #pollingInterval;
  #onError;
  #flags = new Map(); // flagKey → full flag object (with variants + allocations)
  #timer = null;
  #initialized = false;

  /**
   * @param {object} options
   * @param {string}   options.host             Base URL of the experiment platform server
   * @param {number}  [options.pollingInterval]  Config refresh interval in ms (default 60 000)
   * @param {Function}[options.onError]          Called with Error on config fetch failures.
   *                                             If omitted, errors are silently swallowed and
   *                                             the stale config is retained.
   */
  constructor({ host, pollingInterval = 60_000, onError = null }) {
    this.#host            = host.replace(/\/$/, '');
    this.#pollingInterval = pollingInterval;
    this.#onError         = onError;
  }

  /**
   * Fetch the initial config and start the polling interval.
   * Must be awaited before calling evaluate().
   * @returns {this}
   */
  async init() {
    await this.#fetchConfig();
    this.#timer = setInterval(() => this.#fetchConfig(), this.#pollingInterval);
    // Don't prevent the Node process from exiting when polling is the only thing running
    this.#timer.unref?.();
    this.#initialized = true;
    return this;
  }

  /**
   * Evaluate a flag for a user synchronously.
   * No network call — uses the locally cached config.
   *
   * @param {string} flagKey
   * @param {string} userId
   * @param {object} [attributes]  Targeting context (country, plan, etc.)
   * @returns {{ variant: string|null, value: *, reason: string, bucket?: number, allocation_id?: number }}
   */
  evaluate(flagKey, userId, attributes = {}) {
    if (!this.#initialized) {
      throw new Error('ExperimentClient.init() must be awaited before calling evaluate()');
    }

    const flag = this.#flags.get(flagKey);
    if (!flag) return { variant: null, value: null, reason: 'unknown_flag' };
    return evaluateFlag(flag, userId, attributes);
  }

  /**
   * Log a pre-computed assignment back to the server asynchronously.
   * Fire-and-forget — returns immediately without waiting for the response.
   * Errors are silently swallowed; wire up onError in the constructor if you need them.
   *
   * @param {string} flagKey
   * @param {string} userId
   * @param {object} result      The object returned by evaluate()
   * @param {object} [attributes]
   */
  logAssignment(flagKey, userId, result, attributes = {}) {
    fetch(`${this.#host}/api/assignments`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flag_key:      flagKey,
        user_id:       userId,
        variant:       result.variant       ?? null,
        value:         result.value         ?? null,
        reason:        result.reason,
        bucket:        result.bucket        ?? null,
        allocation_id: result.allocation_id ?? null,
        attributes,
      }),
    }).catch(e => this.#onError?.(e));
  }

  /**
   * Return the number of flags currently in the local cache.
   * Useful for health checks after init().
   */
  get flagCount() {
    return this.#flags.size;
  }

  /**
   * Stop the polling interval. Call this on shutdown.
   */
  close() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  // ---------------------------------------------------------------------------

  async #fetchConfig() {
    try {
      const res = await fetch(`${this.#host}/api/sdk/config`);
      if (!res.ok) throw new Error(`Config fetch failed: HTTP ${res.status}`);
      const flags = await res.json();
      const map = new Map();
      for (const f of flags) map.set(f.key, f);
      this.#flags = map;
    } catch (e) {
      // Keep stale config on failure so in-flight traffic is unaffected
      this.#onError?.(e);
    }
  }
}
