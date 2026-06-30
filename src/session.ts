import { AudioQueue } from './utils';
import WebSocket from 'ws';

export interface TranscriptTurn {
  speaker: 'user' | 'agent';
  text: string;
  timestamp: Date;
  language?: string;
}

export interface CallSession {
  callSid: string;
  streamSid?: string;
  toNumber: string;
  systemPrompt: string;
  status: string;
  createdAt: Date;
  
  // Accumulated raw audio buffers for call recording
  audioChunks: Buffer[];
  
  // Dialog turns
  transcript: TranscriptTurn[];
  
  // AWS Transcribe variables
  sttQueue?: AudioQueue;
  sttPromise?: Promise<void>;
  
  // Agent speech state & controls for barge-in (interruption)
  agentIsSpeaking: boolean;
  activeTtsSocket?: WebSocket;
  shouldAbortLlm: boolean;
  voiceId?: string;
  sttProvider?: any;
  ttsInterrupted?: boolean;
  openingLine?: string;
  hasReceivedAudio?: boolean;
  isPlayingOpeningLine?: boolean;
  silenceTimeoutId?: any;
  consecutiveSilenceCount?: number;
  strictValidation?: boolean;
  callEnding?: boolean;
  maxCallTimeoutId?: any;
}

class SessionManager {
  private sessions = new Map<string, CallSession>();

  /**
   * Spawns a new call session configuration.
   */
  createSession(
    callSid: string,
    sessionData: Omit<CallSession, 'createdAt' | 'audioChunks' | 'transcript' | 'agentIsSpeaking' | 'shouldAbortLlm'>
  ): CallSession {
    const session: CallSession = {
      ...sessionData,
      createdAt: new Date(),
      audioChunks: [],
      transcript: [],
      agentIsSpeaking: false,
      shouldAbortLlm: false,
    };
    this.sessions.set(callSid, session);
    return session;
  }

  /**
   * Retrieves an active session by its Twilio Call SID.
   */
  getSession(callSid: string): CallSession | undefined {
    return this.sessions.get(callSid);
  }

  /**
   * Retrieves an active session by its Twilio Media Stream SID.
   */
  getSessionByStreamSid(streamSid: string): CallSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.streamSid === streamSid) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Removes a session from memory when the call terminates.
   */
  deleteSession(callSid: string) {
    this.sessions.delete(callSid);
  }

  /**
   * Interrupts the active agent response for a session.
   * Stops Gemini text processing, terminates active ElevenLabs synthesis sockets, 
   * and clears the agent speaker state.
   */
  interruptAgent(session: CallSession) {
    if (!session.agentIsSpeaking) return;
    
    console.log(`[Session] 🛑 Interrupting active agent for call ${session.callSid}`);
    
    // Set interruption flag so LLM loop knows to break
    session.shouldAbortLlm = true;
    session.agentIsSpeaking = false;

    // Terminate the active ElevenLabs WebSocket connection
    if (session.activeTtsSocket) {
      if (session.activeTtsSocket.readyState === WebSocket.OPEN || session.activeTtsSocket.readyState === WebSocket.CONNECTING) {
        try {
          session.activeTtsSocket.close();
          console.log(`[Session] ElevenLabs TTS connection closed due to user interruption.`);
        } catch (err) {
          console.error(`[Session] Error closing ElevenLabs TTS socket:`, err);
        }
      }
      session.activeTtsSocket = undefined;
    }
  }
}

export const sessionManager = new SessionManager();
export type { SessionManager };
