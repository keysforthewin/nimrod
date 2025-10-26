// core/Types.js - Type definitions, enums, and constants

/**
 * Session state machine states
 */
const SessionState = {
  IDLE: 'IDLE',           // No Deepgram connection; buffering audio
  STREAMING: 'STREAMING', // Deepgram connected; draining buffer + forwarding live chunks
  ENDING: 'ENDING',       // EOA received; waiting for speech_final or timeout
  CLOSED: 'CLOSED',       // Client disconnected; cleanup in progress
};

/**
 * Deepgram connection states (maps to WebSocket readyState)
 */
const DeepgramState = {
  DISCONNECTED: 'DISCONNECTED', // Not connected
  CONNECTING: 'CONNECTING',     // Connection in progress
  CONNECTED: 'CONNECTED',       // WebSocket open and ready
  CLOSING: 'CLOSING',           // Close initiated
  CLOSED: 'CLOSED',             // Connection closed
};

/**
 * Map WebSocket readyState to DeepgramState
 */
const ReadyStateToDeepgramState = {
  0: DeepgramState.CONNECTING,
  1: DeepgramState.CONNECTED,
  2: DeepgramState.CLOSING,
  3: DeepgramState.CLOSED,
};

/**
 * Audio buffer event types
 */
const AudioEventType = {
  CHUNK: 'CHUNK', // Audio data chunk
  EOA: 'EOA',     // End-Of-Audio sentinel
};

/**
 * Client-facing event types
 */
const ClientEventType = {
  TRANSCRIPT: 'TRANSCRIPT',   // Transcription result
  ERROR: 'ERROR',             // Error message
  FINALIZED: 'FINALIZED',     // Session finalized
};

/**
 * Error codes for structured error handling
 */
const ErrorCode = {
  BUFFER_FULL: 'BUFFER_FULL',
  DEEPGRAM_CONNECTION_FAILED: 'DEEPGRAM_CONNECTION_FAILED',
  DEEPGRAM_ERROR: 'DEEPGRAM_ERROR',
  SESSION_CLOSED: 'SESSION_CLOSED',
  INVALID_STATE: 'INVALID_STATE',
  TIMEOUT: 'TIMEOUT',
};

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Check if data is a text message (control message)
 * @param {Buffer|string} data - Message data
 * @returns {boolean} True if text message
 */
function isTextMessage(data) {
  if (typeof data === 'string') {
    return true;
  }
  // Small buffer likely to be a text control message
  if (Buffer.isBuffer(data) && data.length < 20) {
    return true;
  }
  return false;
}

/**
 * Check if data is binary audio
 * @param {Buffer|string} data - Message data
 * @returns {boolean} True if binary audio
 */
function isBinaryAudio(data) {
  return Buffer.isBuffer(data) && data.length >= 20;
}

/**
 * Constants for retry logic
 */
const RetryConstants = {
  MAX_JITTER_MS: 500,           // Max jitter to add to retry delay
  BACKOFF_MULTIPLIER: 2,        // Exponential backoff multiplier
};

module.exports = {
  SessionState,
  DeepgramState,
  ReadyStateToDeepgramState,
  AudioEventType,
  ClientEventType,
  ErrorCode,
  RetryConstants,
  generateSessionId,
  isTextMessage,
  isBinaryAudio,
};