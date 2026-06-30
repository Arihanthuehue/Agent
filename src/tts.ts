import WebSocket from 'ws';
import { config } from './config';
import { CallSession } from './session';

interface TtsStreamHandler {
  sendText: (text: string) => void;
  finalize: () => void;
}

/**
 * Establishes a real-time text-to-speech connection with ElevenLabs using WebSockets.
 * Listens for audio chunks returning from ElevenLabs and pipes them back to Twilio.
 * 
 * @param session The active CallSession object.
 * @param twilioWs The WebSocket connection back to Twilio Media Streams.
 * @param onAudioStarted Optional callback triggered when the first audio chunk is received.
 * @returns A promise resolving to helper methods to stream text and finalize the sequence.
 */
export function createTtsStream(
  session: CallSession,
  twilioWs: WebSocket,
  languageCode?: string,
  onAudioStarted?: () => void,
  onAudioFinished?: () => void
): Promise<TtsStreamHandler> {
  return new Promise((resolve, reject) => {
    const voiceId = session.voiceId || config.elevenlabs.voiceId;
    const modelId = config.elevenlabs.modelId;
    const apiKey = config.elevenlabs.apiKey;
    
    // Append language_code query parameter if provided (mapped from BCP-47 to ISO-639-1)
    let url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=ulaw_8000`;
    if (languageCode) {
      const isoCode = languageCode.split('-')[0];
      url += `&language_code=${isoCode}`;
      console.log(`[TTS] ElevenLabs stream connecting with language code parameter: "${isoCode}" (derived from "${languageCode}")`);
    }
    
    const ws = new WebSocket(url);
    session.activeTtsSocket = ws;

    let hasTriggeredAudioStart = false;
    let hasTriggeredAudioFinished = false;

    const triggerFinishedOnce = () => {
      if (!hasTriggeredAudioFinished) {
        hasTriggeredAudioFinished = true;
        if (onAudioFinished) onAudioFinished();
      }
    };

    ws.on('open', () => {
      console.log(`[TTS] Connected to ElevenLabs TTS WebSocket for call ${session.callSid}`);
      
      // 1. Send the initialization chunk containing the API Key and voice settings
      const initMessage = {
        text: " ",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8
        },
        xi_api_key: apiKey
      };
      ws.send(JSON.stringify(initMessage));
      
      // 2. Resolve the promise with control actions
      resolve({
        sendText: (text: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              text: text,
              try_trigger_generation: true
            }));
          }
        },
        finalize: () => {
          if (ws.readyState === WebSocket.OPEN) {
            // Sending an empty string tells ElevenLabs that the generation sequence is complete.
            ws.send(JSON.stringify({
              text: ""
            }));
          }
        }
      });
    });

    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        
        if (response.audio) {
          // If the agent was interrupted, discard the audio chunk
          if (!session.agentIsSpeaking || !session.streamSid) {
            return;
          }

          if (!hasTriggeredAudioStart && onAudioStarted) {
            hasTriggeredAudioStart = true;
            console.log(`[TTS] 📥 First audio chunk received from ElevenLabs for call ${session.callSid}`);
            onAudioStarted();
          }

          // Forward the base64-encoded G.711 mu-law audio chunk directly to Twilio Media Streams
          console.log(`[TWILIO] 📥 Writing audio chunk (${response.audio.length} base64 chars) to Twilio connection for call ${session.callSid}`);
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: session.streamSid,
            media: {
              payload: response.audio
            }
          }));
        }
        
        if (response.isFinal) {
          console.log(`[TTS] Finished playing speech turn for call ${session.callSid}`);
          triggerFinishedOnce();
        }
      } catch (err) {
        console.error(`[TTS] Error parsing ElevenLabs response for call ${session.callSid}:`, err);
      }
    });

    ws.on('error', (err) => {
      console.error(`[TTS] ElevenLabs WebSocket error for call ${session.callSid}:`, err);
      reject(err);
    });

    ws.on('close', () => {
      console.log(`[TTS] ElevenLabs WebSocket closed for call ${session.callSid}`);
      if (session.activeTtsSocket === ws) {
        session.activeTtsSocket = undefined;
      }
      triggerFinishedOnce();
    });
  });
}
