import React, { useState } from 'react';
import './App.css';
import { NewCall } from './components/NewCall';
import { CallHistory } from './components/CallHistory';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || window.location.origin;

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'new-call' | 'history'>('new-call');
  const [error, setError] = useState<string | null>(null);

  const handleError = (msg: string | null) => {
    setError(msg);
  };

  return (
    <div className="app-container">
      {/* Dashboard Title Header */}
      <header>
        <div>
          <h1>Grr</h1>
          <span className="tagline">Custom AI Voice Orchestration Platform</span>
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          API URL: <code>{API_BASE_URL}</code>
        </div>
      </header>

      {/* Error Announcement Banner */}
      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
          <button
            onClick={() => handleError(null)}
            style={{
              float: 'right',
              background: 'none',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="tabs-container">
        <button
          className={`tab-btn ${activeTab === 'new-call' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('new-call');
            handleError(null);
          }}
        >
          New Call Form
        </button>
        <button
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('history');
            handleError(null);
          }}
        >
          Call History Log
        </button>
      </div>

      {/* View Components Router */}
      <main>
        {activeTab === 'new-call' ? (
          <NewCall apiBaseUrl={API_BASE_URL} onError={handleError} />
        ) : (
          <CallHistory apiBaseUrl={API_BASE_URL} onError={handleError} />
        )}
      </main>
    </div>
  );
};

export default App;
