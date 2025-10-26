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
function debug(clientId, sessionId, module, message, metadata = null) {
  if (process.env.LOG_LEVEL === 'DEBUG' || process.env.NODE_ENV === 'development') {
    console.log(formatLog(clientId, sessionId, module, 'DEBUG', message, metadata));
  }
}

/**
 * Log an info message (normal operation)
 */
function info(clientId, sessionId, module, message, metadata = null) {
  console.log(formatLog(clientId, sessionId, module, 'INFO', message, metadata));
}

/**
 * Log a warning message (unexpected but handled)
 */
function warn(clientId, sessionId, module, message, metadata = null) {
  console.warn(formatLog(clientId, sessionId, module, 'WARN', message, metadata));
}

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
function stateTransition(clientId, sessionId, module, fromState, toState, reason = null) {
  const metadata = { from: fromState, to: toState };
  if (reason) {
    metadata.reason = reason;
  }
  info(clientId, sessionId, module, `State transition: ${fromState} → ${toState}`, metadata);
}

/**
 * Log performance timing
 */
function timing(clientId, sessionId, module, operation, durationMs, metadata = null) {
  const meta = { operation, durationMs, ...(metadata || {}) };
  info(clientId, sessionId, module, `⏱️ ${operation} took ${durationMs.toFixed(2)}ms`, meta);
}

/**
 * Log metric/counter
 */
function metric(clientId, sessionId, module, metricName, value, metadata = null) {
  const meta = { metric: metricName, value, ...(metadata || {}) };
  info(clientId, sessionId, module, `📊 ${metricName}: ${value}`, meta);
}

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