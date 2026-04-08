# Experiment Platform — Roadmap

## What We Have

| Area | Status |
|---|---|
| Flag management (boolean/string/json types) | ✓ |
| Variant definitions with typed values | ✓ |
| Weighted split allocations | ✓ |
| JSON Logic targeting rule builder | ✓ |
| Deterministic bucketing (MD5, 0–99) | ✓ |
| Assignment log (`experiment_assignments`) | ✓ |
| Assignments UI with pagination + filter | ✓ |
| Evaluate tab with curl + browser runner | ✓ |

---

## Phase 1 — Data Model Foundation

**Goal**: Schema and APIs that can support real experiments without breaking what exists.

### 1.1 Experiments Table

Experiments are distinct entities from flags. A flag is the delivery mechanism; an experiment is the study.

```sql
experiments (
  id, flag_id, name, hypothesis, status,   -- status: draft|running|paused|concluded
  started_at, ended_at, required_n,        -- required_n computed from power analysis at launch
  concluded_variant, owner, namespace,     -- namespace used for mutual exclusion later
  created_at
)
```

- Status machine: `draft → running → paused → concluded`
- Transitions validated server-side. Running requires ≥2 variants + 1 primary metric.
- **Immutability rule**: When status = running, allocation splits are locked. `PUT /flags/:id/allocations/:id` returns 409.
- Add `namespace` now (default `"default"`) and include it in bucket hash: `md5(${namespace}/${flagKey}/${userId})`. Changing this later re-randomizes all active experiments — do it early.

### 1.2 Metrics Table

Metrics are reusable across experiments, defined independently of flags.

```sql
metrics (
  id, key, name, description,
  type,               -- mean | proportion | ratio
  event_name,         -- which event_name in metric_events to aggregate
  aggregation,        -- sum | count | avg
  value_column,       -- which field in metric_events.properties to use as the value
  denominator_event,  -- for ratio metrics: the event in the denominator
  created_at
)

experiment_metrics (
  experiment_id, metric_id,
  role            -- primary | secondary | guardrail
)
```

### 1.3 Events Tables

Two separate event streams:

```sql
-- Conversion / revenue / engagement events
metric_events (
  id, user_id, metric_key, value,
  properties TEXT,   -- JSON, arbitrary k/v for slicing
  occurred_at
)

-- Separate from experiment_assignments (which is the evaluation log)
-- experiment_enrollments is the per-user first-touch, used as analysis anchor
experiment_enrollments (
  id, experiment_id, flag_key, user_id, variant,
  bucket, enrolled_at,
  UNIQUE(experiment_id, user_id)   -- only first assignment counts
)
```

Write to `experiment_enrollments` on first evaluation per user+experiment. Keep `experiment_assignments` as the full audit log.

**Why separate enrollments**: Analysis queries join `enrollments → metric_events` on user_id, filtered `metric_events.occurred_at >= enrollments.enrolled_at`. This is the correct per-user exposure window. Getting this wrong (using a fixed experiment date instead of per-user enrollment date) introduces pre-experiment bias.

### 1.4 Environments

Add `environment` column to flags (default: `production`). Add `environments` table with SDK keys. Required before any SDK work.

---

## Phase 2 — Statistical Engine

**Goal**: Trustworthy results computed in-process. No new infrastructure.

**Architecture decision**: Run stats in-process in Node.js using `simple-statistics`. This handles up to ~5M rows before query times become an issue. Design the stats layer as a pluggable interface (`computeResults(experimentId, metricId, windowStart, windowEnd) → ResultSet`) so BigQuery or a Python service can be swapped in later without changing the API contract.

### 2.1 Sample Ratio Mismatch (SRM) Detection

First thing checked before any metric results are shown. Chi-squared test on observed per-variant user counts vs. expected counts from split weights. An SRM means the assignment mechanism is broken and all metric results are suspect.

```
GET /api/experiments/:id/srm-check
→ { ok: boolean, chi_sq: number, p_value: number, observed: {}, expected: {} }
```

Always show an SRM warning banner on the results page if `p_value < 0.001`.

### 2.2 Statistical Tests

Implement per metric type:

- **Proportion metrics**: Two-proportion z-test. Returns: rate_control, rate_treatment, absolute_lift, relative_lift_pct, p_value, ci_lower, ci_upper, n_control, n_treatment.
- **Mean metrics**: Welch two-sample t-test (unequal variance). Same output shape.
- **Ratio metrics**: Delta method variance approximation. Handles cases where the denominator varies per user (e.g., revenue per session where session count differs).

Add Benjamini-Hochberg correction across all metrics in an experiment. Return both raw and corrected p-values.

### 2.3 Sequential Testing (mSPRT)

The peeking problem: checking results before reaching required_n inflates Type I error. The fix is mixture Sequential Probability Ratio Test (mSPRT), which produces always-valid p-values safe to check at any time. This is what Eppo uses.

Implement alongside fixed-horizon tests. Flag in results: `sequential: true | false`. When sequential mode is off, show a "results checked before required N" warning if `n_observed < required_n`.

### 2.4 Power Analysis

```
POST /api/power-analysis
{ baseline_rate, mde_relative, alpha=0.05, power=0.8, variants=2 }
→ { required_n_per_variant, required_n_total, detectable_absolute_mde }
```

Two-sample z-test formula for proportions. Pure math, no dependencies. ~20 lines.

### 2.5 CUPED Variance Reduction (Phase 2B)

CUPED reduces variance by regressing out pre-experiment covariates (e.g., a user's pre-experiment conversion rate). Reduces required sample size by 20–50% in practice.

Requires: a `pre_experiment_metrics` table or a configurable lookback window into `metric_events` before `enrolled_at`. Run OLS regression per metric: `Y_cuped = Y - theta * (X - mean(X))` where X is the pre-experiment covariate.

Defer until Phase 2 is stable. CUPED adds complexity; get the basic tests right first.

### 2.6 Results Caching

Computing results on every page load is expensive. Write results to:

```sql
experiment_results (
  id, experiment_id, metric_id, variant_key,
  mean, std_error, n, p_value, p_value_corrected,
  ci_lower, ci_upper, relative_lift_pct,
  computed_at
)
```

Compute nightly (or on-demand via "Refresh" button). Results endpoint reads from cache + shows `computed_at`. Stale banner if >24h old.

---

## Phase 3 — Results UI

**Goal**: A product manager can read and act on results without a data scientist.

### 3.1 Experiment Detail Page

- Status badge + lifecycle controls (Start / Pause / Conclude)
- Progress bar: `n_enrolled / required_n`
- SRM warning banner (always first, above metric results)
- Per-metric result cards

### 3.2 Result Cards

Each metric card shows:
- Metric name + role (primary / guardrail)
- Control mean vs. treatment mean
- Relative lift % with confidence interval
- Forest plot bar: horizontal CI bar, vertical line at 0, colored green/red/grey
- p-value (raw + corrected) + significance indicator
- n per variant

### 3.3 Time-Series Results

Daily cumulative metric values over experiment duration. Needed to diagnose novelty effects (metric improves in week 1, reverts in week 2) and verify convergence. Expensive to compute — cache per day in `experiment_results_timeseries`.

### 3.4 Segment Breakdowns

Run the full analysis per segment (e.g., country, plan). Useful for finding heterogeneous treatment effects. Add as an optional tab on the results page. Requires no new schema — just filter the analysis query.

---

## Phase 4 — LLM Layer (Claude API)

**Where Claude adds genuine value beyond Eppo:**

### 4.1 Results Interpreter

After an experiment concludes, Claude writes a plain-English interpretation. Replaces the data scientist in the "what do these results mean?" conversation.

```
POST /api/experiments/:id/interpret-results
→ {
    summary: string,
    recommendation: "ship" | "hold" | "iterate" | "investigate",
    confidence: "high" | "medium" | "low",
    findings: [{ metric, direction, significant, narrative }],
    caveats: [string],
    next_steps: [string]
  }
```

**Prompt strategy**: Pass the full results JSON (metric stats, CIs, p-values, SRM status, sample sizes, hypothesis). Instruct Claude to be calibrated — if underpowered, say so. If guardrail regressed, highlight it prominently regardless of primary metric significance. Use `claude-opus-4-6` — this output influences product decisions.

Cache per experiment per `computed_at` timestamp. Don't re-run on every page load.

### 4.2 Power Analysis Assistant

Conversational interface for sample size calculation. User describes the experiment in natural language; Claude extracts parameters and calls the `/api/power-analysis` endpoint.

```
POST /api/experiments/power-chat
{ messages: [{ role, content }] }
→ { reply: string, computed?: { required_n, ... } }
```

**Implementation**: Use tool use. Define a `calculate_sample_size` tool. User says "I want to detect a 5% improvement in checkout conversion which is currently 3.2%". Claude extracts baseline=0.032, mde_relative=0.05, calls the tool, formats the result, and explains what it means in terms of time-to-complete given their daily traffic.

Show in a chat panel inside the experiment creation modal, before the user clicks "Start Experiment".

### 4.3 Hypothesis Generator

Given a flag description + primary metric + variant values, Claude drafts 2–3 hypotheses with:
- The expected mechanism (why this change affects the metric)
- Expected direction and magnitude
- Potential failure modes

```
POST /api/experiments/:id/suggest-hypothesis
→ { hypotheses: [{ title, mechanism, expected_direction, risks }] }
```

User selects or edits. Store the selected hypothesis on the experiment. Post-experiment: compare stated hypothesis against actual results and flag divergences.

Use `claude-haiku-4-5` — low stakes, high volume.

### 4.4 Metric Recommender

After entering a hypothesis, Claude recommends which metrics to track (primary / secondary / guardrail) from the existing metric catalog.

```
POST /api/experiments/:id/suggest-metrics
{ hypothesis: string, available_metrics: [...] }
→ { recommendations: [{ metric_id, role, rationale, expected_direction }] }
```

This works because Claude understands causal chains: a checkout flow change should affect conversion rate (primary), revenue per user (secondary), and watch session duration as a guardrail.

### 4.5 Anomaly Explainer

When SRM is detected, offer "Explain This" — Claude returns ranked hypotheses for what caused it, with investigation steps for each.

```
POST /api/experiments/:id/explain-anomaly
{ anomaly_type: "srm" | "metric_spike" | "novelty_effect", context: {...} }
→ { hypotheses: [{ description, probability, investigation_steps }] }
```

---

## Phase 5 — SDK + Integrations

### 5.1 Config Export Endpoint

```
GET /sdk/config?env=production
Authorization: Bearer <sdk_key>
→ { flags: [{ key, type, variants, allocations, targeting_rules }], etag: string }
```

ETag-based caching. SDK polls every 30s, only fetches if ETag changed.

### 5.2 Node.js Server SDK

npm package. API:

```js
const client = await EppoClient.init(sdkKey);
const assignment = client.getAssignment('flag-key', userId, attributes);
// → { variant: 'treatment', value: true }

client.track(userId, 'checkout.completed', 1, { revenue: 49.99 });
```

- Evaluates entirely in-process (no network call on the hot path)
- Batches assignments + metric events, flushes every 5s to `POST /sdk/events/batch`
- Reconnects automatically on network failure

### 5.3 BigQuery Integration

Two modes:

**Push mode** (simpler): Sync `experiment_assignments`, `experiment_enrollments`, and `metric_events` to BigQuery on a schedule. Analysis continues to run in-process against SQLite, but BQ has a full copy for ad-hoc queries and downstream dashboards.

**Pull mode** (for scale): Define metric sources as BQ SQL queries. The analysis layer executes the query against BQ and imports the aggregated results back. Required when assignments exceed ~10M rows.

Start with push mode. Add pull mode as a metric source type option.

### 5.4 Notifications

Webhook-based (Slack, generic HTTP). Trigger on:
- Experiment reached `required_n` (time to check results)
- Experiment concluded (with ship/hold recommendation)
- SRM detected (action required)

### 5.5 Audit Log

```sql
audit_log (id, entity_type, entity_id, action, actor, diff TEXT, created_at)
```

Write on every mutation. `GET /audit-log?entity_type=experiment&entity_id=1` for history view.

---

## Key Architectural Decisions

### Bucketing Hash

**Current**: `md5(${flagKey}/${userId})`

**Change now**: `md5(${namespace}/${flagKey}/${userId})`

Default namespace = `"default"`. When mutual exclusion layers are added, experiments within a namespace share the bucket space and are mutually exclusive. Changing the hash input re-randomizes all active experiments — do this before any experiments have data.

### Assignment Deduplication

Keep `experiment_assignments` as the full append-only audit log (every evaluation). Add `experiment_enrollments` with a UNIQUE constraint for first-touch only. Use enrollments as the anchor for analysis. Do not count rows in the assignment log — count distinct users in enrollments.

### Frequentist vs. Bayesian

Ship frequentist + mSPRT sequential testing first. mSPRT gives always-valid p-values safe to check at any time, which is the core Eppo approach. Add Bayesian (posterior probability, credible intervals) as an alternative view in Phase 3 — it's more intuitive for non-statisticians but shouldn't be the default.

### SQLite Longevity

SQLite in WAL mode handles ~1000 evaluations/second and ~50M rows before needing attention. Design `db.js` to use standard SQL (no SQLite-specific syntax) so migration to Postgres is a driver swap. Switch when: multi-server deployment is needed, or assignment volume exceeds 1000/second sustained.

### Per-User Metric Window

Analysis must filter `metric_events.occurred_at >= enrollments.enrolled_at` (per-user enrollment date), not a fixed experiment start date. Getting this wrong introduces pre-experiment bias and invalidates results. Enforce this in every analysis query from day one.

---

## What to Build Next

Recommended sequence given current state:

1. **`experiments` table + status machine** — the foundation everything else sits on
2. **`metrics` + `metric_events` tables + ingestion endpoint** — needed before any analysis
3. **`experiment_enrollments` table** — replace per-row assignment log as analysis source
4. **SRM detection** — simplest stats, highest diagnostic value
5. **Basic t-test / z-test results endpoint** — first real results
6. **Power analysis endpoint** — needed before experiments can be sized
7. **Results UI** — forest plot, stat cards, SRM banner
8. **Claude: Results Interpreter** — highest LLM value, builds on results UI
9. **Claude: Power Analysis Assistant** — second highest LLM value
10. **Node.js SDK** — needed for production use
