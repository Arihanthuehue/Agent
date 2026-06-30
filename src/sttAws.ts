import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from '@aws-sdk/client-transcribe-streaming';
import { config } from './config';
import { decodeMuLawToPcm, AudioQueue } from './utils';
import { CallSession } from './session';
import { SttProvider, SttResult } from './stt';

const transcribeClient = new TranscribeStreamingClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

/**
 * AWS Transcribe implementation of the SttProvider interface.
 */
export class AwsSttProvider implements SttProvider {
  private session: CallSession;
  private queue: AudioQueue;
  private sttPromise?: Promise<void>;
  private hasForwardedAudio = false;

  constructor(session: CallSession) {
    this.session = session;
    this.queue = new AudioQueue();
    // Maintain backwards compatibility reference on the session
    session.sttQueue = this.queue;
  }

  async start(onTranscript: (result: SttResult) => void): Promise<void> {
    const makeAudioStream = async function* (queue: AudioQueue) {
      for await (const chunk of queue) {
        // Decode raw 8-bit mu-law to 16-bit linear PCM (little-endian)
        const pcmChunk = decodeMuLawToPcm(Buffer.from(chunk));
        yield {
          AudioEvent: {
            AudioChunk: pcmChunk,
          },
        };
      }
    };

    const command = new StartStreamTranscriptionCommand({
      IdentifyLanguage: true,
      LanguageOptions: config.aws.candidateLanguages.join(','),
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 8000,
      AudioStream: makeAudioStream(this.queue),
    });

    this.sttPromise = (async () => {
      try {
        console.log(`[AwsStt] Starting AWS Transcribe stream for call ${this.session.callSid}...`);
        console.log(`[AwsStt] Candidate languages: ${config.aws.candidateLanguages.join(', ')}`);
        const response = await transcribeClient.send(command);
        console.log(`[AwsStt] AWS Transcribe stream established successfully for call ${this.session.callSid}.`);

        if (!response.TranscriptResultStream) {
          throw new Error("AWS Transcribe returned an empty TranscriptResultStream.");
        }

        // Process stream events returned by AWS Transcribe
        for await (const event of response.TranscriptResultStream) {
          if (event.TranscriptEvent && event.TranscriptEvent.Transcript) {
            const results = event.TranscriptEvent.Transcript.Results;
            if (results && results.length > 0) {
              const result = results[0];
              const isPartial = result.IsPartial ?? true;
              const detectedLanguage = result.LanguageCode;

              // Warning check if the language code returned is outside our candidate list
              if (detectedLanguage && !config.aws.candidateLanguages.includes(detectedLanguage)) {
                console.warn(`[AwsStt] ⚠️ Warning: AWS Transcribe guessed "${detectedLanguage}" which is not in our candidate list config.`);
              }

              const alternatives = result.Alternatives;
              if (alternatives && alternatives.length > 0) {
                const transcriptText = alternatives[0].Transcript ?? '';
                onTranscript({
                  text: transcriptText,
                  isFinal: !isPartial,
                  detectedLanguage,
                });
              }
            }
          }
        }
      } catch (error) {
        console.error(`[AwsStt] Error during AWS Transcribe stream for call ${this.session.callSid}:`, error);
      } finally {
        console.log(`[AwsStt] AWS Transcribe stream handler terminated for call ${this.session.callSid}.`);
      }
    })();

    // Expose reference on session for downstream compatibility
    this.session.sttPromise = this.sttPromise;
  }

  feed(chunk: Buffer): void {
    if (!this.hasForwardedAudio) {
      this.hasForwardedAudio = true;
      console.log(`[STT] [AWS] ⏩ Forwarding first audio chunk to AWS Transcribe queue for call ${this.session.callSid}`);
    }
    this.queue.push(chunk);
  }

  async stop(): Promise<void> {
    this.queue.stop();
    if (this.sttPromise) {
      try {
        await this.sttPromise;
      } catch (err) {
        console.error(`[AwsStt] Error resolving STT stream:`, err);
      }
    }
  }
}
export default AwsSttProvider;
