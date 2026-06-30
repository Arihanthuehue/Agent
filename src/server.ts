import express from 'express';
import WebSocket, { Server as WebSocketServer } from 'ws';
import http from 'http';
import cors from 'cors';
import twilio from 'twilio';
import { config } from './config';
import { sessionManager, CallSession } from './session';
import { createSttProvider } from './stt';
import { generateLlmReplyStream } from './llm';
import { createTtsStream } from './tts';
import { triggerOutboundCall, generateTwiML, handleStatusCallback } from './twilio';
import { insertTranscriptTurn, uploadRecording, updateCall, supabase } from './supabase';
import { writeWavHeader, SentenceChunker } from './utils';

const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

// Silence Prompt Config Constants
const SILENCE_TIMEOUT = parseInt(process.env.SILENCE_TIMEOUT || '10000', 10);
const SILENCE_CHECK_IN_MESSAGE = process.env.SILENCE_CHECK_IN_MESSAGE || "Hello, are you still there?";
const SILENCE_GOODBYE_MESSAGE = process.env.SILENCE_GOODBYE_MESSAGE || "Since I haven't heard from you, I'll go ahead and end the call now. Goodbye!";
const MAX_CALL_DURATION = parseInt(process.env.MAX_CALL_DURATION || '600000', 10);

async function terminateCall(callSid: string): Promise<boolean> {
  console.log(`[Twilio] 📞 API request to terminate live call ${callSid}...`);
  try {
    const call = await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`[Twilio] 📞 Call ${callSid} successfully completed via Twilio API. Status: ${call.status}`);
    return true;
  } catch (err: any) {
    console.error(`[Twilio] ❌ Failed to terminate call ${callSid} via Twilio API:`, err.message || err);
    return false;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// --- HTTP Webhook and API Endpoints ---

/**
 * Trigger outbound call REST endpoint.
 * POST /call { "to": "+1XXXYYYZZZZ", "systemPrompt": "...", "voiceId": "..." }
 */
app.post('/call', async (req, res) => {
  const { to, systemPrompt, voiceId, openingLine, strictValidation } = req.body;

  if (!to) {
    return res.status(400).json({ error: "Missing required parameter 'to'." });
  }

  try {
    const callSid = await triggerOutboundCall(to, systemPrompt, voiceId, openingLine, strictValidation);
    return res.status(200).json({
      message: 'Call successfully triggered.',
      callSid: callSid,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'Failed to place call.',
      details: error.message || error,
    });
  }
});

/**
 * Twilio TwiML callback endpoint.
 * Triggered by Twilio to retrieve TwiML instructions when call connects.
 */
app.post('/twiml', (req, res) => {
  const host = req.headers.host || '';
  console.log(`[Server] Generating TwiML for host: ${host}`);
  const twiml = generateTwiML(host);
  res.type('text/xml');
  res.send(twiml);
});

/**
 * Twilio status callback endpoint.
 * Informs our server of call termination (completed, busy, failed, etc.).
 */
app.post('/status-callback', async (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const duration = CallDuration ? parseInt(CallDuration, 10) : undefined;
  
  try {
    await handleStatusCallback(CallSid, CallStatus, duration);
    res.sendStatus(200);
  } catch (err) {
    console.error(`[Server] Error processing status-callback:`, err);
    res.sendStatus(500);
  }
});

/**
 * GET /voices
 * Proxies ElevenLabs' voice list so the frontend doesn't need to expose keys.
 */
app.get('/voices', async (_req, res) => {
  try {
    console.log('[Server] Fetching voices from ElevenLabs...');
    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': config.elevenlabs.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs API returned status: ${response.status}`);
    }

    const data: any = await response.json();
    return res.json(data.voices || []);
  } catch (error: any) {
    console.error('[Server] Failed to proxy voices list:', error);
    return res.status(500).json({
      error: 'Failed to fetch voices list.',
      details: error.message || error
    });
  }
});

/**
 * GET /calls
 * Fetches all past calls from Supabase.
 */
app.get('/calls', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('calls')
      .select('id, call_sid, to_number, duration_seconds, status, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json(data || []);
  } catch (error: any) {
    console.error('[Server] Failed to fetch call list:', error);
    return res.status(500).json({
      error: 'Failed to fetch call history.',
      details: error.message || error
    });
  }
});

/**
 * GET /calls/:id
 * Fetches details of a specific call, including transcript turns.
 */
app.get('/calls/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Fetch call metadata supporting both internal UUID and Twilio Call SID
    const isUuid = !id.startsWith('CA');
    const query = supabase.from('calls').select('*');
    if (isUuid) {
      query.eq('id', id);
    } else {
      query.eq('call_sid', id);
    }
    
    const { data: call, error: callError } = await query.single();

    if (callError || !call) {
      return res.status(404).json({ error: 'Call record not found.' });
    }

    // 2. Fetch transcript turns using verified call.id UUID
    const { data: turns, error: turnsError } = await supabase
      .from('transcript_turns')
      .select('speaker, text, created_at')
      .eq('call_id', call.id)
      .order('created_at', { ascending: true });

    if (turnsError) throw turnsError;

    return res.json({
      ...call,
      transcript: turns || []
    });
  } catch (error: any) {
    console.error(`[Server] Failed to fetch call details for ${id}:`, error);
    return res.status(500).json({
      error: 'Failed to fetch call details.',
      details: error.message || error
    });
  }
});

/**
 * GET /calls/:id/transcript
 * Downloads transcript in plain text (.txt) or raw JSON (.json).
 */
app.get('/calls/:id/transcript', async (req, res) => {
  const { id } = req.params;
  const format = req.query.format === 'json' ? 'json' : 'txt';

  try {
    // 1. Fetch call metadata supporting both internal UUID and Twilio Call SID
    const isUuid = !id.startsWith('CA');
    const query = supabase.from('calls').select('*');
    if (isUuid) {
      query.eq('id', id);
    } else {
      query.eq('call_sid', id);
    }
    
    const { data: call, error: callError } = await query.single();

    if (callError || !call) {
      return res.status(404).json({ error: 'Call record not found.' });
    }

    // 2. Fetch transcript turns using verified call.id UUID
    const { data: turns, error: turnsError } = await supabase
      .from('transcript_turns')
      .select('speaker, text, created_at')
      .eq('call_id', call.id)
      .order('created_at', { ascending: true });

    if (turnsError) throw turnsError;

    const filename = `call-${call.call_sid}-transcript.${format}`;

    if (format === 'json') {
      const payload = {
        metadata: {
          id: call.id,
          call_sid: call.call_sid,
          to_number: call.to_number,
          duration_seconds: call.duration_seconds,
          status: call.status,
          recording_url: call.recording_url,
          created_at: call.created_at
        },
        transcript: turns || []
      };

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      return res.send(JSON.stringify(payload, null, 2));
    } else {
      let textContent = `CALL TRANSCRIPT\n`;
      textContent += `========================================\n`;
      textContent += `Call SID: ${call.call_sid}\n`;
      textContent += `Recipient: ${call.to_number}\n`;
      textContent += `Status: ${call.status}\n`;
      textContent += `Duration: ${call.duration_seconds || 0} seconds\n`;
      textContent += `Connected At: ${call.created_at}\n`;
      textContent += `========================================\n\n`;

      if (turns && turns.length > 0) {
        turns.forEach((turn: any) => {
          const timeStr = new Date(turn.created_at).toLocaleTimeString();
          const speakerName = turn.speaker === 'user' ? 'USER' : 'AGENT';
          textContent += `[${timeStr}] ${speakerName}: ${turn.text}\n\n`;
        });
      } else {
        textContent += `(No dialogue captured)\n`;
      }

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'text/plain');
      return res.send(textContent);
    }
  } catch (error: any) {
    console.error(`[Server] Error preparing transcript download:`, error);
    return res.status(500).json({
      error: 'Failed to prepare transcript download.',
      details: error.message || error
    });
  }
});

// --- WebSocket handlers for Twilio Media Streams ---

wss.on('connection', (ws) => {
  console.log('[WebSocket] Connection opened from Twilio Media Streams.');
  let currentCallSid: string | undefined;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case 'start': {
          const startData = data.start;
          currentCallSid = startData.callSid;
          const streamSid = data.streamSid;

          console.log(`[WebSocket] Stream started. Call SID: ${currentCallSid}, Stream SID: ${streamSid}`);

          if (!currentCallSid) {
            console.error('[WebSocket] Missing callSid in start event.');
            ws.close();
            return;
          }

          // Lookup session initialized by triggerOutboundCall
          const session = sessionManager.getSession(currentCallSid);
          if (!session) {
            console.error(`[WebSocket] No active session found for Call SID: ${currentCallSid}`);
            ws.close();
            return;
          }

          // Associate stream SID
          session.streamSid = streamSid;

          // Start Hard Max Call Duration timer (default 10 minutes)
          session.maxCallTimeoutId = setTimeout(async () => {
            console.log(`[Server] 🛑 Hard maximum call duration of ${MAX_CALL_DURATION}ms exceeded for call ${session.callSid}. Forcing termination.`);
            await terminateCall(session.callSid);
            await safeCleanupSession(session);
          }, MAX_CALL_DURATION);

          // 1. Establish configured STT Provider in the background
          const sttProvider = createSttProvider(session);
          session.sttProvider = sttProvider;
          
          await sttProvider.start((result) => {
            if (session.callEnding) {
              console.log(`[STT] [Deafened] Ignored STT event (speechStarted: ${result.speechStarted}, text: "${result.text}") because callEnding is true for call ${session.callSid}`);
              return;
            }
            if (result.speechStarted) {
              // Log StartOfTurn but ignore for immediate barge-in. We wait for actual transcript words.
              console.log(`[STT] [Barge-in] StartOfTurn event received for call ${session.callSid} (ignored for immediate cut-off, waiting for text)`);
            } else {
              handleSpeechTranscript(session, ws, result.text, result.isFinal, result.detectedLanguage);
            }
          });

          // 2. Trigger the agent's welcome greeting
          triggerAgentGreeting(session, ws);
          break;
        }

        case 'media': {
          if (!currentCallSid) return;
          const session = sessionManager.getSession(currentCallSid);
          if (!session) return;

          if (session.callEnding) {
            return;
          }

          const payload = data.media.payload;
          const chunk = Buffer.from(payload, 'base64');

          // Log when Twilio Media Stream audio data starts arriving
          if (!session.hasReceivedAudio) {
            session.hasReceivedAudio = true;
            console.log(`[TWILIO] 🎙️ First audio stream media chunk received for call ${currentCallSid}`);
          }

          // Archive audio chunk for call recording
          session.audioChunks.push(chunk);

          // Stream audio chunk into STT provider
          session.sttProvider?.feed(chunk);
          break;
        }

        case 'stop': {
          console.log(`[WebSocket] Stream stop event received for Call SID: ${currentCallSid}`);
          if (currentCallSid) {
            const session = sessionManager.getSession(currentCallSid);
            if (session) {
              await safeCleanupSession(session);
            }
          }
          break;
        }
      }
    } catch (error) {
      console.error('[WebSocket] Error processing message:', error);
    }
  });

  ws.on('close', async () => {
    console.log(`[WebSocket] Connection closed for Call SID: ${currentCallSid}`);
    if (currentCallSid) {
      const session = sessionManager.getSession(currentCallSid);
      if (session) {
        await safeCleanupSession(session);
      }
    }
  });
});



/**
 * Handles speech transcript segments from the active STT provider.
 * Implements barge-in (interruption) and queries Gemini for responses on finalized speech.
 */
/**
 * Utility function to filter background noise and verify whether the user actually spoke genuine content.
 * Evaluates the word count threshold.
 */
function isGenuineSpeech(text: string, callSid: string): boolean {
  const cleanText = text.trim();
  if (cleanText.length === 0) return false;

  // Strip punctuation to check the clean words
  const cleanWords = cleanText.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").split(/\s+/).filter(Boolean);
  if (cleanWords.length === 0) return false;

  // Any phrase with 2 or more words is accepted as genuine speech
  if (cleanWords.length >= 2) {
    console.log(`[STT] [Speech Check] ✅ ACCEPTED text "${cleanText}" (word count ${cleanWords.length} >= 2) as genuine speech for call ${callSid}`);
    return true;
  }

  // Single word validation
  const singleWord = cleanWords[0].toLowerCase();
  
  // Set of non-speech fillers and single character fragments (breathing/static artifacts)
  const noiseFillers = new Set(['uh', 'um', 'ah', 'oh', 'er', 'eh', 'm', 'h', 's', 't', 'uhm', 'huh', 'snort', 'cough', 'click']);
  const isNoise = noiseFillers.has(singleWord);

  // Check if it has any valid unicode letters
  const hasLetters = /\p{L}/u.test(singleWord);
  
  // Exclude single consonant fragments (like just 'd' or 'c') but accept valid single-letter words (like 'i', 'a', 'y', 'o')
  const isSingleCharNoise = singleWord.length === 1 && !['i', 'a', 'y', 'o'].includes(singleWord);

  const isGenuine = hasLetters && !isNoise && !isSingleCharNoise;

  if (!isGenuine) {
    console.log(`[STT] [Speech Check] 🤫 IGNORED single-word text "${cleanText}" (treated as noise/filler fragment: "${singleWord}") for call ${callSid}`);
  } else {
    console.log(`[STT] [Speech Check] ✅ ACCEPTED single-word "${cleanText}" as genuine speech for call ${callSid}`);
  }

  return isGenuine;
}

/**
 * Handles speech transcript segments from the active STT provider.
 * Implements barge-in (interruption) and queries Gemini for responses on finalized speech.
 */
async function handleSpeechTranscript(
  session: CallSession,
  twilioWs: WebSocket,
  text: string,
  isFinal: boolean,
  detectedLanguage?: string
) {
  if (session.callEnding) {
    console.log(`[STT] [Deafened] Ignored transcript text "${text}" because callEnding is true for call ${session.callSid}`);
    return;
  }

  const cleanText = text.trim();
  if (cleanText.length === 0) return;

  const genuine = isGenuineSpeech(cleanText, session.callSid);

  // Reset/cancel silence timer ONLY on genuine speech
  if (genuine) {
    console.log(`[Silence Timer] ⏱️ Resetting silence timer for call ${session.callSid} due to genuine user speech.`);
    clearSilenceTimer(session);
    session.consecutiveSilenceCount = 0;
  } else {
    console.log(`[Silence Timer] ⏱️ Ignoring non-genuine user speech for call ${session.callSid}. Silence timer remains active.`);
  }

  // 1. Barge-in (Interruption) detection
  if (session.agentIsSpeaking) {
    // Protect opening line from any interruption
    if (session.isPlayingOpeningLine) {
      console.log(`[STT] [Barge-in Check] 🔒 IGNORED user speech during protected opening line for call ${session.callSid}: "${cleanText}"`);
      return;
    }

    if (!genuine) {
      // Barge-in ignored due to noise filter
      return;
    }

    console.log(`[STT] [Barge-in Check] ⚡ ACCEPTED interruption for speech: "${cleanText}" for call ${session.callSid}`);
    session.ttsInterrupted = true;
    sessionManager.interruptAgent(session);
    
    // Command Twilio to discard all queued TTS audio on the call
    if (session.streamSid) {
      twilioWs.send(JSON.stringify({
        event: 'clear',
        streamSid: session.streamSid,
      }));
    }
  }

  // 2. Process final transcript turn
  if (isFinal) {
    if (!genuine) {
      console.log(`[STT] 🏁 EndOfTurn event fired but text "${cleanText}" is not genuine speech. Skipping Gemini request for call ${session.callSid}`);
      return;
    }

    const endOfTurnTime = Date.now();
    let firstGeminiTokenTime = 0;
    let hasLoggedLatency = false;

    console.log(`[STT] 🏁 EndOfTurn event fired. User finalized text: "${cleanText}" [Language: ${detectedLanguage || 'en-US'}]`);
    console.log(`[LLM] 🧠 Sending conversation history + prompt to Gemini for call ${session.callSid}...`);

    // Add user turn to dialogue history, caching the language tag
    session.transcript.push({
      speaker: 'user',
      text: cleanText,
      timestamp: new Date(),
      language: detectedLanguage,
    });
    
    // Persist turn in Supabase in real-time including language column
    await insertTranscriptTurn(session.callSid, 'user', cleanText, detectedLanguage);

    // Set speaking flag before processing Gemini logic
    session.agentIsSpeaking = true;
    session.ttsInterrupted = false;

    try {
      // Connect ElevenLabs TTS stream, passing the language code derived from user transcription
      const ttsStream = await createTtsStream(session, twilioWs, detectedLanguage, () => {
        // Triggered when first audio chunk arrives from ElevenLabs
        if (!hasLoggedLatency && firstGeminiTokenTime > 0) {
          hasLoggedLatency = true;
          const firstElevenLabsAudioTime = Date.now();
          console.log(`[Latency] ⏱️ STT EndOfTurn -> First Gemini token: ${firstGeminiTokenTime - endOfTurnTime}ms`);
          console.log(`[Latency] ⏱️ First Gemini token -> ElevenLabs audio: ${firstElevenLabsAudioTime - firstGeminiTokenTime}ms`);
          console.log(`[Latency] ⏱️ Total response latency to Twilio: ${firstElevenLabsAudioTime - endOfTurnTime}ms`);
        }
      }, async () => {
        // Triggered when response completed playing back to the caller
        console.log(`[Server] Response completed playback for call ${session.callSid}.`);
        if (session.callEnding) {
          console.log(`[Server] callEnding is true. Delaying call termination to allow Twilio audio buffer to flush...`);
          setTimeout(async () => {
            console.log(`[Server] 📞 Confirming closing line is fully done playing. Triggering terminateCall for call ${session.callSid}.`);
            await terminateCall(session.callSid);
            await safeCleanupSession(session);
          }, 3000);
        } else {
          session.agentIsSpeaking = false;
          resetSilenceTimer(session, twilioWs);
        }
      });

      // Stream text response from Gemini, split on sentence boundaries, and pipe to ElevenLabs
      const chunker = new SentenceChunker((sentence) => {
        if (!session.ttsInterrupted && session.agentIsSpeaking) {
          // Strip the [END_CALL] token from the stream chunk to prevent ElevenLabs from speaking it
          const cleanSentence = sentence.replace('[END_CALL]', '').trim();
          if (cleanSentence.length > 0) {
            console.log(`[TTS] 📤 Sending clause text to ElevenLabs: "${cleanSentence}"`);
            ttsStream.sendText(cleanSentence);
          }
        }
      });

      const fullReply = await generateLlmReplyStream(session, (textChunk) => {
        if (firstGeminiTokenTime === 0) {
          firstGeminiTokenTime = Date.now();
        }
        // Strip the [END_CALL] token from the stream chunk to prevent ElevenLabs from speaking it
        const cleanChunk = textChunk.replace('[END_CALL]', '');
        chunker.addChunk(cleanChunk);
      });

      // Flush remaining clause text in chunker buffer
      chunker.flush();

      // Check if Gemini request contains the call termination token
      const hasEndToken = fullReply.includes('[END_CALL]');
      if (hasEndToken) {
        session.callEnding = true;
        console.log(`[Server] 🛑 [END_CALL] token detected in Gemini response. Flagging callEnding = true for call ${session.callSid}`);
      }

      // Let ElevenLabs know we have finished streaming input text
      ttsStream.finalize();

      // Save agent response to memory history and Supabase DB ONLY if not interrupted
      if (fullReply.trim().length > 0 && !session.ttsInterrupted && !session.shouldAbortLlm) {
        const cleanReply = fullReply.replace('[END_CALL]', '').trim();
        session.transcript.push({
          speaker: 'agent',
          text: cleanReply,
          timestamp: new Date(),
          language: detectedLanguage, // Mirror the detected language
        });
        await insertTranscriptTurn(session.callSid, 'agent', cleanReply, detectedLanguage);
      } else if (session.ttsInterrupted) {
        console.log(`[Barge-in] 🚫 Agent response was interrupted mid-turn. Omitted from Gemini history.`);
      }
    } catch (error) {
      console.error(`[Server] Error processing conversational turn for call ${session.callSid}:`, error);
      session.agentIsSpeaking = false;
      resetSilenceTimer(session, twilioWs);
    }
  }
}

function clearSilenceTimer(session: CallSession) {
  if (session.silenceTimeoutId) {
    console.log(`[Silence Timer] ⏱️ Clearing active timer for call ${session.callSid}`);
    clearTimeout(session.silenceTimeoutId);
    session.silenceTimeoutId = undefined;
  }
}

function resetSilenceTimer(session: CallSession, twilioWs: WebSocket) {
  clearSilenceTimer(session);

  // Do not run silence timer if agent is speaking or the opening line is playing
  if (session.agentIsSpeaking || session.isPlayingOpeningLine) {
    console.log(`[Silence Timer] ⏱️ Skipping timer arming for call ${session.callSid} (agentIsSpeaking: ${session.agentIsSpeaking}, isPlayingOpeningLine: ${session.isPlayingOpeningLine})`);
    return;
  }

  console.log(`[Silence Timer] ⏱️ Armed, will fire in ${SILENCE_TIMEOUT / 1000}s if no genuine speech detected for call ${session.callSid}`);
  session.silenceTimeoutId = setTimeout(async () => {
    console.log(`[Silence Timer] ⏱️ Silence threshold crossed for call ${session.callSid}`);
    await handleSilenceTimeout(session, twilioWs);
  }, SILENCE_TIMEOUT);
}

async function handleSilenceTimeout(session: CallSession, twilioWs: WebSocket) {
  session.silenceTimeoutId = undefined;
  session.consecutiveSilenceCount = (session.consecutiveSilenceCount || 0) + 1;

  if (session.consecutiveSilenceCount >= 3) {
    console.log(`[Silence] 🛑 3 consecutive silence timeouts reached for call ${session.callSid}. Hanging up gracefully.`);
    try {
      session.agentIsSpeaking = true;
      const ttsStream = await createTtsStream(session, twilioWs, undefined, () => {
        session.agentIsSpeaking = true;
      }, async () => {
        console.log(`[Silence] Goodbye TTS finished. Delaying Twilio REST call hangup to allow audio buffer to flush.`);
        setTimeout(async () => {
          console.log(`[Silence] 📞 Confirming goodbye line is fully done playing. Triggering terminateCall for call ${session.callSid}.`);
          await terminateCall(session.callSid);
          await safeCleanupSession(session);
        }, 3000);
      });

      console.log(`[TTS] 📤 Sending goodbye text to ElevenLabs: "${SILENCE_GOODBYE_MESSAGE}"`);
      ttsStream.sendText(SILENCE_GOODBYE_MESSAGE);
      ttsStream.finalize();

      session.transcript.push({
        speaker: 'agent',
        text: SILENCE_GOODBYE_MESSAGE,
        timestamp: new Date(),
        language: 'en-US',
      });
      await insertTranscriptTurn(session.callSid, 'agent', SILENCE_GOODBYE_MESSAGE, 'en-US');
    } catch (err) {
      console.error(`[Silence] Failed to play goodbye prompt:`, err);
      await terminateCall(session.callSid);
      await safeCleanupSession(session);
    }
  } else {
    console.log(`[Silence] ⚠️ Silence timeout #${session.consecutiveSilenceCount}. Prompting check-in message: "${SILENCE_CHECK_IN_MESSAGE}" for call ${session.callSid}`);
    try {
      session.agentIsSpeaking = true;
      const ttsStream = await createTtsStream(session, twilioWs, undefined, () => {
        session.agentIsSpeaking = true;
      }, () => {
        console.log(`[Silence] Check-in prompt completed playing. Re-arming silence timer.`);
        session.agentIsSpeaking = false;
        resetSilenceTimer(session, twilioWs);
      });

      console.log(`[TTS] 📤 Sending check-in prompt text to ElevenLabs: "${SILENCE_CHECK_IN_MESSAGE}"`);
      ttsStream.sendText(SILENCE_CHECK_IN_MESSAGE);
      ttsStream.finalize();

      session.transcript.push({
        speaker: 'agent',
        text: SILENCE_CHECK_IN_MESSAGE,
        timestamp: new Date(),
        language: 'en-US',
      });
      await insertTranscriptTurn(session.callSid, 'agent', SILENCE_CHECK_IN_MESSAGE, 'en-US');
    } catch (err) {
      console.error(`[Silence] Failed to play check-in prompt:`, err);
      session.agentIsSpeaking = false;
      resetSilenceTimer(session, twilioWs);
    }
  }
}

/**
 * Handles playing the custom opening line greeting when the call connects.
 * If no opening line is configured, the bot remains silent waiting for user speech.
 */
async function triggerAgentGreeting(session: CallSession, twilioWs: WebSocket) {
  if (!session.openingLine) {
    console.log(`[Server] No opening line configured for call ${session.callSid}. Waiting for user to speak first...`);
    // Arm silence timer directly if no opening line is playing
    resetSilenceTimer(session, twilioWs);
    return;
  }

  console.log(`[Server] [TTS] Triggering configured opening line: "${session.openingLine}" for call ${session.callSid}`);
  session.agentIsSpeaking = true;
  session.isPlayingOpeningLine = true; // Lock barge-in interruptions

  try {
    const ttsStream = await createTtsStream(session, twilioWs, undefined, () => {
      session.agentIsSpeaking = true;
    }, () => {
      console.log(`[Server] Opening line completed playback for call ${session.callSid}. Unlocking interruptions.`);
      session.isPlayingOpeningLine = false;
      session.agentIsSpeaking = false;
      resetSilenceTimer(session, twilioWs);
    });

    // Send the fixed opening line directly to ElevenLabs stream
    console.log(`[TTS] 📤 Sending opening line text to ElevenLabs: "${session.openingLine}"`);
    ttsStream.sendText(session.openingLine);
    ttsStream.finalize();

    // Record the turn in memory history and Supabase DB
    session.transcript.push({
      speaker: 'agent',
      text: session.openingLine,
      timestamp: new Date(),
      language: 'en-US',
    });
    await insertTranscriptTurn(session.callSid, 'agent', session.openingLine, 'en-US');
  } catch (error) {
    console.error(`[Server] Error playing opening line greeting for call ${session.callSid}:`, error);
    session.isPlayingOpeningLine = false;
    session.agentIsSpeaking = false;
    resetSilenceTimer(session, twilioWs);
  }
}

/**
 * Handles thread-safe session cleanup and audio recording upload to Supabase storage.
 * Ensures the operations are executed exactly once per call.
 */
async function safeCleanupSession(session: CallSession): Promise<void> {
  clearSilenceTimer(session);
  if (session.maxCallTimeoutId) {
    console.log(`[Server] Clearing hard max duration timer for call ${session.callSid}`);
    clearTimeout(session.maxCallTimeoutId);
    session.maxCallTimeoutId = undefined;
  }
  const sessionWithLock = session as any;
  if (sessionWithLock.cleanupPromise) {
    return sessionWithLock.cleanupPromise;
  }

  sessionWithLock.cleanupPromise = (async () => {
    console.log(`[Server] Commencing cleanup and persistence for call ${session.callSid}...`);

    // 1. Terminate audio stream listener and wait for provider to clean up
    if (session.sttProvider) {
      try {
        await session.sttProvider.stop();
      } catch (err) {
        console.error(`[Server] Error stopping STT provider:`, err);
      }
    }

    // 3. Upload recording file to Supabase Storage
    if (session.audioChunks.length > 0) {
      try {
        const rawAudio = Buffer.concat(session.audioChunks);
        // Formulate valid mono 8kHz mu-law WAV file
        const wavHeader = writeWavHeader(rawAudio.length);
        const wavFile = Buffer.concat([wavHeader, rawAudio]);

        const publicUrl = await uploadRecording(session.callSid, wavFile);
        if (publicUrl) {
          // Update DB with recording url
          await updateCall(session.callSid, {
            status: 'completed',
            recording_url: publicUrl,
          });
        }
      } catch (err) {
        console.error(`[Server] Error uploading recording file:`, err);
      }
    } else {
      console.log(`[Server] No audio chunks generated to upload for call ${session.callSid}`);
      await updateCall(session.callSid, { status: 'completed' });
    }

    // 4. Delete session from manager
    sessionManager.deleteSession(session.callSid);
    console.log(`[Server] Session metadata cleaned up for call ${session.callSid}`);
  })();

  return sessionWithLock.cleanupPromise;
}

// --- WebSocket upgrade coordination ---

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

  if (pathname === '/stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

export { server, app };
