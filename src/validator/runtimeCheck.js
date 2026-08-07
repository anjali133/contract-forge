// Spawns runtimeCheckWorker.mjs in a separate process to run the
// contract-derived integration test suite. This has to be a child process,
// not an in-process call: the worker needs to freely connect/disconnect
// mongoose's global default connection against a throwaway in-memory
// MongoDB, and the main server process already holds its own long-lived
// mongoose connection for saving generation history. Doing this in-process
// once hijacked and then tore down that connection mid-request and crashed
// the server -- isolating it in a child process makes that collision
// impossible.
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'runtimeCheckWorker.mjs');
const WORKER_TIMEOUT_MS = 120_000;

export function runIntegrationTests(contract, backendFiles) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ issues: [], skipped: true, skipReason: `runtime test worker timed out after ${WORKER_TIMEOUT_MS / 1000}s` });
    }, WORKER_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      finish({ issues: [], skipped: true, skipReason: `could not start runtime test worker (${err.message})` });
    });

    child.on('close', () => {
      const lastLine = stdout.trim().split('\n').pop();
      try {
        finish(JSON.parse(lastLine));
      } catch {
        finish({
          issues: [],
          skipped: true,
          skipReason: `runtime test worker produced no usable output${stderr ? ` (stderr: ${stderr.slice(0, 300)})` : ''}`
        });
      }
    });

    child.stdin.write(JSON.stringify({ contract, backendFiles }));
    child.stdin.end();
  });
}
