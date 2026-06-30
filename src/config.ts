import dotenv from 'dotenv';

dotenv.config();

const requiredEnv = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GEMINI_API_KEY',
  'ELEVENLABS_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'PUBLIC_URL',
];

const missingEnv = requiredEnv.filter((env) => !process.env[env]);

if (missingEnv.length > 0) {
  console.warn(`⚠️ Warning: Missing required environment variables: ${missingEnv.join(', ')}`);
  console.warn(`Make sure to populate your .env file before running in production/test.`);
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  publicUrl: process.env.PUBLIC_URL || '',
  sttProvider: process.env.STT_PROVIDER || 'aws', // 'aws' or 'deepgram'
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  },
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    candidateLanguages: (process.env.CANDIDATE_LANGUAGES || 'en-US,hi-IN,es-US,fr-FR,ar-SA,ta-IN,te-IN,bn-IN,pt-BR,de-DE,zh-CN,ja-JP').split(','),
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    modelId: 'eleven_flash_v2_5',
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
};
export type Config = typeof config;
