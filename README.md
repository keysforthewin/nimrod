# Nimrod

A small WebSocket proxy that puts [Deepgram](https://deepgram.com) real-time speech-to-text behind your own server, so your apps can stream audio and get transcripts back without ever holding a Deepgram API key.

Point a browser, mobile app, or any WebSocket client at Nimrod, send raw PCM audio, and receive transcripts as JSON. Nimrod keeps the Deepgram key on the server, manages the Deepgram connection for each client, and handles reconnects, keep-alives, and end-of-speech finalization for you.

## Why

Deepgram's live API is a WebSocket that needs your API key in the connection. That's fine from a backend, but you can't ship that key inside a web page or a mobile app. Nimrod sits in between:

```
Your app  ──PCM audio──▶  Nimrod  ──PCM audio──▶  Deepgram
Your app  ◀──JSON──────   Nimrod  ◀──transcripts──  Deepgram
```

Your clients only know about Nimrod. Nimrod only knows about Deepgram. No SDK to install on the client side, just a WebSocket.

## Quick start

Requires Node.js 18 or newer.

```bash
git clone https://github.com/keysforthewin/nimrod.git
cd nimrod
npm install
cp env.example .env
# edit .env and set DEEPGRAM_API_KEY
npm start
```

Nimrod listens on `ws://localhost:8550` by default.

## Protocol

Nimrod's client protocol is deliberately tiny.

**Client to server**

- Binary frames: raw PCM audio, 16-bit signed little-endian, mono, at the configured sample rate (default 16 kHz). Send chunks as you capture them.
- Text frame `END_OF_AUDIO`: tells Nimrod you've finished speaking. Nimrod flushes remaining audio, waits for Deepgram's final transcript (or a timeout), then resets the session so you can start speaking again on the same connection.

**Server to client**

Each transcript is a JSON text frame:

```json
{ "isPartial": true,  "transcript": "hello wor" }
{ "isPartial": false, "transcript": "Hello world." }
```

`isPartial: true` is an interim result that will be revised. `isPartial: false` is a finalized segment.

### Minimal browser example

```js
const ws = new WebSocket('ws://localhost:8550');
ws.binaryType = 'arraybuffer';

ws.onmessage = (event) => {
  const { isPartial, transcript } = JSON.parse(event.data);
  console.log(isPartial ? 'partial:' : 'final:', transcript);
};

// Feed Int16 PCM chunks from your audio pipeline (AudioWorklet, MediaRecorder, etc.)
function sendAudio(int16Array) {
  ws.send(int16Array.buffer);
}

// When the user stops talking
function finish() {
  ws.send('END_OF_AUDIO');
}
```

## Testing with a WAV file

A test client that uses ffmpeg to convert any audio file to the right PCM format and stream it to Nimrod is included. ffmpeg must be on your PATH.

```bash
node test.js path/to/audio.wav
```

Unit tests for the authentication and limiter code (no network, no Deepgram) run with:

```bash
npm run test:unit
```

## Configuration

All settings come from environment variables. `env.example` lists every option with its default. Only `DEEPGRAM_API_KEY` is required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | | Your Deepgram API key |
| `PORT` | `8550` | WebSocket port to listen on |
| `DEEPGRAM_MODEL` | `nova-3` | Deepgram model |
| `SOURCE_LANGUAGE_CODE_LOCALE` | `en-US` | Transcription language |
| `SAMPLE_RATE` | `16000` | Sample rate of incoming PCM |
| `FINALIZE_TIMEOUT_MS` | `5000` | Max wait for a final transcript after `END_OF_AUDIO` |
| `BUFFER_MAX_CHUNKS` | `1000` | Per-client audio buffer size before backpressure |
| `AUTH_MODE` | `none` | `none`, `static` or `token`; see [Authentication](#authentication) |
| `MAX_*` | `0` | Usage caps; see [Usage caps](#usage-caps) |

## How it works

```
index.js → ClientGateway (WS server) → SessionManager (one per client) → DeepgramClient
                                              ↓
                                         AudioBuffer (bounded async queue)
```

Each client connection gets its own session with a small state machine: `IDLE` while buffering, `STREAMING` once Deepgram is connected and audio is flowing, `ENDING` while waiting for the final transcript after `END_OF_AUDIO`, then back to `IDLE`. The Deepgram connection is opened lazily on the first audio chunk and reconnects automatically with exponential backoff if it drops.

## Authentication

Out of the box Nimrod accepts any connection, so anyone who can reach the port can spend your Deepgram quota. Authentication is optional and off by default; existing installs keep working unchanged. Set `AUTH_MODE` to turn it on.

### What this does and does not protect

Be clear-eyed about the threat model before picking a mode:

- **A static key shipped inside a browser or game client can be extracted** by anyone who has the client. It stops drive-by abuse from people who merely find your port, nothing more.
- **Short-lived signed tokens keep the secret off the client entirely.** Your own backend, which already knows who its users are, mints a token that expires in minutes. Someone who pulls a token out of a client gets a few minutes of transcription as that user, which is what that user was allowed anyway, and you can see who it was.
- **Transcripts cannot be bound to a client.** Once text is returned, whoever receives it can do what they like with it. No auth scheme changes that.
- **Usage caps bound the damage** from any leaked credential, and are worth setting even with auth off.

### Passing the credential

Browsers cannot set headers on a WebSocket, so Nimrod accepts the credential two ways. The header is checked first.

| Client | How |
| --- | --- |
| Backend, CLI, game engine with header support | `Authorization: Bearer <credential>` on the upgrade request |
| Browser | `ws://host:8550/?token=<credential>` |

The query-string form may end up in proxy logs. Prefer the header where you can, and short-lived tokens where you cannot.

### `AUTH_MODE=static`

A single shared secret, compared in constant time.

```bash
AUTH_MODE=static
AUTH_STATIC_KEY=some-long-random-string
```

Use it for a backend-to-backend setup or a quick private deployment. Do not ship it inside something you hand to users.

### `AUTH_MODE=token`

Clients present a standard JWT signed with HMAC-SHA256 (`alg: HS256`). Nimrod verifies it with `AUTH_TOKEN_SECRET`; nothing else is needed on the Nimrod side, and no extra dependency.

```bash
AUTH_MODE=token
AUTH_TOKEN_SECRET=   # 32+ random characters, shared only with your backend
AUTH_TOKEN_MAX_TTL_SEC=3600
```

Claims Nimrod looks at:

| Claim | Required | Meaning |
| --- | --- | --- |
| `exp` | yes | Expiry (seconds since epoch). The connection is closed when it passes. |
| `iat` | no | Issued-at. `exp - iat` must not exceed `AUTH_TOKEN_MAX_TTL_SEC`. If absent, `exp - now` is checked instead. |
| `nbf` | no | Not-before. |
| `sub` | no | Who the token is for. Logged per session and used for `MAX_CONNECTIONS_PER_SUBJECT`. |

Any other `alg`, including `none`, is rejected before the signature is even checked.

**A token is a connection lifetime.** When `exp` passes, Nimrod closes the socket with code `1008` and reason `token expired`. Clients should fetch a fresh token from your backend and reconnect. Pick a TTL that matches how long one session of your app reasonably lasts.

Mint a token from the command line for testing:

```bash
node scripts/mint-token.js --sub alice --ttl 300
NIMROD_TOKEN=$(node scripts/mint-token.js --sub alice --ttl 300) node test.js path/to/audio.wav
```

Your backend does the same thing with any JWT library. In Node:

```js
// npm install jsonwebtoken
const jwt = require('jsonwebtoken');
const token = jwt.sign({ sub: user.id }, process.env.AUTH_TOKEN_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
// hand the token to the client; it connects to ws://nimrod/?token=<token>
```

In Python:

```python
# pip install pyjwt
import jwt, time
now = int(time.time())
token = jwt.encode({"sub": user.id, "iat": now, "exp": now + 300}, SECRET, algorithm="HS256")
```

### Browser Origin allowlist

`AUTH_ALLOWED_ORIGINS=https://app.example.com,http://localhost:3000` rejects browser connections from any other site with `403`. Requests with no `Origin` header (anything that is not a browser) pass this check, because a non-browser client can set any Origin it likes. It is a cheap complement to authentication, not a replacement.

### Usage caps

All default to `0` (unlimited) and apply in every auth mode.

| Variable | Effect |
| --- | --- |
| `MAX_CONNECTION_SEC` | Close the connection after this many seconds |
| `MAX_AUDIO_SEC_PER_CONNECTION` | Close after this many seconds of audio (computed from PCM bytes received) |
| `MAX_CONNECTIONS_PER_IP` | Concurrent connections per client IP (set `TRUST_PROXY=true` behind a reverse proxy) |
| `MAX_CONNECTIONS_PER_SUBJECT` | Concurrent connections per token `sub` (token mode only) |

### What clients see on rejection

| Situation | Response |
| --- | --- |
| Missing or invalid credential | HTTP `401` during the handshake |
| Origin not allowed | HTTP `403` during the handshake |
| Per-IP or per-subject connection cap | HTTP `429` during the handshake |
| Plain HTTP request | HTTP `426 Upgrade Required` |
| Token expired, lifetime or audio cap hit mid-session | WebSocket close code `1008` with reason `token expired`, `connection lifetime exceeded` or `audio limit exceeded` |

The transcript message format is unchanged, so clients that do not know about any of this keep working.

## Deploying

Run Nimrod behind a reverse proxy with TLS (`wss://`). If you terminate TLS at the proxy, set `TRUST_PROXY=true` so per-IP limits see the real client address. You can still layer whatever your stack already uses on top: a VPN, a network allowlist, or an auth check at the proxy.

`nimrod.sh` is a small launcher that loads nvm, sets `NODE_ENV=production`, and starts the server from the script's own directory. It's suitable for a systemd unit or a process manager.

## License

MIT
