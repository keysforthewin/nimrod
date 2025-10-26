// index.js - Main entry point for Nimrod WebSocket → Deepgram streaming bridge

const config = require('./config');
const ClientGateway = require('./server/ClientGateway');
const logger = require('./utils/logger');

// Validate configuration
try {
  config.validate();
  logger.info(null, null, 'main', '✓ Configuration validated');
} catch (err) {
  logger.error(null, null, 'main', 'Configuration validation failed', err);
  process.exit(1);
}

// Create and start the gateway
const gateway = new ClientGateway(config.server.port, config);

gateway.start();

logger.info(null, null, 'main', '🚀 Nimrod server started', {
  port: config.server.port,
  deepgramModel: config.deepgram.model,
  language: config.deepgram.language,
  sampleRate: config.deepgram.sampleRate,
  bufferMaxChunks: config.session.bufferMaxChunks,
  finalizeTimeoutMs: config.session.finalizeTimeoutMs,
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info(null, null, 'main', 'Received SIGINT, shutting down gracefully...');
  await gateway.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info(null, null, 'main', 'Received SIGTERM, shutting down gracefully...');
  await gateway.stop();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  logger.error(null, null, 'main', 'Uncaught exception', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(null, null, 'main', 'Unhandled rejection', 
    reason instanceof Error ? reason : new Error(String(reason)));
  process.exit(1);
});