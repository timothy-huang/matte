// One-shot partner checks: Tavily, model server (tool calling), Daytona.
import { fetchGuidance, readCache } from './guidance.js';
import { proposeRule } from './model.js';
import { runAbstractTests } from './core.js';
import { evaluate } from './runner.js';
const which = process.argv[2] || 'all';
const step = async (name, fn) => { const t = Date.now(); try { const out = await fn(); console.log(`OK   ${name} (${Date.now() - t}ms)\n     ${out}`); } catch (e) { console.log(`FAIL ${name}: ${e.message}`); } };
if (['all', 'tavily'].includes(which)) await step('tavily', async () => (await fetchGuidance()).excerpt.slice(0, 160) + '…');
if (['all', 'model'].includes(which)) await step(`model (${process.env.MODEL_PATH || 'direct'})`, async () => {
  const g = readCache();
  const out = await proposeRule(g, (m) => console.log('     · ' + m));
  return `${out.mode} · ${out.requests.length} request(s) · tests ${out.rule ? (runAbstractTests(out.rule).passed ? 'PASS' : 'FAIL') : 'no rule'} · ${JSON.stringify(out.rule)}`;
});
if (['all', 'daytona'].includes(which)) await step(`runner (${process.env.EVAL_RUNNER || 'local'})`, async () => JSON.stringify((await evaluate({ payments: [{ id: 'X', vendor_id: 'V', proposed_destination: 'A' }], vendors: [{ id: 'V', verified_destination: 'A' }], rule: null })).results));
process.exit(0);
