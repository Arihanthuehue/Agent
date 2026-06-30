import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { config } from './config';

// Polyfill global WebSocket for Node.js < 22 to prevent Supabase Realtime errors
if (typeof global.WebSocket === 'undefined') {
  (global as any).WebSocket = ws;
}

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey
);

const BUCKET_NAME = 'call-recordings';

/**
 * Initializes the storage bucket for call recordings.
 */
export async function initializeStorageBucket() {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    console.warn("⚠️ Supabase credentials missing. Storage bucket initialization skipped.");
    return;
  }
  try {
    const { data: buckets, error: getError } = await supabase.storage.listBuckets();
    if (getError) {
      throw getError;
    }

    const bucketExists = buckets?.some(b => b.name === BUCKET_NAME);
    if (!bucketExists) {
      console.log(`Creating Supabase Storage bucket: ${BUCKET_NAME}...`);
      const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
        public: true, // Allow direct playback links
      });
      if (createError) throw createError;
      console.log(`Bucket "${BUCKET_NAME}" created successfully.`);
    } else {
      console.log(`Supabase Storage bucket "${BUCKET_NAME}" already exists.`);
    }
  } catch (error) {
    console.error(`❌ Failed to initialize Supabase Storage bucket:`, error);
  }
}

/**
 * Inserts a new call into the database.
 */
export async function insertCall(callSid: string, toNumber: string) {
  try {
    const { data, error } = await supabase
      .from('calls')
      .insert({
        call_sid: callSid,
        to_number: toNumber,
        status: 'ringing'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`❌ Error inserting call ${callSid}:`, error);
    return null;
  }
}

/**
 * Updates call status and metadata.
 */
export async function updateCall(
  callSid: string,
  updates: { status: string; duration_seconds?: number; recording_url?: string }
) {
  try {
    const { data, error } = await supabase
      .from('calls')
      .update(updates)
      .eq('call_sid', callSid)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`❌ Error updating call ${callSid}:`, error);
    return null;
  }
}

/**
 * Inserts a single turn of the transcript in real-time.
 */
export async function insertTranscriptTurn(
  callSid: string,
  speaker: 'user' | 'agent',
  text: string,
  language?: string
) {
  try {
    // 1. Get the internal table call.id from the call_sid
    const { data: call, error: callError } = await supabase
      .from('calls')
      .select('id')
      .eq('call_sid', callSid)
      .single();

    if (callError || !call) {
      throw callError || new Error(`Call not found for SID: ${callSid}`);
    }

    // 2. Insert the turn linked to the call.id
    const { data, error } = await supabase
      .from('transcript_turns')
      .insert({
        call_id: call.id,
        speaker,
        text,
        language
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`❌ Error inserting transcript turn for call ${callSid}:`, error);
    return null;
  }
}

/**
 * Uploads a call recording (WAV format) to Supabase Storage and returns the public URL.
 */
export async function uploadRecording(callSid: string, recordingBuffer: Buffer): Promise<string | null> {
  try {
    const filename = `${callSid}.wav`;
    console.log(`Uploading recording ${filename} (${recordingBuffer.length} bytes) to Supabase Storage...`);

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filename, recordingBuffer, {
        contentType: 'audio/wav',
        upsert: true
      });

    if (error) throw error;

    // Retrieve the public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filename);

    console.log(`Recording uploaded successfully. Public URL: ${urlData.publicUrl}`);
    return urlData.publicUrl;
  } catch (error) {
    console.error(`❌ Error uploading recording for call ${callSid}:`, error);
    return null;
  }
}
