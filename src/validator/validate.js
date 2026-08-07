// Lightweight, regex-based validator. It's not a full static analyzer \u2014
// it catches path/method mismatches between the contract, the backend routes,
// and the frontend fetch calls, which is the failure mode this project cares about.

import { backendRouteFile } from '../agents/modelFiles.js';

function extractBackendRoutes(files) {
  const routes = [];
  const routeRegex = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/gi;

  for (const [filename, content] of Object.entries(files)) {
    if (!filename.startsWith('routes/')) continue;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      // Routes are written as full literal paths (e.g. "/api/books/:id"),
      // so no mount-prefix guessing is needed here.
      routes.push({ method: match[1].toUpperCase(), path: match[2], file: filename });
    }
  }
  return routes;
}

function extractFrontendCalls(files) {
  const calls = [];
  const fetchRegex = /fetch\(\s*[`'"]([^`'"]+)[`'"]\s*(?:,\s*\{([\s\S]*?)\})?\s*\)/gi;
  const methodRegex = /method\s*:\s*['"`](\w+)['"`]/i;

  for (const [filename, content] of Object.entries(files)) {
    let match;
    while ((match = fetchRegex.exec(content)) !== null) {
      const url = match[1];
      const optionsBlock = match[2] || '';
      const methodMatch = optionsBlock.match(methodRegex);
      const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
      calls.push({ method, url, file: filename });
    }
  }
  return calls;
}

// Normalizes both contract paths and generated-code paths so ":id",
// "${id}", and literal ids all compare equal.
function normalizePath(rawPath) {
  return rawPath
    .replace(/\$\{[^}]+\}/g, ':id')
    .replace(/\/[a-f0-9]{24}\b/gi, '/:id')
    .replace(/\/:\w+/g, '/:id')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Flags "record.id" usage, which is almost always a bug against a Mongoose
// record (whose real identifier field is "_id") -- this is exactly the kind
// of runtime-only failure that path/method matching alone can't see, since
// the URL *shape* still looks correct even when the value plugged into it
// is undefined.
function findSuspiciousIdUsage(frontendFiles) {
  const issues = [];
  // Matches ".id" as a property access, but not "._id" (underscore blocks
  // the match) and not "target.id"/"currentTarget.id" -- a DOM element's
  // own id attribute (e.g. "e.target.id" in a controlled-form onChange
  // handler), which is a legitimate, common pattern and not a Mongo bug.
  const suspiciousIdPattern = /(?<!target)\.id\b/i;

  for (const [filename, content] of Object.entries(frontendFiles)) {
    const lines = content.split('\n');
    const hitLines = [];
    lines.forEach((line, i) => {
      if (suspiciousIdPattern.test(line)) hitLines.push(i + 1);
    });
    if (hitLines.length) {
      issues.push(
        `Frontend: ${filename} reads ".id" on what looks like a MongoDB record at line(s) ${hitLines.join(', ')} \u2014 it should be "._id", or every id-based action will send "undefined" in the URL`
      );
    }
  }
  return issues;
}

// Runs right after planning, before any code is generated -- catches a
// planner mistake (a "ref" typo'd or pointing at a model that doesn't
// exist) while it's still cheap to just re-plan, rather than discovering it
// after two agents have already generated code against a broken contract.
export function checkContractIntegrity(contract) {
  const warnings = [];
  const modelNames = new Set((contract.models || []).map((m) => m.name));

  for (const model of contract.models || []) {
    for (const field of model.fields || []) {
      if (field.type !== 'ObjectId') continue;
      if (!field.ref) {
        warnings.push(`${model.name}.${field.name} is type ObjectId but has no "ref" \u2014 the backend won't know which model it points to`);
      } else if (!modelNames.has(field.ref)) {
        warnings.push(`${model.name}.${field.name} references "${field.ref}", which isn't one of the models in this contract (${[...modelNames].join(', ')})`);
      }
    }
  }
  return warnings;
}

// Flags a model with ref fields whose route file never calls .populate() --
// structurally the routes still match the contract fine, but the frontend
// would only ever receive raw ids instead of the related record's data,
// the same "looks fine, silently wrong" shape as the _id bug.
function findMissingPopulate(contract, backendFiles) {
  const issues = [];

  for (const model of contract.models || []) {
    const refFields = (model.fields || []).filter((f) => f.type === 'ObjectId' && f.ref);
    if (!refFields.length) continue;

    const entry = Object.entries(backendFiles).find(([name]) => name === backendRouteFile(model.name));
    if (!entry) continue; // a missing route file entirely is already caught by the endpoint check above

    const [filename, content] = entry;
    if (!/\.populate\(/.test(content)) {
      const fieldNames = refFields.map((f) => f.name).join(', ');
      issues.push(
        `Backend: ${filename} has reference field(s) (${fieldNames}) but never calls .populate() \u2014 the frontend will only receive raw ids instead of the related record's data`
      );
    }
  }
  return issues;
}

// Shared between /build (guards against writing files outside output/<appName>)
// and /download/:appName (guards against reading files outside output/<appName>)
// -- both join this value straight into a filesystem path, so anything but a
// tight allowlist opens a path-traversal hole (an appName of ".." resolves
// to the project root itself, which would zip up .env and stream it back).
export const APP_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const VALID_FIELD_TYPES = new Set(['String', 'Number', 'Boolean', 'Date', 'ObjectId']);
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

// Runs at the /build boundary, before any agent call or file write, so a
// malformed or hand-edited contract (today only ever LLM-produced, but the
// planned inline-editing feature will make hand-edited contracts routine)
// fails fast with a specific reason instead of crashing deep inside
// scaffold.js/pipeline.js with a raw TypeError after tokens are already spent.
export function validateContractShape(contract) {
  const errors = [];

  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return ['contract must be a JSON object'];
  }

  if (typeof contract.appName !== 'string' || !APP_NAME_PATTERN.test(contract.appName)) {
    errors.push('appName must be a kebab-case string (lowercase letters, digits, hyphens only)');
  }

  const modelNames = new Set();

  if (!Array.isArray(contract.models) || contract.models.length === 0) {
    errors.push('models must be a non-empty array');
  } else {
    contract.models.forEach((model, i) => {
      if (!model || typeof model.name !== 'string' || !model.name.trim()) {
        errors.push(`models[${i}] is missing a valid "name"`);
        return;
      }
      // Duplicate names only become a real risk once a contract is
      // hand-editable -- renaming one model to collide with another
      // silently merges their ref checks and endpoint matching.
      if (modelNames.has(model.name)) {
        errors.push(`duplicate model name "${model.name}" -- model names must be unique`);
      }
      modelNames.add(model.name);
      if (!Array.isArray(model.fields) || model.fields.length === 0) {
        errors.push(`${model.name}.fields must be a non-empty array`);
        return;
      }
      const fieldNames = new Set();
      model.fields.forEach((field, j) => {
        if (!field || typeof field.name !== 'string' || !field.name.trim()) {
          errors.push(`${model.name}.fields[${j}] is missing a valid "name"`);
          return;
        }
        if (fieldNames.has(field.name)) {
          errors.push(`${model.name} has a duplicate field name "${field.name}" -- field names must be unique within a model`);
        }
        fieldNames.add(field.name);
        if (!VALID_FIELD_TYPES.has(field.type)) {
          errors.push(`${model.name}.${field.name} has an invalid type "${field.type}" (must be one of ${[...VALID_FIELD_TYPES].join(', ')})`);
        }
      });
    });
  }

  if (!Array.isArray(contract.endpoints) || contract.endpoints.length === 0) {
    errors.push('endpoints must be a non-empty array');
  } else {
    contract.endpoints.forEach((ep, i) => {
      if (!ep || !VALID_METHODS.has(ep.method)) {
        errors.push(`endpoints[${i}] has an invalid "method" (must be one of ${[...VALID_METHODS].join(', ')})`);
      }
      if (!ep || typeof ep.path !== 'string' || !ep.path.startsWith('/')) {
        errors.push(`endpoints[${i}] has an invalid "path" (must be a string starting with "/")`);
      }
      if (!ep || typeof ep.model !== 'string' || !modelNames.has(ep.model)) {
        errors.push(`endpoints[${i}] references model "${ep?.model}", which isn't declared in "models"`);
      }
    });
  }

  return errors;
}

export function validateContract(contract, backendFiles, frontendFiles) {
  const mismatches = [];

  const backendRoutes = extractBackendRoutes(backendFiles).map((r) => ({
    ...r,
    normalized: normalizePath(r.path)
  }));

  const frontendCalls = extractFrontendCalls(frontendFiles).map((c) => ({
    ...c,
    normalized: normalizePath(c.url)
  }));

  for (const endpoint of contract.endpoints) {
    const expected = normalizePath(endpoint.path);

    // Exact match, not endsWith -- both sides are normalized to the full
    // literal path already, so a genuine match is always equal. endsWith
    // would let a bug like a double-prefixed route ("/api/api/books")
    // wrongly count as matching "/api/books", since the longer string ends
    // with the shorter one -- silently passing validation on a route that's
    // actually unreachable at the path the contract promised.
    const backendMatch = backendRoutes.some(
      (r) => r.method === endpoint.method && r.normalized === expected
    );
    if (!backendMatch) {
      mismatches.push(`Backend: missing ${endpoint.method} ${endpoint.path} (declared in contract, no matching route in routes/*.js)`);
    }

    const frontendMatch = frontendCalls.some(
      (c) => c.method === endpoint.method && c.normalized === expected
    );
    if (!frontendMatch) {
      mismatches.push(`Frontend: never calls ${endpoint.method} ${endpoint.path} (declared in contract, no matching fetch found)`);
    }
  }

  mismatches.push(...findSuspiciousIdUsage(frontendFiles));
  mismatches.push(...findMissingPopulate(contract, backendFiles));

  return {
    passed: mismatches.length === 0,
    mismatches,
    backendRoutes,
    frontendCalls
  };
}
