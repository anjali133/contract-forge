import { useState, useEffect, useCallback } from 'react';
import BuildPanel from './components/BuildPanel.jsx';
import HistoryView from './components/HistoryView.jsx';
import { fetchHistory, fetchGeneration } from './api.js';

export default function App() {
  const [tab, setTab] = useState('build');
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState(null);
  const [selected, setSelected] = useState(null);

  const loadHistory = useCallback(async () => {
    try {
      const data = await fetchHistory();
      setHistory(data.generations);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(err.message);
    }
  }, []);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  async function handleSelect(id) {
    try {
      const data = await fetchGeneration(id);
      setSelected(data.generation);
    } catch (err) {
      setHistoryError(err.message);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="eyebrow">MULTI-AGENT BUILDER</span>
          <h1>Contract-first app generator</h1>
        </div>
        <div className="tab-switcher">
          <button
            className={`tab-button ${tab === 'build' ? 'active' : ''}`}
            onClick={() => setTab('build')}
          >
            Build
          </button>
          <button
            className={`tab-button ${tab === 'history' ? 'active' : ''}`}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </div>
      </header>

      <main className="app-main">
        {tab === 'build' && <BuildPanel onBuilt={loadHistory} />}
        {tab === 'history' && (
          <HistoryView
            items={history}
            error={historyError}
            selected={selected}
            onSelect={handleSelect}
            onBack={() => setSelected(null)}
            onRefresh={loadHistory}
          />
        )}
      </main>
    </div>
  );
}
