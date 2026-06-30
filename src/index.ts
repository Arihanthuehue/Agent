import { server } from './server';
import { config } from './config';
import { initializeStorageBucket } from './supabase';

const PORT = config.port;

async function boot() {
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
