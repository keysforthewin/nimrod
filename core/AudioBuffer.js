// core/AudioBuffer.js - Bounded async queue with EOA sentinel support

const { AudioEventType, ErrorCode } = require('./Types');
const logger = require('../utils/logger');

/**
 * Bounded audio buffer with async pop support
 * Supports audio chunks and EOA (End-Of-Audio) sentinel
 */
class AudioBuffer {
  /**
   * @param {number} maxChunks - Maximum number of chunks to buffer
   * @param {string} clientId - Client identifier for logging
   * @param {string} sessionId - Session identifier for logging
   */
  constructor(maxChunks, clientId, sessionId) {
    this.maxChunks = maxChunks;
    this.clientId = clientId;
    this.sessionId = sessionId;
    this.buffer = [];
    this.resolvers = []; // Pending pop() promises
    this.closed = false;
    
    logger.debug(clientId, sessionId, 'AudioBuffer', `Created with max capacity: ${maxChunks}`);
  }
  
  /**
   * Push an audio chunk onto the buffer
   * @param {Buffer} chunk - Audio data chunk
   * @returns {boolean} True if added, false if full or closed
   */
  push(chunk) {
    if (this.closed) {
      logger.warn(this.clientId, this.sessionId, 'AudioBuffer', 'Attempted to push to closed buffer');
      return false;
    }
    
    if (this.isFull()) {
      logger.warn(this.clientId, this.sessionId, 'AudioBuffer', 'Buffer full, cannot add chunk', {
        currentSize: this.buffer.length,
        maxChunks: this.maxChunks,
      });
      return false;
    }
    
    const item = {
      type: AudioEventType.CHUNK,
      data: chunk,
    };
    
    this.buffer.push(item);
    logger.debug(this.clientId, this.sessionId, 'AudioBuffer', `Pushed chunk (${chunk.length} bytes)`, {
      bufferSize: this.buffer.length,
      pendingResolvers: this.resolvers.length,
    });
    
    // If there's a pending pop(), resolve it immediately
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      const poppedItem = this.buffer.shift();
      resolver(poppedItem);
      logger.debug(this.clientId, this.sessionId, 'AudioBuffer', 'Resolved pending pop() with new chunk');
    }
    
    return true;
  }
  
  /**
   * Push an EOA (End-Of-Audio) sentinel onto the buffer
   * @returns {boolean} True if added, false if closed
   */
  pushEOA() {
    if (this.closed) {
      logger.warn(this.clientId, this.sessionId, 'AudioBuffer', 'Attempted to push EOA to closed buffer');
      return false;
    }
    
    const item = {
      type: AudioEventType.EOA,
      data: null,
    };
    
    this.buffer.push(item);
    logger.info(this.clientId, this.sessionId, 'AudioBuffer', '📌 EOA sentinel added to buffer', {
      bufferSize: this.buffer.length,
    });
    
    // If there's a pending pop(), resolve it immediately with EOA
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      const poppedItem = this.buffer.shift();
      resolver(poppedItem);
      logger.info(this.clientId, this.sessionId, 'AudioBuffer', 'Resolved pending pop() with EOA');
    }
    
    return true;
  }
  
  /**
   * Pop an item from the buffer (async, awaits until data available)
   * @returns {Promise<{type: string, data: Buffer|null}>} The next item
   * @throws {Error} If buffer is closed
   */
  async pop() {
    // If buffer has items, return immediately
    if (this.buffer.length > 0) {
      const item = this.buffer.shift();
      logger.debug(this.clientId, this.sessionId, 'AudioBuffer', `Popped ${item.type}`, {
        remainingSize: this.buffer.length,
      });
      return item;
    }
    
    // If buffer is closed and empty, reject
    if (this.closed) {
      const err = new Error('Buffer is closed');
      err.code = ErrorCode.SESSION_CLOSED;
      throw err;
    }
    
    // Otherwise, wait for data to be pushed
    logger.debug(this.clientId, this.sessionId, 'AudioBuffer', 'pop() waiting for data...');
    
    return new Promise((resolve, reject) => {
      this.resolvers.push(resolve);
      
      // Store reject for cleanup
      resolve._reject = reject;
    });
  }
  
  /**
   * Peek at the next item without removing it
   * @returns {{type: string, data: Buffer|null}|null} The next item or null if empty
   */
  peek() {
    return this.buffer.length > 0 ? this.buffer[0] : null;
  }
  
  /**
   * Clear all items from the buffer
   */
  clear() {
    const clearedCount = this.buffer.length;
    this.buffer = [];
    logger.info(this.clientId, this.sessionId, 'AudioBuffer', `Cleared buffer (removed ${clearedCount} items)`);
  }
  
  /**
   * Get current buffer size
   * @returns {number} Number of items in buffer
   */
  getSize() {
    return this.buffer.length;
  }
  
  /**
   * Check if buffer is full
   * @returns {boolean} True if at capacity
   */
  isFull() {
    return this.buffer.length >= this.maxChunks;
  }
  
  /**
   * Check if buffer is closed
   * @returns {boolean} True if closed
   */
  isClosed() {
    return this.closed;
  }
  
  /**
   * Close the buffer and reject all pending pop() promises
   */
  close() {
    if (this.closed) {
      return;
    }
    
    this.closed = true;
    logger.info(this.clientId, this.sessionId, 'AudioBuffer', 'Closing buffer', {
      remainingItems: this.buffer.length,
      pendingResolvers: this.resolvers.length,
    });
    
    // Reject all pending pop() promises
    const err = new Error('Buffer closed');
    err.code = ErrorCode.SESSION_CLOSED;
    
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver._reject) {
        resolver._reject(err);
      }
    }
    
    // Clear buffer
    this.clear();
  }
  
  /**
   * Get buffer statistics for debugging
   * @returns {object} Buffer stats
   */
  getStats() {
    return {
      size: this.buffer.length,
      maxChunks: this.maxChunks,
      isFull: this.isFull(),
      isClosed: this.closed,
      pendingResolvers: this.resolvers.length,
      utilization: (this.buffer.length / this.maxChunks * 100).toFixed(1) + '%',
    };
  }
}

module.exports = AudioBuffer;