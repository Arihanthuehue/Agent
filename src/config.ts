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

function getEnv(key: string, defaultValue: string = ''): string {
  const value = process.env[key];
  return value ? value.trim() : defaultValue;
}

export const config = {
  port: parseInt(getEnv('PORT', '3000'), 10),
  publicUrl: getEnv('PUBLIC_URL'),
  sttProvider: getEnv('STT_PROVIDER', 'aws'), // 'aws' or 'deepgram'
  twilio: {
    accountSid: getEnv('TWILIO_ACCOUNT_SID'),
    authToken: getEnv('TWILIO_AUTH_TOKEN'),
    phoneNumber: getEnv('TWILIO_PHONE_NUMBER'),
  },
  aws: {
    region: getEnv('AWS_REGION', 'us-east-1'),
    accessKeyId: getEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: getEnv('AWS_SECRET_ACCESS_KEY'),
    candidateLanguages: getEnv('CANDIDATE_LANGUAGES', 'en-US,hi-IN,es-US,fr-FR,ar-SA,ta-IN,te-IN,bn-IN,pt-BR,de-DE,zh-CN,ja-JP').split(','),
  },
  gemini: {
    apiKey: getEnv('GEMINI_API_KEY'),
    model: getEnv('GEMINI_MODEL', 'gemini-3.5-flash'),
  },
  elevenlabs: {
    apiKey: getEnv('ELEVENLABS_API_KEY'),
    voiceId: getEnv('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM'),
    modelId: 'eleven_flash_v2_5',
  },
  supabase: {
    url: getEnv('SUPABASE_URL'),
    serviceRoleKey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
  },
};
export type Config = typeof config;
