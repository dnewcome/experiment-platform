# Experiment Platform

A self-hosted feature flagging and experimentation platform. Designed as a replacement for tools like Eppo or Statsig when you need full control over your targeting logic, data model, and statistical pipeline — without value limits, vendor lock-in, or per-seat pricing.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser UI (React, no build step)                               │
│  Flags · Evaluate · Assignments · Simulate · Warehouse           │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTP (+ Bearer token if API_KEY set)
┌──────────────────────────▼───────────────────────────────────────┐  ┌──────────────────────────────────┐
│  Fastify API                                                     │  │  Node.js SDK  sdk/index.js       │
│  /api/flags          /api/sdk/config                             │  │                                  │
│  /api/evaluate       /api/assignments                            │  │  polls /api/sdk/config (60s)     │
│  /api/srm/:flagKey   /api/metrics/*                              │  │  evaluates locally               │
│  /api/analysis/*                                                 │  │  logs via POST /api/assignments  │
└──────────────────────────┬───────────────────────────────────────┘  │  tracks via POST /api/metrics    │
                           │                  ▲                        └──────────────────────────────────┘
┌──────────────────────────▼────────────────┐ │
│  lib/evaluate.js (shared core)            │─┘
│  getBucket · parseValue · evaluateFlag    │
└──────────────────────────┬────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────┐
│  db/index.js — adapter selector                                  │
│                                                                  │
│  SQLite (default)   Postgres              BigQuery               │
│  flags.db           DATABASE_URL=...      BIGQUERY_KEYFILE=...   │
│  better-sqlite3     pg pool               @google-cloud/bigquery │
│  WAL mode                                                        │
└──────────────────────────────────────────────────────────────────┘
```

**No build step.** The frontend is plain React loaded via UMD scripts + Babel standalone. Edit `public/app.js`, refresh the browser.

## Getting Started

```sh
npm install
npm run dev        # starts on http://localhost:3000
                   # auto-restarts on file changes (node --watch)
```

Delete `flags.db` and restart to reset all data.

**Optional authentication:** set the `API_KEY` environment variable to require a Bearer token on all `/api` requests:

```sh
API_KEY=my-secret npm run dev
```

## Database Adapters

The platform supports three database backends. Set the appropriate environment variables before starting the server; the adapter is selected automatically.

### SQLite (default)

No configuration needed. Uses `flags.db` in the project root (WAL mode, indexed assignment log, prepared statements). Recommended for local development and single-machine deployments.

```sh
npm start
```

Delete `flags.db` to reset all data.

### Postgres

```sh
DATABASE_URL=postgres://user:pass@host:5432/dbname npm start
```

Schema is created on startup via `CREATE TABLE IF NOT EXISTS`. Migrations (new columns) are applied automatically on the next start.

### BigQuery

```sh
BIGQUERY_KEYFILE=/path/to/service-account.json npm start

# Optional overrides:
BIGQUERY_PROJECT=my-gcp-project   # defaults to project_id in keyfile
BIGQUERY_DATASET=experiment_data  # defaults to experiment_platform
BIGQUERY_LOCATION=US              # defaults to US
```

The service account needs **BigQuery Data Editor** and **BigQuery Job User** IAM roles. The dataset and all tables are created on startup if they don't exist.

The BigQuery adapter handles:
- **No AUTOINCREMENT**: row IDs are generated via `crypto.randomInt`
- **Strict typing**: route string params are coerced to INT64 for known ID columns
- **No DEFAULT expressions**: column defaults are injected per-INSERT in the adapter
- **No real transactions**: operations run sequentially without rollback

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
| `in` / `not_in` | text | `country in "US, CA, GB"` |

Groups can be nested to any depth with AND/OR combinators.

### Experiment Lifecycle

Flags have a `status` field that controls the experiment state machine:

```
draft ──► running ──► stopped
  ▲                      │
  └──────────────────────┘  (reset)
```

| Status | Meaning |
|---|---|
| `draft` | Flag is being configured. Variants and allocations can be freely edited. |
| `running` | Experiment is live. `started_at` is recorded. Variants and allocations are **locked** — edits are rejected with 409 to prevent mid-experiment config drift. |
| `stopped` | Experiment has ended. Results are preserved. Can be reset back to draft to reconfigure and re-run. |

Use `PUT /api/flags/:id/status` to transition between states. The UI shows a lifecycle bar with Start / Stop / Restart / Reset buttons and locks all editing controls while the experiment is running.

## API

All endpoints are under `/api`. Request and response bodies are JSON.

If `API_KEY` is set on the server, all `/api` requests must include:
```
Authorization: Bearer <key>
```

### Flags

```
GET    /api/flags                    list all flags
POST   /api/flags                    create a flag
GET    /api/flags/:id                get flag with variants + allocations
PUT    /api/flags/:id                update flag (name, enabled, fields, type)
DELETE /api/flags/:id                delete flag and all its data
PUT    /api/flags/:id/status         transition experiment status
```

**Create flag:**
```json
POST /api/flags
{ "key": "new-checkout", "name": "New Checkout Flow", "type": "boolean" }
```

**Transition status:**
```json
PUT /api/flags/1/status
{ "status": "running" }
```

Valid transitions: `draft → running`, `running → stopped`, `stopped → draft` (reset).

### Variants

```
POST   /api/flags/:id/variants             add a variant
DELETE /api/flags/:flagId/variants/:id     remove a variant
```

Rejected with 409 if the flag is `running`.

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

Rejected with 409 if the flag is `running`.

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
POST   /api/assignments                                  log a pre-computed assignment (SDK)
DELETE /api/assignments                                  clear all records
```

`POST /api/assignments` is the endpoint used by the SDK's `logAssignment()`. It records a pre-computed assignment without re-evaluating the flag — useful when evaluation happened client-side and you're shipping the result back to be logged.

### SRM Detection

```
GET /api/srm/:flagKey?since=<ISO timestamp>
```

Runs a chi-squared goodness-of-fit test to detect Sample Ratio Mismatch (SRM). Returns the observed assignment counts per variant, the expected counts based on split weights, the χ² statistic, degrees of freedom, and a p-value. A p-value below 0.05 means the traffic split is significantly different from what the split weights imply — this usually indicates a bug in the assignment pipeline, not a real effect.

```json
{
  "flag_key": "new-checkout",
  "since": "2024-03-01T00:00:00Z",
  "srm": false,
  "p_value": 0.62,
  "chi2": 0.24,
  "df": 1,
  "variants": [
    { "variant": "control",   "observed": 502, "expected": 500 },
    { "variant": "treatment", "observed": 498, "expected": 500 }
  ]
}
```

The UI shows the SRM widget on the flag detail page whenever the experiment is running or stopped.

### Metrics

Metrics use a **facts table** model: you ingest raw events, and the server joins them with assignment records to compute per-variant results.

#### Ingestion

```
POST   /api/metrics/events              record a single event
POST   /api/metrics/events/bulk         batch ingest (for dbt pipelines)
DELETE /api/metrics/events?flag_key=&metric_name=   clear for re-ingestion
```

**Single event:**
```json
POST /api/metrics/events
{
  "flag_key":    "new-checkout",
  "user_id":     "user-abc123",
  "metric_name": "conversion",
  "value":       1,
  "event_at":    "2024-03-15T10:30:00Z"
}
```

`value` defaults to 1 (binary conversion). Use a numeric value for continuous metrics like revenue. `event_at` defaults to `NOW()` if omitted.

**Bulk ingest (dbt pipeline pattern):**
```json
POST /api/metrics/events/bulk
{
  "flag_key":    "new-checkout",
  "metric_name": "conversion",
  "events": [
    { "user_id": "user-001", "value": 1, "event_at": "2024-03-15T10:00:00Z" },
    { "user_id": "user-002", "value": 0 },
    { "user_id": "user-003", "value": 1 }
  ]
}
```

`flag_key` and `metric_name` at the top level are used as defaults per event; events can override them individually. Designed to be called directly after a dbt run.

#### Discovery

```
GET /api/metrics/names?flag_key=<key>
```

Returns distinct metric names with event counts for a flag.

#### Results

```
GET /api/metrics/results/:flagKey?metric=<name>&since=<ISO timestamp>
```

Runs the core facts-table join:

```sql
metric_events JOIN experiment_assignments ON user_id
WHERE event_at >= assignment.assigned_at   -- post-assignment events only
  AND reason = 'allocated'                 -- excludes flag_disabled, no_match, etc.
  AND assigned_at >= <since>               -- defaults to flag's started_at
GROUP BY variant
```

Per-variant stats include `mean` (total metric value / assigned users, including non-converters as 0) and `variance` (Bessel-corrected sample variance across all assigned users). These feed directly into the delta-method CI calculations.

**Response:**
```json
{
  "flag_key": "new-checkout",
  "metric_name": "conversion",
  "since": "2024-03-01T00:00:00Z",
  "variants": [
    {
      "variant":     "control",
      "assigned":    502,
      "converted":   201,
      "rate":        0.4004,
      "mean":        0.4004,
      "variance":    0.2402,
      "total_value": 201
    }
  ]
}
```

### Warehouse Analysis

The warehouse analysis API lets you run analysis directly against your data warehouse using SQL snippets — decoupling the statistical engine from how and where your experiment data is stored. This runs through the active database adapter, so with BigQuery configured the SQL executes directly against BigQuery.

#### Run analysis

```
POST /api/analysis/run
```

```json
{
  "assignment_sql": "SELECT user_id AS entity_id, variant_key AS variant, assigned_at FROM `myproject.dataset.assignments` WHERE experiment_key = 'my-flag'",
  "metric_sql":     "SELECT user_id AS entity_id, 1 AS value, converted_at AS event_at FROM `myproject.dataset.conversions`",
  "metric_name":    "conversion"
}
```

**SQL contracts:**
- `assignment_sql` must return: `entity_id`, `variant`, `assigned_at`
- `metric_sql` must return: `entity_id`, `value`, `event_at` (`event_at` may be NULL to include all events)

The server composes these into a single CTE that joins on `entity_id`, filters metric events to `event_at >= assigned_at`, aggregates per user, then per variant. Write SQL in the dialect of your configured database.

**Response:** same shape as `/api/metrics/results` — per-variant `assigned`, `converted`, `rate`, `mean`, `variance`, `total_value`.

#### Saved configs

```
GET    /api/analysis/configs           list saved configs
POST   /api/analysis/configs           save a config
PUT    /api/analysis/configs/:id       update a config
DELETE /api/analysis/configs/:id       delete a config
```

**Config shape:**
```json
{
  "name": "Checkout experiment — conversion",
  "assignment_sql": "SELECT ...",
  "metrics": [
    { "name": "conversion", "sql": "SELECT ..." },
    { "name": "revenue",    "sql": "SELECT ..." }
  ]
}
```

## Data Model

```sql
flags (
  id, key, name, description, type,
  enabled, fields, created_at,
  status TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'running' | 'stopped'
  started_at TEXT                         -- ISO timestamp; set when status → 'running'
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

metric_events (
  id, flag_key, user_id, metric_name,
  value REAL,       -- 1 for binary conversions; revenue amount for continuous metrics
  event_at TEXT     -- ISO timestamp; defaults to NOW() on insert
)

warehouse_configs (
  id, name,
  assignment_sql TEXT,  -- SQL returning entity_id, variant, assigned_at
  metrics        TEXT,  -- JSON: [{name, sql}] where sql returns entity_id, value, event_at
  created_at
)
```

`flags.fields` is a JSON array of attribute definitions used to populate the targeting rule builder:
```json
[
  { "name": "country", "label": "Country", "inputType": "text" },
  { "name": "account_age_days", "label": "Account Age (days)", "inputType": "number" }
]
```

## Authentication

Set the `API_KEY` environment variable to require authentication on all `/api` requests:

```sh
API_KEY=my-secret-key npm start
```

When set:
- All `/api` requests must include `Authorization: Bearer <key>` or they receive `401 Unauthorized`.
- Static files (the UI) are always served without authentication.
- The UI prompts for the key on first load (a login screen), then stores it in `localStorage` and includes it automatically on all API calls. A `401` at any point clears the stored key and shows the login screen again.

Leave `API_KEY` unset for unauthenticated local development.

## Statistical Analysis

All analysis modes use the **delta method** to compute confidence intervals on relative lift Δ = (μ_T − μ_C) / μ_C. This works for both binary (conversion rate) and continuous (revenue, latency) metrics without changing the formula.

```
σ²_Δ = (μ_T/μ_C)² × ( σ²_C/(n_C·μ_C²)  +  σ²_T/(n_T·μ_T²) )
```

Where μ and σ² are the per-user mean and Bessel-corrected sample variance across all assigned users (non-converters contribute 0).

### Analysis Methods

Four methods are available in the UI and used across both the Results card (flag detail page), the Simulate tab, and the Warehouse Analysis tab.

#### Fixed-sample (classical frequentist)

Two-sided z-test on the relative lift. Use this when you commit to a sample size before the experiment and look at results exactly once.

```
z = Δ / σ_Δ
p-value = 2 · Φ(−|z|)
95% CI: Δ ± 1.96 · σ_Δ
```

**When to use:** you've pre-registered a stopping rule and won't peek early. The p-value and CI are valid only at the planned sample size — peeking inflates Type I error.

#### Sequential (Howard et al.)

Always-valid confidence sequences using the time-uniform mixture martingale from Howard et al. (2021). The CI is valid at every sample size simultaneously — you can check results at any time without inflating α.

```
B(t) = √( (t+ρ)/t · log((t+ρ) / (ρ·α²)) )
CI:   Δ ± B(t) · σ_Δ
ρ = 10000 / ( log(log(e/α²)) − 2·log(α) )
```

ρ is tuned for experiments targeting ~10,000 total observations. The CI is wider than a fixed-sample CI (the price of always-valid inference) but asymptotically tightens as t grows.

**When to use:** continuous monitoring, no pre-committed stopping rule. Safe to check daily.

#### Sequential hybrid

Same Howard et al. formula, but ρ is tuned to a user-specified **planned sample size** N instead of 10,000. At t = N the CI is as tight as it can be while remaining always-valid at every earlier look. Before N it is wider; after N it continues to tighten.

```
ρ = N / ( log(log(e/α²)) − 2·log(α) )
```

**When to use:** you have a planned experiment duration but want to be able to call it early if an effect is obvious. Enter N = total users you expect by the end date.

#### Bayesian (Gaussian prior)

Gaussian prior N(0, 0.05²) on the relative lift (a weak prior that encodes "effects are usually within ±10%"). Posterior is the precision-weighted update:

```
precision_prior = 1/0.05²  = 400
precision_data  = 1/σ²_Δ

posterior mean  = (precision_data · Δ) / (precision_prior + precision_data)
posterior σ     = 1/√(precision_prior + precision_data)

P(lift > 0) = Φ(posterior_mean / posterior_σ)
```

The 95% credible interval is `posterior_mean ± 1.96 · posterior_σ` and can be read directly: "there is a 95% probability the true relative lift lies in this range."

**When to use:** you want a probability statement rather than a rejection decision, or you want the prior to regularize small samples toward zero.

### Power and Sample Size

**Achieved power** — probability of detecting the observed effect at α = 0.05 given the actual sample sizes. Displayed alongside Fixed-sample results as a health check.

**Required N for 80% power** — solved analytically accounting for the flag's actual split weights w₁ and w₂:

```
N = ( 1.96·√(p̄(1−p̄)·(1/w₁+1/w₂))  +  0.842·√(p₁(1−p₁)/w₁ + p₂(1−p₂)/w₂) )²
    ─────────────────────────────────────────────────────────────────────────────
                              (p₁ − p₂)²
```

Unequal splits increase the required N: a 90/10 split needs substantially more total users than a 50/50 split for the same effect.

### Significance, Power, and the Winner's Curse

| State | Meaning |
|---|---|
| Significant + well-powered (≥ 60%) | Result is reliable. |
| Significant + underpowered (< 60%) | **Winner's curse.** Effect size is probably inflated. |
| Not significant + underpowered | Inconclusive — can't distinguish no effect from too small to detect. |
| Not significant + well-powered | Genuine null — you had enough data and found nothing. |

With low power, you can only cross p < 0.05 when sampling noise pushes the estimate up. The runs that come up significant are the ones where noise inflated the effect. This is why low-power significant results don't replicate.

### Sample Ratio Mismatch (SRM) Detection

An SRM occurs when observed traffic differs significantly from split weights. Chi-squared goodness-of-fit test:

```
χ² = Σ (observed − expected)² / expected
```

Under the null, χ² ~ χ²(k−1). A p-value below 0.05 is flagged as an SRM. Causes are almost always bugs (cookie deletion, bot traffic, redirect issues, inconsistent bucketing) — not real effects. Running an experiment with an SRM invalidates results.

## Simulate Tab

Pick a flag, set simulated user count and a true conversion rate per variant. The simulator:
1. Draws synthetic users, assigns to variants via the flag's real split weights
2. Generates Bernoulli outcomes at the configured rates
3. Runs the selected analysis method (all four are available)
4. Displays lift, CI, p-value/probability, power, and required N

The random seed makes runs reproducible. Changing the seed redraws from the same distribution — useful for understanding sampling variance. Re-roll repeatedly with a small effect to see the winner's curse in action: most seeds are non-significant, and the ones that are significant show much larger apparent effects than the true difference you set.

## Warehouse Analysis Tab

The Warehouse tab lets you run a full Eppo-style analysis directly against your data warehouse without ingesting events into the platform's metric_events table.

### How it works

You provide two SQL snippets:
- **Assignment SQL** — any query returning `entity_id`, `variant`, `assigned_at`
- **Metric SQL** (one per metric) — any query returning `entity_id`, `value`, `event_at`

The server composes them into a single CTE query:

```sql
WITH assignments AS ( <your SQL> ),
     metric_raw  AS ( <your SQL> ),
     per_user    AS (
       SELECT a.variant, a.entity_id, COALESCE(SUM(m.value), 0) AS user_value
       FROM assignments a
       LEFT JOIN metric_raw m
         ON  m.entity_id   = a.entity_id
         AND m.event_at   >= a.assigned_at   -- post-assignment only
       GROUP BY a.variant, a.entity_id
     )
SELECT variant,
       COUNT(*)                                    AS assigned,
       COUNT(CASE WHEN user_value > 0 THEN 1 END) AS converted,
       SUM(user_value)                             AS total_value,
       SUM(user_value * user_value)                AS sum_sq_value
FROM per_user GROUP BY variant
```

This query runs through the active database adapter. With BigQuery configured it executes directly against BigQuery — your SQL snippets can reference fully-qualified tables (`project.dataset.table`) anywhere in your warehouse.

### Workflow

1. Write your **Assignment SQL** — typically a query against your experiment assignment log, filtered to one experiment
2. Add one or more **Metrics** — name + SQL per metric
3. Choose an analysis method
4. Click **Run Analysis**
5. Optionally **Save** the config for reuse

Configs are persisted to `warehouse_configs` across restarts.

### Example (BigQuery)

**Assignment SQL:**
```sql
SELECT
  user_id        AS entity_id,
  variant_key    AS variant,
  assigned_at
FROM `myproject.analytics.experiment_assignments`
WHERE experiment_key = 'new-checkout'
  AND assigned_at >= '2024-03-01'
```

**Conversion metric SQL:**
```sql
SELECT
  user_id      AS entity_id,
  1            AS value,
  converted_at AS event_at
FROM `myproject.analytics.order_events`
WHERE event_type = 'purchase'
```

**Revenue metric SQL:**
```sql
SELECT
  user_id       AS entity_id,
  order_total   AS value,
  created_at    AS event_at
FROM `myproject.analytics.orders`
```

Running this with the Bayesian method on a BigQuery-connected instance executes both queries against BigQuery and returns posterior credible intervals on the relative lift for both conversion rate and revenue per user.

## UI

Six sections accessible from the top nav:

**Flags** — Create and manage flags. Toggle on/off. Click into a flag to:
- Manage variants and define targeting attribute fields
- Build allocations with the visual rule builder
- Control the experiment lifecycle (Start / Stop / Restart / Reset buttons)
- View status badges (draft / running / stopped)
- See the SRM widget (when running or stopped)
- View the Results card with per-variant metric analysis and analysis method selector

**Evaluate** — Test any flag evaluation in the browser. Pick a flag to pre-populate a sample payload, edit the `user_id` and `attributes`, then run it. The page shows the full JSON response and an equivalent `curl` command you can copy.

**Assignments** — Live view of the `experiment_assignments` table. Filter by flag, paginate, clear. Click `{…}` in the Attributes column to inspect the full context that was evaluated.

**Simulate** — Design experiments before launch. Configure true conversion rates per variant, run a synthetic dataset through any of the four analysis methods, and see power analysis accounting for your flag's actual split weights.

**Warehouse** — Run analysis directly against your data warehouse. Write assignment SQL and per-metric SQL snippets, select an analysis method, and get the same statistical output as the Results card. Configs are saved and reloadable.

### Analysis method selector

Available in the Results card, Simulate tab, and Warehouse tab. Switching method changes:

| Method | Stat shown | CI label | Verdict |
|---|---|---|---|
| Fixed-sample | p-value | 95% CI | significant / not significant |
| Sequential | — | Anytime-valid 95% CI | anytime-valid result / no conclusion yet |
| Sequential hybrid | — | Anytime-valid 95% CI (hybrid) | same as sequential |
| Bayesian | P(treatment > control) | 95% credible interval | probability statement |

Sequential hybrid shows an additional **Planned N** input — enter the total users you expect by your experiment's end date.

## Node.js SDK

The SDK evaluates flags locally — no network call per evaluation. It fetches the full flag config on startup and re-polls every 60 seconds. Assignment logging is explicit: the SDK never logs on its own, you call `logAssignment()` when you're ready to record.

### Setup

```js
import { ExperimentClient } from './sdk/index.js';

const client = new ExperimentClient({
  host:            'http://localhost:3000',
  apiKey:          process.env.EXPERIMENT_API_KEY, // optional; required if API_KEY is set server-side
  pollingInterval: 60_000,                          // optional, default 60s
  maxQueueSize:    500,                             // optional; drop events if queue exceeds this
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

Delivery is asynchronous with up to 3 retries at exponential backoff (1s, 2s, 4s). If the retry queue exceeds `maxQueueSize`, events are dropped and `onError` is called. Errors are never thrown from this method.

### Tracking metric events

```js
// Record a conversion event — fire-and-forget with the same retry semantics
client.trackMetricEvent('my-flag', 'user-123', 'conversion');

// Record a revenue event with a custom value
client.trackMetricEvent('my-flag', 'user-123', 'revenue', 49.99);
```

POSTs to `POST /api/metrics/events`. The server joins these events with `experiment_assignments` to compute per-variant metric results.

### Observability

```js
client.flagCount       // number of flags currently cached
client.pendingLogCount // in-flight log + metric events (useful for health checks)
```

### Shutdown

```js
// Stop polling and wait up to 5s for in-flight events to flush
await client.close();

// Custom timeout
await client.close(10_000);
```

Call `close()` during graceful shutdown to avoid dropping queued assignments or metric events.

### How the SDK config endpoint works

`GET /api/sdk/config` returns all enabled flags with their variants and allocations in a single response. The SDK caches this as a `Map<flagKey, flag>` and evaluates entirely from memory.

Bucket computation, targeting rule evaluation, and split assignment are implemented in `lib/evaluate.js`, which is imported by both the API route and the SDK. This structural sharing guarantees that `client.evaluate()` and `POST /api/evaluate` will always produce identical results for the same input.

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
- `split_exhausted` when splits don't cover the full 0–99 range
- Targeting rule match/no-match
- `user_id` is automatically injected into the targeting context
- Multi-allocation priority: first matching allocation wins

## Extending

**Adding a new API route**: create a file in `routes/`, export a Fastify plugin function, register it in `server.js`.

**Changing the schema**: edit all three adapter files (`db/sqlite.js`, `db/postgres.js`, `db/bigquery.js`). For SQLite changes to existing tables, add a migration block under `if (version < N)` and increment `pragma user_version`. For new tables, `CREATE TABLE IF NOT EXISTS` in all three adapters is sufficient.

**Frontend changes**: edit `public/app.js`. It's plain React with JSX transpiled by Babel standalone in the browser. No build step — save and refresh. Bump `?v=N` on the script tag in `index.html` to bust the Babel transform cache.

## Roadmap

### Completed

- **BigQuery adapter** — SQLite, Postgres, and BigQuery all supported via a unified db adapter interface. BigQuery handles strict typing, ID generation, and default injection automatically.
- **API key authentication** — Bearer token auth on all `/api` routes; UI login screen + localStorage key storage.
- **Experiment lifecycle** — `draft → running → stopped` state machine; variants and allocations locked while running.
- **SRM detection** — chi-squared goodness-of-fit test displayed on every running/stopped experiment.
- **Node.js SDK** — local flag evaluation, assignment logging with retry queue, metric event tracking, graceful shutdown.
- **Fixed-sample analysis** — delta-method CIs on relative lift for binary and continuous metrics.
- **Sequential analysis** — Howard et al. time-uniform confidence sequences (always-valid, peek any time).
- **Sequential hybrid** — sequential CIs tuned to a planned stopping sample size for maximum power at the end date while remaining valid at every earlier look.
- **Bayesian analysis** — Gaussian prior N(0, 0.05²) on relative lift; posterior credible intervals and P(treatment > control).
- **Warehouse Analysis tab** — Eppo-style facts-table analysis: write assignment SQL and metric SQL, server composes a CTE and runs it against the active adapter (BigQuery, Postgres, or SQLite). Configs saved to `warehouse_configs`.

### Planned

- **CUPED** — variance reduction using pre-experiment covariates (20–40% fewer users for the same power). `Y_adj = Y − θ·(X − mean(X))` where X is a pre-experiment covariate correlated with Y.
- **Results UI enhancements** — time-series lift over the experiment duration, segment breakdowns, forest plots
- **LLM-powered features** — results interpreter, power analysis assistant, hypothesis generator (Claude API)
