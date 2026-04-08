const { useState, useEffect, useMemo } = React;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const api = {
  get:  (path)       => fetch(`/api${path}`).then(r => r.json()),
  post: (path, body) => fetch(`/api${path}`, { method: 'POST',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  put:  (path, body) => fetch(`/api${path}`, { method: 'PUT',    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  del:  (path)       => fetch(`/api${path}`, { method: 'DELETE' }).then(r => r.json()),
};

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

      {/* SRM widget — shown when experiment has run */}
      {(flag.status === 'running' || flag.status === 'stopped') && (
        <SrmWidget flagKey={flag.key} startedAt={flag.started_at} />
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
  const [varCfg,     setVarCfg]     = useState({});   // { variantKey: { rate: string } }
  const [results,    setResults]    = useState(null);
  const [seed,       setSeed]       = useState(() => Math.floor(Math.random() * 1e9));

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

  function runSimulation() {
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
      const p1true = parseFloat(varCfg[controlKey]?.rate ?? 0.1);
      const p2true = parseFloat(varCfg[v.key]?.rate    ?? 0.1);
      // Extract fractional weights from the allocation splits for this pair
      const sp1 = splits.find(s => s.variant_key === controlKey);
      const sp2 = splits.find(s => s.variant_key === v.key);
      const w1  = (sp1?.weight ?? 50) / 100;
      const w2  = (sp2?.weight ?? 50) / 100;
      const t   = zTestProportions(n1, x1, n2, x2);
      const pow = computePower(n1, n2, p1true, p2true);
      const req = requiredNTotal(p1true, p2true, w1, w2);
      const bay = bayesianTest(n1, x1, n2, x2);
      tests.push({ variantKey: v.key, ...t, power: pow, requiredNTotal: req, w1, w2, bay });
    }

    setResults({ counts, conversions, tests, controlKey });
  }

  // Verdict combines significance AND power.
  // Significant + underpowered = "winner's curse" risk — show amber, not green.
  function verdictStyle(pValue, power) {
    if (pValue < 0.05 && power >= 0.6) return { bg: '#d4edda', tx: '#155724' }; // green — significant & adequately powered
    if (pValue < 0.05 && power <  0.6) return { bg: '#fff3cd', tx: '#856404' }; // amber — significant but underpowered
    if (pValue < 0.1)                  return { bg: '#fff3cd', tx: '#856404' }; // amber — marginal
    return                                    { bg: '#f8d7da', tx: '#721c24' }; // red   — not significant
  }
  function pct(n)    { return (n * 100).toFixed(2) + '%'; }
  function fmt(n, d=3) { return n.toFixed(d); }
  function pp(n)     { return (n >= 0 ? '+' : '') + (n*100).toFixed(2) + 'pp'; }

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

            <div style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={runSimulation}>Run Simulation</button>
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
            <h2 style={{ marginBottom: 2 }}>Frequentist — Two-proportion z-test</h2>
            <div className="muted" style={{ marginBottom: 16, fontSize: 12 }}>
              Two-sided, α = 0.05. Each treatment arm vs. control. Answers: "is the observed difference unlikely under the null hypothesis?"
            </div>
            {results.tests.length === 0
              ? <div className="muted">No treatment arms to test.</div>
              : results.tests.map(t => (
                <div key={t.variantKey} style={{ marginBottom: 20 }}>
                  <div style={{ fontWeight: 600, marginBottom: 10 }}>
                    <span className="flag-key">{t.variantKey}</span> vs <span className="flag-key">{results.controlKey}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                    {[
                      ['z-statistic',     fmt(t.z)],
                      ['p-value',         fmt(t.pValue, 4)],
                      ['Observed diff',   pp(t.diff)],
                      ['95% CI',          `[${pp(t.ci95lo)}, ${pp(t.ci95hi)}]`],
                      ['Power (this N)',   pct(t.power)],
                      ['N for 80% power', t.requiredNTotal.toLocaleString() + ` total (${Math.round(t.w1*100)}/${Math.round(t.w2*100)} split)`],
                    ].map(([label, val]) => (
                      <div key={label} style={{ background: '#f8f9fc', border: '1px solid #e5e5e5', borderRadius: 6, padding: '10px 16px', minWidth: 130 }}>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
                        <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {(() => {
                    const { bg, tx } = verdictStyle(t.pValue, t.power);
                    const sigText = t.pValue < 0.05
                      ? t.power < 0.6
                        ? `Significant but underpowered (p = ${fmt(t.pValue,4)}) — effect size likely inflated`
                        : `Statistically significant (p = ${fmt(t.pValue,4)})`
                      : t.pValue < 0.1
                        ? `Marginal (p = ${fmt(t.pValue,4)}) — not significant at α = 0.05`
                        : `Not significant (p = ${fmt(t.pValue,4)})`;
                    return (
                      <div style={{ display: 'inline-block', padding: '6px 14px', borderRadius: 6, fontWeight: 700, fontSize: 13, background: bg, color: tx }}>
                        {sigText}
                      </div>
                    );
                  })()}
                  {t.power < 0.6 && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#856404', background: '#fff3cd', padding: '6px 12px', borderRadius: 5, display: 'block', maxWidth: 560, lineHeight: 1.5 }}>
                      ⚠ Only {pct(t.power)} power — this experiment is underpowered. {t.pValue < 0.05 ? 'The significant result is likely a winner\'s curse: sampling noise inflated the observed effect. ' : ''}Need {t.requiredNTotal.toLocaleString()} total users for 80% power at this {Math.round(t.w1*100)}/{Math.round(t.w2*100)} split.
                    </div>
                  )}
                  {t.power >= 0.6 && t.power < 0.8 && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#856404', background: '#fff3cd', padding: '6px 12px', borderRadius: 5, display: 'inline-block' }}>
                      ⚠ {pct(t.power)} power — below 80% target. Need {t.requiredNTotal.toLocaleString()} total users at this {Math.round(t.w1*100)}/{Math.round(t.w2*100)} split.
                    </div>
                  )}
                </div>
              ))
            }
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 2 }}>Bayesian — Beta-Binomial</h2>
            <div className="muted" style={{ marginBottom: 16, fontSize: 12 }}>
              Uninformative Beta(1,1) prior. Answers: "given the data, what is the probability treatment is better than control?"
            </div>
            {results.tests.length === 0
              ? <div className="muted">No treatment arms to test.</div>
              : results.tests.map(t => {
                const b = t.bay;
                const probPct = pct(b.probBgtA);
                const isWinner = b.probBgtA >= 0.95;
                const isLoser  = b.probBgtA <= 0.05;
                const bgColor  = isWinner ? '#d4edda' : isLoser ? '#f8d7da' : '#fff3cd';
                const txColor  = isWinner ? '#155724' : isLoser ? '#721c24' : '#856404';
                const verdict  = isWinner
                  ? `Treatment is better with ${probPct} probability`
                  : isLoser
                    ? `Control is better (treatment win prob = ${probPct})`
                    : `Inconclusive — treatment win probability ${probPct}`;
                return (
                  <div key={t.variantKey} style={{ marginBottom: 20 }}>
                    <div style={{ fontWeight: 600, marginBottom: 10 }}>
                      <span className="flag-key">{t.variantKey}</span> vs <span className="flag-key">{results.controlKey}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                      {[
                        ['P(treatment > control)', probPct],
                        ['Posterior rate — control',   pct(b.posteriorMeanA)],
                        ['Posterior rate — treatment', pct(b.posteriorMeanB)],
                        ['Expected lift',   (b.relLift >= 0 ? '+' : '') + (b.relLift * 100).toFixed(2) + '%'],
                        ['95% credible interval', `[${pp(b.credLo)}, ${pp(b.credHi)}]`],
                      ].map(([label, val]) => (
                        <div key={label} style={{ background: '#f8f9fc', border: '1px solid #e5e5e5', borderRadius: 6, padding: '10px 16px', minWidth: 130 }}>
                          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
                          <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{val}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'inline-block', padding: '6px 14px', borderRadius: 6, fontWeight: 700, fontSize: 13, background: bgColor, color: txColor }}>
                      {verdict}
                    </div>
                    <div style={{ marginTop: 10, fontSize: 12, color: '#555', maxWidth: 620, lineHeight: 1.5 }}>
                      The posterior is updated from the observed data. Unlike the p-value, this probability can be read directly:
                      there is a {probPct} chance treatment converts better than control, given what we observed.
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
          <button className={view === 'simulate' ? 'active' : ''} onClick={() => setView('simulate')}>Simulate</button>
        </nav>
      </header>
      <main>
        {view === 'flags'       && <FlagList onSelectFlag={goToFlag} />}
        {view === 'flag-detail' && <FlagDetail flagId={selectedId} onBack={goToFlags} />}
        {view === 'evaluate'    && <EvaluateView />}
        {view === 'assignments' && <AssignmentsView />}
        {view === 'simulate'    && <SimulateView />}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
