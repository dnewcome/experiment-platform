# Experiment Platform

A self-hosted feature flagging and experimentation platform. Designed as a replacement for tools like Eppo or Statsig when you need full control over your targeting logic, data model, and statistical pipeline — without value limits, vendor lock-in, or per-seat pricing.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser UI (React, no build step)                  │
│  Flags · Evaluate · Assignments · Simulate          │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP
┌─────────────────────▼───────────────────────────────┐  ┌──────────────────────────┐
│  Fastify API                                        │  │  Node.js SDK             │
│  /api/flags        /api/sdk/config                  │  │  sdk/index.js            │
│  /api/evaluate     /api/assignments                 │  │                          │
└─────────────────────┬───────────────────────────────┘  │  polls /api/sdk/config   │
                      │                 ▲                 │  evaluates locally       │
┌─────────────────────▼───────────────┐ │                 │  logs via POST           │
│  lib/evaluate.js (shared core)      │─┘                 │  /api/assignments        │
│  getBucket · parseValue             │◄──────────────────┘
│  evaluateFlag                       │
└─────────────────────┬───────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│  SQLite (better-sqlite3, WAL mode)                  │
│  flags · variants · allocations                     │
│  experiment_assignments                             │
└─────────────────────────────────────────────────────┘
```

**No build step.** The frontend is plain React loaded via UMD scripts + Babel standalone. Edit `public/app.js`, refresh the browser.

**No external services.** Everything runs on one Node.js process against a local SQLite file. The database is production-ready for moderate traffic (WAL mode, indexed assignment log, prepared statements).

## Getting Started

```sh
npm install
npm run dev        # starts on http://localhost:3000
                   # auto-restarts on file changes (node --watch)
```

Delete `flags.db` and restart to reset all data.

## Concepts

### Flags

A flag is the unit of configuration. Every flag has a **type** that determines what kind of value its variants hold:

| Type | Use for | Example value |
|---|---|---|
| `boolean` | simple on/off | `true` |
| `string` | variants, themes, copy | `"checkout-v2"` |
| `json` | structured config | `{"color":"blue","size":3}` |

### Variants

A flag's possible values. Each variant has a key (the name) and a value (what gets returned to the caller when this variant is assigned).

### Allocations

An allocation answers: *who gets into this experiment, and in what proportions?*

Each allocation has:
- **Targeting rules** — JSON Logic expressions evaluated against user attributes. Unlimited complexity: nested AND/OR, any field, any operator. Or catch-all (match everyone).
- **Split weights** — how to divide matched users across variants. Must sum to 100. E.g. `control: 50, treatment: 50`.
- **Priority** — allocations are evaluated in priority order (lower = first). First matching allocation wins.

### Bucketing

Assignment is deterministic and stateless:

```
bucket = md5("${flagKey}/${userId}") % 100
```

The same user always lands in the same bucket for a given flag. No sticky sessions, no database lookup on the hot path. Users walk through the allocation's split weights as contiguous ranges: if splits are `[{control, 60}, {treatment, 40}]`, buckets 0–59 → control and 60–99 → treatment.

### Targeting Rules

Rules are built visually in the UI and stored as [JSON Logic](https://jsonlogic.com/). Fields are defined per flag. Supported operators:

| Operator | Types | Example |
|---|---|---|
| `==` / `!=` | text, number | `country == "US"` |
| `>` `>=` `<` `<=` | number | `account_age_days >= 30` |
| `contains` / `not_contains` | text | `email contains "@acme"` |
| `starts_with` | text | `plan starts_with "ent"` |
| `in` | text | `country in "US, CA, GB"` |

Groups can be nested to any depth with AND/OR combinators.

## API

All endpoints are under `/api`. Request and response bodies are JSON.

### Flags

```
GET    /api/flags                    list all flags
POST   /api/flags                    create a flag
GET    /api/flags/:id                get flag with variants + allocations
PUT    /api/flags/:id                update flag (name, enabled, fields, type)
DELETE /api/flags/:id                delete flag and all its data
```

**Create flag:**
```json
POST /api/flags
{ "key": "new-checkout", "name": "New Checkout Flow", "type": "boolean" }
```

### Variants

```
POST   /api/flags/:id/variants             add a variant
DELETE /api/flags/:flagId/variants/:id     remove a variant
```

**Add variant:**
```json
POST /api/flags/1/variants
{ "key": "treatment", "value": "true" }
```

### Allocations

```
POST   /api/flags/:id/allocations             add an allocation
PUT    /api/flags/:flagId/allocations/:id     update an allocation
DELETE /api/flags/:flagId/allocations/:id     remove an allocation
```

**Add allocation (50/50 split, US enterprise users only):**
```json
POST /api/flags/1/allocations
{
  "splits": [
    { "variant_key": "control",   "weight": 50 },
    { "variant_key": "treatment", "weight": 50 }
  ],
  "targeting_rules": {
    "and": [
      { "==": [{ "var": "country" }, "US"] },
      { "==": [{ "var": "plan" }, "enterprise"] }
    ]
  },
  "priority": 0
}
```

Split weights must sum to exactly 100.

### Evaluate

```
POST /api/evaluate
```

```json
{
  "flag_key": "new-checkout",
  "user_id": "user-abc123",
  "attributes": {
    "country": "US",
    "plan": "enterprise",
    "account_age_days": 90
  }
}
```

**Response:**
```json
{
  "variant": "treatment",
  "value": true,
  "reason": "allocated",
  "bucket": 42,
  "allocation_id": 1
}
```

**Reason codes:**

| Reason | Meaning |
|---|---|
| `allocated` | User matched an allocation and landed in-bucket |
| `no_matching_allocation` | No allocation's targeting rules matched |
| `flag_disabled` | Flag is toggled off |
| `split_exhausted` | Targeting matched but split weights don't sum to 100 (misconfiguration) |

Every evaluation is logged to `experiment_assignments`.

### Assignments

```
GET    /api/assignments?flag_key=&limit=200&offset=0    paginated log
DELETE /api/assignments                                  clear all records
```

## Data Model

```sql
flags (
  id, key, name, description, type,
  enabled, fields, created_at
)

variants (
  id, flag_id, key, value
)

allocations (
  id, flag_id,
  splits TEXT,           -- JSON: [{variant_key, weight}], weights sum to 100
  targeting_rules TEXT,  -- JSON Logic expression, null = catch-all
  priority INTEGER       -- lower evaluated first
)

experiment_assignments (
  id, flag_key, user_id, variant, value,
  reason, bucket, allocation_id, attributes,
  assigned_at
)
```

`flags.fields` is a JSON array of attribute definitions used to populate the targeting rule builder:
```json
[
  { "name": "country", "label": "Country", "inputType": "text" },
  { "name": "account_age_days", "label": "Account Age (days)", "inputType": "number" }
]
```

## Simulation & Statistical Analysis

The **Simulate** tab lets you design experiments before running them, and understand the statistics behind A/B test results.

### How it works

Pick a flag, set a simulated number of users, and configure the **true conversion rate** per variant — the ground-truth probability you're pretending to know. The simulator draws synthetic users, assigns them to variants according to the flag's real split weights, generates Bernoulli-distributed outcomes, then runs two statistical tests on the result.

The random seed makes runs reproducible: the same seed + same config = the same dataset. Changing the seed redraws from the same distribution, which is useful for understanding sampling variance.

### Frequentist test — two-proportion z-test

Tests the null hypothesis that both variants have the same true conversion rate.

```
z = (p̂₁ − p̂₂) / SE_pool

SE_pool = √( p̄(1−p̄) · (1/n₁ + 1/n₂) )

p̄ = (n₁p̂₁ + n₂p̂₂) / (n₁ + n₂)   ← weighted pooled proportion
```

The p-value is two-sided at α = 0.05. A result is "statistically significant" if p < 0.05, meaning that if the null were true, you'd see a difference this large less than 5% of the time by chance alone.

**What the p-value does not tell you:** the probability that treatment is better than control, the size of the effect, or whether the result is practically meaningful.

### Bayesian test — Beta-Binomial

Uses a Beta(1,1) uninformative prior (equivalent to having seen zero previous data). After observing the data, the posterior for each arm's true rate is:

```
posterior ∝ Beta(1 + conversions, 1 + non-conversions)
```

The posterior is approximated as normal for large n, which lets us compute:

```
P(treatment > control) = Φ( (μ₂ − μ₁) / √(σ₁² + σ₂²) )
```

where μ and σ² are the posterior mean and variance of each Beta.

This produces a direct probability statement: "there is an 87% chance treatment converts better than control, given the data." Unlike a p-value, this can be read at face value and updated as more data arrives.

The 95% credible interval on the difference can also be interpreted directly: "there is a 95% probability the true difference lies in this range" — which is what most people incorrectly believe a frequentist confidence interval means.

### Power and sample size

**Achieved power** is the probability you would detect the true effect (if it exists) at α = 0.05, given the sample sizes in this simulation. It uses the actual observed arm sizes n₁ and n₂ and the weighted pooled SE under H₀:

```
power = Φ( (|p₁ − p₂| − 1.96 · SE_null) / SE_alt )

SE_null = √( p̄(1−p̄) · (1/n₁ + 1/n₂) )
SE_alt  = √( p₁(1−p₁)/n₁ + p₂(1−p₂)/n₂ )
```

**Required total N** is solved analytically for 80% power (z_β = 0.842) at the flag's actual allocation weights w₁ and w₂:

```
N = ( 1.96·√(p̄(1−p̄)·(1/w₁+1/w₂))  +  0.842·√(p₁(1−p₁)/w₁ + p₂(1−p₂)/w₂) )²
    ─────────────────────────────────────────────────────────────────────────────
                              (p₁ − p₂)²
```

This correctly accounts for unequal allocation. A 90/10 split requires substantially more total users than a 50/50 split for the same effect size, because the minority arm accumulates observations slowly and dominates the variance. The required N and power warning in the UI both display the actual split ratio so this trade-off is visible.

### Significance, power, and the winner's curse

α = 0.05 is the significance threshold. A result is flagged significant when p < 0.05, meaning the observed difference would occur less than 5% of the time by chance if the null hypothesis were true.

Power and significance measure different things and both matter:

| State | Meaning |
|---|---|
| Significant + well-powered (≥ 60%) | Result is reliable. The observed effect is a reasonable estimate of the true effect. |
| Significant + underpowered (< 60%) | **Winner's curse.** The result is real in the frequentist sense, but the estimated effect size is probably inflated. |
| Not significant + underpowered | Inconclusive. You can't distinguish "no effect" from "effect too small to detect." |
| Not significant + well-powered | Genuine null result. You had enough data to detect a real effect and didn't find one. |

**Why significant + underpowered is dangerous (the winner's curse):**

With low power and a small sample, you can only cross p < 0.05 if the *observed* difference happens to be large — which means you need sampling noise to push the estimate up. The specific runs that come up significant are the ones where noise inflated the apparent effect. The true effect, measured with a much larger sample, would typically be smaller.

This is a Type M error (error in **m**agnitude): you detected that something is going on, but you're overestimating how big it is. Decisions made on winner's curse results — "this feature boosted conversion by 8%, ship it!" — tend not to replicate.

You can verify this in the simulator: configure a small true effect (e.g. 10% vs 11%), set N = 500, and re-roll the seed repeatedly. Most runs will be non-significant. The ones that turn significant will show observed differences much larger than 1pp. That gap between what you set and what you observe in significant-only runs is the winner's curse in action.

**The 60% power threshold** used to separate green from amber in the UI is a practical judgement call, not a hard statistical rule. 80% is the conventional target for experiment design. Results between 60–80% are flagged with a softer warning; below 60% alongside a significant result triggers the winner's curse warning.

### CUPED (planned)

CUPED (Controlled-experiment Using Pre-Experiment Data) is a variance reduction technique that uses a pre-experiment covariate (e.g., a user's conversion rate in the week before the experiment) to reduce noise in the metric. The adjustment is:

```
Y_adj = Y − θ·(X − mean(X))
θ = Cov(Y, X) / Var(X)
```

Because X is measured before treatment assignment it cannot be affected by the treatment, so the adjusted metric has the same expected value but lower variance — often 20–40% reduction. This means you need 20–40% fewer users for the same power. Simulation support for CUPED (including a correlated pre-period covariate) is planned once continuous metrics are added.

## UI

Four tabs:

**Flags** — Create and manage flags. Toggle on/off. Click into a flag to manage variants, define targeting attribute fields, and build allocations.

**Evaluate** — Test any flag evaluation in the browser. Pick a flag to pre-populate a sample payload, edit the `user_id` and `attributes`, then run it. The page shows the full JSON response and an equivalent `curl` command you can copy.

**Assignments** — Live view of the `experiment_assignments` table. Filter by flag, paginate, clear. Click `{…}` in the Attributes column to inspect the full context that was evaluated.

**Simulate** — Design experiments before launch. Configure true conversion rates per variant, run a synthetic dataset through both frequentist and Bayesian tests, and see power analysis accounting for your flag's actual split weights.

## Node.js SDK

The SDK evaluates flags locally — no network call per evaluation. It fetches the full flag config on startup and re-polls every 60 seconds. Assignment logging is explicit: the SDK never logs on its own, you call `logAssignment()` when you're ready to record.

### Setup

```js
import { ExperimentClient } from './sdk/index.js';

const client = new ExperimentClient({
  host:            'http://localhost:3000',
  pollingInterval: 60_000,           // optional, default 60s
  onError:         e => console.error('[experiment]', e.message), // optional
});

await client.init();
```

`init()` blocks until the first config fetch completes. After that, polling runs in the background and does not prevent the Node process from exiting.

### Evaluating a flag

```js
const result = client.evaluate('my-flag', 'user-123', {
  country: 'US',
  plan:    'enterprise',
});
// { variant: 'treatment', value: true, reason: 'allocated', bucket: 42, allocation_id: 1 }
```

Evaluation is fully synchronous. The result object matches the shape returned by `POST /api/evaluate`.

**Reason codes:**

| Reason | Meaning |
|---|---|
| `allocated` | User matched an allocation and landed in a split |
| `flag_disabled` | Flag is toggled off |
| `no_matching_allocation` | No allocation's targeting rules matched |
| `split_exhausted` | Targeting matched but splits don't cover the bucket (misconfiguration) |
| `unknown_flag` | Flag key not found in the cached config |

### Logging assignments

```js
// Fire-and-forget — returns immediately, does not block
client.logAssignment('my-flag', 'user-123', result, { country: 'US', plan: 'enterprise' });
```

This POSTs to `POST /api/assignments` asynchronously. Errors are routed to `onError` if configured, otherwise silently swallowed. The stale config is always retained on fetch failures so in-flight traffic is unaffected.

You control when logging happens — log after every evaluation, or batch them, or skip logging entirely for internal health checks.

### Shutdown

```js
client.close(); // clears the polling interval
```

### How the SDK config endpoint works

`GET /api/sdk/config` returns all enabled flags with their variants and allocations in a single response. The SDK caches this as a `Map<flagKey, flag>` and evaluates entirely from memory.

Bucket computation, targeting rule evaluation, and split assignment are implemented in `lib/evaluate.js`, which is imported by both the API route and the SDK. This structural sharing guarantees that `client.evaluate()` and `POST /api/evaluate` will always produce identical results for the same input — there is no separate implementation to drift.

Disabled flags are excluded from the config snapshot. If a flag is disabled between polls, the SDK will continue serving the last known state for up to one polling interval.

## Testing

```sh
npm test
```

Uses Node.js's built-in test runner (`node:test`), no extra dependencies.

### What's covered

Tests live in `test/evaluate.test.js` and target `lib/evaluate.js` — the shared core that both the API and SDK depend on.

**`getBucket`**
- Output is always in [0, 99]
- Deterministic: same inputs always return the same bucket
- Sensitive to `userId`: 200 distinct users cover > 80% of buckets
- Sensitive to `flagKey`: same user gets independent buckets across flags
- Regression values against known server output (guards against accidental algorithm changes)

**`parseValue`**
- `boolean` type: `"true"` → `true`, `"false"` → `false`, actual boolean passthrough
- `json` type: valid JSON string parsed, invalid JSON returned as-is
- `string` and unknown types: value returned unchanged

**`evaluateFlag`**
- Disabled flag returns `flag_disabled`
- No allocations returns `no_matching_allocation`
- 50/50 split: users with bucket < 50 get control, ≥ 50 get treatment
- Result includes correct `bucket` and `allocation_id`
- `result.bucket` always equals `getBucket(userId, flagKey)`
- `split_exhausted` when splits don't cover the full 0–99 range and bucket falls in the gap
- Targeting rule match/no-match
- `user_id` is automatically injected into the targeting context
- Multi-allocation priority: first matching allocation wins
- Split referencing a missing variant key returns `null` value without crashing

### Architecture note

The test suite is also a contract: because both the API route (`routes/evaluate.js`) and the SDK (`sdk/index.js`) import from `lib/evaluate.js`, passing these tests is sufficient to guarantee consistent behavior across both consumers. If you ever need to change the evaluation algorithm, update `lib/evaluate.js` and the tests — both consumers get the change automatically.

## Extending

**Adding a new API route**: create a file in `routes/`, export a Fastify plugin function, register it in `server.js`.

**Changing the schema**: edit `db.js`. For changes to existing tables, add a migration block under `if (version < N)` and increment `pragma user_version`.

**Frontend changes**: edit `public/app.js`. It's plain React with JSX transpiled by Babel standalone in the browser. No build step — save and refresh. Bump `?v=N` on the script tag in `index.html` to bust the Babel transform cache.

## Roadmap

See [PLAN.md](./PLAN.md) for the full feature roadmap covering:

- Statistical engine (SRM detection, t-test/z-test, sequential testing, CUPED, power analysis)
- Experiment lifecycle management (hypothesis, status machine, allocation locking, required sample size)
- Results UI (forest plots, confidence intervals, time-series, segment breakdowns)
- LLM-powered features via Claude API (results interpreter, power analysis assistant, hypothesis generator, metric recommender)
- Node.js SDK with in-process evaluation and async event batching
- BigQuery integration for warehouse-scale analysis
