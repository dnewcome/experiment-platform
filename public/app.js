const { useState, useEffect, useMemo } = React;

// ---------------------------------------------------------------------------
// API key auth helpers
// ---------------------------------------------------------------------------

const AUTH_KEY = 'experiment_api_key';
const getApiKey  = () => localStorage.getItem(AUTH_KEY) ?? '';
const setApiKey  = (k) => k ? localStorage.setItem(AUTH_KEY, k) : localStorage.removeItem(AUTH_KEY);

// Global 401 handler — components subscribe via this callback
let _on401 = null;
const on401 = (cb) => { _on401 = cb; };

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch(path, init = {}) {
  const key = getApiKey();
  const headers = { ...init.headers };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 401) { _on401?.(); return { error: 'Unauthorized' }; }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    return { error: `Server returned HTTP ${res.status} (non-JSON). Is the server running the latest code?` };
  }
  return res.json();
}

const api = {
  get:  (path)       => apiFetch(path),
  post: (path, body) => apiFetch(path, { method: 'POST',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  put:  (path, body) => apiFetch(path, { method: 'PUT',    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  del:  (path)       => apiFetch(path, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// ApiKeyGate — wraps the whole app; shows a login form when a key is required
// ---------------------------------------------------------------------------

function ApiKeyGate({ children }) {
  const [locked, setLocked] = useState(false);
  const [input,  setInput]  = useState('');
  const [error,  setError]  = useState('');

  useEffect(() => {
    on401(() => setLocked(true));
    // Probe on mount so we detect a key requirement immediately
    apiFetch('/flags').then(r => { if (r.error === 'Unauthorized') setLocked(true); });
  }, []);

  async function submit() {
    setError('');
    setApiKey(input.trim());
    const probe = await apiFetch('/flags');
    if (probe.error === 'Unauthorized') { setError('Invalid key'); setApiKey(''); }
    else setLocked(false);
  }

  if (!locked) return children;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f5f5f5' }}>
      <div className="card" style={{ width: 360, margin: 0 }}>
        <h2 style={{ marginBottom: 4 }}>API Key Required</h2>
        <p className="muted" style={{ marginBottom: 16, fontSize: 13 }}>
          This server requires an API key. Enter the value of the <code>API_KEY</code> environment variable.
        </p>
        <input className="input" style={{ width: '100%', marginBottom: 8 }} type="password"
          placeholder="Bearer token" value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} autoFocus />
        {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={submit}>Unlock</button>
      </div>
    </div>
  );
}

// Ensure an allocation received from the API always has splits as an array
// and targeting_rules as an object/null — guards against the server sending
// raw JSON strings if parseAllocation wasn't called on the response.
function normalizeAlloc(alloc) {
  return {
    ...alloc,
    splits:          Array.isArray(alloc.splits) ? alloc.splits : JSON.parse(alloc.splits ?? '[]'),
    targeting_rules: alloc.targeting_rules && typeof alloc.targeting_rules === 'string'
      ? JSON.parse(alloc.targeting_rules)
      : (alloc.targeting_rules ?? null),
  };
}

// ---------------------------------------------------------------------------
// Rule Builder — outputs JSON Logic
// ---------------------------------------------------------------------------

const OPERATORS_TEXT   = ['==', '!=', 'contains', 'not_contains', 'starts_with', 'one_of', 'not_one_of'];
const OPERATORS_NUMBER = ['==', '!=', '>', '>=', '<', '<=', 'one_of', 'not_one_of'];

// Operators that take a list of values (one per line) instead of a single value
const LIST_OPERATORS = new Set(['one_of', 'not_one_of']);

function getOperators(field) {
  return field?.inputType === 'number' ? OPERATORS_NUMBER : OPERATORS_TEXT;
}

function uid() { return Math.random().toString(36).slice(2); }

function defaultRule(fields) {
  const f = fields[0] ?? { name: 'user_id', inputType: 'text' };
  return { id: uid(), field: f.name, operator: '==', value: '' };
}

function defaultGroup(fields) {
  return { id: uid(), combinator: 'and', rules: [defaultRule(fields)] };
}

function ruleToJsonLogic(rule, fields) {
  if (rule.rules) return groupToJsonLogic(rule, fields);
  const v = { var: rule.field };
  const fieldDef = fields.find(f => f.name === rule.field);
  const isNumber = fieldDef?.inputType === 'number';
  const val = isNumber ? Number(rule.value) : rule.value;
  switch (rule.operator) {
    case '==':           return { '==':  [v, val] };
    case '!=':           return { '!=':  [v, val] };
    case '>':            return { '>':   [v, val] };
    case '>=':           return { '>=':  [v, val] };
    case '<':            return { '<':   [v, val] };
    case '<=':           return { '<=':  [v, val] };
    case 'contains':     return { 'in':  [val, v] };
    case 'not_contains': return { '!':   [{ 'in': [val, v] }] };
    case 'starts_with':  return { '===': [{ substr: [v, 0, String(val).length] }, val] };
    case 'one_of':       return { 'in':  [v, parseList(rule.value)] };
    case 'not_one_of':   return { '!':   [{ 'in': [v, parseList(rule.value)] }] };
    default:             return { '==':  [v, val] };
  }
}

// Parse a newline-separated list of values, trimming whitespace and dropping blanks
function parseList(raw) {
  return String(raw).split('\n').map(s => s.trim()).filter(Boolean);
}

function groupToJsonLogic(group, fields) {
  const conditions = group.rules.map(r => ruleToJsonLogic(r, fields));
  return { [group.combinator]: conditions };
}

function extractQuery(targeting_rules) {
  return targeting_rules?._builderQuery ?? null;
}

function RuleCondition({ rule, fields, onChange, onRemove }) {
  const fieldDef  = fields.find(f => f.name === rule.field) ?? fields[0];
  const operators = getOperators(fieldDef);
  const isList    = LIST_OPERATORS.has(rule.operator);

  function update(patch) {
    const updated = { ...rule, ...patch };
    if (patch.field) {
      const ops = getOperators(fields.find(f => f.name === patch.field));
      if (!ops.includes(updated.operator)) updated.operator = ops[0];
    }
    // Reset value when switching between list and non-list operators
    if (patch.operator && LIST_OPERATORS.has(patch.operator) !== LIST_OPERATORS.has(rule.operator)) {
      updated.value = '';
    }
    onChange(updated);
  }

  const isList2 = LIST_OPERATORS.has(rule.operator);
  const count   = isList2 ? parseList(rule.value).length : null;

  return (
    <div className="rule-row" style={{ alignItems: isList2 ? 'flex-start' : 'center' }}>
      <select value={rule.field} onChange={e => update({ field: e.target.value })}>
        {fields.map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
      </select>
      <select value={rule.operator} onChange={e => update({ operator: e.target.value })}>
        {operators.map(op => <option key={op} value={op}>{op.replace('_', ' ')}</option>)}
      </select>
      {isList2
        ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <textarea
              value={rule.value}
              onChange={e => update({ value: e.target.value })}
              placeholder={"one value per line\nUS\nCA\nGB"}
              style={{ width: 180, height: 80, fontSize: 12, padding: '4px 7px', border: '1px solid #ccc', borderRadius: 4, resize: 'vertical', fontFamily: 'monospace' }}
            />
            <span style={{ fontSize: 11, color: '#888' }}>{count} value{count !== 1 ? 's' : ''}</span>
          </div>
        )
        : (
          <input
            value={rule.value}
            onChange={e => update({ value: e.target.value })}
            placeholder="value"
            style={{ width: 140 }}
          />
        )
      }
      <button className="btn btn-xs btn-danger" onClick={onRemove} style={{ alignSelf: isList2 ? 'flex-start' : 'center' }}>×</button>
    </div>
  );
}

function RuleGroup({ group, fields, onChange, onRemove, depth = 0 }) {
  function toggleCombinator() {
    onChange({ ...group, combinator: group.combinator === 'and' ? 'or' : 'and' });
  }
  function updateRule(i, updated) {
    onChange({ ...group, rules: group.rules.map((r, j) => j === i ? updated : r) });
  }
  function removeRule(i) {
    onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) });
  }
  function addCondition() {
    onChange({ ...group, rules: [...group.rules, defaultRule(fields)] });
  }
  function addGroup() {
    onChange({ ...group, rules: [...group.rules, defaultGroup(fields)] });
  }

  return (
    <div className="rule-group" style={depth > 0 ? { marginTop: 8 } : {}}>
      <div className="rule-group-header">
        <span
          className={`combinator-badge combinator-${group.combinator}`}
          onClick={toggleCombinator}
          title="Click to toggle AND / OR"
        >
          {group.combinator.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: '#888' }}>click to toggle</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn btn-xs" onClick={addCondition}>+ Condition</button>
          {depth < 2 && <button className="btn btn-xs" onClick={addGroup}>+ Group</button>}
          {onRemove && <button className="btn btn-xs btn-danger" onClick={onRemove}>Remove Group</button>}
        </div>
      </div>
      {group.rules.map((rule, i) => (
        rule.rules
          ? <RuleGroup key={rule.id} group={rule} fields={fields} depth={depth + 1}
              onChange={u => updateRule(i, u)} onRemove={() => removeRule(i)} />
          : <RuleCondition key={rule.id} rule={rule} fields={fields}
              onChange={u => updateRule(i, u)} onRemove={() => removeRule(i)} />
      ))}
      {group.rules.length === 0 && (
        <div className="muted" style={{ fontSize: 12, padding: '4px 0' }}>No conditions yet.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SplitEditor — variant weights that must sum to 100
// ---------------------------------------------------------------------------

function SplitEditor({ variants, splits, onChange }) {
  const total = splits.reduce((s, x) => s + x.weight, 0);
  const ok    = total === 100;

  function setWeight(variantKey, raw) {
    const weight = Math.max(0, Math.min(100, Number(raw) || 0));
    const next   = splits.map(s => s.variant_key === variantKey ? { ...s, weight } : s);
    onChange(next);
  }

  // Ensure splits has an entry for every variant
  const normalised = variants.map(v => {
    const existing = splits.find(s => s.variant_key === v.key);
    return existing ?? { variant_key: v.key, weight: 0 };
  });

  if (normalised.length !== splits.length) {
    // sync on next render
    setTimeout(() => onChange(normalised), 0);
  }

  return (
    <div>
      {normalised.map(s => {
        const barPct = Math.round((s.weight / 100) * 100);
        return (
          <div key={s.variant_key} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span className="flag-key" style={{ minWidth: 100 }}>{s.variant_key}</span>
              <input
                type="number" min="0" max="100"
                value={s.weight}
                onChange={e => setWeight(s.variant_key, e.target.value)}
                style={{ width: 64, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
              />
              <span className="muted">%</span>
            </div>
            <div style={{ height: 6, background: '#e5e5e5', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${barPct}%`, background: '#1a1a2e', borderRadius: 3, transition: 'width 0.2s' }} />
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 8, fontWeight: 600, fontSize: 13, color: ok ? '#27ae60' : '#c0392b' }}>
        Total: {total} / 100 {ok ? '✓' : `— need ${100 - total > 0 ? '+' : ''}${100 - total} more`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Toggle
// ---------------------------------------------------------------------------

function Toggle({ checked, onChange }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="toggle-slider"></span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Flag type badge
// ---------------------------------------------------------------------------

function TypeBadge({ type }) {
  const colors = { boolean: '#dbeafe:#1e40af', string: '#dcfce7:#166534', json: '#fef9c3:#713f12' };
  const [bg, fg] = (colors[type] ?? '#f3f4f6:#374151').split(':');
  return (
    <span style={{ background: bg, color: fg, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Variant value input — respects flag type
// ---------------------------------------------------------------------------

function VariantValueInput({ type, value, onChange }) {
  if (type === 'boolean') {
    return (
      <select className="input" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">— choose —</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (type === 'json') {
    return (
      <textarea
        className="input"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={'{"key": "value"}'}
        style={{ width: 240, height: 60, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
      />
    );
  }
  return (
    <input className="input" value={value} onChange={e => onChange(e.target.value)} placeholder="string value" />
  );
}

// ---------------------------------------------------------------------------
// Flag List
// ---------------------------------------------------------------------------

function FlagList({ onSelectFlag }) {
  const [flags, setFlags]       = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm]         = useState({ key: '', name: '', description: '', type: 'boolean' });
  const [error, setError]       = useState('');

  useEffect(() => { api.get('/flags').then(setFlags); }, []);

  async function createFlag() {
    setError('');
    const res = await api.post('/flags', form);
    if (res.error) { setError(res.error); return; }
    setFlags(f => [res, ...f]);
    setForm({ key: '', name: '', description: '', type: 'boolean' });
    setShowForm(false);
  }

  async function toggleFlag(flag) {
    const res = await api.put(`/flags/${flag.id}`, { enabled: !flag.enabled });
    setFlags(f => f.map(x => x.id === flag.id ? res : x));
  }

  async function deleteFlag(flag) {
    if (!confirm(`Delete flag "${flag.key}"?`)) return;
    await api.del(`/flags/${flag.id}`);
    setFlags(f => f.filter(x => x.id !== flag.id));
  }

  return (
    <div>
      <div className="section-header">
        <h2 style={{ margin: 0 }}>Feature Flags</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(s => !s)}>
          {showForm ? 'Cancel' : '+ New Flag'}
        </button>
      </div>

      {showForm && (
        <div className="card">
          <div className="section-label" style={{ marginBottom: 12 }}>Create Flag</div>
          <div className="form-row">
            <input className="input" placeholder="flag-key" value={form.key}
              onInput={e => setForm(f => ({ ...f, key: e.target.value }))} />
            <input className="input" placeholder="Display name" value={form.name}
              onInput={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <select className="input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              <option value="boolean">boolean</option>
              <option value="string">string</option>
              <option value="json">json</option>
            </select>
          </div>
          <div className="form-row">
            <input className="input" style={{ width: '100%' }} placeholder="Description (optional)" value={form.description}
              onInput={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          {error && <div className="error">{error}</div>}
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={createFlag}>Create</button>
          </div>
        </div>
      )}

      <div className="card">
        {flags.length === 0
          ? <div className="empty-state">No flags yet. Create one to get started.</div>
          : flags.map(flag => (
            <div key={flag.id} className="flag-row">
              <Toggle checked={flag.enabled} onChange={() => toggleFlag(flag)} />
              <TypeBadge type={flag.type} />
              <span className="flag-key">{flag.key}</span>
              <span className="flag-name">{flag.name}</span>
              <span className={`badge badge-${flag.enabled ? 'on' : 'off'}`}>{flag.enabled ? 'ON' : 'OFF'}</span>
              <span className={`badge badge-${flag.status ?? 'draft'}`}>{flag.status ?? 'draft'}</span>
              <button className="btn btn-sm" onClick={() => onSelectFlag(flag.id)}>Edit →</button>
              <button className="btn btn-sm btn-danger" onClick={() => deleteFlag(flag)}>Delete</button>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allocation Modal
// ---------------------------------------------------------------------------

function AllocationModal({ flag, editAlloc, onSave, onClose }) {
  const rawSplits  = editAlloc ? normalizeAlloc(editAlloc).splits : null;
  const initSplits = rawSplits ?? flag.variants.map(v => ({ variant_key: v.key, weight: 0 }));
  const [splits,   setSplits]   = useState(initSplits);
  const [priority, setPriority] = useState(editAlloc?.priority ?? 0);
  const [catchAll, setCatchAll] = useState(!editAlloc?.targeting_rules);
  const [query,    setQuery]    = useState(extractQuery(editAlloc?.targeting_rules) ?? defaultGroup(flag.fields));

  const fields = flag.fields.length > 0 ? flag.fields : [{ name: 'user_id', label: 'User ID', inputType: 'text' }];
  const total  = splits.reduce((s, x) => s + x.weight, 0);

  async function save() {
    if (total !== 100) { alert(`Weights must sum to 100 (currently ${total})`); return; }
    let targeting_rules = null;
    if (!catchAll && query.rules.length > 0) {
      const jsonLogic = groupToJsonLogic(query, fields);
      targeting_rules = { ...jsonLogic, _builderQuery: query };
    }
    const res = await onSave({ splits, targeting_rules, priority: Number(priority) });
    if (res?.error) { alert(res.error); return; }
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{editAlloc ? 'Edit Allocation' : 'New Allocation'}</h2>

        <div className="section">
          <div className="section-label" style={{ marginBottom: 10 }}>Traffic Split</div>
          <div className="muted" style={{ marginBottom: 12 }}>
            Weights must add up to 100. Users matched by targeting rules are split across variants by these weights.
          </div>
          {flag.variants.length === 0
            ? <div className="error">Add variants to the flag before creating an allocation.</div>
            : <SplitEditor variants={flag.variants} splits={splits} onChange={setSplits} />
          }
        </div>

        <div className="section">
          <div className="section-label" style={{ marginBottom: 8 }}>Targeting Rules</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={catchAll} onChange={e => setCatchAll(e.target.checked)} />
            Catch-all — match every user
          </label>
          {!catchAll && (
            <RuleGroup group={query} fields={fields} onChange={setQuery} />
          )}
        </div>

        <div className="section">
          <div className="section-label" style={{ marginBottom: 8 }}>Priority</div>
          <input type="number" className="input" value={priority} min="0"
            onInput={e => setPriority(e.target.value)} style={{ width: 90 }} />
          <div className="muted" style={{ marginTop: 4 }}>Lower = evaluated first.</div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={total !== 100}>
            Save Allocation
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flag Detail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Results — live metric analysis from real assignment + metric event data
// ---------------------------------------------------------------------------

function ResultsCard({ flag }) {
  const [metricNames,  setMetricNames]  = useState([]);
  const [metric,       setMetric]       = useState('');
  const [method,       setMethod]       = useState('fixed_sample');
  const [nTarget,      setNTarget]      = useState(10000);
  const [results,      setResults]      = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [importText,   setImportText]   = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [showImport,   setShowImport]   = useState(false);

  useEffect(() => {
    api.get(`/metrics/names?flag_key=${flag.key}`).then(r => {
      if (Array.isArray(r)) {
        setMetricNames(r);
        if (r.length > 0 && !metric) setMetric(r[0].metric_name);
      }
    });
  }, [flag.key]);

  async function loadResults() {
    if (!metric) return;
    setLoading(true);
    const r = await api.get(`/metrics/results/${flag.key}?metric=${encodeURIComponent(metric)}`);
    setLoading(false);
    if (r.error) { alert(r.error); return; }
    setResults(r);
  }

  async function importCsv() {
    setImportStatus('');
    const lines = importText.trim().split('\n').filter(Boolean);
    if (!lines.length) return;
    // Expected format: user_id,value  (header optional)
    const events = [];
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 1) continue;
      const uid = parts[0].trim();
      if (uid === 'user_id' || uid === 'user') continue; // skip header
      const val = parts[1] ? parseFloat(parts[1].trim()) : 1;
      if (uid) events.push({ user_id: uid, value: isNaN(val) ? 1 : val });
    }
    if (!events.length) { setImportStatus('No valid rows found.'); return; }
    const res = await api.post('/metrics/events/bulk', { flag_key: flag.key, metric_name: metric || 'conversion', events });
    if (res.error) { setImportStatus(`Error: ${res.error}`); return; }
    setImportStatus(`Imported ${res.inserted} events.`);
    setImportText('');
    setShowImport(false);
    api.get(`/metrics/names?flag_key=${flag.key}`).then(r => { if (Array.isArray(r)) setMetricNames(r); });
  }

  function analyze() {
    if (!results || results.variants.length < 2) return null;
    const ctrl = results.variants[0];
    return results.variants.slice(1).map(trt => {
      if (!ctrl.assigned || !trt.assigned) return null;
      // Use mean/variance from API if present; fall back to rate + Bernoulli variance
      const cMean = ctrl.mean ?? ctrl.rate;
      const tMean = trt.mean  ?? trt.rate;
      const cVar  = ctrl.variance ?? cMean * (1 - cMean);
      const tVar  = trt.variance  ?? tMean * (1 - tMean);
      const analysis = runAnalysis(
        { assigned: ctrl.assigned, mean: cMean, variance: cVar },
        { assigned: trt.assigned,  mean: tMean, variance: tVar },
        method, 0.05, nTarget,
      );
      const sp1 = flag.allocations[0]?.splits?.find(s => s.variant_key === ctrl.variant);
      const sp2 = flag.allocations[0]?.splits?.find(s => s.variant_key === trt.variant);
      const w1  = (sp1?.weight ?? 50) / 100, w2 = (sp2?.weight ?? 50) / 100;
      const pow = computePower(ctrl.assigned, trt.assigned, cMean, tMean);
      const req = requiredNTotal(cMean, tMean, w1, w2);
      return { trt, analysis, pow, req, w1, w2 };
    }).filter(Boolean);
  }

  const analyses = analyze();
  const pct  = n  => (n * 100).toFixed(2) + '%';
  const pp   = n  => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + 'pp';
  const fmt  = (n, d=3) => n.toFixed(d);

  return (
    <div className="card">
      <div className="section-header" style={{ marginBottom: 12 }}>
        <div className="section-label">Experiment Results</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setShowImport(s => !s)}>
            {showImport ? 'Cancel' : '↑ Import CSV'}
          </button>
        </div>
      </div>

      {showImport && (
        <div style={{ marginBottom: 16, padding: '12px', background: '#f8f9fc', border: '1px solid #e5e5e5', borderRadius: 6 }}>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
            Paste CSV: <code>user_id,value</code> (value defaults to 1 for binary conversion).
            Metric name: <input className="input" style={{ width: 160, marginLeft: 6 }} placeholder="e.g. conversion"
              value={metric} onChange={e => setMetric(e.target.value)} />
          </div>
          <textarea className="input" style={{ width: '100%', height: 100, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
            placeholder={"user-123,1\nuser-456,1\nuser-789,0"} value={importText}
            onChange={e => setImportText(e.target.value)} />
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-sm btn-primary" onClick={importCsv}>Import</button>
            {importStatus && <span className="muted" style={{ fontSize: 12 }}>{importStatus}</span>}
          </div>
        </div>
      )}

      <div className="form-row" style={{ marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Metric</div>
          {metricNames.length > 0
            ? <select className="input" value={metric} onChange={e => setMetric(e.target.value)}>
                {metricNames.map(m => <option key={m.metric_name} value={m.metric_name}>{m.metric_name} ({m.event_count} events)</option>)}
              </select>
            : <input className="input" placeholder="metric name" value={metric} onChange={e => setMetric(e.target.value)} style={{ width: 200 }} />
          }
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Analysis method</div>
          <select className="input" value={method} onChange={e => setMethod(e.target.value)}>
            <option value="fixed_sample">Fixed-sample</option>
            <option value="sequential">Sequential</option>
            <option value="sequential_hybrid">Sequential hybrid</option>
            <option value="bayesian">Bayesian</option>
          </select>
        </div>
        {method === 'sequential_hybrid' && (
          <div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Planned N (total)</div>
            <input className="input" type="number" min="100" step="100" value={nTarget}
              onChange={e => setNTarget(Number(e.target.value))} style={{ width: 120 }} />
          </div>
        )}
        <div style={{ alignSelf: 'flex-end' }}>
          <button className="btn btn-primary" onClick={loadResults} disabled={!metric || loading}>
            {loading ? 'Loading…' : 'Analyze'}
          </button>
        </div>
      </div>

      {metricNames.length === 0 && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          No metric events yet. Import a CSV above, call <code>POST /api/metrics/events/bulk</code> from your dbt pipeline,
          or use <code>client.trackMetricEvent()</code> from the SDK.
        </div>
      )}

      {results && (
        <>
          <table style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>Variant</th>
                <th style={{ textAlign: 'right' }}>Assigned</th>
                <th style={{ textAlign: 'right' }}>Converted</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>vs control</th>
              </tr>
            </thead>
            <tbody>
              {results.variants.map((v, i) => {
                const ctrl = results.variants[0];
                const diff = i === 0 ? null : v.rate - ctrl.rate;
                return (
                  <tr key={v.variant}>
                    <td><span className="flag-key">{v.variant}</span> {i === 0 && <span className="muted" style={{ fontSize: 11 }}>control</span>}</td>
                    <td style={{ textAlign: 'right' }}>{v.assigned.toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>{v.converted.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{pct(v.rate)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', color: diff === null ? '#ccc' : diff > 0 ? '#155724' : '#721c24' }}>
                      {diff === null ? '—' : pp(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {analyses && analyses.map(a => {
            const { trt, analysis, pow, req } = a;
            if (!analysis) return null;
            const relPct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
            const displayLift = analysis.method === 'bayesian' ? analysis.postMean : analysis.lift;
            const sig = analysis.method === 'bayesian'
              ? (analysis.probPositive >= 0.95 || analysis.probPositive <= 0.05)
              : (analysis.lo > 0 || analysis.hi < 0);
            const powOk = analysis.method !== 'fixed_sample' || pow >= 0.6;
            const { bg, tx } = sig && powOk ? { bg: '#d4edda', tx: '#155724' }
                             : sig          ? { bg: '#fff3cd', tx: '#856404' }
                             :                { bg: '#f8d7da', tx: '#721c24' };
            const isSeq = analysis.method === 'sequential' || analysis.method === 'sequential_hybrid';
            const ciLabel = { sequential: 'Anytime-valid 95% CI', sequential_hybrid: 'Anytime-valid 95% CI (hybrid)', bayesian: '95% credible interval' }[analysis.method] ?? '95% CI';
            const statField = analysis.method === 'bayesian'
              ? ['P(treatment > control)', pct(analysis.probPositive)]
              : ['p-value', analysis.pValue != null ? fmt(analysis.pValue, 4) : (sig ? '< α' : '> α')];
            const verdictMsg = analysis.method === 'bayesian'
              ? (analysis.probPositive >= 0.95 ? `Treatment better with ${pct(analysis.probPositive)} probability`
                : analysis.probPositive <= 0.05 ? `Control better — P(T > C) = ${pct(analysis.probPositive)}`
                : `Inconclusive — P(treatment > control) = ${pct(analysis.probPositive)}`)
              : isSeq
                ? (sig ? `Anytime-valid result: ${relPct(analysis.lift)} relative lift` : `No conclusion yet — CI contains 0`)
                : (analysis.pValue < 0.05 && pow < 0.6 ? `Significant but underpowered (p = ${fmt(analysis.pValue,4)})`
                  : analysis.pValue < 0.05 ? `Statistically significant (p = ${fmt(analysis.pValue,4)})`
                  : analysis.pValue < 0.1  ? `Marginal (p = ${fmt(analysis.pValue,4)})`
                  : `Not significant (p = ${fmt(analysis.pValue,4)})`);
            return (
              <div key={trt.variant} style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
                  <span className="flag-key">{trt.variant}</span> vs <span className="flag-key">{results.variants[0].variant}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  {[
                    ['Relative lift', relPct(displayLift)],
                    [ciLabel,         `[${relPct(analysis.lo)}, ${relPct(analysis.hi)}]`],
                    statField,
                    ['Power',         pct(pow)],
                    ['N for 80% power', req.toLocaleString() + ' total'],
                  ].map(([label, val]) => (
                    <div key={label} style={{ background: '#f8f9fc', border: '1px solid #e5e5e5', borderRadius: 6, padding: '8px 14px', minWidth: 120 }}>
                      <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>{label}</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13 }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'inline-block', padding: '5px 12px', borderRadius: 6, fontWeight: 700, fontSize: 12, background: bg, color: tx }}>
                    {verdictMsg}
                  </div>
                  {analysis.method === 'fixed_sample' && pow < 0.8 && (
                    <div style={{ fontSize: 12, color: '#856404', background: '#fff3cd', padding: '5px 12px', borderRadius: 5 }}>
                      ⚠ {pct(pow)} power — need {req.toLocaleString()} total for 80%
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function SrmWidget({ flagKey, startedAt }) {
  const [srm, setSrm] = useState(null);

  useEffect(() => {
    if (!flagKey) return;
    const qs = startedAt ? `?since=${encodeURIComponent(startedAt)}` : '';
    api.get(`/srm/${flagKey}${qs}`).then(r => { if (!r.error) setSrm(r); });
  }, [flagKey, startedAt]);

  if (!srm) return null;
  if (srm.total < 100) return (
    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
      SRM check requires ≥ 100 allocated users (have {srm.total}).
    </div>
  );

  const variantKeys = Object.keys(srm.observed);
  return (
    <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 6, background: srm.srm ? '#fff3cd' : '#f8f9fc', border: `1px solid ${srm.srm ? '#ffc107' : '#e5e5e5'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>Sample Ratio Mismatch</b>
        <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 10, background: srm.srm ? '#ffc107' : '#d4edda', color: srm.srm ? '#856404' : '#155724' }}>
          {srm.srm ? '⚠ SRM DETECTED' : '✓ No SRM'}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>χ² = {srm.chiSq} · p = {srm.pValue} · n = {srm.total}</span>
      </div>
      <table style={{ width: 'auto', fontSize: 12 }}>
        <thead><tr><th>Variant</th><th style={{ textAlign: 'right' }}>Expected</th><th style={{ textAlign: 'right' }}>Observed</th><th style={{ textAlign: 'right' }}>Δ</th></tr></thead>
        <tbody>
          {variantKeys.map(v => {
            const obs = srm.observed[v] ?? 0, exp = srm.expected[v] ?? 0;
            const delta = obs - exp, pct = exp ? ((delta / exp) * 100).toFixed(1) : '—';
            return (
              <tr key={v}>
                <td><span className="flag-key">{v}</span></td>
                <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{exp}</td>
                <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{obs}</td>
                <td style={{ textAlign: 'right', fontFamily: 'monospace', color: Math.abs(delta) > exp * 0.05 ? '#856404' : '#888' }}>{delta >= 0 ? '+' : ''}{pct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {srm.srm && <div style={{ marginTop: 8, fontSize: 12, color: '#856404' }}>The assignment ratio does not match the configured split weights. This likely indicates a bug in targeting rules or assignment logging. Results from this experiment should not be trusted until the cause is identified and fixed.</div>}
    </div>
  );
}

function FlagDetail({ flagId, onBack }) {
  const [flag,           setFlag]           = useState(null);
  const [variantForm,    setVariantForm]    = useState({ key: '', value: '' });
  const [showAllocModal, setShowAllocModal] = useState(false);
  const [editAlloc,      setEditAlloc]      = useState(null);
  const [fieldForm,      setFieldForm]      = useState({ name: '', label: '', inputType: 'text' });
  const [showFieldForm,  setShowFieldForm]  = useState(false);

  useEffect(() => { api.get(`/flags/${flagId}`).then(setFlag); }, [flagId]);

  async function toggleEnabled() {
    const res = await api.put(`/flags/${flagId}`, { enabled: !flag.enabled });
    setFlag(f => ({ ...f, enabled: res.enabled }));
  }

  async function setStatus(status) {
    const res = await api.put(`/flags/${flagId}/status`, { status });
    if (res.error) { alert(res.error); return; }
    setFlag(f => ({ ...f, status: res.status, started_at: res.started_at }));
  }

  async function addVariant() {
    if (!variantForm.key || !variantForm.value) return;
    const res = await api.post(`/flags/${flagId}/variants`, variantForm);
    if (res.error) { alert(res.error); return; }
    setFlag(f => ({ ...f, variants: [...f.variants, res] }));
    setVariantForm({ key: '', value: '' });
  }

  async function deleteVariant(v) {
    if (!confirm(`Delete variant "${v.key}"?`)) return;
    await api.del(`/flags/${flagId}/variants/${v.id}`);
    setFlag(f => ({ ...f, variants: f.variants.filter(x => x.id !== v.id) }));
  }

  async function saveAllocation(data) {
    let res;
    if (editAlloc) {
      res = await api.put(`/flags/${flagId}/allocations/${editAlloc.id}`, data);
      if (res.error) return res;
      const norm = normalizeAlloc(res);
      setFlag(f => ({ ...f, allocations: f.allocations.map(a => a.id === editAlloc.id ? norm : a) }));
    } else {
      res = await api.post(`/flags/${flagId}/allocations`, data);
      if (res.error) return res;
      const norm = normalizeAlloc(res);
      setFlag(f => ({ ...f, allocations: [...f.allocations, norm].sort((a, b) => a.priority - b.priority) }));
    }
    setEditAlloc(null);
  }

  async function deleteAlloc(alloc) {
    if (!confirm('Delete this allocation?')) return;
    await api.del(`/flags/${flagId}/allocations/${alloc.id}`);
    setFlag(f => ({ ...f, allocations: f.allocations.filter(a => a.id !== alloc.id) }));
  }

  async function addField() {
    if (!fieldForm.name || !fieldForm.label) return;
    const updatedFields = [...flag.fields, { name: fieldForm.name, label: fieldForm.label, inputType: fieldForm.inputType }];
    const res = await api.put(`/flags/${flagId}`, { fields: updatedFields });
    setFlag(f => ({ ...f, fields: res.fields }));
    setFieldForm({ name: '', label: '', inputType: 'text' });
    setShowFieldForm(false);
  }

  async function removeField(name) {
    const res = await api.put(`/flags/${flagId}`, { fields: flag.fields.filter(f => f.name !== name) });
    setFlag(f => ({ ...f, fields: res.fields }));
  }

  if (!flag) return <div style={{ padding: 20, color: '#888' }}>Loading…</div>;

  const isRunning = flag.status === 'running';
  const lockedMsg = 'Stop the experiment to make changes';

  return (
    <div>
      <span className="back-link" onClick={onBack}>← All Flags</span>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <Toggle checked={flag.enabled} onChange={toggleEnabled} />
          <TypeBadge type={flag.type} />
          <h2 style={{ margin: 0, flex: 1 }}>{flag.name}</h2>
          <span className={`badge badge-${flag.enabled ? 'on' : 'off'}`}>{flag.enabled ? 'ON' : 'OFF'}</span>
        </div>
        <div className="flag-key" style={{ display: 'inline-block', marginBottom: flag.description ? 6 : 0 }}>{flag.key}</div>
        {flag.description && <div style={{ marginTop: 6, color: '#555' }}>{flag.description}</div>}
      </div>

      {/* Results + SRM — shown when experiment has run */}
      {(flag.status === 'running' || flag.status === 'stopped') && (
        <>
          <ResultsCard flag={flag} />
          <SrmWidget flagKey={flag.key} startedAt={flag.started_at} />
        </>
      )}

      {/* Experiment lifecycle bar */}
      <div className={`experiment-bar ${flag.status ?? 'draft'}`}>
        <span className={`badge badge-${flag.status ?? 'draft'}`} style={{ fontSize: 12 }}>
          {(flag.status ?? 'draft').toUpperCase()}
        </span>
        {flag.status === 'running' && flag.started_at && (
          <span style={{ color: '#155724', fontSize: 12 }}>Started {flag.started_at}</span>
        )}
        {flag.status === 'stopped' && flag.started_at && (
          <span style={{ color: '#721c24', fontSize: 12 }}>Ran from {flag.started_at}</span>
        )}
        {(!flag.status || flag.status === 'draft') && (
          <span className="muted">Configure variants and allocations, then start the experiment to lock the configuration.</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {(!flag.status || flag.status === 'draft') && (
            <button className="btn btn-sm btn-primary" onClick={() => setStatus('running')}
              disabled={!flag.allocations?.length}
              title={!flag.allocations?.length ? 'Add an allocation before starting' : ''}>
              ▶ Start Experiment
            </button>
          )}
          {flag.status === 'running' && (
            <button className="btn btn-sm btn-danger" onClick={() => setStatus('stopped')}>■ Stop Experiment</button>
          )}
          {flag.status === 'stopped' && (<>
            <button className="btn btn-sm btn-primary" onClick={() => setStatus('running')}>▶ Restart Experiment</button>
            <button className="btn btn-sm" onClick={() => { if (confirm('Reset to draft? This clears the start time.')) setStatus('draft'); }}>Reset to Draft</button>
          </>)}
        </div>
      </div>

      {/* Variants */}
      <div className="card">
        <div className="section-header">
          <div className="section-label">Variants <span className="muted" style={{ textTransform: 'none', fontWeight: 400 }}>({flag.type})</span></div>
        </div>
        {flag.variants.length > 0 && (
          <table style={{ marginBottom: 16 }}>
            <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
            <tbody>
              {flag.variants.map(v => (
                <tr key={v.id}>
                  <td><span className="flag-key">{v.key}</span></td>
                  <td style={{ fontFamily: 'monospace' }}>{v.value}</td>
                  <td><button className="btn btn-sm btn-danger" onClick={() => deleteVariant(v)} disabled={isRunning} title={isRunning ? lockedMsg : ''}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="form-row" style={{ alignItems: 'flex-start' }}>
          <input className="input" placeholder="key (e.g. control)" value={variantForm.key}
            onInput={e => setVariantForm(f => ({ ...f, key: e.target.value }))} disabled={isRunning} />
          <VariantValueInput type={flag.type} value={variantForm.value}
            onChange={val => setVariantForm(f => ({ ...f, value: val }))} disabled={isRunning} />
          <button className="btn btn-primary btn-sm" onClick={addVariant} style={{ alignSelf: 'flex-start', marginTop: 2 }}
            disabled={isRunning} title={isRunning ? lockedMsg : ''}>Add Variant</button>
          {isRunning && <span className="muted" style={{ fontSize: 12 }}>🔒 {lockedMsg}</span>}
        </div>
      </div>

      {/* Targeting Attributes */}
      <div className="card">
        <div className="section-header">
          <div className="section-label">Targeting Attributes</div>
          <button className="btn btn-sm" onClick={() => setShowFieldForm(s => !s)}>
            {showFieldForm ? 'Cancel' : '+ Add Field'}
          </button>
        </div>
        <div className="muted" style={{ marginBottom: 12 }}>Fields available in the rule builder.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: showFieldForm ? 12 : 0 }}>
          {flag.fields.map(f => (
            <span key={f.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#f0f0f0', borderRadius: 4, padding: '3px 10px', fontSize: 12 }}>
              <b>{f.label}</b>
              <span style={{ color: '#888' }}>({f.name}, {f.inputType})</span>
              <span style={{ cursor: 'pointer', color: '#c0392b' }} onClick={() => removeField(f.name)}>×</span>
            </span>
          ))}
          {flag.fields.length === 0 && <span className="muted">No fields defined.</span>}
        </div>
        {showFieldForm && (
          <div className="form-row" style={{ marginTop: 8 }}>
            <input className="input" placeholder="field name" value={fieldForm.name}
              onInput={e => setFieldForm(f => ({ ...f, name: e.target.value }))} />
            <input className="input" placeholder="label" value={fieldForm.label}
              onInput={e => setFieldForm(f => ({ ...f, label: e.target.value }))} />
            <select className="input" value={fieldForm.inputType} onChange={e => setFieldForm(f => ({ ...f, inputType: e.target.value }))}>
              <option value="text">text</option>
              <option value="number">number</option>
            </select>
            <button className="btn btn-primary btn-sm" onClick={addField}>Add</button>
          </div>
        )}
      </div>

      {/* Allocations */}
      <div className="card">
        <div className="section-header">
          <div className="section-label">Allocations</div>
          <button className="btn btn-primary btn-sm"
            onClick={() => { setEditAlloc(null); setShowAllocModal(true); }}
            disabled={flag.variants.length === 0 || isRunning}
            title={isRunning ? lockedMsg : flag.variants.length === 0 ? 'Add variants first' : ''}
          >
            + Add Allocation
          </button>
        </div>
        <div className="muted" style={{ marginBottom: 12 }}>
          Evaluated in priority order. First matching allocation determines variant assignment via weighted split.
        </div>
        {flag.allocations.length === 0
          ? <div className="empty-state">No allocations. Users get no variant until you add one.</div>
          : (
            <table>
              <thead>
                <tr><th>Priority</th><th>Split</th><th>Targeting</th><th></th></tr>
              </thead>
              <tbody>
                {flag.allocations.map(alloc => (
                  <tr key={alloc.id}>
                    <td style={{ color: '#888' }}>{alloc.priority}</td>
                    <td>
                      {(alloc.splits ?? []).map(s => (
                        <span key={s.variant_key} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
                          <span className="flag-key">{s.variant_key}</span>
                          <span className="muted" style={{ marginLeft: 4 }}>{s.weight}%</span>
                        </span>
                      ))}
                    </td>
                    <td>
                      {alloc.targeting_rules
                        ? <span style={{ fontFamily: 'monospace', fontSize: 11, background: '#f0f0f0', padding: '2px 6px', borderRadius: 3, display: 'inline-block', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {JSON.stringify(alloc.targeting_rules)}
                          </span>
                        : <span className="muted">catch-all</span>
                      }
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm" onClick={() => { setEditAlloc(alloc); setShowAllocModal(true); }} disabled={isRunning} title={isRunning ? lockedMsg : ''}>Edit</button>
                        <button className="btn btn-sm btn-danger" onClick={() => deleteAlloc(alloc)} disabled={isRunning} title={isRunning ? lockedMsg : ''}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </div>

      {showAllocModal && (
        <AllocationModal
          flag={flag}
          editAlloc={editAlloc}
          onSave={saveAllocation}
          onClose={() => { setShowAllocModal(false); setEditAlloc(null); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

function samplePayload(flag) {
  return JSON.stringify({
    flag_key: flag?.key ?? 'your-flag-key',
    user_id: 'user-' + Math.floor(Math.random() * 1000),
    attributes: {
      country: 'US',
      plan: 'pro',
      account_age_days: 45,
      email: 'user@example.com',
    },
  }, null, 2);
}

function curlCommand(payload) {
  return `curl -X POST http://localhost:3000/api/evaluate \\\n  -H "Content-Type: application/json" \\\n  -d '${payload.replace(/\n/g, '\n       ')}'`;
}

function EvaluateView() {
  const [flags,    setFlags]    = useState([]);
  const [flagKey,  setFlagKey]  = useState('');
  const [payload,  setPayload]  = useState('{\n  "flag_key": "",\n  "user_id": "user-123",\n  "attributes": {\n    "country": "US",\n    "plan": "pro"\n  }\n}');
  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState('');
  const [copied,   setCopied]   = useState(false);
  const [loading,  setLoading]  = useState(false);

  useEffect(() => { api.get('/flags').then(setFlags); }, []);

  function handleFlagChange(key) {
    setFlagKey(key);
    setResult(null);
    const flag = flags.find(f => f.key === key);
    if (flag) setPayload(samplePayload(flag));
  }

  async function evaluate() {
    setError('');
    setLoading(true);
    let body;
    try { body = JSON.parse(payload); } catch { setError('Invalid JSON in payload'); setLoading(false); return; }
    // Randomize user_id on every run so repeated clicks produce different bucket assignments
    body = { ...body, user_id: 'user-' + Math.floor(Math.random() * 1000000) };
    setPayload(JSON.stringify(body, null, 2));
    const res = await api.post('/evaluate', body);
    setResult(res);
    setLoading(false);
  }

  function copycurl() {
    navigator.clipboard.writeText(curlCommand(payload));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const curl = curlCommand(payload);

  return (
    <div>
      <div className="card">
        <h2>Evaluate a Flag</h2>

        <div className="section">
          <div className="section-label" style={{ marginBottom: 8 }}>Flag (pre-populate payload)</div>
          <select className="input" value={flagKey} onChange={e => handleFlagChange(e.target.value)}>
            <option value="">— select a flag —</option>
            {flags.map(f => <option key={f.id} value={f.key}>{f.key} — {f.name}</option>)}
          </select>
        </div>

        <div className="section">
          <div className="section-label" style={{ marginBottom: 8 }}>Request Payload</div>
          <textarea
            className="input"
            style={{ width: '100%', height: 180, resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
            value={payload}
            onChange={e => { setPayload(e.target.value); setResult(null); }}
          />
          {error && <div className="error">{error}</div>}
        </div>

        <div className="section">
          <div className="section-label" style={{ marginBottom: 8 }}>curl</div>
          <div style={{ position: 'relative' }}>
            <pre style={{ margin: 0, padding: '12px 44px 12px 14px', background: '#1a1a2e', color: '#a8ff78', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{curl}</pre>
            <button
              onClick={copycurl}
              style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        <button className="btn btn-primary" onClick={evaluate} disabled={loading}>
          {loading ? 'Running…' : 'Run in Browser →'}
        </button>
      </div>

      {result && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div className="section-label">Response</div>
            <span style={{ fontSize: 12, color: '#888' }}>POST /api/evaluate</span>
          </div>
          <div className="result-box">{JSON.stringify(result, null, 2)}</div>
          <div style={{ marginTop: 12, fontSize: 13 }}>
            {result.error
              ? <span style={{ color: '#c0392b', fontWeight: 600 }}>✗ Error: {result.error}</span>
              : result.variant
                ? <span style={{ color: '#27ae60', fontWeight: 600 }}>✓ Variant <code>{result.variant}</code> → value: <code>{JSON.stringify(result.value)}</code></span>
                : <span style={{ color: '#e67e22', fontWeight: 600 }}>✗ No variant — reason: {result.reason}</span>
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assignments view
// ---------------------------------------------------------------------------

const REASON_COLORS = {
  allocated:              { bg: '#d4edda', fg: '#155724' },
  no_matching_allocation: { bg: '#fff3cd', fg: '#856404' },
  flag_disabled:          { bg: '#f8d7da', fg: '#721c24' },
  split_exhausted:        { bg: '#f8d7da', fg: '#721c24' },
};

function ReasonBadge({ reason }) {
  const c = REASON_COLORS[reason] ?? { bg: '#e9ecef', fg: '#495057' };
  return (
    <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {reason}
    </span>
  );
}

function AssignmentsView() {
  const [data,       setData]       = useState(null);
  const [flagFilter, setFlagFilter] = useState('');
  const [flags,      setFlags]      = useState([]);
  const PAGE = 50;
  const [offset, setOffset] = useState(0);

  useEffect(() => { api.get('/flags').then(setFlags); }, []);

  useEffect(() => {
    load(0);
  }, [flagFilter]);

  async function load(nextOffset = offset) {
    const qs = new URLSearchParams({ limit: PAGE, offset: nextOffset });
    if (flagFilter) qs.set('flag_key', flagFilter);
    const res = await api.get(`/assignments?${qs}`);
    setData(res);
    setOffset(nextOffset);
  }

  async function clearAll() {
    if (!confirm('Delete all assignment records?')) return;
    await api.del('/assignments');
    load(0);
  }

  const rows  = data?.rows  ?? [];
  const total = data?.total ?? 0;

  return (
    <div>
      <div className="card">
        <div className="section-header" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Experiment Assignments</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="input" value={flagFilter} onChange={e => setFlagFilter(e.target.value)}>
              <option value="">All flags</option>
              {flags.map(f => <option key={f.id} value={f.key}>{f.key}</option>)}
            </select>
            <button className="btn btn-sm" onClick={() => load(0)}>Refresh</button>
            <button className="btn btn-sm btn-danger" onClick={clearAll}>Clear All</button>
          </div>
        </div>

        <div className="muted" style={{ marginBottom: 12 }}>
          {total} total record{total !== 1 ? 's' : ''}{flagFilter ? ` for "${flagFilter}"` : ''}
        </div>

        {rows.length === 0
          ? <div className="empty-state">No assignments yet. Run an evaluation to see records here.</div>
          : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Flag</th>
                    <th>User ID</th>
                    <th>Variant</th>
                    <th>Value</th>
                    <th>Bucket</th>
                    <th>Reason</th>
                    <th>Attributes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id}>
                      <td style={{ whiteSpace: 'nowrap', color: '#888', fontSize: 12 }}>
                        {row.assigned_at.replace('T', ' ').slice(0, 19)}
                      </td>
                      <td><span className="flag-key">{row.flag_key}</span></td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.user_id}</td>
                      <td>
                        {row.variant
                          ? <span className="flag-key">{row.variant}</span>
                          : <span className="muted">—</span>
                        }
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.value ?? <span className="muted">—</span>}
                      </td>
                      <td style={{ color: '#888', fontSize: 12 }}>{row.bucket ?? '—'}</td>
                      <td><ReasonBadge reason={row.reason} /></td>
                      <td>
                        <span
                          style={{ fontFamily: 'monospace', fontSize: 11, color: '#888', cursor: 'pointer' }}
                          title={row.attributes}
                          onClick={() => alert(JSON.stringify(JSON.parse(row.attributes ?? '{}'), null, 2))}
                        >
                          {row.attributes ? '{…}' : '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        {total > PAGE && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => load(Math.max(0, offset - PAGE))} disabled={offset === 0}>← Prev</button>
            <span className="muted">{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
            <button className="btn btn-sm" onClick={() => load(offset + PAGE)} disabled={offset + PAGE >= total}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simulation — stats helpers
// ---------------------------------------------------------------------------

// Abramowitz & Stegun error function approximation (max error < 1.5e-7)
function erf(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign * y;
}

function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

// Inverse normal CDF (probit) — Acklam rational approximation, max error ~1.15e-9
function probit(p) {
  const a = [-3.969683028665376e+01,  2.209460984245205e+02, -2.759285104469687e+02,
              1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00];
  const b = [-5.447609879822406e+01,  1.615858368580409e+02, -1.556989798598866e+02,
              6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00];
  const d = [ 7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
              3.754408661907416e+00];
  if (p <= 0) return -Infinity;
  if (p >= 1) return  Infinity;
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

// ---------------------------------------------------------------------------
// Eppo-style analysis methods
//
// All three methods operate on relative lift Δ = (μT − μC) / μC and use the
// delta method to propagate variance. Inputs for each variant:
//   { assigned: n, mean: per-user mean (incl. zeros), variance: sample var }
// ---------------------------------------------------------------------------

// Relative lift and standard error via the delta method (Eppo's formula).
function deltaMethodLift(nC, mC, vC, nT, mT, vT) {
  if (!mC) return { lift: 0, sigmaDelta: Infinity };
  const lift     = (mT - mC) / mC;
  // σ²_Δ = (mT/mC)² × (vC/(nC·mC²) + vT/(nT·mT²))
  const varDelta = (mT / mC) ** 2 * (vC / (nC * mC ** 2) + (mT ? vT / (nT * mT ** 2) : 0));
  return { lift, sigmaDelta: Math.sqrt(Math.max(0, varDelta)) };
}

// Fixed-sample frequentist CI. Two-sided z-test on relative lift.
function fixedSampleCI(lift, sigmaDelta, alpha = 0.05) {
  if (!sigmaDelta || !isFinite(sigmaDelta)) return null;
  const z      = -probit(alpha / 2); // e.g. 1.96 for α=0.05
  const pValue = 2 * normalCDF(-Math.abs(lift / sigmaDelta));
  return { lo: lift - z * sigmaDelta, hi: lift + z * sigmaDelta, pValue, method: 'fixed_sample' };
}

// Sequential CI — Howard et al. time-uniform confidence sequence (Eppo's formula).
// t = nC + nT, ρ tuned with N_tune = 10,000.
function sequentialCI(lift, sigmaDelta, t, alpha = 0.05) {
  if (!sigmaDelta || !isFinite(sigmaDelta) || t < 2) return null;
  const rho = 10000 / (Math.log(Math.log(Math.E / alpha ** 2)) - 2 * Math.log(alpha));
  const B   = Math.sqrt((t + rho) * Math.log((t + rho) / (rho * alpha ** 2))) / Math.sqrt(t);
  return { lo: lift - B * sigmaDelta, hi: lift + B * sigmaDelta, B, method: 'sequential' };
}

// Sequential hybrid CI — same Howard et al. formula, but ρ is tuned to nTarget
// (the planned total sample size) rather than a fixed 10,000.  This makes the
// confidence sequence as tight as possible at the planned stopping point while
// remaining valid at every earlier peek.
function sequentialHybridCI(lift, sigmaDelta, t, nTarget, alpha = 0.05) {
  if (!sigmaDelta || !isFinite(sigmaDelta) || t < 2) return null;
  const rho = nTarget / (Math.log(Math.log(Math.E / alpha ** 2)) - 2 * Math.log(alpha));
  const B   = Math.sqrt((t + rho) * Math.log((t + rho) / (rho * alpha ** 2))) / Math.sqrt(t);
  return { lo: lift - B * sigmaDelta, hi: lift + B * sigmaDelta, B, nTarget, method: 'sequential_hybrid' };
}

// Bayesian CI — Gaussian prior N(0, σ²=0.05²) on relative lift (Eppo's prior).
// Posterior is weighted average of prior and likelihood.
function bayesianGaussianCI(lift, sigmaDelta, alpha = 0.05) {
  if (!sigmaDelta || !isFinite(sigmaDelta)) return null;
  const precPrior    = 1 / 0.05 ** 2;            // prior N(0, 0.05²): precision = 400
  const precData     = 1 / sigmaDelta ** 2;
  const postMean     = precData * lift / (precPrior + precData); // prior mean = 0
  const postSigma    = Math.sqrt(1 / (precPrior + precData));
  const z            = -probit(alpha / 2);
  const probPositive = normalCDF(postMean / postSigma);
  return { lo: postMean - z * postSigma, hi: postMean + z * postSigma,
           postMean, postSigma, probPositive, method: 'bayesian' };
}

// Unified entry point. ctrl/trt: { assigned, mean, variance }
// method: 'fixed_sample' | 'sequential' | 'sequential_hybrid' | 'bayesian'
// nTarget: required for sequential_hybrid — planned total sample size
function runAnalysis(ctrl, trt, method = 'fixed_sample', alpha = 0.05, nTarget = 10000) {
  const { lift, sigmaDelta } = deltaMethodLift(
    ctrl.assigned, ctrl.mean, ctrl.variance,
    trt.assigned,  trt.mean,  trt.variance,
  );
  const t = ctrl.assigned + trt.assigned;
  switch (method) {
    case 'sequential':        return { lift, sigmaDelta, ...sequentialCI(lift, sigmaDelta, t, alpha) };
    case 'sequential_hybrid': return { lift, sigmaDelta, ...sequentialHybridCI(lift, sigmaDelta, t, nTarget, alpha) };
    case 'bayesian':          return { lift, sigmaDelta, ...bayesianGaussianCI(lift, sigmaDelta, alpha) };
    default:                  return { lift, sigmaDelta, ...fixedSampleCI(lift, sigmaDelta, alpha) };
  }
}

// Two-proportion z-test (two-sided). Returns { z, pValue, diff, ci95lo, ci95hi }
function zTestProportions(n1, x1, n2, x2) {
  const p1 = x1 / n1, p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se    = Math.sqrt(pPool * (1 - pPool) * (1/n1 + 1/n2));
  const z     = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));
  const seDiff = Math.sqrt(p1*(1-p1)/n1 + p2*(1-p2)/n2);
  return { p1, p2, z, pValue, diff: p1 - p2, ci95lo: (p1-p2) - 1.96*seDiff, ci95hi: (p1-p2) + 1.96*seDiff };
}

// Achieved power given actual arm sizes n1, n2 and true rates p1, p2.
// Uses the weighted pooled proportion under H0, so unequal splits are handled correctly.
function computePower(n1, n2, p1, p2) {
  const pBar   = (n1*p1 + n2*p2) / (n1 + n2);
  const seNull = Math.sqrt(pBar * (1-pBar) * (1/n1 + 1/n2));
  const seAlt  = Math.sqrt(p1*(1-p1)/n1 + p2*(1-p2)/n2);
  const zBeta  = (Math.abs(p1-p2) - 1.96 * seNull) / seAlt;
  return normalCDF(zBeta);
}

// Required TOTAL sample size for 80% power at alpha=0.05, given fractional
// allocation weights w1 (control) and w2 (treatment) that sum to 1.
// Unequal splits are less efficient — required N rises as the ratio departs from 50/50.
function requiredNTotal(p1, p2, w1, w2) {
  const pBar = w1*p1 + w2*p2;
  const num  = (1.96 * Math.sqrt(pBar*(1-pBar)*(1/w1 + 1/w2)) + 0.842 * Math.sqrt(p1*(1-p1)/w1 + p2*(1-p2)/w2)) ** 2;
  return Math.ceil(num / (p1-p2) ** 2);
}

// Bayesian Beta-Binomial test (uninformative Beta(1,1) prior).
// Uses normal approximation to the Beta posterior — accurate for n > ~30.
// Returns { probBgtA, posteriorMeanA, posteriorMeanB, credLo, credHi, relLift }
function bayesianTest(n1, x1, n2, x2) {
  // Posterior parameters: Beta(1 + conversions, 1 + non-conversions)
  const a1 = 1 + x1,  b1 = 1 + (n1 - x1);
  const a2 = 1 + x2,  b2 = 1 + (n2 - x2);
  const mu1  = a1 / (a1 + b1);
  const mu2  = a2 / (a2 + b2);
  const var1 = (a1 * b1) / ((a1+b1)**2 * (a1+b1+1));
  const var2 = (a2 * b2) / ((a2+b2)**2 * (a2+b2+1));
  // P(treatment > control): difference of two approx-normals
  const z          = (mu2 - mu1) / Math.sqrt(var1 + var2);
  const probBgtA   = normalCDF(z);
  // 95% credible interval on the absolute difference
  const seDiff = Math.sqrt(var1 + var2);
  const credLo = (mu2 - mu1) - 1.96 * seDiff;
  const credHi = (mu2 - mu1) + 1.96 * seDiff;
  const relLift = mu1 > 0 ? (mu2 - mu1) / mu1 : 0;
  return { probBgtA, posteriorMeanA: mu1, posteriorMeanB: mu2, credLo, credHi, relLift };
}

// Seeded PRNG (mulberry32) — reproducible runs given same seed
function makePrng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// SimulateView
// ---------------------------------------------------------------------------

function SimulateView() {
  const [flags,      setFlags]      = useState([]);
  const [flagId,     setFlagId]     = useState('');
  const [flag,       setFlag]       = useState(null);
  const [nUsers,     setNUsers]     = useState(1000);
  const [method,     setMethod]     = useState('fixed_sample');
  const [nTarget,    setNTarget]    = useState(10000);
  const [varCfg,     setVarCfg]     = useState({});   // { variantKey: { rate: string } }
  const [results,    setResults]    = useState(null);
  const [seed,       setSeed]       = useState(() => Math.floor(Math.random() * 1e9));
  const [writeToDb,  setWriteToDb]  = useState(false);
  const [writeStatus, setWriteStatus] = useState(''); // '', 'writing', 'ok:<run_id>', 'error:<msg>'

  useEffect(() => { api.get('/flags').then(setFlags); }, []);

  async function loadFlag(id) {
    setFlagId(id);
    setResults(null);
    if (!id) { setFlag(null); return; }
    const f = await api.get(`/flags/${id}`);
    setFlag(f);
    // Default rate: 10% for control, 12% for others
    const cfg = {};
    f.variants.forEach((v, i) => { cfg[v.key] = { rate: i === 0 ? '0.10' : '0.12' }; });
    setVarCfg(cfg);
  }

  function setRate(key, val) {
    setVarCfg(c => ({ ...c, [key]: { ...c[key], rate: val } }));
  }

  async function runSimulation() {
    const rng     = makePrng(seed);
    const variants = flag.variants;
    // Flatten splits from all allocations into a single bucket map 0-99
    const alloc = flag.allocations[0];
    if (!alloc) { alert('No allocation configured on this flag.'); return; }
    const splits = alloc.splits;

    // Build bucket→variantKey map
    const bucketMap = new Array(100);
    let cursor = 0;
    for (const sp of splits) {
      for (let b = cursor; b < cursor + sp.weight; b++) bucketMap[b] = sp.variant_key;
      cursor += sp.weight;
    }

    // Per-variant accumulators
    const counts      = {};
    const conversions = {};
    variants.forEach(v => { counts[v.key] = 0; conversions[v.key] = 0; });

    for (let i = 0; i < nUsers; i++) {
      const bucket     = Math.floor(rng() * 100);
      const variantKey = bucketMap[bucket];
      if (!variantKey || !counts.hasOwnProperty(variantKey)) continue;
      counts[variantKey]++;
      const rate = parseFloat(varCfg[variantKey]?.rate ?? 0);
      if (rng() < rate) conversions[variantKey]++;
    }

    // Pick control = first variant
    const controlKey = variants[0]?.key;
    const tests = [];
    for (const v of variants) {
      if (v.key === controlKey) continue;
      const n1 = counts[controlKey], x1 = conversions[controlKey];
      const n2 = counts[v.key],      x2 = conversions[v.key];
      if (!n1 || !n2) continue;
      const m1 = x1 / n1, m2 = x2 / n2; // observed rates
      const p1true = parseFloat(varCfg[controlKey]?.rate ?? 0.1);
      const p2true = parseFloat(varCfg[v.key]?.rate    ?? 0.1);
      const sp1 = splits.find(s => s.variant_key === controlKey);
      const sp2 = splits.find(s => s.variant_key === v.key);
      const w1  = (sp1?.weight ?? 50) / 100;
      const w2  = (sp2?.weight ?? 50) / 100;
      // Bernoulli variance for binary simulation data
      const analysis = runAnalysis(
        { assigned: n1, mean: m1, variance: m1 * (1 - m1) },
        { assigned: n2, mean: m2, variance: m2 * (1 - m2) },
        method, 0.05, nTarget,
      );
      const pow = computePower(n1, n2, p1true, p2true);
      const req = requiredNTotal(p1true, p2true, w1, w2);
      tests.push({ variantKey: v.key, analysis, power: pow, requiredNTotal: req, w1, w2 });
    }

    setResults({ counts, conversions, tests, controlKey });
    setWriteStatus('');

    if (writeToDb) {
      const runId = `sim-${Date.now()}-s${seed}`;
      setWriteStatus('writing');
      const variantPayload = Object.keys(counts).map(vk => ({
        variant:     vk,
        n:           counts[vk],
        conversions: conversions[vk],
      }));
      const r = await api.post('/simulation/write', {
        run_id:      runId,
        seed,
        flag_key:    flag.key,
        metric_name: 'conversion',
        variants:    variantPayload,
      });
      if (r.error) {
        setWriteStatus(`error:${r.error}`);
      } else {
        setWriteStatus(`ok:${runId}`);
      }
    }
  }

  function pct(n)    { return (n * 100).toFixed(2) + '%'; }
  function fmt(n, d=3) { return n.toFixed(d); }
  function pp(n)     { return (n >= 0 ? '+' : '') + (n*100).toFixed(2) + 'pp'; }
  function relPct(n) { return (n >= 0 ? '+' : '') + (n*100).toFixed(2) + '%'; }

  const hasVariants = flag?.variants?.length > 0;
  const hasAlloc    = flag?.allocations?.length > 0;

  return (
    <div>
      <div className="card">
        <h2 style={{ marginBottom: 16 }}>Simulate Experiment</h2>

        <div className="form-row" style={{ alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Flag</div>
            <select className="input" value={flagId} onChange={e => loadFlag(e.target.value)}>
              <option value="">— select a flag —</option>
              {flags.map(f => <option key={f.id} value={f.id}>{f.key}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Simulated users</div>
            <input className="input" type="number" min="100" max="1000000" step="100"
              value={nUsers} onChange={e => setNUsers(Number(e.target.value))} style={{ width: 120 }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Random seed</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" type="number" value={seed}
                onChange={e => setSeed(Number(e.target.value))} style={{ width: 110 }} />
              <button className="btn btn-sm" onClick={() => { setSeed(Math.floor(Math.random()*1e9)); setResults(null); }}>↺</button>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Analysis method</div>
            <select className="input" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="fixed_sample">Fixed-sample</option>
              <option value="sequential">Sequential</option>
              <option value="sequential_hybrid">Sequential hybrid</option>
              <option value="bayesian">Bayesian</option>
            </select>
          </div>
          {method === 'sequential_hybrid' && (
            <div>
              <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Planned N (total)</div>
              <input className="input" type="number" min="100" step="100" value={nTarget}
                onChange={e => setNTarget(Number(e.target.value))} style={{ width: 120 }} />
            </div>
          )}
        </div>

        {flag && hasVariants && hasAlloc && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
              Conversion rates per variant
            </div>
            <table style={{ width: 'auto' }}>
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>Split weight</th>
                  <th>True conversion rate</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {flag.variants.map((v, i) => {
                  const sp = flag.allocations[0]?.splits?.find(s => s.variant_key === v.key);
                  return (
                    <tr key={v.key}>
                      <td><span className="flag-key">{v.key}</span></td>
                      <td>{sp ? sp.weight + '%' : <span className="muted">—</span>}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input className="input" type="number" min="0" max="1" step="0.001"
                            value={varCfg[v.key]?.rate ?? '0.10'}
                            onChange={e => setRate(v.key, e.target.value)}
                            style={{ width: 90 }} />
                          <span className="muted">{pct(parseFloat(varCfg[v.key]?.rate ?? 0))}</span>
                        </div>
                      </td>
                      <td style={{ color: '#888', fontSize: 12 }}>{i === 0 ? 'control' : 'treatment'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={runSimulation}>Run Simulation</button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={writeToDb} onChange={e => setWriteToDb(e.target.checked)} />
                Write to DB
              </label>
              {writeStatus === 'writing' && (
                <span style={{ fontSize: 12, color: '#555' }}>Writing to database…</span>
              )}
              {writeStatus.startsWith('ok:') && (() => {
                const runId = writeStatus.slice(3);
                return (
                  <span style={{ fontSize: 12, color: '#155724', background: '#d4edda', padding: '4px 10px', borderRadius: 4 }}>
                    Written — run_id: <code style={{ fontFamily: 'monospace' }}>{runId}</code>
                  </span>
                );
              })()}
              {writeStatus.startsWith('error:') && (
                <span style={{ fontSize: 12, color: '#721c24', background: '#f8d7da', padding: '4px 10px', borderRadius: 4 }}>
                  {writeStatus.slice(6)}
                </span>
              )}
            </div>
          </div>
        )}

        {flag && !hasVariants && <div className="muted" style={{ marginTop: 12 }}>This flag has no variants. Add variants first.</div>}
        {flag && !hasAlloc    && <div className="muted" style={{ marginTop: 12 }}>This flag has no allocation. Configure splits first.</div>}
      </div>

      {results && (
        <>
          <div className="card">
            <h2 style={{ marginBottom: 16 }}>Assignment &amp; Outcome Summary</h2>
            <table>
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>Role</th>
                  <th style={{ textAlign: 'right' }}>Users assigned</th>
                  <th style={{ textAlign: 'right' }}>Conversions</th>
                  <th style={{ textAlign: 'right' }}>Observed rate</th>
                  <th style={{ textAlign: 'right' }}>True rate</th>
                  <th style={{ textAlign: 'right' }}>vs control</th>
                </tr>
              </thead>
              <tbody>
                {flag.variants.map((v, i) => {
                  const n    = results.counts[v.key]      ?? 0;
                  const x    = results.conversions[v.key] ?? 0;
                  const obs  = n ? x / n : 0;
                  const ctrl = results.counts[results.controlKey] ? results.conversions[results.controlKey] / results.counts[results.controlKey] : 0;
                  const diff = i === 0 ? null : obs - ctrl;
                  return (
                    <tr key={v.key}>
                      <td><span className="flag-key">{v.key}</span></td>
                      <td style={{ color: '#888', fontSize: 12 }}>{i === 0 ? 'control' : 'treatment'}</td>
                      <td style={{ textAlign: 'right' }}>{n.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{x.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{pct(obs)}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#888' }}>{pct(parseFloat(varCfg[v.key]?.rate ?? 0))}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'monospace', color: diff === null ? '#ccc' : diff >= 0 ? '#155724' : '#721c24' }}>
                        {diff === null ? '—' : pp(diff)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 2 }}>Statistical Analysis
              <span style={{ fontWeight: 400, fontSize: 13, color: '#666', marginLeft: 10 }}>
                {{ fixed_sample: 'Fixed-sample · δ-method CI on relative lift', sequential: 'Sequential · Howard et al. anytime-valid CI', sequential_hybrid: `Sequential hybrid · anytime-valid, tuned to N=${nTarget.toLocaleString()}`, bayesian: 'Bayesian · Gaussian prior N(0, 0.05²) on lift' }[method]}
              </span>
            </h2>
            <div className="muted" style={{ marginBottom: 16, fontSize: 12 }}>
              Relative lift = (treatment − control) / control. Each treatment arm vs. control. α = 0.05.
            </div>
            {results.tests.length === 0
              ? <div className="muted">No treatment arms to test.</div>
              : results.tests.map(t => {
                const { analysis, power, requiredNTotal, w1, w2 } = t;
                if (!analysis) return null;
                const displayLift = analysis.method === 'bayesian' ? analysis.postMean : analysis.lift;
                const sig = analysis.method === 'bayesian'
                  ? (analysis.probPositive >= 0.95 || analysis.probPositive <= 0.05)
                  : (analysis.lo > 0 || analysis.hi < 0);
                const powOk = analysis.method !== 'fixed_sample' || power >= 0.6;
                const { bg, tx } = sig && powOk ? { bg: '#d4edda', tx: '#155724' }
                                 : sig          ? { bg: '#fff3cd', tx: '#856404' }
                                 :                { bg: '#f8d7da', tx: '#721c24' };
                const isSeq = analysis.method === 'sequential' || analysis.method === 'sequential_hybrid';
                const ciLabel = { sequential: 'Anytime-valid 95% CI', sequential_hybrid: 'Anytime-valid 95% CI (hybrid)', bayesian: '95% credible interval' }[analysis.method] ?? '95% CI';
                const statField = analysis.method === 'bayesian'
                  ? ['P(treatment > control)', pct(analysis.probPositive)]
                  : ['p-value', analysis.pValue != null ? fmt(analysis.pValue, 4) : (sig ? '< α' : '> α')];
                const verdictMsg = analysis.method === 'bayesian'
                  ? (analysis.probPositive >= 0.95 ? `Treatment better with ${pct(analysis.probPositive)} probability`
                    : analysis.probPositive <= 0.05 ? `Control better — P(T > C) = ${pct(analysis.probPositive)}`
                    : `Inconclusive — P(treatment > control) = ${pct(analysis.probPositive)}`)
                  : isSeq
                    ? (sig ? `Anytime-valid result: ${relPct(analysis.lift)} relative lift` : `No conclusion yet — CI contains 0`)
                    : (analysis.pValue < 0.05 && power < 0.6 ? `Significant but underpowered (p = ${fmt(analysis.pValue,4)})`
                      : analysis.pValue < 0.05 ? `Statistically significant (p = ${fmt(analysis.pValue,4)})`
                      : analysis.pValue < 0.1  ? `Marginal (p = ${fmt(analysis.pValue,4)})`
                      : `Not significant (p = ${fmt(analysis.pValue,4)})`);
                return (
                  <div key={t.variantKey} style={{ marginBottom: 20 }}>
                    <div style={{ fontWeight: 600, marginBottom: 10 }}>
                      <span className="flag-key">{t.variantKey}</span> vs <span className="flag-key">{results.controlKey}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                      {[
                        ['Relative lift', relPct(displayLift)],
                        [ciLabel,         `[${relPct(analysis.lo)}, ${relPct(analysis.hi)}]`],
                        statField,
                        ['Power (this N)',   pct(power)],
                        ['N for 80% power', requiredNTotal.toLocaleString() + ` total (${Math.round(w1*100)}/${Math.round(w2*100)} split)`],
                      ].map(([label, val]) => (
                        <div key={label} style={{ background: '#f8f9fc', border: '1px solid #e5e5e5', borderRadius: 6, padding: '10px 16px', minWidth: 130 }}>
                          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{val}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ display: 'inline-block', padding: '6px 14px', borderRadius: 6, fontWeight: 700, fontSize: 13, background: bg, color: tx }}>
                        {verdictMsg}
                      </div>
                      {analysis.method === 'fixed_sample' && power < 0.8 && (
                        <div style={{ fontSize: 12, color: '#856404', background: '#fff3cd', padding: '6px 12px', borderRadius: 5 }}>
                          ⚠ {pct(power)} power — need {requiredNTotal.toLocaleString()} total for 80% at {Math.round(w1*100)}/{Math.round(w2*100)} split
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            }
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PreviewResult — renders the output of a SQL preview call
// ---------------------------------------------------------------------------

function PreviewResult({ preview }) {
  if (!preview) return null;
  if (preview.loading) return <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>Running…</div>;
  if (preview.error)   return <div style={{ fontSize: 12, color: '#721c24', background: '#f8d7da', padding: '6px 10px', borderRadius: 4, marginTop: 6, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.error}</div>;
  if (!preview.rows?.length) return <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>No rows returned.</div>;
  const cols = Object.keys(preview.rows[0]);
  return (
    <div style={{ marginTop: 8, overflowX: 'auto' }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>First {preview.rows.length} row{preview.rows.length !== 1 ? 's' : ''}</div>
      <table style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        <thead>
          <tr>{cols.map(c => <th key={c} style={{ fontFamily: 'monospace' }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {preview.rows.map((row, i) => (
            <tr key={i}>
              {cols.map(c => <td key={c} style={{ fontFamily: 'monospace' }}>{row[c] == null ? <span style={{ color: '#aaa' }}>NULL</span> : String(row[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WarehouseView — Eppo-style facts-table analysis
// ---------------------------------------------------------------------------
//
// The user provides two SQL snippets per analysis:
//   assignment_sql — returns (entity_id, variant, assigned_at)
//   metric_sql     — returns (entity_id, value, event_at)
// The server composes them into a CTE that joins and aggregates per variant.
// Configs are saved to warehouse_configs and run against the active DB adapter
// (SQLite, Postgres, or BigQuery), so the query literally hits your warehouse.

const ASSIGN_PLACEHOLDER = `-- Must return columns named exactly: entity_id, variant, assigned_at
-- The entity id column MUST be aliased AS entity_id.
--
-- Example — simulation data:
SELECT
  user_id     AS entity_id,
  variant,
  assigned_at
FROM \`myproject.experiment_platform_simulation.experiment_assignments\`
WHERE run_id = 'sim-...'
--
-- Example — production data:
SELECT
  user_id     AS entity_id,
  variant_key AS variant,
  assigned_at
FROM \`myproject.dataset.experiment_assignments\`
WHERE experiment_key = 'my-flag-key'`;

const METRIC_PLACEHOLDER = `-- Must return columns named exactly: entity_id, value, event_at
-- The entity id column MUST be aliased AS entity_id.
--
-- Example — simulation data:
SELECT
  user_id  AS entity_id,
  value,
  event_at
FROM \`myproject.experiment_platform_simulation.experiment_facts\`
WHERE run_id = 'sim-...' AND metric_name = 'conversion'
--
-- Example — production data:
SELECT
  user_id      AS entity_id,
  1            AS value,
  converted_at AS event_at
FROM \`myproject.dataset.conversions\``;

function WarehouseView() {
  const [configs,       setConfigs]       = useState([]);
  const [activeId,      setActiveId]      = useState(null);   // saved config id
  const [configName,    setConfigName]    = useState('');
  const [assignSql,     setAssignSql]     = useState('');
  const [metrics,       setMetrics]       = useState([{ name: 'conversion', sql: '' }]);
  const [method,        setMethod]        = useState('fixed_sample');
  const [nTarget,       setNTarget]       = useState(10000);
  const [running,       setRunning]       = useState(false);
  const [results,       setResults]       = useState([]);    // [{metric_name, variants, analyses}]
  const [error,         setError]         = useState('');
  const [previews,      setPreviews]      = useState({});    // { key: {rows, error, loading} }

  useEffect(() => { refreshConfigs(); }, []);

  async function refreshConfigs() {
    const r = await api.get('/analysis/configs');
    if (Array.isArray(r)) setConfigs(r);
  }

  function loadConfig(cfg) {
    setActiveId(cfg.id);
    setConfigName(cfg.name);
    setAssignSql(cfg.assignment_sql ?? '');
    setMetrics(Array.isArray(cfg.metrics) && cfg.metrics.length > 0
      ? cfg.metrics
      : [{ name: 'conversion', sql: '' }]);
    setResults([]);
    setError('');
  }

  function newConfig() {
    setActiveId(null);
    setConfigName('');
    setAssignSql('');
    setMetrics([{ name: 'conversion', sql: '' }]);
    setResults([]);
    setError('');
  }

  async function saveConfig() {
    if (!configName.trim()) { alert('Enter a config name first.'); return; }
    const body = { name: configName, assignment_sql: assignSql, metrics };
    if (activeId) {
      await api.put(`/analysis/configs/${activeId}`, body);
    } else {
      const r = await api.post('/analysis/configs', body);
      if (r.id) setActiveId(r.id);
    }
    refreshConfigs();
  }

  async function deleteConfig() {
    if (!activeId) return;
    if (!confirm('Delete this config?')) return;
    await api.del(`/analysis/configs/${activeId}`);
    newConfig();
    refreshConfigs();
  }

  async function runQuery() {
    setError('');
    setResults([]);
    if (!assignSql.trim()) { setError('Assignment SQL is required.'); return; }
    const validMetrics = metrics.filter(m => m.sql.trim());
    if (!validMetrics.length) { setError('At least one metric SQL is required.'); return; }

    setRunning(true);
    const out = [];
    for (const m of validMetrics) {
      const r = await api.post('/analysis/run', {
        assignment_sql: assignSql,
        metric_sql:     m.sql,
        metric_name:    m.name,
      });
      if (r.error) { setError(`${m.name}: ${r.error}`); setRunning(false); return; }
      // Compute pairwise analyses (first variant = control)
      const ctrl = r.variants[0];
      const analyses = ctrl
        ? r.variants.slice(1).map(trt => {
            const analysis = runAnalysis(
              { assigned: ctrl.assigned, mean: ctrl.mean, variance: ctrl.variance },
              { assigned: trt.assigned,  mean: trt.mean,  variance: trt.variance },
              method, 0.05, nTarget,
            );
            return { trt, analysis };
          })
        : [];
      out.push({ ...r, ctrl, analyses });
    }
    setResults(out);
    setRunning(false);
  }

  function setMetricField(i, field, val) {
    setMetrics(ms => ms.map((m, j) => j === i ? { ...m, [field]: val } : m));
  }
  function addMetric() {
    setMetrics(ms => [...ms, { name: '', sql: '' }]);
  }
  function removeMetric(i) {
    setMetrics(ms => ms.filter((_, j) => j !== i));
  }

  async function previewSql(key, sql) {
    if (!sql?.trim()) return;
    setPreviews(p => ({ ...p, [key]: { loading: true, rows: null, error: null } }));
    const r = await api.post('/analysis/preview', { sql });
    if (r.error) {
      setPreviews(p => ({ ...p, [key]: { loading: false, rows: null, error: r.error } }));
    } else {
      setPreviews(p => ({ ...p, [key]: { loading: false, rows: r.rows, error: null } }));
    }
  }

  const pct    = n => (n * 100).toFixed(2) + '%';
  const fmt    = (n, d=4) => n.toFixed(d);
  const relPct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';

  return (
    <div>
      {/* ── Configs sidebar + header ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-header" style={{ marginBottom: 12 }}>
          <div className="section-label">Warehouse Analysis</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="input" value={activeId ?? ''} onChange={e => {
              const cfg = configs.find(c => String(c.id) === e.target.value);
              if (cfg) loadConfig(cfg); else newConfig();
            }}>
              <option value="">— new config —</option>
              {configs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input className="input" placeholder="Config name" value={configName}
              onChange={e => setConfigName(e.target.value)} style={{ width: 180 }} />
            <button className="btn btn-sm btn-primary" onClick={saveConfig}>
              {activeId ? 'Update' : 'Save'}
            </button>
            {activeId && <button className="btn btn-sm" onClick={deleteConfig}>Delete</button>}
          </div>
        </div>

        {/* ── Assignment SQL ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
              Assignment SQL
              <span style={{ fontWeight: 400, marginLeft: 8, color: '#888' }}>
                must return <code>entity_id</code>, <code>variant</code>, <code>assigned_at</code>
              </span>
            </div>
            <button className="btn btn-sm" onClick={() => previewSql('assignment', assignSql)}
              disabled={previews.assignment?.loading}>
              {previews.assignment?.loading ? 'Running…' : 'Preview'}
            </button>
          </div>
          <textarea
            className="input"
            style={{ width: '100%', height: 120, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
            placeholder={ASSIGN_PLACEHOLDER}
            value={assignSql}
            onChange={e => setAssignSql(e.target.value)}
          />
          <PreviewResult preview={previews.assignment} />
        </div>

        {/* ── Metrics ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
              Metrics
              <span style={{ fontWeight: 400, marginLeft: 8, color: '#888' }}>
                must return <code>entity_id</code>, <code>value</code>, <code>event_at</code>
              </span>
            </div>
            <button className="btn btn-sm" onClick={addMetric}>+ Add metric</button>
          </div>
          {metrics.map((m, i) => (
            <div key={i} style={{ marginBottom: 12, padding: '10px 12px', background: '#f8f9fc', borderRadius: 6, border: '1px solid #e5e5e5' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input className="input" placeholder="Metric name" value={m.name}
                  onChange={e => setMetricField(i, 'name', e.target.value)}
                  style={{ width: 180, fontSize: 12 }} />
                <button className="btn btn-sm" onClick={() => previewSql(`metric-${i}`, m.sql)}
                  disabled={previews[`metric-${i}`]?.loading}>
                  {previews[`metric-${i}`]?.loading ? 'Running…' : 'Preview'}
                </button>
                {metrics.length > 1 && (
                  <button className="btn btn-sm" onClick={() => removeMetric(i)} style={{ marginLeft: 'auto' }}>✕ Remove</button>
                )}
              </div>
              <textarea
                className="input"
                style={{ width: '100%', height: 100, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                placeholder={METRIC_PLACEHOLDER}
                value={m.sql}
                onChange={e => setMetricField(i, 'sql', e.target.value)}
              />
              <PreviewResult preview={previews[`metric-${i}`]} />
            </div>
          ))}
        </div>

        {/* ── Analysis settings + run ── */}
        <div className="form-row" style={{ alignItems: 'flex-end', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Analysis method</div>
            <select className="input" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="fixed_sample">Fixed-sample</option>
              <option value="sequential">Sequential</option>
              <option value="sequential_hybrid">Sequential hybrid</option>
              <option value="bayesian">Bayesian</option>
            </select>
          </div>
          {method === 'sequential_hybrid' && (
            <div>
              <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>Planned N (total)</div>
              <input className="input" type="number" min="100" step="100" value={nTarget}
                onChange={e => setNTarget(Number(e.target.value))} style={{ width: 120 }} />
            </div>
          )}
          <div style={{ alignSelf: 'flex-end' }}>
            <button className="btn btn-primary" onClick={runQuery} disabled={running}>
              {running ? 'Running…' : 'Run Analysis'}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: '#f8d7da', color: '#721c24', borderRadius: 6, fontSize: 13, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error}
          </div>
        )}
      </div>

      {/* ── Results ── */}
      {results.map(res => (
        <div key={res.metric_name} className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 4 }}>
            {res.metric_name}
            <span style={{ fontWeight: 400, fontSize: 13, color: '#666', marginLeft: 10 }}>
              {{ fixed_sample: 'Fixed-sample', sequential: 'Sequential (anytime-valid)', sequential_hybrid: `Sequential hybrid (N=${nTarget.toLocaleString()})`, bayesian: 'Bayesian' }[method]}
            </span>
          </h2>
          <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>
            Relative lift = (treatment − control) / control · α = 0.05
          </div>

          {/* Raw variant table */}
          <table style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>Variant</th>
                <th style={{ textAlign: 'right' }}>Assigned</th>
                <th style={{ textAlign: 'right' }}>Converted</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Mean value</th>
              </tr>
            </thead>
            <tbody>
              {res.variants.map((v, i) => (
                <tr key={v.variant}>
                  <td>
                    <span className="flag-key">{v.variant}</span>
                    {i === 0 && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>control</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>{v.assigned.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{v.converted.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{pct(v.rate)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmt(v.mean)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Per-treatment analysis */}
          {res.analyses.map(({ trt, analysis }) => {
            if (!analysis) return null;
            const isSeq  = analysis.method === 'sequential' || analysis.method === 'sequential_hybrid';
            const displayLift = analysis.method === 'bayesian' ? analysis.postMean : analysis.lift;
            const sig    = analysis.method === 'bayesian'
              ? (analysis.probPositive >= 0.95 || analysis.probPositive <= 0.05)
              : (analysis.lo > 0 || analysis.hi < 0);
            const { bg, tx } = sig ? { bg: '#d4edda', tx: '#155724' } : { bg: '#f8d7da', tx: '#721c24' };
            const ciLabel = { sequential: 'Anytime-valid 95% CI', sequential_hybrid: 'Anytime-valid 95% CI (hybrid)', bayesian: '95% credible interval' }[analysis.method] ?? '95% CI';
            const statField = analysis.method === 'bayesian'
              ? ['P(treatment > control)', pct(analysis.probPositive)]
              : ['p-value', analysis.pValue != null ? fmt(analysis.pValue, 4) : (sig ? '< α' : '> α')];
            const verdictMsg = analysis.method === 'bayesian'
              ? (analysis.probPositive >= 0.95 ? `Treatment better with ${pct(analysis.probPositive)} probability`
                : analysis.probPositive <= 0.05 ? `Control better — P(T > C) = ${pct(analysis.probPositive)}`
                : `Inconclusive — P(T > C) = ${pct(analysis.probPositive)}`)
              : isSeq
                ? (sig ? `Anytime-valid result: ${relPct(analysis.lift)} relative lift` : 'No conclusion yet — CI contains 0')
                : (analysis.pValue < 0.05 ? `Statistically significant (p = ${fmt(analysis.pValue)})`
                  : analysis.pValue < 0.1  ? `Marginal (p = ${fmt(analysis.pValue)})`
                  : `Not significant (p = ${fmt(analysis.pValue)})`);

            return (
              <div key={trt.variant} style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
                  <span className="flag-key">{trt.variant}</span> vs <span className="flag-key">{res.ctrl.variant}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                  {[
                    ['Relative lift', relPct(displayLift)],
                    [ciLabel, `[${relPct(analysis.lo)}, ${relPct(analysis.hi)}]`],
                    statField,
                  ].map(([label, val]) => (
                    <div key={label} style={{ background: '#f8f9fc', border: '1px solid #e5e5e5', borderRadius: 6, padding: '8px 14px', minWidth: 120 }}>
                      <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>{label}</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13 }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'inline-block', padding: '5px 12px', borderRadius: 6, fontWeight: 700, fontSize: 12, background: bg, color: tx }}>
                  {verdictMsg}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

function App() {
  const [view,       setView]       = useState('flags');
  const [selectedId, setSelectedId] = useState(null);

  function goToFlag(id) { setSelectedId(id); setView('flag-detail'); }
  function goToFlags()  { setSelectedId(null); setView('flags'); }

  return (
    <div>
      <header>
        <h1>Experiment Platform</h1>
        <nav>
          <button className={view === 'flags' || view === 'flag-detail' ? 'active' : ''} onClick={goToFlags}>Flags</button>
          <button className={view === 'evaluate' ? 'active' : ''} onClick={() => setView('evaluate')}>Evaluate</button>
          <button className={view === 'assignments' ? 'active' : ''} onClick={() => setView('assignments')}>Assignments</button>
          <button className={view === 'simulate'  ? 'active' : ''} onClick={() => setView('simulate')}>Simulate</button>
          <button className={view === 'warehouse' ? 'active' : ''} onClick={() => setView('warehouse')}>Warehouse</button>
        </nav>
      </header>
      <main>
        {view === 'flags'       && <FlagList onSelectFlag={goToFlag} />}
        {view === 'flag-detail' && <FlagDetail flagId={selectedId} onBack={goToFlags} />}
        {view === 'evaluate'    && <EvaluateView />}
        {view === 'assignments' && <AssignmentsView />}
        {view === 'simulate'    && <SimulateView />}
        {view === 'warehouse'   && <WarehouseView />}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ApiKeyGate><App /></ApiKeyGate>
);
