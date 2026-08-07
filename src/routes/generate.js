import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import archiver from 'archiver';
import { planApp, planAppExtend, buildApp } from '../orchestrator/pipeline.js';
import { buildScaffold, remapGeneratedFiles } from '../orchestrator/scaffold.js';
import { checkContractIntegrity, validateContractShape, APP_NAME_PATTERN } from '../validator/validate.js';
import Generation from '../db/models/Generation.js';
import { isDBConnected } from '../db/connectDB.js';

const router = express.Router();

// Phase 1: prompt -> contract. The human reviews this before anything gets generated.
router.post('/plan', async (req, res) => {
  try {
    const { description } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }

    const { contract, usage } = await planApp(description);
    const contractWarnings = checkContractIntegrity(contract);

    let generationId = null;
    if (isDBConnected()) {
      try {
        const doc = await Generation.create({
          appName: contract.appName,
          description,
          contract,
          status: 'planned',
          plannerUsage: usage
        });
        generationId = doc._id;
      } catch (dbErr) {
        console.warn('Could not save generation history:', dbErr.message);
      }
    }

    res.json({ contract, usage, generationId, contractWarnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Add a feature" to an already-planned/built app: unlike /plan, this call
// is aware of the existing contract, so the result only changes what the
// new feature actually requires -- everything else comes back byte-for-byte
// identical, which is what lets the next /build stay incremental instead of
// regenerating the whole app for one new field.
router.post('/plan-extend', async (req, res) => {
  try {
    const { existingContract, description } = req.body;
    if (!existingContract || !existingContract.appName) {
      return res.status(400).json({ error: 'existingContract (with an appName) is required' });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'description is required' });
    }

    const { contract, usage } = await planAppExtend(existingContract, description.trim());
    const contractWarnings = checkContractIntegrity(contract);

    let generationId = null;
    if (isDBConnected()) {
      try {
        const doc = await Generation.create({
          appName: contract.appName,
          description: `(feature added) ${description.trim()}`,
          contract,
          status: 'planned',
          plannerUsage: usage
        });
        generationId = doc._id;
      } catch (dbErr) {
        console.warn('Could not save generation history:', dbErr.message);
      }
    }

    res.json({ contract, usage, generationId, contractWarnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-checks a contract while it's being hand-edited in the dashboard, before
// the person clicks Build -- plain code, no LLM call, so the UI can call
// this on every edit without it costing anything. Shape errors (malformed
// input) and integrity warnings (a dangling/missing "ref") are reported
// separately since the UI treats them differently, but both are checked
// here so an edit that introduces either is caught immediately.
router.post('/validate-contract', (req, res) => {
  const { contract } = req.body;
  const shapeErrors = validateContractShape(contract);
  const contractWarnings = shapeErrors.length ? [] : checkContractIntegrity(contract);
  res.json({ shapeErrors, contractWarnings });
});

// A flat agent path (models/Book.js, src/components/BookList.jsx) maps to a
// specific spot inside output/<appName> once remapped -- this is the
// inverse of remapGeneratedFiles, used to check whether a model's disk
// files still exist for reuse before trusting them.
function toOutputRelativePath(flatPath) {
  if (flatPath.startsWith('models/') || flatPath.startsWith('routes/')) return `backend/${flatPath}`;
  if (flatPath.startsWith('src/')) return `frontend/${flatPath}`;
  return flatPath;
}

// For an incremental rebuild, "the previous version of this file" should be
// whatever's actually on disk right now, not the snapshot saved in history
// -- disk is where a person's own hand-edit to previously-generated code
// would live, and reusing history's copy instead would silently overwrite
// exactly the thing this feature exists to protect. History's copy is only
// a fallback, for when the output folder itself is missing or incomplete.
async function loadReusableFiles(outDir, historyFiles) {
  const merged = {};
  for (const [flatPath, historyContent] of Object.entries(historyFiles || {})) {
    try {
      merged[flatPath] = await fs.readFile(path.join(outDir, toOutputRelativePath(flatPath)), 'utf-8');
    } catch {
      merged[flatPath] = historyContent;
    }
  }
  return merged;
}

// Phase 2: approved contract -> backend + frontend code, validated and written to disk.
router.post('/build', async (req, res) => {
  try {
    const { contract, generationId } = req.body;
    const shapeErrors = validateContractShape(contract);
    if (shapeErrors.length) {
      return res.status(400).json({ error: `Invalid contract: ${shapeErrors.join('; ')}` });
    }
    const integrityWarnings = checkContractIntegrity(contract);
    if (integrityWarnings.length) {
      return res.status(400).json({ error: `Invalid contract: ${integrityWarnings.join('; ')}` });
    }

    const outDir = path.join(process.cwd(), 'output', contract.appName || 'generated-app');

    // Incremental rebuild: if this appName has a previously built generation
    // on record, diff against it so only the models that actually changed
    // get regenerated -- everything else is reused (from disk, preferring
    // any hand-edits) rather than burning an agent call to rewrite it
    // unchanged.
    let previous = null;
    if (isDBConnected()) {
      const prevDoc = await Generation.findOne({ appName: contract.appName, status: 'built' })
        .sort({ updatedAt: -1 })
        .lean();
      if (prevDoc?.contract && prevDoc?.files) {
        previous = { contract: prevDoc.contract, files: await loadReusableFiles(outDir, prevDoc.files) };
      }
    }

    const result = await buildApp(contract, previous);

    // Validation already ran against the agents' original flat paths above.
    // Remapping into backend/ and frontend/ folders and adding the static
    // runnable scaffold is purely a packaging step from here on.
    const remappedGenerated = remapGeneratedFiles(result.files);
    const scaffoldFiles = buildScaffold(contract);
    const allFiles = { ...scaffoldFiles, ...remappedGenerated };

    // These are the only paths whose *file set* can differ between two
    // generations of the same app name (e.g. a model gets removed from the
    // description) -- clear them first so stale leftovers don't linger.
    // Everything else (node_modules, .env) is left alone on purpose.
    const variablePaths = ['backend/models', 'backend/routes', 'frontend/src/components'];
    for (const rel of variablePaths) {
      await fs.rm(path.join(outDir, rel), { recursive: true, force: true });
    }

    for (const [relativePath, content] of Object.entries(allFiles)) {
      const fullPath = path.join(outDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }

    if (isDBConnected()) {
      try {
        const update = {
          appName: contract.appName,
          contract,
          files: result.files,
          status: 'built',
          validation: result.validation,
          attempts: result.attempts,
          buildUsageLog: result.usageLog
        };
        if (generationId) {
          await Generation.findByIdAndUpdate(generationId, update);
        } else {
          await Generation.create({ description: '(built without a saved plan)', ...update });
        }
      } catch (dbErr) {
        console.warn('Could not save generation history:', dbErr.message);
      }
    }

    res.json({
      outputDir: outDir,
      fileList: Object.keys(allFiles),
      validation: result.validation,
      attempts: result.attempts,
      incremental: !!previous,
      reusedModels: result.reusedModels,
      regeneratedModels: result.regeneratedModels,
      removedModels: result.removedModels
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    if (!isDBConnected()) {
      return res.status(503).json({ error: 'Database not connected \u2014 set MONGODB_URI in .env and restart' });
    }
    const generations = await Generation.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .select('appName description status validation attempts createdAt')
      .lean();
    res.json({ generations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/:id', async (req, res) => {
  try {
    if (!isDBConnected()) {
      return res.status(503).json({ error: 'Database not connected \u2014 set MONGODB_URI in .env and restart' });
    }
    const generation = await Generation.findById(req.params.id).lean();
    if (!generation) return res.status(404).json({ error: 'not found' });
    res.json({ generation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/download/:appName', async (req, res) => {
  if (!APP_NAME_PATTERN.test(req.params.appName)) {
    return res.status(400).json({ error: 'invalid app name' });
  }
  const outDir = path.join(process.cwd(), 'output', req.params.appName);
  try {
    await fs.access(outDir);
  } catch {
    return res.status(404).json({ error: 'No generated app found with that name' });
  }

  res.attachment(`${req.params.appName}.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Zip error:', err.message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);
  // node_modules is excluded on purpose -- keeps the download small,
  // the person just runs npm install after unzipping like any other project.
  archive.glob('**/*', { cwd: outDir, ignore: ['**/node_modules/**'] });
  archive.finalize();
});

export default router;
