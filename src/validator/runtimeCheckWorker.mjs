// Runs in a separate child process, spawned by runtimeCheck.js -- never in
// the main server process. The main server holds its own long-lived
// mongoose connection (for saving generation history); this worker needs to
// connect/disconnect mongoose's global default connection freely to boot
// the generated backend against a throwaway in-memory MongoDB, and doing
// that in-process would hijack and then tear down the server's own
// connection mid-request. Running it here means the two can never collide.
//
// Protocol: reads {contract, backendFiles} as JSON from stdin, writes a
// single JSON result line to stdout: { issues, skipped, skipReason? }.
import path from 'path';
import fs from 'fs/promises';
import mongoose from 'mongoose';
import express from 'express';
import { pathToFileURL } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import supertest from 'supertest';

const SCRATCH_ROOT = path.join(process.cwd(), '.runtime-check');

function sampleValue(field, createdIds) {
  switch (field.type) {
    case 'Number':
      return 42;
    case 'Boolean':
      return true;
    case 'Date':
      return new Date().toISOString();
    case 'ObjectId': {
      const existing = field.ref && createdIds.get(field.ref);
      return existing || new mongoose.Types.ObjectId().toString();
    }
    default:
      return `Sample ${field.name}`;
  }
}

function topoSortModels(models) {
  const byName = new Map(models.map((m) => [m.name, m]));
  const visited = new Set();
  const ordered = [];

  function visit(model, stack) {
    if (!model || visited.has(model.name) || stack.has(model.name)) return;
    stack.add(model.name);
    for (const field of model.fields || []) {
      if (field.type === 'ObjectId' && field.ref) visit(byName.get(field.ref), stack);
    }
    visited.add(model.name);
    ordered.push(model);
  }

  for (const model of models) visit(model, new Set());
  return ordered;
}

function idParam(routePath) {
  return /:\w+$/.test(routePath);
}

async function writeScratchBackend(backendFiles) {
  const dir = path.join(SCRATCH_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [relPath, content] of Object.entries(backendFiles)) {
    const fullPath = path.join(dir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }
  return dir;
}

async function mountGeneratedRoutes(app, dir, backendFiles) {
  const routeFiles = Object.keys(backendFiles).filter((f) => f.startsWith('routes/'));
  for (const relPath of routeFiles) {
    const fileUrl = pathToFileURL(path.join(dir, relPath)).href;
    const mod = await import(fileUrl);
    if (!mod.default) throw new Error(`${relPath} has no default export (expected "export default router")`);
    app.use(mod.default);
  }
}

function truncate(value) {
  const str = JSON.stringify(value);
  return str && str.length > 200 ? str.slice(0, 200) + '...' : str;
}

async function runIntegrationTests(contract, backendFiles) {
  let mongod = null;
  let scratchDir = null;

  try {
    mongod = await MongoMemoryServer.create();
  } catch (err) {
    return { issues: [], skipped: true, skipReason: `could not start in-memory MongoDB (${err.message})` };
  }

  try {
    await mongoose.connect(mongod.getUri(), { dbName: 'runtime-check' });

    scratchDir = await writeScratchBackend(backendFiles);

    const app = express();
    app.use(express.json());

    try {
      await mountGeneratedRoutes(app, scratchDir, backendFiles);
    } catch (err) {
      return { issues: [`Backend: generated routes failed to load (${err.message})`], skipped: false };
    }

    const request = supertest(app);
    const createdIds = new Map();
    const issues = [];

    for (const model of topoSortModels(contract.models || [])) {
      const endpoints = (contract.endpoints || []).filter((e) => e.model === model.name);
      const createEp = endpoints.find((e) => e.method === 'POST' && !idParam(e.path));
      const listEp = endpoints.find((e) => e.method === 'GET' && !idParam(e.path));
      const getOneEp = endpoints.find((e) => e.method === 'GET' && idParam(e.path));
      const updateEp = endpoints.find((e) => (e.method === 'PUT' || e.method === 'PATCH') && idParam(e.path));
      const deleteEp = endpoints.find((e) => e.method === 'DELETE' && idParam(e.path));

      let recordId = null;

      if (createEp) {
        const payload = {};
        for (const field of model.fields || []) payload[field.name] = sampleValue(field, createdIds);

        const res = await request.post(createEp.path).send(payload);
        if (res.status !== 201) {
          issues.push(`Backend: POST ${createEp.path} returned ${res.status} (expected 201) -- body: ${truncate(res.body)}`);
        } else if (!res.body?._id) {
          issues.push(`Backend: POST ${createEp.path} response has no "_id" field -- body: ${truncate(res.body)}`);
        } else {
          recordId = res.body._id;
          createdIds.set(model.name, recordId);
        }
      }

      if (listEp) {
        const res = await request.get(listEp.path);
        if (res.status !== 200) {
          issues.push(`Backend: GET ${listEp.path} returned ${res.status} (expected 200) -- body: ${truncate(res.body)}`);
        } else if (!Array.isArray(res.body)) {
          issues.push(`Backend: GET ${listEp.path} did not return an array -- body: ${truncate(res.body)}`);
        } else if (recordId && !res.body.some((r) => r._id === recordId)) {
          issues.push(`Backend: GET ${listEp.path} does not include the record just created via POST ${createEp.path}`);
        }
      }

      if (getOneEp && recordId) {
        const res = await request.get(getOneEp.path.replace(/:\w+$/, recordId));
        if (res.status !== 200) {
          issues.push(`Backend: GET ${getOneEp.path} returned ${res.status} for an id that exists (expected 200) -- body: ${truncate(res.body)}`);
        }
      }

      if (updateEp && recordId) {
        const stringField = (model.fields || []).find((f) => f.type === 'String');
        const patch = stringField ? { [stringField.name]: `${stringField.name}-updated` } : {};
        const res = await request[updateEp.method.toLowerCase()](updateEp.path.replace(/:\w+$/, recordId)).send(patch);
        if (res.status !== 200) {
          issues.push(`Backend: ${updateEp.method} ${updateEp.path} returned ${res.status} (expected 200) -- body: ${truncate(res.body)}`);
        } else if (stringField && res.body?.[stringField.name] !== patch[stringField.name]) {
          issues.push(`Backend: ${updateEp.method} ${updateEp.path} did not persist the updated "${stringField.name}" field in its response`);
        }
      }

      if (deleteEp && recordId) {
        const concretePath = deleteEp.path.replace(/:\w+$/, recordId);
        const res = await request.delete(concretePath);
        if (res.status !== 200) {
          issues.push(`Backend: DELETE ${deleteEp.path} returned ${res.status} (expected 200) -- body: ${truncate(res.body)}`);
        } else if (getOneEp) {
          const check = await request.get(concretePath);
          if (check.status !== 404) {
            issues.push(`Backend: after DELETE ${deleteEp.path}, GET ${getOneEp.path} still returns ${check.status} instead of 404 -- record was not actually removed`);
          }
        }
      }
    }

    return { issues, skipped: false };
  } catch (err) {
    return { issues: [`Backend: runtime test harness crashed (${err.message})`], skipped: false };
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // already disconnected
    }
    if (mongod) await mongod.stop();
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function reportCrash(err) {
  console.log(JSON.stringify({ issues: [], skipped: true, skipReason: `runtime test worker crashed unexpectedly (${err?.message || err})` }));
}

process.on('unhandledRejection', (reason) => {
  reportCrash(reason);
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  reportCrash(err);
  process.exit(0);
});

try {
  const { contract, backendFiles } = JSON.parse(await readStdin());
  const result = await runIntegrationTests(contract, backendFiles);
  console.log(JSON.stringify(result));
} catch (err) {
  reportCrash(err);
}
process.exit(0);
