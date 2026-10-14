// test/auth.test.js - Unit tests for server/auth.js and server/ConnectionLimiter.js
// Run with: npm run test:unit   (node --test test/)

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  signJwtHs256,
  verifyJwtHs256,
  verifyStaticKey,
  extractCredential,
  checkOrigin,
  clientIp,
  authenticate,
  base64urlEncode,
} = require('../server/auth');
const ConnectionLimiter = require('../server/ConnectionLimiter');

const SECRET = 'test-secret-that-is-at-least-32-chars-long';
const NOW = 1_700_000_000;

function req({ url = '/', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { url, headers, socket: { remoteAddress } };
}

test('verifyJwtHs256: accepts a valid token and returns claims', () => {
  const token = signJwtHs256({ sub: 'alice', iat: NOW, exp: NOW + 300 }, SECRET);
  const result = verifyJwtHs256(token, SECRET, { nowSec: NOW + 10, maxTtlSec: 3600 });
  assert.equal(result.ok, true);
  assert.equal(result.claims.sub, 'alice');
  assert.equal(result.claims.exp, NOW + 300);
});

test('verifyJwtHs256: rejects expired token', () => {
  const token = signJwtHs256({ exp: NOW - 1 }, SECRET);
  const result = verifyJwtHs256(token, SECRET, { nowSec: NOW });
  assert.deepEqual(result, { ok: false, reason: 'token expired' });
});

test('verifyJwtHs256: rejects token with exp exactly now', () => {
  const token = signJwtHs256({ exp: NOW }, SECRET);
  assert.equal(verifyJwtHs256(token, SECRET, { nowSec: NOW }).ok, false);
});

test('verifyJwtHs256: rejects missing exp', () => {
  const token = signJwtHs256({ sub: 'alice' }, SECRET);
  assert.deepEqual(verifyJwtHs256(token, SECRET, { nowSec: NOW }), { ok: false, reason: 'exp missing' });
});

test('verifyJwtHs256: rejects nbf in the future', () => {
  const token = signJwtHs256({ nbf: NOW + 60, exp: NOW + 300 }, SECRET);
  assert.deepEqual(verifyJwtHs256(token, SECRET, { nowSec: NOW }), { ok: false, reason: 'token not yet valid' });
});

test('verifyJwtHs256: rejects lifetime over maxTtlSec using iat', () => {
  const token = signJwtHs256({ iat: NOW, exp: NOW + 7200 }, SECRET);
  const result = verifyJwtHs256(token, SECRET, { nowSec: NOW, maxTtlSec: 3600 });
  assert.deepEqual(result, { ok: false, reason: 'token lifetime exceeds maximum' });
});

test('verifyJwtHs256: rejects lifetime over maxTtlSec using now when iat absent', () => {
  const token = signJwtHs256({ exp: NOW + 7200 }, SECRET);
  assert.equal(verifyJwtHs256(token, SECRET, { nowSec: NOW, maxTtlSec: 3600 }).ok, false);
  assert.equal(verifyJwtHs256(token, SECRET, { nowSec: NOW + 4000, maxTtlSec: 3600 }).ok, true);
});

test('verifyJwtHs256: maxTtlSec of 0 disables the lifetime check', () => {
  const token = signJwtHs256({ iat: NOW, exp: NOW + 10 * 365 * 86400 }, SECRET);
  assert.equal(verifyJwtHs256(token, SECRET, { nowSec: NOW, maxTtlSec: 0 }).ok, true);
});

test('verifyJwtHs256: rejects wrong secret', () => {
  const token = signJwtHs256({ exp: NOW + 300 }, SECRET);
  assert.deepEqual(verifyJwtHs256(token, 'another-secret', { nowSec: NOW }), { ok: false, reason: 'bad signature' });
});

test('verifyJwtHs256: rejects tampered payload', () => {
  const token = signJwtHs256({ sub: 'alice', exp: NOW + 300 }, SECRET);
  const [h, , s] = token.split('.');
  const forgedPayload = base64urlEncode(JSON.stringify({ sub: 'admin', exp: NOW + 300 }));
  assert.equal(verifyJwtHs256(`${h}.${forgedPayload}.${s}`, SECRET, { nowSec: NOW }).ok, false);
});

test('verifyJwtHs256: rejects tampered signature', () => {
  const token = signJwtHs256({ exp: NOW + 300 }, SECRET);
  const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyJwtHs256(flipped, SECRET, { nowSec: NOW }).ok, false);
});

test('verifyJwtHs256: rejects alg none and other algs', () => {
  const payload = base64urlEncode(JSON.stringify({ exp: NOW + 300 }));
  for (const alg of ['none', 'HS512', 'RS256', 'hs256']) {
    const header = base64urlEncode(JSON.stringify({ alg, typ: 'JWT' }));
    const result = verifyJwtHs256(`${header}.${payload}.`, SECRET, { nowSec: NOW });
    assert.equal(result.ok, false, `alg ${alg} should be rejected`);
    assert.notEqual(result.reason, 'bad signature', 'alg must be rejected before signature check');
  }
});

test('verifyJwtHs256: rejects malformed input', () => {
  for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', 'a.b.c', '!!.!!.!!', null, undefined, 42]) {
    assert.equal(verifyJwtHs256(bad, SECRET, { nowSec: NOW }).ok, false, `input ${String(bad)}`);
  }
});

test('verifyJwtHs256: rejects non-string sub', () => {
  const token = signJwtHs256({ sub: 123, exp: NOW + 300 }, SECRET);
  assert.deepEqual(verifyJwtHs256(token, SECRET, { nowSec: NOW }), { ok: false, reason: 'sub invalid' });
});

test('verifyJwtHs256: rejects empty secret', () => {
  const token = signJwtHs256({ exp: NOW + 300 }, '');
  assert.equal(verifyJwtHs256(token, '', { nowSec: NOW }).ok, false);
});

test('verifyStaticKey: timing-safe match and mismatch', () => {
  assert.equal(verifyStaticKey('abc', 'abc'), true);
  assert.equal(verifyStaticKey('abd', 'abc'), false);
  assert.equal(verifyStaticKey('ab', 'abc'), false);
  assert.equal(verifyStaticKey('abcd', 'abc'), false);
  assert.equal(verifyStaticKey('', ''), false);
  assert.equal(verifyStaticKey(undefined, 'abc'), false);
  assert.equal(verifyStaticKey('abc', undefined), false);
});

test('extractCredential: Bearer header wins, then ?token=', () => {
  assert.equal(extractCredential(req({ headers: { authorization: 'Bearer h1' }, url: '/?token=q1' })), 'h1');
  assert.equal(extractCredential(req({ headers: { authorization: 'bearer h2' } })), 'h2');
  assert.equal(extractCredential(req({ url: '/?token=q2' })), 'q2');
  assert.equal(extractCredential(req({ url: '/?foo=bar&token=q3' })), 'q3');
  assert.equal(extractCredential(req({ url: '/?token=' })), null);
  assert.equal(extractCredential(req({ headers: { authorization: 'Basic abc' } })), null);
  assert.equal(extractCredential(req({})), null);
});

test('checkOrigin: empty allowlist passes everything', () => {
  assert.equal(checkOrigin(req({ headers: { origin: 'https://evil.example' } }), []), true);
  assert.equal(checkOrigin(req({}), undefined), true);
});

test('checkOrigin: enforces allowlist, exact match, missing header passes', () => {
  const allowed = ['https://app.example.com', 'http://localhost:3000'];
  assert.equal(checkOrigin(req({ headers: { origin: 'https://app.example.com' } }), allowed), true);
  assert.equal(checkOrigin(req({ headers: { origin: 'http://localhost:3000' } }), allowed), true);
  assert.equal(checkOrigin(req({ headers: { origin: 'https://evil.example' } }), allowed), false);
  assert.equal(checkOrigin(req({ headers: { origin: 'https://app.example.com.evil' } }), allowed), false);
  assert.equal(checkOrigin(req({ headers: { origin: 'https://APP.example.com' } }), allowed), false);
  assert.equal(checkOrigin(req({}), allowed), true);
});

test('clientIp: honours X-Forwarded-For only when trustProxy', () => {
  const r = req({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, remoteAddress: '10.0.0.1' });
  assert.equal(clientIp(r, false), '10.0.0.1');
  assert.equal(clientIp(r, true), '203.0.113.5');
  assert.equal(clientIp({ headers: {}, socket: {} }, false), 'unknown');
});

test('authenticate: mode none admits anyone', () => {
  const result = authenticate(req({}), { auth: { mode: 'none' } });
  assert.deepEqual(result, { ok: true, subject: null, expSec: null, ip: '127.0.0.1' });
});

test('authenticate: mode none still enforces origin allowlist', () => {
  const config = { auth: { mode: 'none', allowedOrigins: ['https://ok.example'] } };
  assert.equal(authenticate(req({ headers: { origin: 'https://ok.example' } }), config).ok, true);
  const bad = authenticate(req({ headers: { origin: 'https://evil.example' } }), config);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);
});

test('authenticate: mode static', () => {
  const config = { auth: { mode: 'static', staticKey: 'k3y' } };
  assert.equal(authenticate(req({ url: '/?token=k3y' }), config).ok, true);
  assert.equal(authenticate(req({ headers: { authorization: 'Bearer k3y' } }), config).ok, true);
  const wrong = authenticate(req({ url: '/?token=nope' }), config);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 401);
  const missing = authenticate(req({}), config);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 401);
});

test('authenticate: mode token returns subject and exp', () => {
  const config = { auth: { mode: 'token', tokenSecret: SECRET, tokenMaxTtlSec: 3600 } };
  const token = signJwtHs256({ sub: 'bob', iat: NOW, exp: NOW + 120 }, SECRET);
  const ok = authenticate(req({ url: `/?token=${token}` }), config, { nowSec: NOW });
  assert.deepEqual(ok, { ok: true, subject: 'bob', expSec: NOW + 120, ip: '127.0.0.1' });

  const expired = authenticate(req({ url: `/?token=${token}` }), config, { nowSec: NOW + 500 });
  assert.equal(expired.ok, false);
  assert.equal(expired.status, 401);
  assert.equal(expired.reason, 'token expired');
});

test('authenticate: unknown mode is rejected, not admitted', () => {
  const result = authenticate(req({ url: '/?token=x' }), { auth: { mode: 'bogus' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
});

test('ConnectionLimiter: zero caps mean unlimited', () => {
  const l = new ConnectionLimiter({});
  for (let i = 0; i < 100; i++) assert.equal(l.acquire({ ip: '1.1.1.1', subject: 's' }), true);
});

test('ConnectionLimiter: per-IP cap', () => {
  const l = new ConnectionLimiter({ maxConnectionsPerIp: 2 });
  assert.equal(l.acquire({ ip: 'a' }), true);
  assert.equal(l.acquire({ ip: 'a' }), true);
  assert.equal(l.acquire({ ip: 'a' }), false);
  assert.equal(l.acquire({ ip: 'b' }), true);
  l.release({ ip: 'a' });
  assert.equal(l.acquire({ ip: 'a' }), true);
});

test('ConnectionLimiter: per-subject cap and failed acquire reserves nothing', () => {
  const l = new ConnectionLimiter({ maxConnectionsPerIp: 10, maxConnectionsPerSubject: 1 });
  assert.equal(l.acquire({ ip: 'a', subject: 'alice' }), true);
  assert.equal(l.acquire({ ip: 'b', subject: 'alice' }), false);
  // IP 'b' must not have been counted by the failed acquire
  assert.equal(l.byIp.has('b'), false);
  assert.equal(l.acquire({ ip: 'b', subject: 'carol' }), true);
});

test('ConnectionLimiter: release is safe when nothing was acquired and cleans up zero entries', () => {
  const l = new ConnectionLimiter({ maxConnectionsPerIp: 1 });
  l.release({ ip: 'ghost', subject: 'ghost' });
  assert.equal(l.acquire({ ip: 'a' }), true);
  l.release({ ip: 'a' });
  assert.equal(l.byIp.size, 0);
  assert.equal(l.acquire({ ip: 'a' }), true);
});
