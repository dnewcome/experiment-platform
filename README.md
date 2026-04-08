# Experiment Platform

A self-hosted feature flagging and experimentation platform. Designed as a replacement for tools like Eppo or Statsig when you need full control over your targeting logic, data model, and statistical pipeline — without value limits, vendor lock-in, or per-seat pricing.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser UI (React, no build step)                  │
│  Flags · Evaluate · Assignments                     │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP
┌─────────────────────▼───────────────────────────────┐
│  Fastify API                                        │
│  /api/flags   /api/evaluate   /api/assignments      │
└─────────────────────┬───────────────────────────────┘
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

## UI

Three tabs:

**Flags** — Create and manage flags. Toggle on/off. Click into a flag to manage variants, define targeting attribute fields, and build allocations.

**Evaluate** — Test any flag evaluation in the browser. Pick a flag to pre-populate a sample payload, edit the `user_id` and `attributes`, then run it. The page shows the full JSON response and an equivalent `curl` command you can copy.

**Assignments** — Live view of the `experiment_assignments` table. Filter by flag, paginate, clear. Click `{…}` in the Attributes column to inspect the full context that was evaluated.

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
