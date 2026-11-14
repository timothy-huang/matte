// Record-side execution: fixed evaluator + validated rule + synthetic records,
// in a separate process (local) or a Daytona sandbox. Results go only to the app.
import { spawn } from 'node:child_process';
import { CORE_SOURCE } from './core.js';

function program(input) {
  return `${CORE_SOURCE}\nconst INPUT = ${JSON.stringify(input)};\nconsole.log('__RESULT__' + JSON.stringify(runBatch(INPUT)));\n`;
}

function parse(out) {
  const line = out.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) throw new Error('evaluator produced no result');
  return JSON.parse(line.slice('__RESULT__'.length));
}

function runLocal(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('local evaluator timed out')); }, 10000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('local evaluator exit ' + code + ': ' + err.slice(0, 300)));
      try { resolve(parse(out)); } catch (e) { reject(e); }
    });
    child.stdin.end(program(input));
  });
}

let sandboxPromise = null;
async function getSandbox() {
  if (!sandboxPromise) {
    sandboxPromise = (async () => {
      const { Daytona } = await import('@daytonaio/sdk');
      const daytona = new Daytona(); // reads DAYTONA_API_KEY / DAYTONA_API_URL
      // Reuse this app's sandbox if one exists, so restarts don't pile up sandboxes.
      let stopped = null;
      for (const app of ['matte', 'wrong-account']) {
        for await (const sb of daytona.list({ labels: { app } })) {
          if (sb.state === 'started') return sb;
          if (!stopped && sb.state === 'stopped') stopped = sb;
        }
      }
      if (stopped) { await stopped.start(60); return stopped; }
      return daytona.create({ language: 'javascript', labels: { app: 'matte' }, autoStopInterval: 120, autoDeleteInterval: 60 });
    })().catch((e) => { sandboxPromise = null; throw e; });
  }
  return sandboxPromise;
}

async function runDaytona(input) {
  const sandbox = await getSandbox();
  let res;
  try {
    res = await sandbox.process.codeRun(program(input), undefined, 30);
  } catch (e) {
    sandboxPromise = null; // stopped/expired sandbox: recreate on retry
    throw e;
  }
  if (res.exitCode !== 0) throw new Error('daytona evaluator exit ' + res.exitCode + ': ' + String(res.result).slice(0, 300));
  return parse(String(res.result));
}

export function runnerName() {
  return process.env.EVAL_RUNNER === 'daytona' && process.env.DAYTONA_API_KEY ? 'daytona' : 'local';
}

export async function warmRunner() {
  if (runnerName() === 'daytona') await getSandbox().catch(() => {}); // evaluate() falls back to local
}

// opts.fail: simulate an execution failure (demo of the retry path)
export async function evaluate(input, opts = {}) {
  const runner = runnerName();
  const t0 = Date.now();
  if (opts.fail) throw Object.assign(new Error('simulated execution failure'), { runner });
  try {
    if (runner === 'daytona') {
      try {
        return { runner, results: await runDaytona(input), ms: Date.now() - t0 };
      } catch (e) {
        // Spec fallback: if Daytona is blocked, run the same evaluator locally and say so.
        console.error('[runner] Daytona unavailable, using local process:', e.message);
        return { runner: 'local (Daytona unavailable)', results: await runLocal(input), ms: Date.now() - t0 };
      }
    }
    return { runner, results: await runLocal(input), ms: Date.now() - t0 };
  } catch (e) {
    e.runner = runner;
    throw e;
  }
}
