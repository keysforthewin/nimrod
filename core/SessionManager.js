// core/SessionManager.js - Session state machine and orchestration

const AudioBuffer = require('./AudioBuffer');
const DeepgramClient = require('./DeepgramClient');
const { SessionState, AudioEventType } = require('./Types');
const logger = require('../utils/logger');

/**
 * Manages a single client session with state machine orchestration
 */
class SessionManager {
  /**
   * @param {string} clientId - Client identifier
   * @param {string} sessionId - Session identifier
   * @param {WebSocket} ws - Client WebSocket connection
   * @param {object} config - Application configuration
   */
  constructor(clientId, sessionId, ws, config) {
    this.clientId = clientId;
    this.sessionId = sessionId;
    this.ws = ws;
    this.config = config;
    
    // State
    this.state = SessionState.IDLE;
    
    // Components
    this.buffer = new AudioBuffer(config.session.bufferMaxChunks, clientId, sessionId);
    this.deepgram = new DeepgramClient(config, clientId, sessionId);
    
    // Timers
    this.finalizeTimeout = null;
    
    // State tracking
    this.completedTranscript = '';
    this.sendLoopRunning = false;
    this.eoaReceived = false;
    
    logger.info(clientId, sessionId, 'SessionManager', 'Session created', {
      bufferMaxChunks: config.session.bufferMaxChunks,
      finalizeTimeoutMs: config.session.finalizeTimeoutMs,
    });
    
    // Set up Deepgram event handlers
    this._setupDeepgramHandlers();
  }
  
  /**
   * Start the session
   */
  async start() {
    logger.info(this.clientId, this.sessionId, 'SessionManager', 'Session started');
  }
  
  /**
   * Handle incoming audio chunk from client
   * @param {Buffer} chunk - Audio data
   */
  async handleAudioChunk(chunk) {
    if (this.state === SessionState.CLOSED) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'Ignoring audio chunk - session closed');
      return;
    }
    
    if (this.eoaReceived) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'Ignoring audio chunk - EOA already received');
      return;
    }
    
    // Add to buffer
    const added = this.buffer.push(chunk);
    
    if (!added) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'Buffer full, applying backpressure', this.buffer.getStats());
      // TODO: Implement backpressure mechanism if needed
      return;
    }
    
    // Ensure Deepgram is connected if we're in IDLE state
    if (this.state === SessionState.IDLE) {
      logger.info(this.clientId, this.sessionId, 'SessionManager', 
        'First audio received, ensuring Deepgram connection');
      await this.ensureDeepgram();
    }
  }
  
  /**
   * Handle EOA (End-Of-Audio) marker from client
   */
  async handleEndOfAudio() {
    if (this.state === SessionState.CLOSED) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'Ignoring EOA - session closed');
      return;
    }
    
    if (this.eoaReceived) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'EOA already received, ignoring duplicate');
      return;
    }
    
    this.eoaReceived = true;
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      '📌 EOA marker received from client');
    
    // Add EOA sentinel to buffer
    this.buffer.pushEOA();
    
    // If still IDLE (no audio sent yet), start connection to process EOA
    if (this.state === SessionState.IDLE) {
      logger.info(this.clientId, this.sessionId, 'SessionManager', 
        'EOA in IDLE state, ensuring Deepgram connection to process it');
      await this.ensureDeepgram();
    }
  }
  
  /**
   * Ensure Deepgram is connected and start sendLoop if needed
   */
  async ensureDeepgram() {
    if (this.deepgram.isConnected()) {
      logger.debug(this.clientId, this.sessionId, 'SessionManager', 
        'Deepgram already connected');
      
      if (!this.sendLoopRunning && this.state !== SessionState.ENDING) {
        logger.info(this.clientId, this.sessionId, 'SessionManager', 
          'Starting sendLoop on existing connection');
        this.state = SessionState.STREAMING;
        this._startSendLoop();
      }
      return;
    }
    
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      'Connecting to Deepgram...');
    
    try {
      await this.deepgram.connect();
      
      // Transition to STREAMING
      logger.stateTransition(this.clientId, this.sessionId, 'SessionManager', 
        this.state, SessionState.STREAMING, 'Deepgram connected');
      this.state = SessionState.STREAMING;
      
      // Start send loop
      this._startSendLoop();
      
    } catch (err) {
      logger.error(this.clientId, this.sessionId, 'SessionManager', 
        'Failed to connect to Deepgram', err);
      // Stay in IDLE, continue buffering
    }
  }
  
  /**
   * Start the send loop that drains buffer to Deepgram
   * @private
   */
  _startSendLoop() {
    if (this.sendLoopRunning) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'sendLoop already running');
      return;
    }
    
    this.sendLoopRunning = true;
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      'Starting sendLoop');
    
    // Run loop asynchronously
    this._sendLoop().catch(err => {
      logger.error(this.clientId, this.sessionId, 'SessionManager', 
        'sendLoop error', err);
      this.sendLoopRunning = false;
    });
  }
  
  /**
   * Send loop: drain buffer and send to Deepgram
   * @private
   */
  async _sendLoop() {
    let chunksSent = 0;
    
    try {
      while (this.state === SessionState.STREAMING && this.deepgram.isConnected()) {
        // Pop from buffer (blocks until data available)
        let item;
        try {
          item = await this.buffer.pop();
        } catch (err) {
          // Buffer closed
          logger.info(this.clientId, this.sessionId, 'SessionManager', 
            'Buffer closed, exiting sendLoop');
          break;
        }
        
        if (item.type === AudioEventType.EOA) {
          logger.info(this.clientId, this.sessionId, 'SessionManager', 
            '📌 EOA popped from buffer, entering ENDING state');
          this.enterEnding();
          break;
        }
        
        // Send audio chunk to Deepgram
        try {
          await this.deepgram.send(item.data);
          chunksSent++;
          
          if (chunksSent % 100 === 0) {
            logger.metric(this.clientId, this.sessionId, 'SessionManager', 
              'chunks_sent', chunksSent, {
              bufferSize: this.buffer.getSize(),
            });
          }
        } catch (err) {
          logger.error(this.clientId, this.sessionId, 'SessionManager', 
            'Error sending chunk to Deepgram', err);
          // Continue trying to send remaining chunks
        }
      }
      
      logger.info(this.clientId, this.sessionId, 'SessionManager', 
        `sendLoop completed. Total chunks sent: ${chunksSent}`);
      
    } finally {
      this.sendLoopRunning = false;
      logger.debug(this.clientId, this.sessionId, 'SessionManager', 
        'sendLoop exited');
    }
  }
  
  /**
   * Enter ENDING state: wait for speech_final or timeout
   */
  enterEnding() {
    if (this.state === SessionState.ENDING) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'Already in ENDING state');
      return;
    }
    
    logger.stateTransition(this.clientId, this.sessionId, 'SessionManager', 
      this.state, SessionState.ENDING, 'EOA processed');
    this.state = SessionState.ENDING;
    
    // Send finalize signal to Deepgram
    if (this.deepgram.isConnected()) {
      this.deepgram.finalize();
    }
    
    // Start finalization timeout
    this.finalizeTimeout = setTimeout(() => {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        `Finalization timeout (${this.config.session.finalizeTimeoutMs}ms) - forcing finalization`);
      this._handleFinalization();
    }, this.config.session.finalizeTimeoutMs);
    
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      `Waiting for speech_final or ${this.config.session.finalizeTimeoutMs}ms timeout`);
  }
  
  /**
   * Handle finalization: close Deepgram and return to IDLE
   * @private
   */
  _handleFinalization() {
    if (this.state !== SessionState.ENDING) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'Finalization called but not in ENDING state', { currentState: this.state });
      return;
    }
    
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      '✓ Finalization complete');
    
    // Clear timeout
    if (this.finalizeTimeout) {
      clearTimeout(this.finalizeTimeout);
      this.finalizeTimeout = null;
    }
    
    // Close Deepgram
    this.deepgram.close();
    
    // Reset state for next session
    logger.stateTransition(this.clientId, this.sessionId, 'SessionManager', 
      SessionState.ENDING, SessionState.IDLE, 'Finalization complete');
    this.state = SessionState.IDLE;
    this.completedTranscript = '';
    this.eoaReceived = false;
    
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      'Session ready for new audio');
  }
  
  /**
   * Set up Deepgram event handlers
   * @private
   */
  _setupDeepgramHandlers() {
    // Handle transcripts
    this.deepgram.onTranscript((data) => {
      this._handleTranscript(data);
    });
    
    // Handle errors
    this.deepgram.onError((err) => {
      logger.error(this.clientId, this.sessionId, 'SessionManager', 
        'Deepgram error event', err);
      
      // If we were STREAMING, return to IDLE (will retry on next audio)
      if (this.state === SessionState.STREAMING) {
        logger.warn(this.clientId, this.sessionId, 'SessionManager', 
          'Deepgram error during STREAMING, returning to IDLE');
        this.state = SessionState.IDLE;
        this.sendLoopRunning = false;
      }
    });
    
    // Handle close
    this.deepgram.onClose((code, reason) => {
      logger.info(this.clientId, this.sessionId, 'SessionManager', 
        'Deepgram closed', { code, reason });
      
      // If we were STREAMING and not intentionally closing, return to IDLE
      if (this.state === SessionState.STREAMING) {
        logger.warn(this.clientId, this.sessionId, 'SessionManager', 
          'Unexpected Deepgram close during STREAMING, returning to IDLE');
        this.state = SessionState.IDLE;
        this.sendLoopRunning = false;
      }
    });
  }
  
  /**
   * Handle transcript from Deepgram
   * @private
   */
  _handleTranscript(data) {
    const alternatives = data.channel && data.channel.alternatives;
    const alternative = alternatives && alternatives[0];
    const transcript = alternative && alternative.transcript;
    const confidence = alternative && alternative.confidence;
    const isFinal = data.is_final;
    const isSpeechFinal = data.from_finalize || data.speech_final;
    
    logger.debug(this.clientId, this.sessionId, 'SessionManager', 
      'Transcript received', {
      transcript: transcript || '(empty)',
      isFinal,
      isSpeechFinal,
      confidence,
    });
    
    // Accumulate completed transcripts
    if (isFinal && transcript && transcript.length > 0) {
      this.completedTranscript += (this.completedTranscript ? ' ' : '') + transcript;
      logger.debug(this.clientId, this.sessionId, 'SessionManager', 
        'Accumulated transcript', { completedTranscript: this.completedTranscript });
    }
    
    // Prepare combined transcript for client
    const combinedTranscript = !isFinal && transcript
      ? (this.completedTranscript ? this.completedTranscript + ' ' + transcript : transcript)
      : this.completedTranscript;
    
    // Send to client if there's content
    if (combinedTranscript || transcript) {
      const message = {
        isPartial: !isSpeechFinal,
        transcript: combinedTranscript || transcript || '',
      };
      
      try {
        this.ws.send(JSON.stringify(message));
        logger.debug(this.clientId, this.sessionId, 'SessionManager', 
          'Sent transcript to client', { isPartial: message.isPartial });
      } catch (err) {
        logger.error(this.clientId, this.sessionId, 'SessionManager', 
          'Error sending transcript to client', err);
      }
    }
    
    // Handle speech_final
    if (isSpeechFinal) {
      logger.info(this.clientId, this.sessionId, 'SessionManager', 
        '✓ Received speech_final from Deepgram');
      
      // If in ENDING state, finalize
      if (this.state === SessionState.ENDING) {
        this._handleFinalization();
      }
    }
  }
  
  /**
   * Handle client disconnect
   */
  async handleClientClose() {
    if (this.state === SessionState.CLOSED) {
      logger.warn(this.clientId, this.sessionId, 'SessionManager', 
        'Already closed');
      return;
    }
    
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      'Client disconnected, cleaning up');
    
    logger.stateTransition(this.clientId, this.sessionId, 'SessionManager', 
      this.state, SessionState.CLOSED, 'Client disconnect');
    this.state = SessionState.CLOSED;
    
    // Clear timers
    if (this.finalizeTimeout) {
      clearTimeout(this.finalizeTimeout);
      this.finalizeTimeout = null;
    }
    
    // Close buffer
    this.buffer.close();
    
    // Close Deepgram
    this.deepgram.close();
    
    logger.info(this.clientId, this.sessionId, 'SessionManager', 
      'Cleanup complete');
  }
  
  /**
   * Get current state
   * @returns {string} SessionState
   */
  getState() {
    return this.state;
  }
  
  /**
   * Get session statistics
   * @returns {object}
   */
  getStats() {
    return {
      state: this.state,
      bufferStats: this.buffer.getStats(),
      deepgramState: this.deepgram.getState(),
      deepgramConnected: this.deepgram.isConnected(),
      sendLoopRunning: this.sendLoopRunning,
      eoaReceived: this.eoaReceived,
      completedTranscriptLength: this.completedTranscript.length,
    };
  }
}

module.exports = SessionManager;