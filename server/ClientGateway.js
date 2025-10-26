// server/ClientGateway.js - WebSocket server and client connection routing

const { WebSocketServer } = require('ws');
const SessionManager = require('../core/SessionManager');
const { generateSessionId, isTextMessage, isBinaryAudio } = require('../core/Types');
const logger = require('../utils/logger');

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
    this.server = null;
    this.sessions = new Map(); // clientId -> SessionManager
    
    logger.info(null, null, 'ClientGateway', `Initializing on port ${port}`);
  }
  
  /**
   * Start the WebSocket server
   */
  start() {
    this.server = new WebSocketServer({ port: this.port }, () => {
      logger.info(null, null, 'ClientGateway', `✓ WebSocket server listening on port ${this.port}`);
    });
    
    this.server.on('connection', (ws) => {
      this._handleConnection(ws);
    });
    
    this.server.on('error', (err) => {
      logger.error(null, null, 'ClientGateway', 'Server error', err);
    });
  }
  
  /**
   * Handle new client connection
   * @private
   */
  _handleConnection(ws) {
    const clientId = generateSessionId();
    const sessionId = generateSessionId();
    
    logger.info(clientId, sessionId, 'ClientGateway', '🔌 New client connected', {
      totalClients: this.sessions.size + 1,
    });
    
    // Create session manager for this client
    const session = new SessionManager(clientId, sessionId, ws, this.config);
    this.sessions.set(clientId, session);
    
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
      closePromises.push(session.handleClientClose());
    }
    
    await Promise.all(closePromises);
    this.sessions.clear();
    
    // Close server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => {
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
        stats: session.getStats(),
      });
    }
    
    return {
      activeClients: this.sessions.size,
      port: this.port,
      sessions: sessionStats,
    };
  }
}

module.exports = ClientGateway;