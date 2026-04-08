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
 *   await client.close(); // flush queue and stop polling
 */

import { evaluateFlag } from '../lib/evaluate.js';

// ---------------------------------------------------------------------------
// Internal retry queue
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]; // 3 attempts with exponential backoff

async function fetchWithRetry(url, init, maxQueueSize, queue, onError) {
  const body = init.body; // serialised once, reused across retries
  let attempt = 0;

  const attempt_ = async () => {
    try {
      const res = await fetch(url, { ...init, body });
      if (res.ok) {
        queue.delete(attempt_);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt++];
        setTimeout(attempt_, delay);
      } else {
        queue.delete(attempt_);
        onError?.(new Error(`logAssignment failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${e.message}`));
      }
    }
  };

  // Shed load if queue is full
  if (queue.size >= maxQueueSize) {
    onError?.(new Error(`logAssignment queue full (${maxQueueSize}), dropping event`));
    return;
  }

  queue.add(attempt_);
  attempt_();
}

// ---------------------------------------------------------------------------
// ExperimentClient
// ---------------------------------------------------------------------------

export class ExperimentClient {
  #host;
  #apiKey;
  #pollingInterval;
  #maxQueueSize;
  #onError;
  #flags       = new Map(); // flagKey → full flag object (with variants + allocations)
  #timer       = null;
  #logQueue    = new Set(); // in-flight log attempts (for flush on close)
  #initialized = false;

  /**
   * @param {object}   options
   * @param {string}   options.host              Base URL of the experiment platform server
   * @param {string}  [options.apiKey]            Bearer token — required if API_KEY is set on the server
   * @param {number}  [options.pollingInterval]   Config refresh interval in ms (default 60 000)
   * @param {number}  [options.maxQueueSize]      Max concurrent in-flight log attempts before
   *                                              events are dropped (default 500)
   * @param {Function}[options.onError]           Called with Error on config fetch or log failures.
   *                                              If omitted, errors are silently swallowed.
   */
  constructor({ host, apiKey = null, pollingInterval = 60_000, maxQueueSize = 500, onError = null }) {
    this.#host            = host.replace(/\/$/, '');
    this.#apiKey          = apiKey;
    this.#pollingInterval = pollingInterval;
    this.#maxQueueSize    = maxQueueSize;
    this.#onError         = onError;
  }

  get #authHeaders() {
    return this.#apiKey ? { 'Authorization': `Bearer ${this.#apiKey}` } : {};
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
   * Log a pre-computed assignment back to the server.
   * Returns immediately — delivery is handled asynchronously with up to 3 retries
   * (1 s, 2 s, 4 s backoff). If the queue is full, the event is dropped and onError
   * is called. Errors are never thrown from this method.
   *
   * @param {string} flagKey
   * @param {string} userId
   * @param {object} result      The object returned by evaluate()
   * @param {object} [attributes]
   */
  logAssignment(flagKey, userId, result, attributes = {}) {
    fetchWithRetry(
      `${this.#host}/api/assignments`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...this.#authHeaders },
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
      },
      this.#maxQueueSize,
      this.#logQueue,
      this.#onError,
    );
  }

  /**
   * Record a metric event for a user. Fire-and-forget with the same retry
   * semantics as logAssignment().
   *
   * Call this when a user performs a measurable action (conversion, purchase,
   * click, etc.) after being assigned to a variant. The server joins these
   * events with experiment_assignments to compute per-variant metric results.
   *
   * @param {string} flagKey
   * @param {string} userId
   * @param {string} metricName   e.g. 'conversion', 'revenue', 'page_views'
   * @param {number} [value=1]    1 for binary events; revenue amount for continuous
   */
  trackMetricEvent(flagKey, userId, metricName, value = 1) {
    fetchWithRetry(
      `${this.#host}/api/metrics/events`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...this.#authHeaders },
        body: JSON.stringify({ flag_key: flagKey, user_id: userId, metric_name: metricName, value }),
      },
      this.#maxQueueSize,
      this.#logQueue,
      this.#onError,
    );
  }

  /**
   * Number of flags currently in the local cache.
   * Useful for health checks after init().
   */
  get flagCount() {
    return this.#flags.size;
  }

  /**
   * Number of assignment log events currently in-flight (queued or being retried).
   * Useful for observability / graceful shutdown decisions.
   */
  get pendingLogCount() {
    return this.#logQueue.size;
  }

  /**
   * Stop polling and wait for all in-flight log attempts to settle (up to timeoutMs).
   * Call this during graceful shutdown to avoid dropping assignments.
   *
   * @param {number} [timeoutMs=5000]
   */
  async close(timeoutMs = 5_000) {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#logQueue.size === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (this.#logQueue.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // ---------------------------------------------------------------------------

  async #fetchConfig() {
    try {
      const res = await fetch(`${this.#host}/api/sdk/config`, { headers: this.#authHeaders });
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
