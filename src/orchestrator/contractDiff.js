// Compares two contracts model-by-model so a rebuild only has to regenerate
// what actually changed. A model counts as "unchanged" only if every one of
// its fields and every one of its endpoints is identical to the previous
// contract -- anything else (a renamed field, a tweaked description, an
// added endpoint) marks it changed, since any of those can change the code
// that needs generating. No LLM involved; this is plain object comparison.

function fieldSignature(f) {
  return [f.name, f.type, !!f.required, f.ref || '', JSON.stringify(f.default ?? null)].join('::');
}

function endpointSignature(e) {
  return [e.method, e.path, e.description || ''].join('::');
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

export function diffContracts(previousContract, nextContract) {
  const prevModels = new Map((previousContract?.models || []).map((m) => [m.name, m]));
  const nextModels = new Map((nextContract.models || []).map((m) => [m.name, m]));

  const changed = [];
  const removed = [];
  const unchanged = [];

  for (const name of prevModels.keys()) {
    if (!nextModels.has(name)) removed.push(name);
  }

  for (const [name, nextModel] of nextModels) {
    const prevModel = prevModels.get(name);
    if (!prevModel) {
      changed.push(name);
      continue;
    }

    const prevFieldSigs = (prevModel.fields || []).map(fieldSignature);
    const nextFieldSigs = (nextModel.fields || []).map(fieldSignature);
    const prevEndpointSigs = (previousContract.endpoints || []).filter((e) => e.model === name).map(endpointSignature);
    const nextEndpointSigs = (nextContract.endpoints || []).filter((e) => e.model === name).map(endpointSignature);

    if (sameSet(prevFieldSigs, nextFieldSigs) && sameSet(prevEndpointSigs, nextEndpointSigs)) {
      unchanged.push(name);
    } else {
      changed.push(name);
    }
  }

  return { changed, removed, unchanged };
}
