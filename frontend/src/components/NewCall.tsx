import React, { useState, useEffect, useRef } from 'react';

interface Voice {
  voice_id: string;
  name: string;
  preview_url?: string;
}

interface NewCallProps {
  apiBaseUrl: string;
  onError: (msg: string | null) => void;
}

export const NewCall: React.FC<NewCallProps> = ({ apiBaseUrl, onError }) => {
  const [to, setTo] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(
    'You are Rachel, a helpful and polite receptionist. Speak naturally and keep responses brief.'
  );
  const [openingLine, setOpeningLine] = useState('');
  const [strictValidation, setStrictValidation] = useState(true);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);
  const [isTriggeringCall, setIsTriggeringCall] = useState(false);
  
  // Active call status states
  const [activeCallSid, setActiveCallSid] = useState<string | null>(null);
  const [activeCallStatus, setActiveCallStatus] = useState<string | null>(null);
  
  const pollIntervalRef = useRef<any>(null);

  // Fetch voice list on component mount
  useEffect(() => {
    const fetchVoices = async () => {
      setIsLoadingVoices(true);
      onError(null);
      try {
        const res = await fetch(`${apiBaseUrl}/voices`);
        if (!res.ok) {
          throw new Error(`Server returned status ${res.status}`);
        }
        const data = await res.json();
        setVoices(data);
        if (data.length > 0) {
          setSelectedVoiceId(data[0].voice_id);
        }
      } catch (err: any) {
        console.error('Error fetching voices:', err);
        onError(`Failed to load voices list: ${err.message}`);
      } finally {
        setIsLoadingVoices(false);
      }
    };

    fetchVoices();

    return () => {
      stopPolling();
    };
  }, [apiBaseUrl]);

  // Clean up polling interval
  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  // Polls the call status endpoint `/calls/:id` using the Call SID
  const startPollingStatus = (callSid: string) => {
    stopPolling();
    console.log(`[NewCall] Starting status polling for Call SID: ${callSid}`);
    
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/calls/${callSid}`);
        if (!res.ok) {
          // If 404, the call record might not be in DB yet, ignore and continue polling
          if (res.status === 404) return;
          throw new Error(`Failed to fetch status: ${res.status}`);
        }
        const callDetails = await res.json();
        const status = callDetails.status;
        setActiveCallStatus(status);

        // Terminal statuses to stop polling
        if (['completed', 'failed', 'busy', 'no-answer'].includes(status)) {
          console.log(`[NewCall] Call finished with status: ${status}. Stopping polling.`);
          stopPolling();
        }
      } catch (err) {
        console.error('[NewCall] Status poll error:', err);
      }
    }, 3000);
  };

  // Handle call trigger
  const handlePlaceCall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!to) {
      onError('Please enter a target phone number.');
      return;
    }

    setIsTriggeringCall(true);
    onError(null);
    setActiveCallSid(null);
    setActiveCallStatus(null);

    try {
      const res = await fetch(`${apiBaseUrl}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          systemPrompt,
          voiceId: selectedVoiceId,
          openingLine,
          strictValidation,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || `Server status ${res.status}`);
      }

      const data = await res.json();
      setActiveCallSid(data.callSid);
      setActiveCallStatus('ringing');
      
      // Start polling
      startPollingStatus(data.callSid);
    } catch (err: any) {
      console.error('Error placing outbound call:', err);
      onError(`Failed to place outbound call: ${err.message}`);
    } finally {
      setIsTriggeringCall(false);
    }
  };

  // Plays a short preview of the selected voice if available
  const handlePlayPreview = () => {
    const selectedVoice = voices.find((v) => v.voice_id === selectedVoiceId);
    if (selectedVoice && selectedVoice.preview_url) {
      const audio = new Audio(selectedVoice.preview_url);
      audio.play().catch((err) => {
        console.error('Audio preview play failed:', err);
        onError('Could not play audio sample.');
      });
    } else {
      onError('Audio preview not available for this voice.');
    }
  };

  const selectedVoiceHasPreview = !!voices.find(
    (v) => v.voice_id === selectedVoiceId
  )?.preview_url;

  return (
    <div className="panel">
      <form onSubmit={handlePlaceCall}>
        <div className="form-group">
          <label htmlFor="phoneNumber">Phone Number (E.164 Format)</label>
          <input
            id="phoneNumber"
            type="tel"
            placeholder="+1XXXYYYZZZZ"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={isTriggeringCall}
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="systemPrompt">Agent Prompt & Instruction</label>
          <textarea
            id="systemPrompt"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            disabled={isTriggeringCall}
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="openingLine">Opening Line (Optional - Speaks First)</label>
          <textarea
            id="openingLine"
            placeholder="Hello! Thanks for calling. How can I help you today?"
            value={openingLine}
            onChange={(e) => setOpeningLine(e.target.value)}
            disabled={isTriggeringCall}
          />
        </div>

        <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
          <input
            id="strictValidation"
            type="checkbox"
            checked={strictValidation}
            onChange={(e) => setStrictValidation(e.target.checked)}
            disabled={isTriggeringCall}
            style={{ width: '16px', height: '16px', margin: 0, cursor: 'pointer' }}
          />
          <label htmlFor="strictValidation" style={{ cursor: 'pointer', userSelect: 'none', margin: 0 }}>Strict Answer Validation</label>
        </div>

        <div className="form-group">
          <label htmlFor="voiceSelect">ElevenLabs Voice Model</label>
          <div className="voice-selector-container">
            <select
              id="voiceSelect"
              className="voice-select"
              value={selectedVoiceId}
              onChange={(e) => setSelectedVoiceId(e.target.value)}
              disabled={isLoadingVoices || isTriggeringCall}
            >
              {isLoadingVoices ? (
                <option>Loading voices list...</option>
              ) : (
                voices.map((voice) => (
                  <option key={voice.voice_id} value={voice.voice_id}>
                    {voice.name} ({voice.voice_id.substring(0, 6)})
                  </option>
                ))
              )}
            </select>

            <button
              type="button"
              className="play-preview-btn"
              onClick={handlePlayPreview}
              title="Preview Voice Sample"
              disabled={!selectedVoiceId || !selectedVoiceHasPreview || isTriggeringCall}
            >
              ▶ Play Sample
            </button>
          </div>
        </div>

        <div className="button-row">
          <button
            type="submit"
            className="btn"
            disabled={isTriggeringCall || !to}
          >
            {isTriggeringCall ? 'Triggering...' : 'Place Outbound Call'}
          </button>
        </div>
      </form>

      {activeCallSid && (
        <div className={`call-status-box ${['ringing', 'in-progress'].includes(activeCallStatus || '') ? 'status-active' : ''}`}>
          <div>
            <strong>CALL SID:</strong> {activeCallSid}
          </div>
          <div>
            <strong>LIVE STATUS:</strong> {activeCallStatus ? activeCallStatus.toUpperCase() : 'PENDING...'}
          </div>
          {['ringing', 'in-progress'].includes(activeCallStatus || '') && (
            <div className="loading-text" style={{ marginTop: '8px' }}>
              • Call connected. Hold conversation...
            </div>
          )}
        </div>
      )}
    </div>
  );
};
