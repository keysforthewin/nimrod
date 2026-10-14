// server/auth.js - Connection authentication: static key, HS256 JWT, Origin allowlist
//
// Pure functions only (no I/O) so they can be unit tested in isolation.

const crypto = require('crypto');

const AuthMode = {
  NONE: 'none',
  STATIC: 'static',
  TOKEN: 'token',
};

/**
 * Base64url encode a Buffer or string (RFC 4648 §5, no padding)
 */
function base64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Base64url decode to a Buffer. Returns null on invalid input.
 */
function base64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) {
    return null;
  }
  return Buffer.from(str, 'base64url');
}

/**
 * Constant-time string comparison. Returns false on length mismatch
 * without leaking which length was expected.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a comparison so timing does not depend on where lengths diverge
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Sign a JWT payload with HS256. Used by scripts/mint-token.js and tests.
 * @param {object} claims
 * @param {string} secret
 * @returns {string} compact JWT
 */
function signJwtHs256(claims, secret) {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64urlEncode(JSON.stringify(claims));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Verify an HS256 JWT.
 *
 * Rules:
 *   - alg must be exactly "HS256"
 *   - exp is required and must be in the future
 *   - nbf, if present, must not be in the future
 *   - exp - iat (or exp - now if iat absent) must be <= maxTtlSec when maxTtlSec > 0
 *
 * @param {string} token
 * @param {string} secret
 * @param {{ nowSec?: number, maxTtlSec?: number }} [opts]
 * @returns {{ ok: true, claims: object } | { ok: false, reason: string }}
 */
function verifyJwtHs256(token, secret, opts = {}) {
  const nowSec = Number.isFinite(opts.nowSec) ? opts.nowSec : Math.floor(Date.now() / 1000);
  const maxTtlSec = Number.isFinite(opts.maxTtlSec) ? opts.maxTtlSec : 0;

  if (typeof token !== 'string') return { ok: false, reason: 'token missing' };
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'secret not configured' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [headerB64, payloadB64, signatureB64] = parts;

  const headerBuf = base64urlDecode(headerB64);
  const payloadBuf = base64urlDecode(payloadB64);
  if (!headerBuf || !payloadBuf || !/^[A-Za-z0-9_-]+$/.test(signatureB64)) {
    return { ok: false, reason: 'malformed token' };
  }

  let header;
  try {
    header = JSON.parse(headerBuf.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed header' };
  }
  if (!header || header.alg !== 'HS256') {
    return { ok: false, reason: 'unsupported alg' };
  }

  // Verify signature before trusting any claim
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  if (!safeEqual(expected, signatureB64)) {
    return { ok: false, reason: 'bad signature' };
  }

  let claims;
  try {
    claims = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed payload' };
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return { ok: false, reason: 'malformed payload' };
  }

  if (!Number.isFinite(claims.exp)) return { ok: false, reason: 'exp missing' };
  if (claims.exp <= nowSec) return { ok: false, reason: 'token expired' };
  if (claims.nbf !== undefined) {
    if (!Number.isFinite(claims.nbf)) return { ok: false, reason: 'nbf invalid' };
    if (claims.nbf > nowSec) return { ok: false, reason: 'token not yet valid' };
  }
  if (claims.iat !== undefined && !Number.isFinite(claims.iat)) {
    return { ok: false, reason: 'iat invalid' };
  }
  if (maxTtlSec > 0) {
    const issuedAt = Number.isFinite(claims.iat) ? claims.iat : nowSec;
    if (claims.exp - issuedAt > maxTtlSec) {
      return { ok: false, reason: 'token lifetime exceeds maximum' };
    }
  }
  if (claims.sub !== undefined && typeof claims.sub !== 'string') {
    return { ok: false, reason: 'sub invalid' };
  }

  return { ok: true, claims };
}

/**
 * Compare a presented credential against the configured static key.
 */
function verifyStaticKey(credential, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return safeEqual(credential, expected);
}

/**
 * Pull the credential from an upgrade request.
 * Order: Authorization: Bearer header, then ?token= query parameter.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
function extractCredential(req) {
  const authHeader = req.headers && req.headers['authorization'];
  if (typeof authHeader === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (match) return match[1];
  }

  const url = req.url || '/';
  const qIndex = url.indexOf('?');
  if (qIndex !== -1) {
    const params = new URLSearchParams(url.slice(qIndex + 1));
    const token = params.get('token');
    if (token) return token;
  }

  return null;
}

/**
 * Origin allowlist check. Empty allowlist means no check. A request with
 * no Origin header passes: non-browser clients do not send one, and this
 * check only exists to stop other websites using the proxy from browsers.
 * @param {import('http').IncomingMessage} req
 * @param {string[]} allowedOrigins
 */
function checkOrigin(req, allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return true;
  const origin = req.headers && req.headers['origin'];
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return allowedOrigins.includes(origin);
}

/**
 * Determine the client IP for rate limiting.
 * @param {import('http').IncomingMessage} req
 * @param {boolean} trustProxy - honour the first X-Forwarded-For entry
 */
function clientIp(req, trustProxy) {
  if (trustProxy && req.headers) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Authenticate an upgrade request according to config.auth.
 * @param {import('http').IncomingMessage} req
 * @param {object} config - application config (uses config.auth)
 * @param {{ nowSec?: number }} [opts]
 * @returns {{ ok: true, subject: string|null, expSec: number|null, ip: string }
 *         | { ok: false, status: number, reason: string }}
 */
function authenticate(req, config, opts = {}) {
  const auth = (config && config.auth) || {};
  const mode = auth.mode || AuthMode.NONE;
  const ip = clientIp(req, Boolean(auth.trustProxy));

  if (!checkOrigin(req, auth.allowedOrigins || [])) {
    return { ok: false, status: 403, reason: 'origin not allowed' };
  }

  if (mode === AuthMode.NONE) {
    return { ok: true, subject: null, expSec: null, ip };
  }

  const credential = extractCredential(req);
  if (!credential) {
    return { ok: false, status: 401, reason: 'credential missing' };
  }

  if (mode === AuthMode.STATIC) {
    if (!verifyStaticKey(credential, auth.staticKey)) {
      return { ok: false, status: 401, reason: 'bad credential' };
    }
    return { ok: true, subject: null, expSec: null, ip };
  }

  if (mode === AuthMode.TOKEN) {
    const result = verifyJwtHs256(credential, auth.tokenSecret, {
      nowSec: opts.nowSec,
      maxTtlSec: auth.tokenMaxTtlSec,
    });
    if (!result.ok) {
      return { ok: false, status: 401, reason: result.reason };
    }
    return {
      ok: true,
      subject: typeof result.claims.sub === 'string' ? result.claims.sub : null,
      expSec: result.claims.exp,
      ip,
    };
  }

  return { ok: false, status: 500, reason: `unknown auth mode "${mode}"` };
}

module.exports = {
  AuthMode,
  base64urlEncode,
  base64urlDecode,
  safeEqual,
  signJwtHs256,
  verifyJwtHs256,
  verifyStaticKey,
  extractCredential,
  checkOrigin,
  clientIp,
  authenticate,
};
