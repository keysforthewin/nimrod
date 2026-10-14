# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Nimrod is a WebSocket-based real-time audio transcription bridge. Clients stream PCM linear16 audio over WebSocket, Nimrod forwards it to Deepgram's speech-to-text API, and returns transcripts as JSON to the client.

## Commands

```bash
npm start          # Run the server (node index.js)
npm test           # Run test client (node test.js) - requires a WAV file arg: node test.js path/to/audio.wav
npm run test:unit  # Unit tests for server/auth.js and server/ConnectionLimiter.js (node:test, no network)
npm run start:old  # Run the original monolithic version (nimrod.js)
node scripts/mint-token.js --sub alice --ttl 300   # Mint an HS256 JWT for AUTH_MODE=token (reads AUTH_TOKEN_SECRET from .env)
```

No build step, no linter. Unit tests use the built-in `node:test` runner; `test.js` (the WAV client) is interactive and talks to Deepgram.

## Required Setup

Copy `env.example` to `.env` and set `DEEPGRAM_API_KEY`. All other env vars have defaults (see `config.js`). Authentication and usage caps are off unless `AUTH_MODE` / `MAX_*` are set, so an older `.env` keeps the old behaviour.

## Architecture

```
index.js → ClientGateway (HTTP + WS server) → SessionManager (per-client) → DeepgramClient
              ↓ on upgrade                         ↓
         auth.js + ConnectionLimiter          AudioBuffer (bounded async queue)
```

**Entry point**: `index.js` — validates config, starts `ClientGateway`, handles graceful shutdown.

**Key modules**:
- `server/ClientGateway.js` — Multi-client WebSocket server (`http.createServer` + `ws` in `noServer` mode). The `upgrade` handler runs `authenticate()`, then the `ConnectionLimiter`, and rejects with a raw HTTP status (401/403/429) before the WebSocket exists. Schedules a 1008 close at token `exp` or `MAX_CONNECTION_SEC`. Routes binary audio and text control messages (`"END_OF_AUDIO"`) to per-client `SessionManager` instances.
- `server/auth.js` — Pure functions: `authenticate(req, config)`, HS256 JWT sign/verify on `node:crypto` (no dependency), static key compare, Origin allowlist, client IP. Credential comes from `Authorization: Bearer` or `?token=`.
- `server/ConnectionLimiter.js` — Concurrent connection counters per IP and per token `sub`; `acquire()` / `release()`.
- `core/SessionManager.js` — State machine orchestrator (IDLE → STREAMING → ENDING → CLOSED). Lazily connects to Deepgram on first audio chunk, runs an async send loop draining the buffer, handles finalization with `speech_final` detection or 5s timeout. Counts PCM bytes received and closes with 1008 `audio limit exceeded` when `MAX_AUDIO_SEC_PER_CONNECTION` is hit.
- `core/DeepgramClient.js` — Manages Deepgram WebSocket lifecycle with exponential backoff retry, keep-alive pings (5s interval), and event-based transcript/error handling.
- `core/AudioBuffer.js` — Bounded async queue with promise-based `pop()`, EOA sentinel support, and backpressure detection.
- `core/Types.js` — Enums (`SessionState`, `DeepgramState`, `AudioEventType`, `ClientEventType`, `ErrorCode`) and helper functions.
- `config.js` — Centralized config from env vars with validation.
- `utils/logger.js` — Structured logger (most levels currently stubbed for production quietness).

## Protocol

**Client → Server**: Binary frames (raw PCM audio) + text frame `"END_OF_AUDIO"` to signal completion.

**Server → Client**: JSON `{ "isPartial": boolean, "transcript": string }`. No other message shapes; limit/auth failures are signalled with HTTP status on the handshake or WebSocket close code 1008, never as JSON.

## Authentication and Limits

Configured in `config.auth` and `config.limits` (all off by default). `AUTH_MODE=none|static|token`; token mode verifies HS256 JWTs (`exp` required, `sub` optional) signed with `AUTH_TOKEN_SECRET`.

| Situation | Client sees |
| --- | --- |
| Bad/missing credential | HTTP 401 on upgrade |
| Origin not in `AUTH_ALLOWED_ORIGINS` | HTTP 403 on upgrade |
| `MAX_CONNECTIONS_PER_IP` / `_PER_SUBJECT` hit | HTTP 429 on upgrade |
| Plain HTTP request | HTTP 426 |
| Token `exp`, `MAX_CONNECTION_SEC`, `MAX_AUDIO_SEC_PER_CONNECTION` hit | WS close 1008 + reason |

When changing auth behaviour, keep `server/auth.js` free of I/O so `test/auth.test.js` stays dependency-free.

## State Machine

```
IDLE (buffering audio) → STREAMING (Deepgram connected, draining + forwarding) → ENDING (waiting for speech_final or 5s timeout) → IDLE
Any state → CLOSED (client disconnects)
```

Deepgram connection is lazy — created only when first audio arrives. Auto-reconnects on unexpected disconnect.

## Dependencies

- `@deepgram/sdk` — Deepgram live transcription
- `ws` — WebSocket server
- `dotenv` — Env var loading
- `@aws-sdk/client-translate` — AWS translation (included but not currently active)
