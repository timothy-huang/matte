// Acceptance checks for the decision logic (no partners needed).
import fs from 'node:fs';
import { core, runAbstractTests, FALLBACK_RULE } from './core.js';
import { evaluate } from './runner.js';

const V = JSON.parse(fs.readFileSync(new URL('../fixtures/vendors.json', import.meta.url)));
const P = JSON.parse(fs.readFileSync(new URL('../fixtures/payments.json', import.meta.url)));
const rule = { id: 'rule-test', all: FALLBACK_RULE.all };
let fail = 0;
const check = (name, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${got} want=${want}`}`); };
const label = (r) => `${r.status} · ${r.reason}`;

const t = runAbstractTests(rule);
check(`abstract tests (${t.cases.length})`, t.passed, true);
check('validator rejects rule without contact predicate', core.validateRule({ id: 'x', all: rule.all.filter((p) => p.left !== 'callback.contact_ref') }).ok, false);
check('validator rejects inequality/other ops', core.validateRule({ id: 'x', all: [...rule.all, { left: 'callback.method', op: 'ne', value: 'x' }] }).ok, false);
check('validator rejects unknown field', core.validateRule({ id: 'x', all: [...rule.all, { left: 'invoice.iban', field: 'payment.id' }] }).ok, false);

const aoba = V.find((v) => v.id === 'V-AOBA');
const p3 = P.find((p) => p.id === 'P3');
const exact = { event_id: 'E1', payment_id: 'P3', vendor_id: 'V-AOBA', confirmed_destination: p3.proposed_destination, contact_ref: aoba.trusted_contact_ref, method: 'callback', outcome: 'confirmed' };

const before = JSON.stringify(V);
const base = (await evaluate({ payments: P, vendors: V, rule, callbacks: {} })).results;
check('P1 baseline', label(base[0]), 'Ready for approval · Destination unchanged');
check('P2 baseline', label(base[1]), 'Needs verification · Trusted callback required');
check('P3 email only', label(base[2]), 'Needs verification · Trusted callback required');
const noRule = (await evaluate({ payments: P, vendors: V, rule: null, callbacks: {} })).results;
check('P3 no rule', label(noRule[2]), 'Needs verification · Verification rule unavailable');
const wrong = (await evaluate({ payments: P, vendors: V, rule, callbacks: { P3: [{ ...exact, confirmed_destination: 'JP-RKTN-711-A-8088' }] }, only: ['P3'] })).results[0];
check('P3 wrong-account callback', label(wrong), 'Needs verification · Callback does not match');
const ok = (await evaluate({ payments: P, vendors: V, rule, callbacks: { P3: [exact] }, only: ['P3'] })).results[0];
check('P3 exact callback', label(ok), 'Ready for approval · Trusted callback confirmed');
check('same rule id', ok.rule_id, 'rule-test');
check('vendor record untouched', JSON.stringify(V), before);
// Investigation boundary: signals carry no account numbers, phone numbers, amounts or vendor names.
const { buildSignals, validateFindings, ruleBasedFindings } = await import('./investigate.js');
const C = JSON.parse(fs.readFileSync(new URL('../fixtures/contacts.json', import.meta.url)));
const E = JSON.parse(fs.readFileSync(new URL('../fixtures/emails.json', import.meta.url)));
const cases = buildSignals(P, V, C, E);
const sent = JSON.stringify(cases.map((c) => c.signals));
const secrets = [...V.flatMap((v) => [v.verified_destination, v.name, v.name_ja]), ...P.flatMap((p) => [p.proposed_destination, String(p.amount_jpy), p.invoice_no]), ...Object.values(C).map((c) => c.phone), '7731', '9099', '2002'];
check('investigation signals leak no record values', secrets.filter((x) => x && sent.includes(x)).join(','), '');
check('investigation covers only changed payments', cases.map((c) => c.payment_id).join(','), 'P2,P3');
const v2 = validateFindings({ cases: [{ case: cases[1].signals.case, clear: true, status: 'Ready for approval', flags: [{ code: 'LOOKS_SAFE', severity: 'info' }, { code: 'URGENCY', severity: 'warn', ja: 'x', en: 'y' }] }] }, cases);
check('validator keeps only allowlisted flags', JSON.stringify(v2.P3.flags.map((f) => f.code)), '["URGENCY"]');
check('validator drops clear/status fields', 'clear' in v2.P3 || 'status' in v2.P3, false);
check('rule-based notes flag phone not on file', ruleBasedFindings(cases).P3.flags.some((f) => f.code === 'PHONE_NOT_ON_FILE'), true);
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
