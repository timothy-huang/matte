// Model-facing side. Allowlist: public guidance, field definitions, abstract
// examples, abstract test tool schemas and results. No fixture access, no record tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { core, runAbstractTests, ABSTRACT_TESTS, CORE_SOURCE } from './core.js';

const FIELD_DOC = `Fields (all values are opaque strings; compare by exact equality):
payment.id, payment.vendor_id, payment.proposed_destination  — the payment being checked
vendor.id, vendor.verified_destination, vendor.trusted_contact_ref — the vendor record on file
callback.payment_id, callback.vendor_id, callback.confirmed_destination, callback.contact_ref, callback.method, callback.outcome — one callback event
Allowed constants: callback.method == "callback", callback.outcome == "confirmed".

Rule format (JSON): {"id": "<short id>", "all": [ {"left": "<field>", "field": "<field>"} | {"left": "<field>", "value": "<allowed constant>"} , ... ]}
Only equality and conjunction ("all") are allowed. The app has already handled missing destinations,
unchanged destinations, and email-only replies; your rule decides whether ONE callback event is
sufficient evidence that the changed destination was confirmed by the vendor.`;

const ABSTRACT_EXAMPLE = `Abstract example (placeholder tokens, not real data):
payment {id: PAY_A, vendor_id: VEN_A, proposed_destination: ACCT_NEW}
vendor  {id: VEN_A, verified_destination: ACCT_ON_FILE, trusted_contact_ref: CONTACT_ON_FILE}
callback {payment_id: PAY_A, vendor_id: VEN_A, confirmed_destination: ACCT_NEW, contact_ref: CONTACT_ON_FILE, method: callback, outcome: confirmed}  → should be sufficient
Same callback with contact_ref: CONTACT_FROM_EMAIL → must NOT be sufficient.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_rule_tests',
      description: 'Validate a candidate rule and run it against the abstract test suite. Returns case names with expected and actual labels.',
      parameters: { type: 'object', properties: { rule: { type: 'object', description: 'Candidate rule JSON' } }, required: ['rule'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_rule',
      description: 'Submit the final rule after run_rule_tests passes.',
      parameters: {
        type: 'object',
        properties: { rule: { type: 'object' }, rationale: { type: 'string', description: 'Which guidance sentence each predicate implements' } },
        required: ['rule', 'rationale'],
      },
    },
  },
];

function messages(guidance) {
  return [
    { role: 'system', content: 'You design payment-verification rules from official guidance. Respond only through the provided tools. Propose a rule, call run_rule_tests, fix it until it passes, then call submit_rule.' },
    {
      role: 'user',
      content: `Official guidance (${guidance.title}, ${guidance.url}):\n"""${guidance.excerpt}"""\n\n${FIELD_DOC}\n\n${ABSTRACT_EXAMPLE}\n\nWrite the rule that implements this guidance for changed bank details.`,
    },
  ];
}

function parseArgs(s) {
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}
function firstJson(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function chat(body, captured) {
  const base = process.env.MODEL_BASE_URL.replace(/\/$/, '');
  captured.push({ label: `POST ${maskHost(base)}/chat/completions`, body }); // exact outbound body; headers (credentials) excluded
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MODEL_API_KEY || 'ollama'}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`model HTTP ${res.status}` + (t.trimStart().startsWith('<') ? ' (endpoint not ready)' : ': ' + t.slice(0, 200))); }
  return res.json();
}

// Native tool-calling loop; falls back to structured JSON output if the model won't call tools.
async function proposeDirect(guidance, log) {
  const captured = [];
  try { return await proposeDirectInner(guidance, log, captured); } catch (e) { e.requests = captured; throw e; }
}
async function proposeDirectInner(guidance, log, captured) {
  const model = process.env.MODEL_NAME;
  const msgs = messages(guidance);
  let lastTested = null;
  for (let turn = 0; turn < 6; turn++) {
    const data = await chat({ model, messages: msgs, tools: TOOLS, temperature: 0 }, captured);
    const msg = data.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      log(`model turn ${turn + 1}: no tool call`);
      break;
    }
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const c of calls) {
      const args = parseArgs(c.function?.arguments) || {};
      if (c.function?.name === 'run_rule_tests') {
        const result = runAbstractTests(args.rule);
        lastTested = { rule: args.rule, result };
        log(`model called run_rule_tests → ${result.passed ? 'pass' : 'fail'}`);
        msgs.push({ role: 'tool', tool_call_id: c.id, name: 'run_rule_tests', content: JSON.stringify(result) });
      } else if (c.function?.name === 'submit_rule') {
        log('model called submit_rule');
        return { rule: args.rule, rationale: args.rationale || '', mode: 'native tool calling', requests: captured };
      }
    }
  }
  if (lastTested?.result.passed) return { rule: lastTested.rule, rationale: '', mode: 'native tool calling (tested, not submitted)', requests: captured };
  // Structured-output fallback: one call, JSON in content; the app runs the tests.
  const sMsgs = messages(guidance);
  sMsgs[0] = { role: 'system', content: 'You design payment-verification rules from official guidance. Reply with only the rule JSON object, nothing else.' };
  const data = await chat({ model, messages: sMsgs, temperature: 0, response_format: { type: 'json_object' } }, captured);
  const rule = firstJson(data.choices?.[0]?.message?.content);
  log('structured-output fallback ' + (rule ? 'returned JSON' : 'returned no JSON'));
  return { rule, rationale: '', mode: 'structured output (app ran tests)', requests: captured };
}

// CodeAF harness path: a fresh directory holding only allowlisted material + an abstract test tool.
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function proposeCodeAF(guidance, log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-codeaf-'));
  const files = {
    'GUIDANCE.md': `# ${guidance.title}\n${guidance.url}\n\n${guidance.excerpt}\n`,
    'FIELDS.md': FIELD_DOC + '\n\n' + ABSTRACT_EXAMPLE + '\n',
    'check_rule.mjs': `// Abstract test tool: node check_rule.mjs rule.json\nimport fs from 'node:fs';\n${CORE_SOURCE}\nconst TESTS = ${JSON.stringify(ABSTRACT_TESTS)};\nconst rule = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nconst v = validateRule(rule); if (!v.ok) { console.log(JSON.stringify({ passed: false, validation_errors: v.errors })); process.exit(1); }\nconst cases = TESTS.map(t => { const r = decide(t.payment, t.vendor, t.callbacks, rule); const got = r.status + ' · ' + r.reason; return { name: t.name, expected: t.expect, got, pass: got === t.expect }; });\nconsole.log(JSON.stringify({ passed: cases.every(c => c.pass), cases }, null, 1)); process.exit(cases.every(c => c.pass) ? 0 : 1);\n`,
  };
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  const system = 'Work only inside the current directory. Do not read files outside it.';
  const prompt = 'Read GUIDANCE.md and FIELDS.md. Write rule.json implementing the guidance. Run `node check_rule.mjs rule.json` and fix rule.json until it passes. Finish when it passes.';
  const args = ['exec', prompt, '--dir', dir, '--system', system, '--json', '--timeout', '6m', '--max-turns', '12'];
  if (process.env.CODEAF_MODEL) args.push('--model', process.env.CODEAF_MODEL);
  log(`codeaf exec in ${dir}`);
  const r = await run('codeaf', args, { cwd: dir, env: process.env });
  let rule = null;
  try { rule = JSON.parse(fs.readFileSync(path.join(dir, 'rule.json'), 'utf8')); } catch {}
  const logs = await run('codeaf', ['logs', '--json', '--tail', '12'], { cwd: dir, env: process.env });
  const requests = [
    { label: 'codeaf exec (system + prompt)', body: { system, prompt, model: process.env.CODEAF_MODEL || '(codeaf default)' } },
    ...Object.entries(files).map(([f, c]) => ({ label: `file visible to CodeAF: ${f}`, body: c })),
    { label: 'codeaf logs --json (calls as recorded by CodeAF)', body: logs.out.slice(0, 60000) },
  ];
  if (r.code !== 0 && !rule) throw new Error(`codeaf exit ${r.code}: ${(r.err || r.out).slice(0, 300)}`);
  return { rule, rationale: '', mode: 'CodeAF harness', requests };
}
const maskHost = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.hostname.split('.')[0].slice(0, 4)}…${x.hostname.includes('nos.ci') ? '.nos.ci' : ''}${x.pathname.replace(/\/$/, '')}`; } catch { return '<model endpoint>'; } };

export function modelPath() {
  const p = process.env.MODEL_PATH || 'direct';
  if (p === 'direct' && !process.env.MODEL_BASE_URL) return 'off';
  return p;
}

export async function proposeRule(guidance, log) {
  const p = modelPath();
  if (p === 'off') throw new Error('model path disabled');
  return p === 'codeaf' ? proposeCodeAF(guidance, log) : proposeDirect(guidance, log);
}

export { core };
