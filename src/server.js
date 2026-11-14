import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchGuidance, readCache, writeCache } from './guidance.js';
import { proposeRule, modelPath } from './model.js';
import { core, runAbstractTests, FALLBACK_RULE } from './core.js';
import { evaluate, warmRunner, runnerName } from './runner.js';

const ROOT = new URL('..', import.meta.url).pathname;
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', f), 'utf8'));
const VENDORS = load('vendors.json');
const PAYMENTS = load('payments.json');
const CONTACTS = load('contacts.json');
const VENDORS_SNAPSHOT = JSON.stringify(VENDORS);

const now = () => new Date().toISOString();
const MODEL_HOST = /nos\.ci/.test(process.env.MODEL_BASE_URL || '') ? 'Nosana' : 'model server';
const MODEL_LABEL = `${MODEL_HOST} · ${process.env.MODEL_NAME || 'model'}`;
const ruleId = (rule) => 'rule-' + crypto.createHash('sha256').update(JSON.stringify(rule.all)).digest('hex').slice(0, 8);

// ---------- setup (once per server, retryable) ----------
const setup = {
  status: 'pending', // pending | ready | failed
  guidance: null,
  rule: null,
  tests: null,
  rationale: '',
  partners: { tavily: 'not run', model: 'not run', runner: 'not run' },
  model_mode: null,
  model_requests: [],
  model_note: '',
  model_status: null,
  trace: [],
  baseline: null, // initial results for all payments (no callbacks)
  error: null,
};
const strace = (stage, text) => { setup.trace.push({ t: now(), stage, text }); console.log(`[setup:${stage}] ${text}`); };

async function runSetup() {
  Object.assign(setup, { status: 'pending', trace: [], error: null, rule: null, tests: null, model_requests: [], model_note: '', model_status: null, baseline: null });
  // 1. Guidance via Tavily
  let guidance = null;
  let cachedRule = null;
  try {
    guidance = await fetchGuidance();
    setup.partners.tavily = 'live';
    strace('source', `Tavily live · ${guidance.title} · ${guidance.url}`);
  } catch (e) {
    const cache = readCache();
    strace('source', `Tavily failed: ${e.message}`);
    if (cache?.validated_rule) {
      guidance = cache;
      cachedRule = cache.validated_rule;
      setup.partners.tavily = 'cached';
      strace('source', `Using cached excerpt and previously validated rule ${cachedRule.id} (retrieved ${cache.retrieved_at} via ${cache.retrieved_via})`);
    } else {
      setup.partners.tavily = 'failed';
      setup.status = 'failed';
      setup.error = 'Guidance unavailable and no validated rule cached — changed payments stay held.';
      strace('source', setup.error);
    }
  }
  setup.guidance = guidance;

  // 2. Rule: model proposes (unless reusing cache), app validates + tests before activating
  let candidate = cachedRule;
  if (!candidate && guidance) {
    try {
      const out = await proposeRule(guidance, (m) => strace('model', m));
      setup.model_mode = out.mode;
      setup.model_requests = out.requests;
      setup.rationale = out.rationale;
      setup.partners.model = modelPath() === 'codeaf' ? `CodeAF → ${MODEL_LABEL}` : MODEL_LABEL;
      candidate = out.rule ? { all: out.rule.all } : null;
      strace('model', `proposal via ${out.mode}: ${candidate ? JSON.stringify(candidate.all.map((p) => p.left + '==' + (p.field || JSON.stringify(p.value)))) : 'none'}`);
    } catch (e) {
      setup.model_requests = e.requests || [];
      const attempted = setup.model_requests.length > 0;
      strace('model', `model path unavailable (${e.message}) — using prewritten source-linked rule` + (attempted ? ' (model request was sent but failed; no model output used)' : ' (no model call was made)'));
      const why = /\b503\b|not ready/.test(e.message) ? 'not up yet' : /HTTP \d+/.test(e.message) ? e.message.match(/HTTP \d+/)[0] : 'unreachable';
      setup.model_status = { host: MODEL_HOST, model: process.env.MODEL_NAME || '', state: 'offline', reason: e.message, why };
      setup.partners.model = modelPath() === 'off' ? 'prewritten rule (model disabled)' : `${MODEL_HOST} ${why} → prewritten rule`;
      setup.model_note = attempted
        ? `The request below was sent to ${MODEL_LABEL} but the server was ${why} (${e.message}). No model output was used; the prewritten, source-linked rule was applied and tested instead.`
        : 'No model call was made; the prewritten rule was applied.';
    }
    if (candidate) {
      const t = runAbstractTests(candidate);
      if (!t.passed) {
        strace('test', `model rule rejected: ${t.validation_errors.join('; ') || t.cases.filter((c) => !c.pass).map((c) => c.name).join(', ')}`);
        setup.model_note = (setup.model_note ? setup.model_note + ' ' : '') + 'Model rule failed validation; prewritten rule used.';
        setup.partners.model += ' → rejected, prewritten rule used';
        candidate = null;
      }
    }
    if (!candidate) candidate = { all: FALLBACK_RULE.all };
  }
  if (candidate) {
    const rule = { id: cachedRule?.id || ruleId(candidate), all: candidate.all };
    const tests = runAbstractTests(rule);
    setup.tests = tests;
    if (tests.passed) {
      setup.rule = rule;
      strace('test', `rule ${rule.id} passed ${tests.cases.length}/${tests.cases.length} abstract tests · fields: ${[...new Set(rule.all.flatMap((p) => [p.left, p.field].filter(Boolean)))].join(', ')}`);
      if (setup.partners.tavily === 'live') writeCache({ ...guidance, validated_rule: rule });
    } else {
      setup.status = 'failed';
      setup.error = 'Rule failed tests — changed payments stay held.';
      strace('test', setup.error);
    }
  }

  // 3. Baseline evaluation on the record side
  try {
    strace('runner', `evaluating batch on ${runnerName()}${runnerName() === 'daytona' ? ' (creating sandbox…)' : ''}`);
    await warmRunner();
    const r = await evaluate({ payments: PAYMENTS, vendors: VENDORS, rule: setup.rule, callbacks: {} });
    setup.baseline = r.results;
    setup.partners.runner = r.runner;
    strace('runner', `${r.runner} · rule ${setup.rule?.id || 'none'} · ${r.results.length} payments evaluated in ${r.ms}ms`);
  } catch (e) {
    setup.partners.runner = `${e.runner || runnerName()} failed`;
    strace('runner', `evaluation failed: ${e.message} — all payments held`);
    setup.baseline = PAYMENTS.map((p) => ({ payment_id: p.id, status: 'Needs verification', reason: 'Check unavailable' }));
  }
  if (setup.status !== 'failed') setup.status = setup.rule ? 'ready' : 'failed';
}

// ---------- per-run demo state ----------
let run = null;
function newRun() {
  run = { id: crypto.randomUUID().slice(0, 8), event: null, inflight: null, failNext: false, replay: 'idle', overrides: {}, trace: [] };
}
newRun();
const rtrace = (stage, text) => { run.trace.push({ t: now(), stage, text }); console.log(`[run ${run.id}:${stage}] ${text}`); };

function ensureEvent() {
  if (run.event) return run.event;
  const p = PAYMENTS.find((x) => x.id === 'P3');
  const v = VENDORS.find((x) => x.id === p.vendor_id);
  run.event = {
    event_id: `EVT-${run.id}`, payment_id: p.id, vendor_id: v.id,
    confirmed_destination: p.proposed_destination, contact_ref: v.trusted_contact_ref,
    method: 'callback', outcome: 'confirmed', created_at: now(),
  };
  rtrace('callback', `created event ${run.event.event_id} · number on file (${CONTACTS[v.trusted_contact_ref].phone_masked}) · supplier confirmed account ending ${p.proposed_destination.slice(-4)}`);
  return run.event;
}

async function replay(runId, fail) {
  if (runId !== run.id) return { stale: true };
  if (setup.status !== 'ready' || !setup.rule) return { error: 'Verification rule unavailable' };
  if (fail) run.failNext = true;
  if (run.inflight) return run.inflight; // duplicate clicks share one run
  const myRun = run;
  const event = ensureEvent(); // same event reused on retry
  myRun.replay = 'checking';
  myRun.inflight = (async () => {
    try {
      const doFail = myRun.failNext;
      myRun.failNext = false;
      const r = await evaluate({ payments: PAYMENTS, vendors: VENDORS, rule: setup.rule, callbacks: { P3: [event] }, only: ['P3'] }, { fail: doFail });
      if (run !== myRun) return { stale: true }; // reset happened: discard late result
      myRun.overrides.P3 = r.results[0];
      myRun.replay = 'done';
      rtrace('runner', `${r.runner} · rule ${setup.rule.id} · P3 → ${r.results[0].status} · ${r.results[0].reason} (${r.ms}ms)`);
      rtrace('scope', `vendor record unchanged: ${JSON.stringify(VENDORS) === VENDORS_SNAPSHOT}`);
      return { ok: true };
    } catch (e) {
      if (run !== myRun) return { stale: true };
      myRun.replay = 'failed';
      rtrace('runner', `${e.runner || runnerName()} · execution failed (${e.message}) · P3 stays held · retry reuses ${event.event_id}`);
      return { failed: true };
    } finally {
      myRun.inflight = null;
    }
  })();
  return myRun.inflight;
}

// ---------- view model (masked) ----------
function view() {
  const mask = (d) => (d ? '••••' + d.slice(-4) : '—');
  const bank = (d) => (d ? d.split('-')[1] : '');
  const results = Object.fromEntries((setup.baseline || []).map((r) => [r.payment_id, r]));
  Object.assign(results, run.overrides);
  return {
    run_id: run.id,
    replay: run.replay,
    event: run.event && { event_id: run.event.event_id, method: run.event.method, outcome: run.event.outcome, contact: CONTACTS[run.event.contact_ref], confirmed_ending: run.event.confirmed_destination.slice(-4) },
    payments: PAYMENTS.map((p) => {
      const v = VENDORS.find((x) => x.id === p.vendor_id);
      return {
        id: p.id, supplier: v.name, supplier_ja: v.name_ja, amount_jpy: p.amount_jpy, invoice_no: p.invoice_no, thread_reply: p.thread_reply,
        on_file: { bank: bank(v.verified_destination), ending: mask(v.verified_destination) },
        invoice: { bank: bank(p.proposed_destination), ending: mask(p.proposed_destination) },
        changed: p.proposed_destination !== v.verified_destination,
        trusted_contact: v.trusted_contact_ref ? CONTACTS[v.trusted_contact_ref] : null,
        result: results[p.id] || { status: 'Needs verification', reason: 'Checking…' },
      };
    }),
    setup: {
      status: setup.status, error: setup.error, guidance: setup.guidance && { title: setup.guidance.title, url: setup.guidance.url, excerpt: setup.guidance.excerpt, retrieved_via: setup.guidance.retrieved_via, retrieved_at: setup.guidance.retrieved_at },
      rule: setup.rule, tests: setup.tests, rationale: setup.rationale, partners: setup.partners,
      model_mode: setup.model_mode, model_note: setup.model_note, model_status: setup.model_status, model_requests: setup.model_requests,
    },
    trace: [...setup.trace, ...run.trace],
  };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state') return send(res, 200, view());
    if (req.method === 'POST' && url.pathname === '/api/reset') { newRun(); return send(res, 200, view()); }
    if (req.method === 'POST' && url.pathname === '/api/replay') {
      const b = await body(req);
      const out = await replay(b.run_id, !!b.fail);
      return send(res, out.stale ? 409 : 200, { ...out, state: view() });
    }
    if (req.method === 'POST' && url.pathname === '/api/setup/retry') {
      if (setup.status !== 'pending') { runSetup(); newRun(); }
      return send(res, 200, view());
    }
    const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(process.env.PORT || 5173, () => {
  console.log(`Matte on http://localhost:${process.env.PORT || 5173} · model=${modelPath()} · runner=${runnerName()}`);
  runSetup();
});
