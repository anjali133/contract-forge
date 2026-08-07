import ContractView from './ContractView.jsx';

export default function HistoryView({ items, error, selected, onSelect, onBack, onRefresh }) {
  if (error) {
    return (
      <div className="card empty-state">
        <h3>History unavailable</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="card">
        <button className="back-link" onClick={onBack}>&larr; Back to history</button>
        <div className="card-header">
          <h2 style={{ fontSize: 15 }}>{selected.appName || '(unnamed)'}</h2>
          <span className="label">{selected.status}</span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>{selected.description}</p>

        {selected.contract && <ContractView contract={selected.contract} />}

        {selected.validation && (
          <div className={`validation-banner ${selected.validation.passed ? 'pass' : 'fail'}`} style={{ marginTop: 16 }}>
            {selected.validation.passed
              ? `Validator passed (${selected.attempts ?? 1} attempt${selected.attempts === 1 ? '' : 's'})`
              : `${selected.validation.mismatches.length} issue${selected.validation.mismatches.length === 1 ? '' : 's'} remained after ${selected.attempts ?? 1} attempts`}
          </div>
        )}
        {selected.validation && !selected.validation.passed && (
          <ul className="mismatch-list">
            {selected.validation.mismatches.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
        {selected.validation?.runtimeSkipped && (
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: 10 }}>
            Runtime tests were skipped — could not start an in-memory MongoDB ({selected.validation.runtimeSkipReason}).
          </p>
        )}

        {selected.files && (
          <>
            <div className="label" style={{ margin: '18px 0 8px' }}>Files</div>
            <div className="file-list">
              {Object.keys(selected.files).map((f) => (
                <span className="file-chip" key={f}>{f}</span>
              ))}
            </div>
            {selected.appName && (
              <a href={`/api/download/${selected.appName}`} style={{ display: 'inline-block', marginTop: 16 }}>
                <button>Download project</button>
              </a>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 style={{ fontSize: 15 }}>Past generations</h2>
        <button onClick={onRefresh}>Refresh</button>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">
          <h3>No generations yet</h3>
          <p>Build something in the Build tab and it shows up here.</p>
        </div>
      ) : (
        items.map((g) => (
          <button className="history-row" key={g._id} onClick={() => onSelect(g._id)}>
            <div className="history-row-main">
              <span className="history-app-name">{g.appName || '(unnamed)'}</span>
              <span className="history-description">{g.description}</span>
            </div>
            <div className="history-meta">
              <span>{g.status}</span>
              {g.validation && (
                <span>{g.validation.passed ? 'passed' : `${g.validation.mismatches?.length ?? '?'} issues`}</span>
              )}
              <span>{g.attempts ?? 0} attempts</span>
              <span>{new Date(g.createdAt).toLocaleDateString()}</span>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
