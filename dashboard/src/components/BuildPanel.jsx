import { useState, useEffect } from 'react';
import { planApp, planExtend, buildApp, validateContractDraft, downloadUrl } from '../api.js';
import PipelineTracker from './PipelineTracker.jsx';
import ContractView from './ContractView.jsx';

function computeStages({ planning, contract, building, buildResult }) {
  const mismatches = buildResult?.validation?.mismatches || [];
  const hasBackendIssues = mismatches.some((m) => m.startsWith('Backend'));
  const hasFrontendIssues = mismatches.some((m) => m.startsWith('Frontend'));

  const plannerStatus = contract ? 'done' : planning ? 'running' : 'pending';

  const codegenStatus = (hasIssues) => {
    if (buildResult) return hasIssues ? 'issues' : 'done';
    if (building) return 'running';
    return 'pending';
  };

  const validatorStatus = () => {
    if (!buildResult) return building ? 'running' : 'pending';
    return buildResult.validation.passed ? 'passed' : 'failed';
  };

  const runtimeStatus = () => {
    if (!buildResult) return building ? 'running' : 'pending';
    const { validation } = buildResult;
    if (!validation.ranRuntimeTests) return 'skipped'; // structural issues upstream, or no in-memory Mongo available
    return validation.runtimeIssueCount > 0 ? 'failed' : 'passed';
  };

  return [
    { key: 'planner', label: 'Planner', status: plannerStatus },
    { key: 'backend', label: 'Backend', status: codegenStatus(hasBackendIssues) },
    { key: 'frontend', label: 'Frontend', status: codegenStatus(hasFrontendIssues) },
    { key: 'validator', label: 'Validator', status: validatorStatus() },
    { key: 'runtime', label: 'Runtime Tests', status: runtimeStatus() }
  ];
}

export default function BuildPanel({ onBuilt }) {
  const [description, setDescription] = useState('');
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [contract, setContract] = useState(null);
  const [contractWarnings, setContractWarnings] = useState([]);
  const [shapeErrors, setShapeErrors] = useState([]);
  const [checkingContract, setCheckingContract] = useState(false);
  const [generationId, setGenerationId] = useState(null);
  const [plannerUsage, setPlannerUsage] = useState(null);

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState(null);
  const [buildResult, setBuildResult] = useState(null);

  const [featureDescription, setFeatureDescription] = useState('');
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState(null);

  // Re-checks the contract on every edit -- plain code, no LLM call, so this
  // is cheap enough to run on a short debounce instead of only at plan time.
  // Keeps the human-approval checkpoint honest once the contract is
  // actually editable: a bad edit is caught before Build, not after.
  useEffect(() => {
    if (!contract) return;
    setCheckingContract(true);
    const timer = setTimeout(async () => {
      try {
        const result = await validateContractDraft(contract);
        setShapeErrors(result.shapeErrors || []);
        setContractWarnings(result.contractWarnings || []);
      } catch {
        // best-effort -- leave the previous check result displayed
      } finally {
        setCheckingContract(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [contract]);

  async function handlePlan() {
    if (!description.trim() || planning) return;
    setPlanning(true);
    setPlanError(null);
    setContract(null);
    setContractWarnings([]);
    setShapeErrors([]);
    setBuildResult(null);
    try {
      const data = await planApp(description.trim());
      setContract(data.contract);
      setContractWarnings(data.contractWarnings || []);
      setGenerationId(data.generationId);
      setPlannerUsage(data.usage);
    } catch (err) {
      setPlanError(err.message);
    } finally {
      setPlanning(false);
    }
  }

  // Unlike handlePlan, this is aware of the existing contract -- the planner
  // only outputs what the new feature actually changes, so everything else
  // comes back untouched and the next Build stays incremental instead of
  // regenerating the whole app for one new field.
  async function handleAddFeature() {
    if (!featureDescription.trim() || extending || !contract) return;
    setExtending(true);
    setExtendError(null);
    try {
      const data = await planExtend(contract, featureDescription.trim());
      setContract(data.contract);
      setContractWarnings(data.contractWarnings || []);
      setGenerationId(data.generationId);
      setPlannerUsage(data.usage);
      setBuildResult(null); // the contract changed -- the last build result no longer describes it
      setFeatureDescription('');
    } catch (err) {
      setExtendError(err.message);
    } finally {
      setExtending(false);
    }
  }

  async function handleBuild() {
    if (!contract || building || checkingContract || shapeErrors.length || contractWarnings.length) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const data = await buildApp(contract, generationId);
      setBuildResult(data);
      onBuilt?.();
    } catch (err) {
      setBuildError(err.message);
    } finally {
      setBuilding(false);
    }
  }

  const stages = computeStages({ planning, contract, building, buildResult });
  const totalTokens =
    (plannerUsage?.total_tokens || 0) +
    (buildResult?.attempts
      ? 0 // buildUsageLog isn't returned by /build directly today; shown via history detail instead
      : 0);

  return (
    <>
      <div className="card">
        <PipelineTracker stages={stages} />
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 10 }}>Describe your app</div>
        <textarea
          className="prompt-textarea"
          placeholder="A library system with books and members who can borrow and return books"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
          {plannerUsage && (
            <span className="usage-line">{plannerUsage.total_tokens} tokens to plan</span>
          )}
          <button className="primary" onClick={handlePlan} disabled={planning || !description.trim()} style={{ marginLeft: 'auto' }}>
            {planning ? 'Thinking…' : 'Generate contract'}
          </button>
        </div>
        {planError && <p style={{ color: 'var(--status-failed)', fontSize: 13, marginTop: 10 }}>{planError}</p>}
      </div>

      {contract && (
        <div className="card">
          <div className="card-header">
            <h2 style={{ fontSize: 15 }}>Contract ready — review and edit before building</h2>
            <button className="primary" onClick={handleBuild} disabled={building || checkingContract || shapeErrors.length > 0 || contractWarnings.length > 0}>
              {building ? 'Building…' : 'Build app from this contract'}
            </button>
          </div>
          <ContractView contract={contract} editable onChange={setContract} />
          {(shapeErrors.length > 0 || contractWarnings.length > 0) && (
            <div className="validation-banner fail" style={{ marginTop: 12 }}>
              {shapeErrors.length + contractWarnings.length} issue{shapeErrors.length + contractWarnings.length === 1 ? '' : 's'} to fix before building:
              <ul className="mismatch-list">
                {shapeErrors.map((w, i) => (
                  <li key={`shape-${i}`}>{w}</li>
                ))}
                {contractWarnings.map((w, i) => (
                  <li key={`warn-${i}`}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {checkingContract && shapeErrors.length === 0 && contractWarnings.length === 0 && (
            <p className="usage-line" style={{ marginTop: 10 }}>Checking edits…</p>
          )}
          {buildError && <p style={{ color: 'var(--status-failed)', fontSize: 13, marginTop: 12 }}>{buildError}</p>}
        </div>
      )}

      {contract && (
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>Add a feature to this app</div>
          <textarea
            className="prompt-textarea"
            placeholder="Add push notifications when a task is overdue"
            value={featureDescription}
            onChange={(e) => setFeatureDescription(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="primary" onClick={handleAddFeature} disabled={extending || !featureDescription.trim()}>
              {extending ? 'Adding…' : 'Add feature to contract'}
            </button>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: 10 }}>
            Unlike "Generate contract" above, this keeps everything about the current contract that
            isn't affected by the new feature — so a later build only regenerates what actually changed.
          </p>
          {extendError && <p style={{ color: 'var(--status-failed)', fontSize: 13, marginTop: 10 }}>{extendError}</p>}
        </div>
      )}

      {buildResult && (
        <div className="card">
          <div className="card-header">
            <h2 style={{ fontSize: 15 }}>Result</h2>
            <a href={downloadUrl(contract.appName)}>
              <button>Download project</button>
            </a>
          </div>

          <div className={`validation-banner ${buildResult.validation.passed ? 'pass' : 'fail'}`}>
            {buildResult.validation.passed
              ? `Validator passed — frontend and backend match${buildResult.validation.ranRuntimeTests ? ', and the generated backend passed its runtime test suite' : ''} (${buildResult.attempts} attempt${buildResult.attempts === 1 ? '' : 's'})`
              : `${buildResult.validation.mismatches.length} issue${buildResult.validation.mismatches.length === 1 ? '' : 's'} remain after ${buildResult.attempts} attempts`}
          </div>
          {!buildResult.validation.passed && (
            <ul className="mismatch-list">
              {buildResult.validation.mismatches.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
          {buildResult.validation.runtimeSkipped && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: 10 }}>
              Runtime tests were skipped — could not start an in-memory MongoDB ({buildResult.validation.runtimeSkipReason}).
            </p>
          )}
          {buildResult.incremental && (
            <p className="usage-line" style={{ marginTop: 10 }}>
              Incremental rebuild — reused {buildResult.reusedModels.length} unchanged model{buildResult.reusedModels.length === 1 ? '' : 's'}
              {buildResult.regeneratedModels.length > 0 &&
                `, regenerated ${buildResult.regeneratedModels.length} (${buildResult.regeneratedModels.join(', ')})`}
              {buildResult.removedModels.length > 0 && `, removed ${buildResult.removedModels.length} (${buildResult.removedModels.join(', ')})`}.
            </p>
          )}

          <div className="label" style={{ margin: '18px 0 8px' }}>Files written to {buildResult.outputDir}</div>
          <div className="file-list">
            {buildResult.fileList.map((f) => (
              <span className="file-chip" key={f}>{f}</span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
