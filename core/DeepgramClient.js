// core/DeepgramClient.js - Deepgram WebSocket connection lifecycle management

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { DeepgramState, ReadyStateToDeepgramState, ErrorCode, RetryConstants } = require('./Types');
const logger = require('../utils/logger');

/**
 * Manages Deepgram WebSocket connection with retry logic
 */
class DeepgramClient {
  /**
   * @param {object} config - Deepgram configuration
   * @param {string} clientId - Client identifier for logging
   * @param {string} sessionId - Session identifier for logging
   */
  constructor(config, clientId, sessionId) {
    this.config = config;
    this.clientId = clientId;
    this.sessionId = sessionId;
    this.connection = null;
    this.state = DeepgramState.DISCONNECTED;
    this.keepAliveInterval = null;
    this.connectionStartTime = null;
    
    // Event handlers
    this.transcriptHandler = null;
    this.errorHandler = null;
    this.closeHandler = null;
    this.openHandler = null;
    
    // Retry tracking
    this.retryAttempt = 0;
    this.maxRetries = config.session.connectMaxRetries;
    this.baseDelay = config.session.connectBaseDelayMs;
    
    logger.debug(clientId, sessionId, 'DeepgramClient', 'Created', {
      maxRetries: this.maxRetries,
      baseDelay: this.baseDelay,
    });
  }
  
  /**
   * Connect to Deepgram with exponential backoff retry
   * @returns {Promise<void>}
   * @throws {Error} If connection fails after max retries
   */
  async connect() {
    if (this.state === DeepgramState.CONNECTED) {
      logger.warn(this.clientId, this.sessionId, 'DeepgramClient', 'Already connected');
      return;
    }
    
    if (this.state === DeepgramState.CONNECTING) {
      logger.warn(this.clientId, this.sessionId, 'DeepgramClient', 'Connection already in progress');
      return;
    }
    
    this.state = DeepgramState.CONNECTING;
    logger.stateTransition(this.clientId, this.sessionId, 'DeepgramClient', 
      DeepgramState.DISCONNECTED, DeepgramState.CONNECTING);
    
    while (this.retryAttempt < this.maxRetries) {
      try {
        await this._attemptConnection();
        this.retryAttempt = 0; // Reset on success
        return;
      } catch (err) {
        this.retryAttempt++;
        
        if (this.retryAttempt >= this.maxRetries) {
          logger.error(this.clientId, this.sessionId, 'DeepgramClient', 
            `Connection failed after ${this.maxRetries} attempts`, err);
          this.state = DeepgramState.DISCONNECTED;
          throw err;
        }
        
        // Calculate exponential backoff with jitter
        const delay = this.baseDelay * Math.pow(RetryConstants.BACKOFF_MULTIPLIER, this.retryAttempt - 1);
        const jitter = Math.random() * RetryConstants.MAX_JITTER_MS;
        const totalDelay = delay + jitter;
        
        logger.warn(this.clientId, this.sessionId, 'DeepgramClient', 
          `Connection attempt ${this.retryAttempt} failed, retrying in ${totalDelay.toFixed(0)}ms`, {
          attempt: this.retryAttempt,
          maxRetries: this.maxRetries,
          error: err.message,
        });
        
        await this._sleep(totalDelay);
      }
    }
  }
  
  /**
   * Attempt a single connection to Deepgram
   * @private
   */
  async _attemptConnection() {
    logger.info(this.clientId, this.sessionId, 'DeepgramClient', 'Attempting Deepgram connection...', {
      attempt: this.retryAttempt + 1,
      maxRetries: this.maxRetries,
    });
    
    const deepgram = createClient(this.config.deepgram.apiKey);
    
    const deepgramConfig = {
      model: this.config.deepgram.model,
      language: this.config.deepgram.language,
      encoding: this.config.deepgram.encoding,
      sample_rate: this.config.deepgram.sampleRate,
      endpointing: this.config.deepgram.endpointing,
      smart_format: this.config.deepgram.smartFormat,
      interim_results: this.config.deepgram.interimResults,
      numerals: this.config.deepgram.numerals,
      mip_opt_out: this.config.deepgram.mipOptOut,
      punctuate: this.config.deepgram.punctuate,
      profanity_filter: this.config.deepgram.profanityFilter,
      redact: this.config.deepgram.redact,
      vad_events: this.config.deepgram.vadEvents,
      channels: this.config.deepgram.channels,
    };
    
    logger.debug(this.clientId, this.sessionId, 'DeepgramClient', 'Creating live connection', deepgramConfig);
    
    this.connection = deepgram.listen.live(deepgramConfig);
    this.connectionStartTime = Date.now();
    
    // Set up event handlers
    this._setupEventHandlers();
    
    // Wait for connection to open
    await this._waitForOpen();
    
    // Start keep-alive
    this._startKeepAlive();
    
    this.state = DeepgramState.CONNECTED;
    logger.stateTransition(this.clientId, this.sessionId, 'DeepgramClient', 
      DeepgramState.CONNECTING, DeepgramState.CONNECTED);
    logger.info(this.clientId, this.sessionId, 'DeepgramClient', '✓ Connected to Deepgram');
  }
  
  /**
   * Set up Deepgram event handlers
   * @private
   */
  _setupEventHandlers() {
    this.connection.on(LiveTranscriptionEvents.Open, () => {
      logger.info(this.clientId, this.sessionId, 'DeepgramClient', '✓ WebSocket OPEN');
      if (this.openHandler) {
        this.openHandler();
      }
    });
    
    this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      logger.debug(this.clientId, this.sessionId, 'DeepgramClient', 'Received transcript event');
      if (this.transcriptHandler) {
        this.transcriptHandler(data);
      }
    });
    
    this.connection.on(LiveTranscriptionEvents.Error, (err) => {
      logger.error(this.clientId, this.sessionId, 'DeepgramClient', 'Deepgram error', err, {
        readyState: this.connection ? this.connection.getReadyState() : 'null',
        uptime: this._getUptimeSeconds(),
      });
      if (this.errorHandler) {
        this.errorHandler(err);
      }
    });
    
    this.connection.on(LiveTranscriptionEvents.Close, (code, reason) => {
      const uptimeSeconds = this._getUptimeSeconds();
      logger.info(this.clientId, this.sessionId, 'DeepgramClient', 'WebSocket CLOSE', {
        code,
        reason: reason || 'no reason provided',
        uptime: `${uptimeSeconds.toFixed(2)}s`,
      });
      
      this._stopKeepAlive();
      this.state = DeepgramState.CLOSED;
      
      if (this.closeHandler) {
        this.closeHandler(code, reason);
      }
    });
    
    this.connection.on(LiveTranscriptionEvents.Metadata, (data) => {
      logger.debug(this.clientId, this.sessionId, 'DeepgramClient', 'Metadata event', data);
    });
  }
  
  /**
   * Wait for WebSocket connection to open
   * @private
   */
  _waitForOpen() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000); // 10 second timeout
      
      const checkReady = () => {
        // close() may have nulled the connection while we were polling
        // (e.g. the client disconnected mid-connect); stop polling rather than crash
        if (!this.connection) {
          clearTimeout(timeout);
          reject(new Error('Connection closed before opening'));
          return;
        }
        
        const readyState = this.connection.getReadyState();
        
        if (readyState === 1) { // OPEN
          clearTimeout(timeout);
          resolve();
        } else if (readyState === 3) { // CLOSED
          clearTimeout(timeout);
          reject(new Error('Connection closed before opening'));
        } else {
          setTimeout(checkReady, 100);
        }
      };
      
      checkReady();
    });
  }
  
  /**
   * Start keep-alive interval
   * @private
   */
  _startKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
    
    this.keepAliveInterval = setInterval(() => {
      if (this.connection && this.connection.getReadyState() === 1) {
        logger.debug(this.clientId, this.sessionId, 'DeepgramClient', 'Sending keep-alive');
        this.connection.keepAlive();
      }
    }, this.config.session.keepAliveIntervalMs);
    
    logger.debug(this.clientId, this.sessionId, 'DeepgramClient', 
      `Started keep-alive (every ${this.config.session.keepAliveIntervalMs}ms)`);
  }
  
  /**
   * Stop keep-alive interval
   * @private
   */
  _stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
      logger.debug(this.clientId, this.sessionId, 'DeepgramClient', 'Stopped keep-alive');
    }
  }
  
  /**
   * Send audio chunk to Deepgram
   * @param {Buffer} chunk - Audio data
   * @throws {Error} If not connected
   */
  async send(chunk) {
    if (!this.isConnected()) {
      const err = new Error('Cannot send: not connected');
      err.code = ErrorCode.INVALID_STATE;
      throw err;
    }
    
    try {
      this.connection.send(chunk);
      logger.debug(this.clientId, this.sessionId, 'DeepgramClient', `Sent chunk (${chunk.length} bytes)`);
    } catch (err) {
      logger.error(this.clientId, this.sessionId, 'DeepgramClient', 'Error sending chunk', err);
      throw err;
    }
  }
  
  /**
   * Send finalize signal to Deepgram
   */
  finalize() {
    if (!this.isConnected()) {
      logger.warn(this.clientId, this.sessionId, 'DeepgramClient', 'Cannot finalize: not connected');
      return;
    }
    
    logger.info(this.clientId, this.sessionId, 'DeepgramClient', 'Sending finalize signal');
    this.connection.finalize();
  }
  
  /**
   * Close the Deepgram connection
   */
  close() {
    if (this.state === DeepgramState.CLOSED || this.state === DeepgramState.DISCONNECTED) {
      logger.debug(this.clientId, this.sessionId, 'DeepgramClient', 'Already closed/disconnected');
      return;
    }
    
    logger.info(this.clientId, this.sessionId, 'DeepgramClient', 'Closing connection', {
      uptime: `${this._getUptimeSeconds().toFixed(2)}s`,
    });
    
    this._stopKeepAlive();
    
    if (this.connection) {
      try {
        this.connection.requestClose();
      } catch (err) {
        logger.error(this.clientId, this.sessionId, 'DeepgramClient', 'Error closing connection', err);
      }
      this.connection = null;
    }
    
    this.state = DeepgramState.DISCONNECTED;
  }
  
  /**
   * Check if connected
   * @returns {boolean}
   */
  isConnected() {
    return this.connection && this.connection.getReadyState() === 1 && this.state === DeepgramState.CONNECTED;
  }
  
  /**
   * Get current state
   * @returns {string} DeepgramState
   */
  getState() {
    return this.state;
  }
  
  /**
   * Get WebSocket ready state
   * @returns {number|null} Ready state or null if no connection
   */
  getReadyState() {
    return this.connection ? this.connection.getReadyState() : null;
  }
  
  /**
   * Register transcript event handler
   * @param {Function} handler - Callback for transcript events
   */
  onTranscript(handler) {
    this.transcriptHandler = handler;
  }
  
  /**
   * Register error event handler
   * @param {Function} handler - Callback for error events
   */
  onError(handler) {
    this.errorHandler = handler;
  }
  
  /**
   * Register close event handler
   * @param {Function} handler - Callback for close events
   */
  onClose(handler) {
    this.closeHandler = handler;
  }
  
  /**
   * Register open event handler
   * @param {Function} handler - Callback for open events
   */
  onOpen(handler) {
    this.openHandler = handler;
  }
  
  /**
   * Get connection uptime in seconds
   * @private
   * @returns {number}
   */
  _getUptimeSeconds() {
    if (!this.connectionStartTime) return 0;
    return (Date.now() - this.connectionStartTime) / 1000;
  }
  
  /**
   * Sleep utility for retry delays
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = DeepgramClient;