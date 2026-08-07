// Single source of truth for the filename convention both agents must
// follow: the model's exact name, case-preserved, for every file. Without
// this being unambiguous and enforced (not just suggested), an LLM will
// sometimes name a route file after the endpoint's plural/kebab-case URL
// instead of the model name (e.g. "routes/team-members.js" for a model
// named "TeamMember") -- which silently breaks anything that needs to trace
// a file back to the model it belongs to, like the missing-populate check
// and incremental rebuilds.
export function backendModelFile(modelName) {
  return `models/${modelName}.js`;
}

export function backendRouteFile(modelName) {
  return `routes/${modelName}.js`;
}

export function frontendListFile(modelName) {
  return `src/components/${modelName}List.jsx`;
}

export function filesForModel(modelName, side) {
  return side === 'backend'
    ? [backendModelFile(modelName), backendRouteFile(modelName)]
    : [frontendListFile(modelName)];
}

// Defensive filter applied to whatever an agent actually returns: even when
// told to scope its output to a specific set of models, an LLM can still
// emit extra files. Silently keeping those would let stale/unrequested
// content leak into a merged incremental build and overwrite a reused,
// already-validated file for a model nothing asked it to touch.
export function filterFilesToModels(files, modelNames, side) {
  const allowed = new Set(modelNames.flatMap((name) => filesForModel(name, side)));
  const filtered = {};
  for (const [path, content] of Object.entries(files || {})) {
    if (allowed.has(path)) filtered[path] = content;
  }
  return filtered;
}
