process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { server } from './server';
import { config } from './config';
import { initializeStorageBucket } from './supabase';

const PORT = process.env.PORT || 3000;

async function boot() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    console.warn('⚠️ WARNING: NODE_TLS_REJECT_UNAUTHORIZED is set to "0". SSL/TLS certificate validation is disabled! Do not use this in production.');
  }
  console.log('🤖 Starting My Own Vapi Voice Orchestrator Server...');

  // Initialize database and storage bucket
  await initializeStorageBucket();

  // Start HTTP and WebSocket server
  server.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`📡 Local WebSocket URL: ws://localhost:${PORT}/stream`);
    console.log(`🔗 Expose this port via ngrok and specify PUBLIC_URL in .env`);
  });
}

// Graceful shutdown handling
const shutdown = () => {
  console.log('Stopping server gracefully...');
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

boot().catch((err) => {
  console.error('❌ Failed to boot the server:', err);
  process.exit(1);
});
