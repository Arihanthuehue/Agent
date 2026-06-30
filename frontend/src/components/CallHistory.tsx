import React, { useState, useEffect } from 'react';

interface Call {
  id: string;
  call_sid: string;
  to_number: string;
  duration_seconds?: number;
  status: string;
  created_at: string;
}

interface TranscriptTurn {
  speaker: 'user' | 'agent';
  text: string;
  created_at: string;
}

interface CallDetail extends Call {
  recording_url?: string;
  transcript: TranscriptTurn[];
}

interface CallHistoryProps {
  apiBaseUrl: string;
  onError: (msg: string | null) => void;
}

export const CallHistory: React.FC<CallHistoryProps> = ({ apiBaseUrl, onError }) => {
  const [calls, setCalls] = useState<Call[]>([]);
  const [isLoadingCalls, setIsLoadingCalls] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [selectedCallDetail, setSelectedCallDetail] = useState<CallDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Fetch list of calls on mount
  useEffect(() => {
    fetchCallHistory();
  }, [apiBaseUrl]);

  const fetchCallHistory = async () => {
    setIsLoadingCalls(true);
    onError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/calls`);
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      const data = await res.json();
      setCalls(data);
    } catch (err: any) {
      console.error('Error fetching call history:', err);
      onError(`Failed to load call history: ${err.message}`);
    } finally {
      setIsLoadingCalls(false);
    }
  };

  const handleRowClick = async (callId: string) => {
    if (selectedCallId === callId) {
      // Toggle / close detail view
      setSelectedCallId(null);
      setSelectedCallDetail(null);
      return;
    }

    setSelectedCallId(callId);
    setSelectedCallDetail(null);
    setIsLoadingDetail(true);
    onError(null);

    try {
      const res = await fetch(`${apiBaseUrl}/calls/${callId}`);
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      const data = await res.json();
      setSelectedCallDetail(data);
    } catch (err: any) {
      console.error('Error fetching call details:', err);
      onError(`Failed to load call details: ${err.message}`);
      setSelectedCallId(null);
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const formatDateTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <div>
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1rem', textTransform: 'uppercase', margin: 0 }}>Call History Log</h2>
          <button className="btn btn-secondary" onClick={fetchCallHistory} style={{ padding: '6px 12px', fontSize: '0.75rem' }}>
            ⟳ Refresh
          </button>
        </div>

        {isLoadingCalls ? (
          <div className="loading-text" style={{ padding: '30px 0', textAlign: 'center' }}>
            Fetching history logs...
          </div>
        ) : calls.length === 0 ? (
          <div className="empty-state" style={{ marginTop: '20px' }}>
            No calls recorded. Place a call first.
          </div>
        ) : (
          <table style={{ marginTop: '20px' }}>
            <thead>
              <tr>
                <th>Date/Time</th>
                <th>Recipient</th>
                <th>Call SID</th>
                <th>Duration</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr
                  key={call.id}
                  onClick={() => handleRowClick(call.id)}
                  className={`interactive-row ${selectedCallId === call.id ? 'selected-row' : ''}`}
                >
                  <td>{formatDateTime(call.created_at)}</td>
                  <td>{call.to_number}</td>
                  <td><code>{call.call_sid.substring(0, 12)}...</code></td>
                  <td>{call.duration_seconds !== undefined && call.duration_seconds !== null ? `${call.duration_seconds}s` : '--'}</td>
                  <td>
                    <span style={{
                      textTransform: 'uppercase',
                      fontSize: '0.75rem',
                      fontWeight: 'bold',
                      color: call.status === 'completed' ? 'var(--success-color)' : 
                             ['failed', 'busy', 'no-answer'].includes(call.status) ? 'var(--danger-color)' : 'var(--text-primary)'
                    }}>
                      {call.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detailed Call Expanded View */}
      {selectedCallId && (
        <div className="panel" style={{ borderTop: '2px solid var(--accent-color)' }}>
          {isLoadingDetail ? (
            <div className="loading-text" style={{ textAlign: 'center', padding: '50px 0' }}>
              Fetching call details and transcript...
            </div>
          ) : selectedCallDetail ? (
            <div>
              <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '15px', marginBottom: '25px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '15px' }}>
                <h3 style={{ margin: 0, textTransform: 'uppercase', fontSize: '1rem' }}>
                  Call Details - {selectedCallDetail.to_number}
                </h3>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <a
                    href={`${apiBaseUrl}/calls/${selectedCallDetail.id}/transcript?format=txt`}
                    download
                    className="btn btn-secondary"
                    style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                  >
                    ↓ Transcript (.txt)
                  </a>
                  <a
                    href={`${apiBaseUrl}/calls/${selectedCallDetail.id}/transcript?format=json`}
                    download
                    className="btn btn-secondary"
                    style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                  >
                    ↓ Raw JSON
                  </a>
                </div>
              </div>

              <div className="call-detail-grid">
                {/* Metadata & Audio Panel */}
                <div className="meta-panel">
                  <div className="meta-item">
                    <label>Twilio Call SID</label>
                    <div className="meta-value"><code>{selectedCallDetail.call_sid}</code></div>
                  </div>
                  <div className="meta-item">
                    <label>Duration</label>
                    <div className="meta-value">
                      {selectedCallDetail.duration_seconds ? `${selectedCallDetail.duration_seconds} seconds` : 'Unavailable'}
                    </div>
                  </div>
                  <div className="meta-item">
                    <label>Created At</label>
                    <div className="meta-value">{formatDateTime(selectedCallDetail.created_at)}</div>
                  </div>
                  <div className="meta-item">
                    <label>Terminal Status</label>
                    <div className="meta-value" style={{ textTransform: 'uppercase', fontWeight: 'bold' }}>
                      {selectedCallDetail.status}
                    </div>
                  </div>

                  {selectedCallDetail.recording_url ? (
                    <div className="audio-player-container">
                      <label style={{ display: 'block', marginBottom: '10px' }}>Call Recording</label>
                      <audio src={selectedCallDetail.recording_url} controls />
                      <a
                        href={selectedCallDetail.recording_url}
                        download
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary"
                        style={{ display: 'block', textAlign: 'center', marginTop: '15px', padding: '10px', fontSize: '0.75rem' }}
                      >
                        Download WAV Audio File
                      </a>
                    </div>
                  ) : (
                    <div className="audio-player-container" style={{ fontStyle: 'italic', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      Recording audio file not available.
                    </div>
                  )}
                </div>

                {/* Readable Chat-Style Transcript Panel */}
                <div className="chat-panel">
                  <label style={{ marginBottom: '10px' }}>Conversation Transcript</label>
                  <div className="chat-history">
                    {selectedCallDetail.transcript.length === 0 ? (
                      <div style={{ textAlign: 'center', margin: 'auto 0', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                        No conversation transcripts recorded for this call.
                      </div>
                    ) : (
                      selectedCallDetail.transcript.map((turn, idx) => {
                        const isAgent = turn.speaker === 'agent';
                        const timeStr = new Date(turn.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        return (
                          <div
                            key={idx}
                            style={{ display: 'flex', flexDirection: 'column', width: '100%' }}
                          >
                            <div className={`bubble-meta ${isAgent ? 'agent' : 'user'}`}>
                              {isAgent ? 'AGENT (Sarah)' : 'USER'} • {timeStr}
                            </div>
                            <div className={`chat-bubble ${isAgent ? 'agent' : 'user'}`}>
                              {turn.text}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">Failed to load detailed record.</div>
          )}
        </div>
      )}
    </div>
  );
};
