// config.js - Centralized configuration from environment variables
require('dotenv').config();

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function listEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

const AUTH_MODES = ['none', 'static', 'token'];

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

  // Client authentication. Everything defaults to off so existing installs are unaffected.
  auth: {
    // none   - accept any connection (current behaviour)
    // static - require a shared secret (AUTH_STATIC_KEY)
    // token  - require a short-lived HS256 JWT signed with AUTH_TOKEN_SECRET
    mode: (process.env.AUTH_MODE || 'none').trim().toLowerCase(),
    staticKey: process.env.AUTH_STATIC_KEY || '',
    tokenSecret: process.env.AUTH_TOKEN_SECRET || '',
    // Reject tokens whose lifetime (exp - iat) exceeds this. 0 disables the check.
    tokenMaxTtlSec: intEnv('AUTH_TOKEN_MAX_TTL_SEC', 3600),
    // Browser Origin allowlist. Empty = not checked.
    allowedOrigins: listEnv('AUTH_ALLOWED_ORIGINS'),
    // Use the first X-Forwarded-For entry as the client IP (only behind a trusted proxy)
    trustProxy: boolEnv('TRUST_PROXY', false),
  },

  // Per-connection and per-client usage caps. 0 = unlimited.
  limits: {
    maxConnectionSec: intEnv('MAX_CONNECTION_SEC', 0),
    maxAudioSecPerConnection: intEnv('MAX_AUDIO_SEC_PER_CONNECTION', 0),
    maxConnectionsPerIp: intEnv('MAX_CONNECTIONS_PER_IP', 0),
    maxConnectionsPerSubject: intEnv('MAX_CONNECTIONS_PER_SUBJECT', 0),
  },
  
  // Validate required configuration.
  // Returns an array of non-fatal warnings; throws on fatal errors.
  validate() {
    const errors = [];
    const warnings = [];
    
    if (!this.deepgram.apiKey) {
      errors.push('DEEPGRAM_API_KEY is required');
    }
    
    if (this.session.bufferMaxChunks < 1) {
      errors.push('BUFFER_MAX_CHUNKS must be at least 1');
    }
    
    if (this.session.finalizeTimeoutMs < 1000) {
      errors.push('FINALIZE_TIMEOUT_MS should be at least 1000ms');
    }

    if (!AUTH_MODES.includes(this.auth.mode)) {
      errors.push(`AUTH_MODE must be one of ${AUTH_MODES.join(', ')} (got "${this.auth.mode}")`);
    }
    if (this.auth.mode === 'static' && !this.auth.staticKey) {
      errors.push('AUTH_STATIC_KEY is required when AUTH_MODE=static');
    }
    if (this.auth.mode === 'token') {
      if (!this.auth.tokenSecret) {
        errors.push('AUTH_TOKEN_SECRET is required when AUTH_MODE=token');
      } else if (this.auth.tokenSecret.length < 32) {
        warnings.push('AUTH_TOKEN_SECRET is shorter than 32 characters; use a longer random secret');
      }
    }
    if (this.auth.mode !== 'token' && this.limits.maxConnectionsPerSubject > 0) {
      warnings.push('MAX_CONNECTIONS_PER_SUBJECT has no effect unless AUTH_MODE=token');
    }
    for (const [name, value] of Object.entries(this.limits)) {
      if (value < 0) errors.push(`limits.${name} must not be negative`);
    }
    if (this.auth.tokenMaxTtlSec < 0) {
      errors.push('AUTH_TOKEN_MAX_TTL_SEC must not be negative');
    }
    
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
    
    return warnings;
  }
};
