// Loads evaluator-core.js both as source text (for remote/process execution)
// and as live functions (for rule validation and abstract tests in the app).
import fs from 'node:fs';
import vm from 'node:vm';

export const CORE_SOURCE = fs.readFileSync(new URL('./evaluator-core.js', import.meta.url), 'utf8');
export const core = vm.runInNewContext(CORE_SOURCE + '\n;({ FIELDS, CONSTANTS, REQUIRED, validateRule, ruleMatches, decide, runBatch })');

// Abstract test cases: placeholder tokens only, no fixture values.
const P = { id: 'PAY_A', vendor_id: 'VEN_A', proposed_destination: 'ACCT_NEW', thread_reply: true };
const V = { id: 'VEN_A', verified_destination: 'ACCT_ON_FILE', trusted_contact_ref: 'CONTACT_ON_FILE' };
const CB = { event_id: 'EVT_1', payment_id: 'PAY_A', vendor_id: 'VEN_A', confirmed_destination: 'ACCT_NEW', contact_ref: 'CONTACT_ON_FILE', method: 'callback', outcome: 'confirmed' };

export const ABSTRACT_TESTS = [
  { name: 'unchanged destination', payment: { ...P, proposed_destination: 'ACCT_ON_FILE' }, vendor: V, callbacks: [], expect: 'Ready for approval · Destination unchanged' },
  { name: 'email reply only, no callback', payment: P, vendor: V, callbacks: [], expect: 'Needs verification · Trusted callback required' },
  { name: 'exact trusted callback', payment: P, vendor: V, callbacks: [CB], expect: 'Ready for approval · Trusted callback confirmed' },
  { name: 'callback for wrong payment', payment: P, vendor: V, callbacks: [{ ...CB, payment_id: 'PAY_B' }], expect: 'Needs verification · Callback does not match' },
  { name: 'callback for wrong vendor', payment: P, vendor: V, callbacks: [{ ...CB, vendor_id: 'VEN_B' }], expect: 'Needs verification · Callback does not match' },
  { name: 'callback confirms wrong account', payment: P, vendor: V, callbacks: [{ ...CB, confirmed_destination: 'ACCT_OTHER' }], expect: 'Needs verification · Callback does not match' },
  { name: 'callback to contact from the email', payment: P, vendor: V, callbacks: [{ ...CB, contact_ref: 'CONTACT_FROM_EMAIL' }], expect: 'Needs verification · Callback does not match' },
  { name: 'vendor has no trusted contact on file', payment: P, vendor: { ...V, trusted_contact_ref: undefined }, callbacks: [CB], expect: 'Needs verification · Callback does not match' },
  { name: 'callback missing contact reference', payment: P, vendor: V, callbacks: [{ ...CB, contact_ref: undefined }], expect: 'Needs verification · Callback does not match' },
  { name: 'confirmation by email, not callback', payment: P, vendor: V, callbacks: [{ ...CB, method: 'email' }], expect: 'Needs verification · Callback does not match' },
  { name: 'callback not confirmed', payment: P, vendor: V, callbacks: [{ ...CB, outcome: 'declined' }], expect: 'Needs verification · Callback does not match' },
];

// Returns abstract results only (case names + expected/actual labels).
export function runAbstractTests(rule) {
  const v = core.validateRule(rule);
  if (!v.ok) return { passed: false, validation_errors: v.errors, cases: [] };
  const cases = ABSTRACT_TESTS.map((t) => {
    const r = core.decide(t.payment, t.vendor, t.callbacks, rule);
    const got = `${r.status} · ${r.reason}`;
    return { name: t.name, expected: t.expect, got, pass: got === t.expect };
  });
  return { passed: cases.every((c) => c.pass), validation_errors: [], cases };
}

export const FALLBACK_RULE = {
  id: 'rule-callback-v1-prewritten',
  all: [
    { left: 'callback.payment_id', field: 'payment.id' },
    { left: 'callback.vendor_id', field: 'payment.vendor_id' },
    { left: 'callback.confirmed_destination', field: 'payment.proposed_destination' },
    { left: 'callback.contact_ref', field: 'vendor.trusted_contact_ref' },
    { left: 'callback.method', value: 'callback' },
    { left: 'callback.outcome', value: 'confirmed' },
  ],
};
