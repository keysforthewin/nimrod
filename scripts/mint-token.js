#!/usr/bin/env node
// scripts/mint-token.js - Mint a short-lived HS256 JWT for AUTH_MODE=token
//
// Usage:
//   node scripts/mint-token.js [--sub <subject>] [--ttl <seconds>] [--secret <secret>]
//
// Reads AUTH_TOKEN_SECRET from .env unless --secret is given. Prints the token.
// This is the reference for what an operator's backend should produce; the
// same thing in any JWT library is: { alg: HS256 }, claims { sub, iat, exp }.

require('dotenv').config();
const { signJwtHs256 } = require('../server/auth');

function parseArgs(argv) {
  const out = { sub: undefined, ttl: 300, secret: process.env.AUTH_TOKEN_SECRET || '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--sub') out.sub = next();
    else if (arg === '--ttl') out.ttl = parseInt(next(), 10);
    else if (arg === '--secret') out.secret = next();
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/mint-token.js [--sub <subject>] [--ttl <seconds>] [--secret <secret>]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.ttl)) throw new Error('--ttl must be an integer number of seconds');
  if (!out.secret) throw new Error('AUTH_TOKEN_SECRET is not set (in .env) and --secret was not given');
  return out;
}

try {
  const { sub, ttl, secret } = parseArgs(process.argv.slice(2));
  const now = Math.floor(Date.now() / 1000);
  const claims = { iat: now, exp: now + ttl };
  if (sub !== undefined) claims.sub = sub;
  process.stdout.write(signJwtHs256(claims, secret) + '\n');
} catch (err) {
  console.error(`mint-token: ${err.message}`);
  process.exit(1);
}
