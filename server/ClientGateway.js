// server/ClientGateway.js - WebSocket server and client connection routing

const http = require('http');
const { WebSocketServer } = require('ws');
const SessionManager = require('../core/SessionManager');
const ConnectionLimiter = require('./ConnectionLimiter');
const { authenticate } = require('./auth');
const { generateSessionId, isTextMessage, isBinaryAudio } = require('../core/Types');
const logger = require('../utils/logger');

// WebSocket close code for policy violations (RFC 6455 §7.4.1)
const CLOSE_POLICY_VIOLATION = 1008;

const HTTP_STATUS_TEXT = {
  401: 'Unauthorized',
  403: 'Forbidden',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

/**
 * Gateway for handling client WebSocket connections
 * Routes messages to isolated SessionManager instances
 */
class ClientGateway {
  /**
   * @param {number} port - Port to listen on
   * @param {object} config - Application configuration
   */
  constructor(port, config) {
    this.port = port;
    this.config = config;
    this.httpServer = null;
    this.server = null;
    this.sessions = new Map(); // clientId -> SessionManager
    this.nextConnectionId = 1;
    this.limiter = new ConnectionLimiter(config.limits || {});

    logger.info(null, null, 'ClientGateway', `Initializing on port ${port}`, {
      authMode: (config.auth && config.auth.mode) || 'none',
    });
  }
  
  /**
   * Start the WebSocket server
   */
  start() {
    this.httpServer = http.createServer((req, res) => {
      // Plain HTTP request: tell the caller this is a WebSocket endpoint
      res.writeHead(426, { 'Content-Type': 'text/plain', 'Upgrade': 'websocket' });
      res.end('Nimrod: WebSocket endpoint, upgrade required\n');
    });

    this.server = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    this.httpServer.on('error', (err) => {
      logger.error(null, null, 'ClientGateway', 'Server error', err);
    });

    this.server.on('error', (err) => {
      logger.error(null, null, 'ClientGateway', 'WebSocket server error', err);
    });

    this.httpServer.listen(this.port, () => {
      logger.info(null, null, 'ClientGateway', `✓ WebSocket server listening on port ${this.port}`);
    });
  }

  /**
   * Authenticate and admit (or reject) an HTTP upgrade request
   * @private
   */
  _handleUpgrade(req, socket, head) {
    const auth = authenticate(req, this.config);
    if (!auth.ok) {
      logger.info(null, null, 'ClientGateway', `⛔ Connection rejected (${auth.status}): ${auth.reason}`, {
        ip: req.socket && req.socket.remoteAddress,
      });
      this._rejectUpgrade(socket, auth.status);
      return;
    }

    if (!this.limiter.acquire({ ip: auth.ip, subject: auth.subject })) {
      logger.info(null, null, 'ClientGateway', '⛔ Connection rejected (429): connection limit reached', {
        ip: auth.ip,
        subject: auth.subject,
      });
      this._rejectUpgrade(socket, 429);
      return;
    }

    this.server.handleUpgrade(req, socket, head, (ws) => {
      this._handleConnection(ws, auth);
    });
  }

  /**
   * Write an HTTP error response to a raw socket and close it
   * @private
   */
  _rejectUpgrade(socket, status) {
    const text = HTTP_STATUS_TEXT[status] || 'Error';
    try {
      socket.write(
        `HTTP/1.1 ${status} ${text}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain\r\n' +
        `Content-Length: ${Buffer.byteLength(text)}\r\n` +
        '\r\n' +
        text
      );
    } catch {
      // Socket may already be gone; nothing to do
    }
    socket.destroy();
  }
  
  /**
   * Handle new client connection
   * @private
   */
  _handleConnection(ws, authInfo) {
    const clientId = this.nextConnectionId++;
    const sessionId = generateSessionId();
    
    logger.info(clientId, sessionId, 'ClientGateway', '🔌 New client connected', {
      totalClients: this.sessions.size + 1,
      ip: authInfo.ip,
      subject: authInfo.subject,
    });
    
    // Create session manager for this client
    const session = new SessionManager(clientId, sessionId, ws, this.config, authInfo);
    this.sessions.set(clientId, session);

    // Enforce connection lifetime: token expiry and/or MAX_CONNECTION_SEC, whichever is sooner
    const deadline = this._connectionDeadlineMs(authInfo);
    if (deadline) {
      session.deadlineTimer = setTimeout(() => {
        logger.info(clientId, sessionId, 'ClientGateway', `⏱ Closing connection: ${deadline.reason}`);
        try {
          ws.close(CLOSE_POLICY_VIOLATION, deadline.reason);
        } catch (err) {
          logger.error(clientId, sessionId, 'ClientGateway', 'Error closing expired connection', err);
        }
      }, deadline.delayMs);
    }
    
    // Start session
    session.start().catch(err => {
      logger.error(clientId, sessionId, 'ClientGateway', 'Error starting session', err);
    });
    
    // Handle messages from client
    ws.on('message', async (data) => {
      try {
        await this._handleMessage(clientId, session, data);
      } catch (err) {
        logger.error(clientId, sessionId, 'ClientGateway', 'Error handling message', err);
      }
    });
    
    // Handle client disconnect
    ws.on('close', () => {
      this._handleClose(clientId, session);
    });
    
    // Handle client errors
    ws.on('error', (err) => {
      logger.error(clientId, sessionId, 'ClientGateway', 'Client WebSocket error', err);
      this._handleClose(clientId, session);
    });
  }

  /**
   * Compute when a connection must be closed, if ever.
   * @private
   * @returns {{ delayMs: number, reason: string } | null}
   */
  _connectionDeadlineMs(authInfo) {
    const candidates = [];
    const maxSec = this.config.limits && this.config.limits.maxConnectionSec;
    if (maxSec > 0) {
      candidates.push({ delayMs: maxSec * 1000, reason: 'connection lifetime exceeded' });
    }
    if (authInfo && Number.isFinite(authInfo.expSec)) {
      candidates.push({ delayMs: Math.max(0, authInfo.expSec * 1000 - Date.now()), reason: 'token expired' });
    }
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.delayMs < a.delayMs ? b : a));
  }
  
  /**
   * Handle message from client
   * @private
   */
  async _handleMessage(clientId, session, data) {
    // Check if this is a text control message
    if (isTextMessage(data)) {
      const message = typeof data === 'string' ? data : data.toString('utf8');
      
      logger.debug(clientId, session.sessionId, 'ClientGateway', 
        `Received text message: "${message}"`);
      
      if (message === 'END_OF_AUDIO') {
        logger.info(clientId, session.sessionId, 'ClientGateway', 
          '📌 END_OF_AUDIO received from client');
        await session.handleEndOfAudio();
      } else {
        logger.warn(clientId, session.sessionId, 'ClientGateway', 
          `Unknown text message: "${message}"`);
      }
    } 
    // Binary audio data
    else if (isBinaryAudio(data)) {
      logger.debug(clientId, session.sessionId, 'ClientGateway', 
        `Received audio chunk (${data.length} bytes)`);
      await session.handleAudioChunk(data);
    } 
    // Unknown data type
    else {
      logger.warn(clientId, session.sessionId, 'ClientGateway', 
        'Received unknown message type', {
        isBuffer: Buffer.isBuffer(data),
        length: data.length,
      });
    }
  }
  
  /**
   * Handle client disconnect
   * @private
   */
  async _handleClose(clientId, session) {
    // 'close' and 'error' can both fire for one socket; only release resources once
    if (session.released) {
      return;
    }
    session.released = true;

    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = null;
    }
    this.limiter.release({ ip: session.ip, subject: session.subject });

    logger.info(clientId, session.sessionId, 'ClientGateway', 
      '🔌 Client disconnected', {
      remainingClients: this.sessions.size - 1,
    });
    
    // Clean up session
    try {
      await session.handleClientClose();
    } catch (err) {
      logger.error(clientId, session.sessionId, 'ClientGateway', 
        'Error during session cleanup', err);
    }
    
    // Remove from sessions map
    this.sessions.delete(clientId);
    
    logger.info(clientId, session.sessionId, 'ClientGateway', 
      'Session removed', {
      activeClients: this.sessions.size,
    });
  }
  
  /**
   * Stop the server and clean up all sessions
   */
  async stop() {
    logger.info(null, null, 'ClientGateway', 'Stopping server...');
    
    // Close all active sessions
    const closePromises = [];
    for (const [clientId, session] of this.sessions.entries()) {
      logger.info(clientId, session.sessionId, 'ClientGateway', 
        'Closing session due to server shutdown');
      if (session.deadlineTimer) {
        clearTimeout(session.deadlineTimer);
        session.deadlineTimer = null;
      }
      closePromises.push(session.handleClientClose());
      // ws 8 only reports the server closed once every client has gone, so close them
      try {
        session.ws.close(1001, 'server shutting down');
      } catch {
        // already gone
      }
    }
    
    await Promise.all(closePromises);
    this.sessions.clear();
    
    // Close servers
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
    }
    if (this.httpServer) {
      await new Promise((resolve) => {
        this.httpServer.close(() => {
          logger.info(null, null, 'ClientGateway', 'Server stopped');
          resolve();
        });
      });
    }
  }
  
  /**
   * Get server statistics
   * @returns {object}
   */
  getStats() {
    const sessionStats = [];
    for (const [clientId, session] of this.sessions.entries()) {
      sessionStats.push({
        clientId,
        sessionId: session.sessionId,
        subject: session.subject,
        ip: session.ip,
        stats: session.getStats(),
      });
    }
    
    return {
      activeClients: this.sessions.size,
      port: this.port,
      authMode: (this.config.auth && this.config.auth.mode) || 'none',
      limiter: this.limiter.getStats(),
      sessions: sessionStats,
    };
  }
}

module.exports = ClientGateway;
