// utils/logger.js - Structured logging utilities

/**
 * Format a log message with consistent structure
 * @param {string} clientId - Client identifier
 * @param {string} sessionId - Session identifier
 * @param {string} module - Module name (e.g., 'SessionManager', 'DeepgramClient')
 * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {object} metadata - Optional metadata object
 * @returns {string} Formatted log message
 */
function formatLog(clientId, sessionId, module, level, message, metadata = null) {
  const timestamp = new Date().toISOString();
  const clientStr = clientId ? `[client:${clientId}]` : '[client:---]';
  const sessionStr = sessionId ? `[session:${sessionId}]` : '[session:---]';
  const moduleStr = module ? `[${module}]` : '';
  
  let logMessage = `[${timestamp}]${clientStr}${sessionStr}${moduleStr}[${level}] ${message}`;
  
  if (metadata) {
    logMessage += ` ${JSON.stringify(metadata)}`;
  }
  
  return logMessage;
}

/**
 * Log a debug message (verbose, for development)
 */
function debug() {}

/**
 * Log an info message (normal operation)
 */
function info() {}

/**
 * Log a warning message (unexpected but handled)
 */
function warn() {}

/**
 * Log an error message (errors and exceptions)
 * @param {Error} error - Optional error object for stack trace
 */
function error(clientId, sessionId, module, message, err = null, metadata = null) {
  console.error(formatLog(clientId, sessionId, module, 'ERROR', message, metadata));
  if (err && err.stack) {
    console.error(`[${new Date().toISOString()}][ERROR] Stack trace:`, err.stack);
  }
}

/**
 * Log a state transition (special case for state machines)
 */
function stateTransition() {}

/**
 * Log performance timing
 */
function timing() {}

/**
 * Log metric/counter
 */
function metric() {}

module.exports = {
  formatLog,
  debug,
  info,
  warn,
  error,
  stateTransition,
  timing,
  metric,
};