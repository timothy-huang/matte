// Self-contained decision core. No imports: this exact source text is executed
// either in a separate local Node process or inside a Daytona sandbox.
// Defines: FIELDS, CONSTANTS, REQUIRED, validateRule, ruleMatches, decide, runBatch.

const FIELDS = [
  'payment.id', 'payment.vendor_id', 'payment.proposed_destination',
  'vendor.id', 'vendor.verified_destination', 'vendor.trusted_contact_ref',
  'callback.payment_id', 'callback.vendor_id', 'callback.confirmed_destination',
  'callback.contact_ref', 'callback.method', 'callback.outcome',
];
const CONSTANTS = { 'callback.method': ['callback'], 'callback.outcome': ['confirmed'] };

// Each required predicate: a set of acceptable spellings (order-insensitive).
const REQUIRED = [
  { name: 'callback is for this payment', any: [['callback.payment_id', 'payment.id']] },
  { name: 'callback is for this vendor', any: [['callback.vendor_id', 'payment.vendor_id'], ['callback.vendor_id', 'vendor.id']] },
  { name: 'callback confirms the exact new destination', any: [['callback.confirmed_destination', 'payment.proposed_destination']] },
  { name: 'callback used the trusted contact on file', any: [['callback.contact_ref', 'vendor.trusted_contact_ref']] },
  { name: 'method is callback', const: ['callback.method', 'callback'] },
  { name: 'outcome is confirmed', const: ['callback.outcome', 'confirmed'] },
];

function predKey(p) {
  if ('field' in p) return [p.left, p.field].sort().join('==');
  return p.left + '==' + JSON.stringify(p.value);
}

// Rule shape: { id, all: [ {left, field} | {left, value} ] }  — equality + conjunction only.
function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return { ok: false, errors: ['rule is not an object'] };
  const keys = Object.keys(rule).filter((k) => k !== 'id' && k !== 'all');
  if (keys.length) errors.push('unexpected keys: ' + keys.join(', '));
  if (!Array.isArray(rule.all) || rule.all.length === 0) errors.push('rule.all must be a non-empty array');
  const seen = new Set();
  for (const p of rule.all || []) {
    const pk = Object.keys(p || {}).sort().join(',');
    if (pk !== 'field,left' && pk !== 'left,value') { errors.push('predicate must be {left, field} or {left, value}: ' + JSON.stringify(p)); continue; }
    if (!FIELDS.includes(p.left)) errors.push('unknown field: ' + p.left);
    if ('field' in p && !FIELDS.includes(p.field)) errors.push('unknown field: ' + p.field);
    if ('value' in p && !(CONSTANTS[p.left] || []).includes(p.value)) errors.push('constant not allowed: ' + p.left + ' == ' + JSON.stringify(p.value));
    if ('field' in p && p.left === p.field) errors.push('self-comparison: ' + p.left);
    seen.add(predKey(p));
  }
  for (const r of REQUIRED) {
    const ok = r.const
      ? seen.has(r.const[0] + '==' + JSON.stringify(r.const[1]))
      : r.any.some((pair) => seen.has(pair.slice().sort().join('==')));
    if (!ok) errors.push('missing required predicate: ' + r.name);
  }
  return { ok: errors.length === 0, errors };
}

function get(ctx, path) {
  const [obj, key] = path.split('.');
  const v = ctx[obj] ? ctx[obj][key] : undefined;
  return v === undefined || v === null || v === '' ? undefined : v;
}

function ruleMatches(rule, ctx) {
  return rule.all.every((p) => {
    const a = get(ctx, p.left);
    const b = 'field' in p ? get(ctx, p.field) : p.value;
    return a !== undefined && b !== undefined && a === b; // missing never matches
  });
}

const R = (payment_id, status, reason, rule_id) => (rule_id ? { payment_id, status, reason, rule_id } : { payment_id, status, reason });
const READY = 'Ready for approval';
const HOLD = 'Needs verification';

// callbacks = callback events attached to this payment's evaluation.
function decide(payment, vendor, callbacks, rule) {
  const id = payment && payment.id;
  if (!vendor || !vendor.verified_destination || !payment || !payment.proposed_destination) return R(id, HOLD, 'Missing destination evidence');
  if (payment.proposed_destination === vendor.verified_destination) return R(id, READY, 'Destination unchanged');
  if (!rule || !validateRule(rule).ok) return R(id, HOLD, 'Verification rule unavailable');
  const cbs = callbacks || [];
  const matches = cbs.filter((c) => ruleMatches(rule, { payment, vendor, callback: c }));
  if (matches.length === 1) return R(id, READY, 'Trusted callback confirmed', rule.id);
  if (cbs.length > 0) return R(id, HOLD, 'Callback does not match', rule.id);
  return R(id, HOLD, 'Trusted callback required', rule.id);
}

// input: { payments, vendors, rule, callbacks: { [payment_id]: [event] }, only?: [payment_id] }
function runBatch(input) {
  const vendors = new Map((input.vendors || []).map((v) => [v.id, v]));
  const list = (input.payments || []).filter((p) => !input.only || input.only.includes(p.id));
  return list.map((p) => decide(p, vendors.get(p.vendor_id), (input.callbacks || {})[p.id] || [], input.rule || null));
}
