import { runPlannerAgent, runPlannerExtendAgent } from '../agents/plannerAgent.js';
import { runBackendAgent } from '../agents/backendAgent.js';
import { runFrontendAgent } from '../agents/frontendAgent.js';
import { filesForModel } from '../agents/modelFiles.js';
import { validateContract } from '../validator/validate.js';
import { checkSyntax } from '../validator/syntaxCheck.js';
import { runIntegrationTests } from '../validator/runtimeCheck.js';
import { diffContracts } from './contractDiff.js';
import { config } from '../config.js';

export async function planApp(description) {
  const { contract, usage } = await runPlannerAgent(description);
  return { contract, usage };
}

// "Add a feature" mode: plans a patch against an already-existing contract
// instead of starting fresh, so the result still builds incrementally
// against whatever was already built under that app name.
export async function planAppExtend(existingContract, featureDescription) {
  const { contract, usage } = await runPlannerExtendAgent(existingContract, featureDescription);
  return { contract, usage };
}

// Runs all three checks that feed the retry loop: static contract matching,
// syntax validity, and (only once a side has no known structural problems)
// an actual boot-and-exercise pass against a real in-memory MongoDB. Runtime
// tests are skipped when static/syntax issues already exist on the backend --
// there's no point booting a server whose routes are already known to be
// wrong, and it saves the cost of spinning up Mongo on every attempt.
async function runFullValidation(contract, backendFiles, frontendFiles) {
  const contractValidation = validateContract(contract, backendFiles, frontendFiles);
  const syntaxIssues = await checkSyntax({ ...backendFiles, ...frontendFiles });

  const mismatches = [...contractValidation.mismatches, ...syntaxIssues];
  const backendStructurallyClean = !mismatches.some((m) => m.startsWith('Backend'));

  let runtimeSkipped = false;
  let runtimeSkipReason = null;
  let runtimeIssueCount = 0;

  if (backendStructurallyClean) {
    const runtime = await runIntegrationTests(contract, backendFiles);
    mismatches.push(...runtime.issues);
    runtimeSkipped = runtime.skipped;
    runtimeSkipReason = runtime.skipReason || null;
    runtimeIssueCount = runtime.issues.length;
  }

  return {
    passed: mismatches.length === 0,
    mismatches,
    backendRoutes: contractValidation.backendRoutes,
    frontendCalls: contractValidation.frontendCalls,
    ranRuntimeTests: backendStructurallyClean && !runtimeSkipped,
    runtimeSkipped,
    runtimeSkipReason,
    runtimeIssueCount
  };
}

// A model only counts as safely reusable if every file it's supposed to
// have actually exists in the previous build's saved files -- if the diff
// engine is ever wrong about "unchanged" (or history is missing something
// it shouldn't), falling back to regenerating that model is what keeps a
// hole from turning into a permanently-broken build the retry loop can
// never fix, since retries stay scoped to the same regenerated-models set.
function resolveReusableModels(unchangedNames, previousFiles) {
  const reusable = [];
  const forcedChanged = [];
  for (const name of unchangedNames) {
    const paths = [...filesForModel(name, 'backend'), ...filesForModel(name, 'frontend')];
    if (paths.every((p) => previousFiles[p] !== undefined)) reusable.push(name);
    else forcedChanged.push(name);
  }
  return { reusable, forcedChanged };
}

function sameMismatchSet(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((m) => setB.has(m));
}

function collectReusedFiles(modelNames, previousFiles, side) {
  const files = {};
  for (const name of modelNames) {
    for (const path of filesForModel(name, side)) {
      files[path] = previousFiles[path];
    }
  }
  return files;
}

// previous, when given as { contract, files }, enables an incremental
// rebuild: only models that actually changed (added, or whose fields/
// endpoints differ) get regenerated via the agents; everything else is
// reused verbatim from the previous build. Validation and the runtime test
// suite still always run against the FULL merged file set and the full
// current contract, exactly as a fresh build would -- reuse only changes
// what gets *generated*, never what gets *checked*, so a new model's
// relationship to an old, reused one is still genuinely verified.
export async function buildApp(contract, previous = null) {
  const diff = previous
    ? diffContracts(previous.contract, contract)
    : { changed: contract.models.map((m) => m.name), removed: [], unchanged: [] };

  const { reusable: reusedModels, forcedChanged } = previous
    ? resolveReusableModels(diff.unchanged, previous.files)
    : { reusable: [], forcedChanged: [] };
  const regeneratedModels = [...diff.changed, ...forcedChanged];

  // null means "no restriction" (today's full-build behavior, unchanged);
  // a real array -- including an empty one -- means "only these models",
  // which lets a no-op rebuild (nothing changed) skip agent calls entirely.
  const onlyModels = previous ? regeneratedModels : null;

  const reusedBackendFiles = previous ? collectReusedFiles(reusedModels, previous.files, 'backend') : {};
  const reusedFrontendFiles = previous ? collectReusedFiles(reusedModels, previous.files, 'frontend') : {};

  async function callBackend(feedback) {
    if (onlyModels && onlyModels.length === 0) return { files: {}, usage: null };
    return runBackendAgent(contract, feedback, onlyModels);
  }
  async function callFrontend(feedback) {
    if (onlyModels && onlyModels.length === 0) return { files: {}, usage: null };
    return runFrontendAgent(contract, feedback, onlyModels);
  }

  // Backend and frontend only depend on the contract, not on each other,
  // so they run in parallel rather than one waiting on the other.
  let [backendResult, frontendResult] = await Promise.all([callBackend(null), callFrontend(null)]);

  let mergedBackendFiles = { ...reusedBackendFiles, ...backendResult.files };
  let mergedFrontendFiles = { ...reusedFrontendFiles, ...frontendResult.files };

  let validation = await runFullValidation(contract, mergedBackendFiles, mergedFrontendFiles);
  let attempts = 1;
  const usageLog = [backendResult.usage, frontendResult.usage].filter(Boolean);

  while (!validation.passed && attempts <= config.maxRetries) {
    const backendIssues = validation.mismatches.filter((m) => m.startsWith('Backend'));
    const frontendIssues = validation.mismatches.filter((m) => m.startsWith('Frontend'));

    // Only re-run the side that actually has a problem \u2014 cheaper and more targeted
    // than regenerating everything from scratch on every retry. On an incremental
    // build this stays scoped to onlyModels throughout: reused files were already
    // known-good from a prior successful build, so they're never retry targets.
    const retries = [];
    if (backendIssues.length) {
      retries.push(
        callBackend(backendIssues.join('\n')).then((r) => {
          backendResult = r;
          mergedBackendFiles = { ...reusedBackendFiles, ...backendResult.files };
          if (r.usage) usageLog.push(r.usage);
        })
      );
    }
    if (frontendIssues.length) {
      retries.push(
        callFrontend(frontendIssues.join('\n')).then((r) => {
          frontendResult = r;
          mergedFrontendFiles = { ...reusedFrontendFiles, ...frontendResult.files };
          if (r.usage) usageLog.push(r.usage);
        })
      );
    }
    await Promise.all(retries);

    const previousMismatches = validation.mismatches;
    validation = await runFullValidation(contract, mergedBackendFiles, mergedFrontendFiles);
    attempts++;

    // If a retry left the exact same problems unresolved, further identical
    // retries won't do any better -- most commonly on an incremental build,
    // because the entire remaining issue belongs to a reused model this
    // build was never allowed to touch, so no amount of regenerating the
    // *changed* models could ever fix it. Stop spending agent calls the
    // moment that becomes clear instead of retrying blindly to the cap.
    if (!validation.passed && sameMismatchSet(previousMismatches, validation.mismatches)) break;
  }

  return {
    files: { ...mergedBackendFiles, ...mergedFrontendFiles },
    validation,
    attempts,
    usageLog,
    reusedModels,
    regeneratedModels,
    removedModels: diff.removed
  };
}
