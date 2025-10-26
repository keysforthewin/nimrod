// config.js - Centralized configuration from environment variables
require('dotenv').config();

module.exports = {
  server: {
    port: parseInt(process.env.PORT, 10) || 8550,
  },
  
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
    url: process.env.DEEPGRAM_URL || 'wss://api.deepgram.com/v1/listen',
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    language: process.env.SOURCE_LANGUAGE_CODE_LOCALE || 'en-US',
    encoding: 'linear16',
    sampleRate: parseInt(process.env.SAMPLE_RATE, 10) || 16000,
    endpointing: false,
    smartFormat: true,
    interimResults: true,
    numerals: false,
    mipOptOut: false,
    punctuate: true,
    profanityFilter: false,
    redact: false,
    vadEvents: false,
    channels: 1,
  },
  
  session: {
    // Timeout for waiting for speech_final after EOA
    finalizeTimeoutMs: parseInt(process.env.FINALIZE_TIMEOUT_MS, 10) || 5000,
    
    // Maximum chunks to buffer before applying backpressure
    bufferMaxChunks: parseInt(process.env.BUFFER_MAX_CHUNKS, 10) || 1000,
    
    // Deepgram connection retry configuration
    connectMaxRetries: parseInt(process.env.DG_CONNECT_MAX_RETRIES, 10) || 3,
    connectBaseDelayMs: parseInt(process.env.DG_CONNECT_BASE_DELAY_MS, 10) || 1000,
    
    // Keep-alive interval for Deepgram (prevents auto-close after 10s silence)
    keepAliveIntervalMs: parseInt(process.env.KEEP_ALIVE_INTERVAL_MS, 10) || 5000,
    
    // Chunk duration for audio processing
    chunkDurationMs: parseInt(process.env.CHUNK_DURATION_MS, 10) || 20,
  },
  
  // Validate required configuration
  validate() {
    const errors = [];
    
    if (!this.deepgram.apiKey) {
      errors.push('DEEPGRAM_API_KEY is required');
    }
    
    if (this.session.bufferMaxChunks < 1) {
      errors.push('BUFFER_MAX_CHUNKS must be at least 1');
    }
    
    if (this.session.finalizeTimeoutMs < 1000) {
      errors.push('FINALIZE_TIMEOUT_MS should be at least 1000ms');
    }
    
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
    
    return true;
  }
};