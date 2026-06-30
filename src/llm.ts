import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { config } from './config';
import { CallSession } from './session';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

/**
 * Streams the conversational response from Google Gemini.
 * Formats the call transcript history into Gemini's user/model structure,
 * applies the call systemPrompt, and yields text chunks as they become available.
 * 
 * Checks the `session.shouldAbortLlm` flag between chunks to support interruption / barge-in.
 * 
 * @param session The active CallSession object containing history and prompt config.
 * @param onTextChunk Callback invoked with each text chunk generated.
 * @returns The full accumulated text reply.
 */
export async function generateLlmReplyStream(
  session: CallSession,
  onTextChunk: (text: string) => void
): Promise<string> {
  // Ensure the abort flag is reset before starting a new generation
  session.shouldAbortLlm = false;

  // Convert speaker roles to Gemini roles ('user' -> 'user', 'agent' -> 'model')
  // For user turns, inject the Transcribe detected language as explicit metadata
  const contents = session.transcript.map(turn => ({
    role: turn.speaker === 'user' ? 'user' : 'model',
    parts: [{
      text: (turn.speaker === 'user' && turn.language)
        ? `[Language: ${turn.language}] ${turn.text}`
        : turn.text
    }]
  }));

  // Auto-inject instruction to mirror the caller's language dynamically
  const multilingualInstruction = `
[SYSTEM RULE: The user may speak to you in any language and may switch languages at any point in the conversation, from one full turn to the next. Always detect the language of the user's most recent message and respond fluently and naturally in that exact same language. Do not default to English unless the user is speaking English. Do not mix languages within a single response unless the user did so first.]`;

  let validationInstruction = '';
  if (session.strictValidation !== false) {
    validationInstruction = `
[SYSTEM RULE: ANSWER VALIDATION: When you ask the user for a specific piece of information (such as their name, country, city, date, phone number, or any other structured detail), check whether their response actually answers what you asked. If the response doesn't make sense for the question (for example, they give a city when you asked for a country, or an answer that's clearly incomplete, nonsensical, or off-topic), do NOT just acknowledge it and move on. Instead, politely point out the mismatch and ask again — for example, if you asked for their country and they said a city name, respond with something like 'I think Delhi is a city — could you tell me which country you're calling from?' Be natural and conversational about it, not robotic or repetitive. Only accept and move forward once the answer genuinely matches what you asked for. Use your own judgment for what counts as a reasonable answer — don't be overly strict on minor variations (e.g. 'India' vs 'Bharat' vs 'Hindustan' should all be accepted as valid country answers), but do catch clear category mismatches or nonsensical responses.]`;
  }

  const endCallInstruction = `
[SYSTEM RULE: CALL TERMINATION: If the conversation's purpose has been fulfilled, OR the user is being hostile/abusive/disrespectful, OR the user explicitly asks to end the call (e.g. 'please hang up,' 'I have to go,' 'stop calling me'), give a brief, polite closing response appropriate to the situation, and end your message with the exact text [END_CALL]. This token [END_CALL] will never be spoken to the user — it signals the system to hang up. For a hostile user, do not argue or escalate — give a short, calm, neutral closing line. Only use this token when the call should genuinely end, not in any other situation.]`;

  const combinedSystemPrompt = `${session.systemPrompt}\n${multilingualInstruction}\n${validationInstruction}\n${endCallInstruction}`;

  try {
    console.log(`[LLM] 🧠 Initiating Gemini stream for call ${session.callSid}...`);
    const responseStream = await ai.models.generateContentStream({
      model: config.gemini.model,
      contents: contents,
      config: {
        systemInstruction: combinedSystemPrompt,
        temperature: 0.7,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
      }
    });
    console.log(`[LLM] 🧠 Gemini stream established successfully for call ${session.callSid}`);

    let fullReply = '';
    for await (const chunk of responseStream) {
      // If user interrupted during LLM generation, exit early
      if (session.shouldAbortLlm) {
        console.log(`[LLM] 🛑 Aborting Gemini generation loop for call ${session.callSid}`);
        break;
      }
      
      const text = chunk.text;
      if (text) {
        if (fullReply === '') {
          console.log(`[LLM] 🧠 First Gemini response token received for call ${session.callSid}`);
        }
        fullReply += text;
        onTextChunk(text);
      }
    }
    console.log(`[LLM] 🧠 Finished receiving full Gemini reply for call ${session.callSid}. Total length: ${fullReply.length} chars.`);
    return fullReply;
  } catch (error) {
    console.error(`[LLM] ❌ Gemini generation failed / timed out for call ${session.callSid}:`, error);
    throw error;
  }
}
export { ai, ThinkingLevel };
