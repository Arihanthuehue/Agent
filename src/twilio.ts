import twilio from 'twilio';
import { config } from './config';
import { sessionManager } from './session';
import { insertCall, updateCall } from './supabase';

const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

/**
 * Places an outbound phone call using Twilio API.
 * Spawns a session record in-memory and in Supabase before connecting.
 * 
 * @param to The target phone number (in E.164 format, e.g. +1XXXYYYZZZZ).
 * @param systemPrompt Custom persona prompt for the AI agent.
 */
export async function triggerOutboundCall(
  to: string,
  systemPrompt?: string,
  voiceId?: string,
  openingLine?: string,
  strictValidation?: boolean
): Promise<string> {
  const prompt = systemPrompt || "You are a helpful and polite conversational AI assistant.";
  const twiMlUrl = `${config.publicUrl}/twiml`;
  const callbackUrl = `${config.publicUrl}/status-callback`;

  console.log(`[Twilio] Initiating outbound call to ${to}...`);
  console.log(`[Twilio] Using TwiML URL: ${twiMlUrl}`);

  try {
    const call = await twilioClient.calls.create({
      url: twiMlUrl,
      to,
      from: config.twilio.phoneNumber,
      statusCallback: callbackUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    console.log(`[Twilio] Call initiated. SID: ${call.sid}, Status: ${call.status}`);

    // Initialize session in memory
    sessionManager.createSession(call.sid, {
      callSid: call.sid,
      toNumber: to,
      systemPrompt: prompt,
      status: call.status,
      voiceId: voiceId,
      openingLine: openingLine,
      strictValidation: strictValidation,
    });

    // Initialize row in database
    await insertCall(call.sid, to);

    return call.sid;
  } catch (error) {
    console.error(`[Twilio] Error triggering outbound call:`, error);
    throw error;
  }
}

/**
 * Generates TwiML response pointing Twilio to the WebSocket server stream.
 * 
 * @param host The hostname (e.g. ngrok domain) to route the WebSocket connection back to.
 */
export function generateTwiML(host: string): string {
  // Use wss:// protocol since Twilio streams require TLS for public endpoints.
  const wsUrl = `wss://${host}/stream`;
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
}

/**
 * Handles the call lifecycle updates posted by Twilio's Status Callback.
 * Updates the database state (duration and status) when the call finishes.
 * 
 * @param callSid The Twilio Call SID.
 * @param status The final status of the call (completed, failed, busy, etc.).
 * @param durationSeconds The length of the call in seconds (if completed).
 */
export async function handleStatusCallback(
  callSid: string,
  status: string,
  durationSeconds?: number
) {
  console.log(`[Twilio Callback] Call ${callSid} ended with status: ${status}, duration: ${durationSeconds}s`);

  // Update in Supabase
  await updateCall(callSid, {
    status,
    duration_seconds: durationSeconds,
  });

  // Update memory session status if it still exists
  const session = sessionManager.getSession(callSid);
  if (session) {
    session.status = status;
  }
}
export { twilioClient };
