// Deterministically merges a planner-produced patch onto an existing
// contract, for the "add a feature to an existing app" flow. Only what the
// patch explicitly mentions changes -- everything else is a straight copy,
// untouched.
//
// This is deliberately NOT "ask the LLM to re-output the whole contract and
// hope it copies the unchanged parts verbatim": a full-contract approach
// risks the LLM cosmetically rephrasing something it wasn't asked to touch
// (a slightly reworded endpoint description, a reordered field), which
// would then look "changed" to contractDiff.js's exact-signature comparison
// and trigger an unnecessary regeneration on the next build. A patch can't
// do that, since anything it doesn't mention is never touched at all.

function endpointKey(e) {
  return `${e.method}::${e.path}`;
}

export function applyContractPatch(existingContract, patch) {
  const removedModelNames = new Set(patch.removedModels || []);

  let models = existingContract.models
    .filter((m) => !removedModelNames.has(m.name))
    // Drop any ref field that pointed at a removed model, mirroring the
    // same cleanup the editable-contract UI already does on model removal.
    .map((m) => ({
      ...m,
      fields: m.fields.filter((f) => !(f.type === 'ObjectId' && removedModelNames.has(f.ref)))
    }));

  for (const modified of patch.modifiedModels || []) {
    models = models.map((m) => (m.name === modified.name ? { ...m, fields: modified.fields } : m));
  }

  for (const added of patch.newModels || []) {
    if (!models.some((m) => m.name === added.name)) models = [...models, added];
  }

  const removedEndpointKeys = new Set((patch.removedEndpoints || []).map(endpointKey));
  let endpoints = existingContract.endpoints
    .filter((e) => !removedModelNames.has(e.model))
    .filter((e) => !removedEndpointKeys.has(endpointKey(e)));

  const existingEndpointKeys = new Set(endpoints.map(endpointKey));
  for (const added of patch.newEndpoints || []) {
    if (!existingEndpointKeys.has(endpointKey(added))) {
      endpoints = [...endpoints, added];
      existingEndpointKeys.add(endpointKey(added));
    }
  }

  // appName never changes here -- extending an app is not the same
  // operation as renaming/forking it, and the incremental build's
  // previous-generation lookup depends on it staying stable.
  return { appName: existingContract.appName, models, endpoints };
}
