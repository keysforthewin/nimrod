// server/ConnectionLimiter.js - Concurrent connection caps per IP and per token subject

/**
 * Tracks live connection counts. A cap of 0 means unlimited.
 */
class ConnectionLimiter {
  /**
   * @param {{ maxConnectionsPerIp?: number, maxConnectionsPerSubject?: number }} limits
   */
  constructor(limits = {}) {
    this.maxPerIp = limits.maxConnectionsPerIp > 0 ? limits.maxConnectionsPerIp : 0;
    this.maxPerSubject = limits.maxConnectionsPerSubject > 0 ? limits.maxConnectionsPerSubject : 0;
    this.byIp = new Map();
    this.bySubject = new Map();
  }

  /**
   * Try to reserve a slot. Returns false (and reserves nothing) if a cap would be exceeded.
   * @param {{ ip?: string|null, subject?: string|null }} key
   * @returns {boolean}
   */
  acquire({ ip = null, subject = null } = {}) {
    if (this.maxPerIp > 0 && ip) {
      if ((this.byIp.get(ip) || 0) >= this.maxPerIp) return false;
    }
    if (this.maxPerSubject > 0 && subject) {
      if ((this.bySubject.get(subject) || 0) >= this.maxPerSubject) return false;
    }
    if (ip) this.byIp.set(ip, (this.byIp.get(ip) || 0) + 1);
    if (subject) this.bySubject.set(subject, (this.bySubject.get(subject) || 0) + 1);
    return true;
  }

  /**
   * Give a slot back. Safe to call with keys that were never acquired.
   * @param {{ ip?: string|null, subject?: string|null }} key
   */
  release({ ip = null, subject = null } = {}) {
    ConnectionLimiter._decrement(this.byIp, ip);
    ConnectionLimiter._decrement(this.bySubject, subject);
  }

  static _decrement(map, key) {
    if (!key || !map.has(key)) return;
    const next = map.get(key) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  /**
   * Current counts, for stats/debugging.
   */
  getStats() {
    return {
      maxPerIp: this.maxPerIp,
      maxPerSubject: this.maxPerSubject,
      ips: this.byIp.size,
      subjects: this.bySubject.size,
    };
  }
}

module.exports = ConnectionLimiter;
