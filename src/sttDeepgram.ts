import WebSocket from 'ws';
import { config } from './config';
import { CallSession } from './session';
import { SttProvider, SttResult } from './stt';

/**
 * Deepgram implementation of the SttProvider interface.
 * Connects to Deepgram's real-time streaming WebSocket using the flux-general-multi model.
 */
export class DeepgramSttProvider implements SttProvider {
  private session: CallSession;
  private ws: WebSocket | null = null;
  private onTranscriptCallback?: (result: SttResult) => void;
  private isStopped = false;
  private wsPromiseResolve?: () => void;
  private sttPromise?: Promise<void>;
  private hasForwardedAudio = false;

  constructor(session: CallSession) {
    this.session = session;
  }

  async start(onTranscript: (result: SttResult) => void): Promise<void> {
    this.onTranscriptCallback = onTranscript;
    this.isStopped = false;

    const apiKey = config.deepgram.apiKey;
    if (!apiKey) {
      console.warn("⚠️ Warning: DEEPGRAM_API_KEY is not set. Deepgram connections will fail.");
    }

    // Convert candidates list to language_hint query parameters.
    // Deepgram expects base codes (e.g. 'en', 'hi', 'es').
    const hints = config.aws.candidateLanguages.map((lang) => {
      const baseCode = lang.split('-')[0];
      return `language_hint=${baseCode}`;
    }).join('&');

    const url = `wss://api.deepgram.com/v2/listen?model=flux-general-multi&encoding=mulaw&sample_rate=8000&${hints}`;

    const maskedHeader = apiKey && apiKey.length > 8
      ? `Token ${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
      : 'Token ****';
    console.log(`[DeepgramStt] Connecting to Deepgram Flux WS: ${url}`);
    console.log(`[DeepgramStt] Sending Authorization header: "${maskedHeader}"`);

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${apiKey}`
      },
      rejectUnauthorized: false
    });

    this.sttPromise = new Promise<void>((resolve) => {
      this.wsPromiseResolve = resolve;
    });

    this.ws.on('open', () => {
      console.log(`[DeepgramStt] Connection established successfully for call ${this.session.callSid}`);
    });

    this.ws.on('message', (data) => {
      if (this.isStopped) return;

      try {
        const response = JSON.parse(data.toString());

        // Deepgram Flux model uses TurnInfo messages for transcripts and events
        if (response.type === 'TurnInfo') {
          const eventType = response.event; // 'StartOfTurn', 'Update', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn'
          const transcriptText = response.transcript || '';
          
          // languages is returned as an array of BCP-47 language codes sorted by dominance
          const detectedLanguages: string[] = response.languages || [];
          const primaryLanguage = detectedLanguages[0]; // Take first/dominant language

          if (eventType === 'StartOfTurn') {
            console.log(`[STT] 🗣️ User Speech Started (StartOfTurn event) detected by Deepgram for call ${this.session.callSid}`);
            if (this.onTranscriptCallback) {
              this.onTranscriptCallback({
                text: '',
                isFinal: false,
                detectedLanguage: primaryLanguage,
                speechStarted: true,
              });
            }
          } else if (eventType === 'Update' || eventType === 'EndOfTurn') {
            const isFinal = eventType === 'EndOfTurn';
            console.log(`[STT] 📝 [Deepgram Event] Transcript: "${transcriptText}" | Final: ${isFinal} | Language: ${primaryLanguage || 'unknown'} (raw list: ${detectedLanguages.join(', ')})`);

            if (this.onTranscriptCallback && transcriptText.trim().length > 0) {
              this.onTranscriptCallback({
                text: transcriptText,
                isFinal,
                detectedLanguage: primaryLanguage // Pass BCP-47 code to match AWS format
              });
            }
          }
        }
      } catch (err) {
        console.error('[DeepgramStt] Error parsing WS event message:', err);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[DeepgramStt] Connection error:', err);
    });

    this.ws.on('close', () => {
      console.log(`[DeepgramStt] Connection closed for call ${this.session.callSid}`);
      if (this.wsPromiseResolve) {
        this.wsPromiseResolve();
        this.wsPromiseResolve = undefined;
      }
    });

    // Expose stream references on session for downstream compatibility
    this.session.sttPromise = this.sttPromise;
  }

  feed(chunk: Buffer): void {
    if (!this.hasForwardedAudio) {
      this.hasForwardedAudio = true;
      console.log(`[STT] [Deepgram] ⏩ Forwarding first audio chunk to Deepgram WebSocket for call ${this.session.callSid}`);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        try {
          this.ws.close();
        } catch (e) {
          console.error('[DeepgramStt] Error closing WS connection:', e);
        }
      }
      this.ws = null;
    }

    if (this.sttPromise) {
      try {
        await this.sttPromise;
      } catch (err) {
        console.error('[DeepgramStt] Error resolving STT stream:', err);
      }
    }
  }
}
export default DeepgramSttProvider;
