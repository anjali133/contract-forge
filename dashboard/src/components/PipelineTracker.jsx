const STATUS_TEXT = {
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  passed: 'Passed',
  failed: 'Failed',
  issues: 'Issues found',
  skipped: 'Skipped'
};

export default function PipelineTracker({ stages }) {
  return (
    <div className="pipeline-tracker" role="list" aria-label="Build pipeline status">
      {stages.map((stage, i) => (
        <div style={{ display: 'flex', alignItems: 'flex-start', flex: i < stages.length - 1 ? 1 : 'none' }} key={stage.key}>
          <div className="stage-node" role="listitem">
            <div className={`stage-dot status-${stage.status}`} />
            <div className="stage-label">{stage.label}</div>
            <div className="stage-sublabel">{STATUS_TEXT[stage.status]}</div>
          </div>
          {i < stages.length - 1 && (
            <div className={`stage-connector ${stage.status === 'done' || stage.status === 'passed' ? 'filled' : ''}`} />
          )}
        </div>
      ))}
    </div>
  );
}
