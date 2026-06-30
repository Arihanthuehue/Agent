import { CallSession } from './session';
import { config } from './config';
import { AwsSttProvider } from './sttAws';
import { DeepgramSttProvider } from './sttDeepgram';

export interface SttResult {
  text: string;
  isFinal: boolean;
  detectedLanguage?: string;
  speechStarted?: boolean;
}

export interface SttProvider {
  /**
   * Initializes the speech-to-text connection and listens for transcript returns.
   */
  start(onTranscript: (result: SttResult) => void): Promise<void>;
  
  /**
   * Streams raw audio buffer chunks into the provider.
   */
  feed(chunk: Buffer): void;
  
  /**
   * Stops the stream and handles cleanup resource closures.
   */
  stop(): Promise<void>;
}

/**
 * Factory function to instantiate the active speech-to-text provider
 * specified by the STT_PROVIDER environment variable.
 * 
 * @param session The active call session.
 */
export function createSttProvider(session: CallSession): SttProvider {
  const provider = config.sttProvider.toLowerCase();
  
  if (provider === 'deepgram') {
    return new DeepgramSttProvider(session);
  } else {
    // Default fallback to 'aws'
    if (provider !== 'aws') {
      console.warn(`[STT] Unknown STT_PROVIDER "${provider}". Defaulting to "aws".`);
    }
    return new AwsSttProvider(session);
  }
}
