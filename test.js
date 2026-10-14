/**
 * ffmpeg-client.js
 *
 * Requirements:
 *   1) ffmpeg must be installed and on your PATH.
 *   2) npm install ws
 *
 * Usage:
 *   node test.js path/to/audio.wav
 *
 * Environment:
 *   NIMROD_URL    WebSocket URL of the server (default ws://localhost:8550)
 *   NIMROD_TOKEN  Credential to send as ?token=... when the server has AUTH_MODE set
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const readline = require('readline');

// 1) Parse command-line argument for input file
const inputFile = process.argv[2];
if (!inputFile) {
    console.error('Please provide a path to a WAV file.');
    process.exit(1);
}

// 2) Set up your WebSocket URL (point to your local proxy)
const WS_URL = (() => {
    const url = new URL(process.env.NIMROD_URL || 'ws://localhost:8550');
    if (process.env.NIMROD_TOKEN) {
        url.searchParams.set('token', process.env.NIMROD_TOKEN);
    }
    return url.toString();
})();

// State management
let ws = null;
let waitingForEnter = false;
let currentFfmpeg = null;
let isReconnecting = false;

// 4) Function to send audio file
function sendAudioFile() {
    console.log('\n=== Starting audio transmission ===');
    
    /**
     * Spawn ffmpeg with the following arguments:
     * -i            Input file
     * -ac 1         Convert to 1 channel (mono)
     * -ar 16000     Resample to 16 kHz
     * -sample_fmt s16  16-bit samples
     * -f s16le      Output raw 16-bit little-endian PCM
     * pipe:1        Send all output to stdout
     */
    currentFfmpeg = spawn('ffmpeg', [
        '-i', inputFile,
        '-ac', '1',
        '-ar', '16000',
        '-sample_fmt', 's16',
        '-f', 's16le',
        'pipe:1'
    ]);

    // Whenever ffmpeg outputs a chunk of audio, send it to the WebSocket
    currentFfmpeg.stdout.on('data', (chunk) => {
        console.log(`[${new Date().toISOString()}] sending chunk of size: ${chunk.length}`);
        ws.send(chunk);
    });

    // If ffmpeg has an error, print it to stderr
    currentFfmpeg.stderr.on('data', (data) => {
        // Suppress ffmpeg info messages, only show actual errors
        const msg = data.toString();
        if (!msg.includes('Stream mapping:') && !msg.includes('Press [q]') && !msg.includes('size=') && !msg.includes('time=')) {
            console.error('ffmpeg error:', msg);
        }
    });

    // When ffmpeg is done, send END_OF_AUDIO signal to trigger finalization
    currentFfmpeg.on('close', (code) => {
        console.log(`[${new Date().toISOString()}] ffmpeg process exited with code ${code}`);
        console.log(`[${new Date().toISOString()}] All audio data sent. Sending END_OF_AUDIO signal...`);
        
        // Send END_OF_AUDIO text message to trigger Deepgram finalization
        ws.send('END_OF_AUDIO');
        console.log(`[${new Date().toISOString()}] END_OF_AUDIO sent. Waiting for final transcript...`);
        
        currentFfmpeg = null;
    });
}

// 5) Function to set up WebSocket handlers
function setupWebSocketHandlers() {
    ws.on('open', () => {
        console.log('Connected to the Transcribe proxy server.');
        isReconnecting = false;
        if (waitingForEnter) {
            // If we were waiting for Enter and just reconnected, send audio
            waitingForEnter = false;
            sendAudioFile();
        } else {
            // Initial connection
            sendAudioFile();
        }
    });

    ws.on('message', (data) => {
        try {
            const { transcript, isPartial } = JSON.parse(data);
            if (transcript) {
                console.log(`[${new Date().toISOString()}] ${transcript} (partial: ${isPartial})`);
            }
            
            // When we receive final transcript, wait for Enter key
            if (!isPartial && !waitingForEnter) {
                waitingForEnter = true;
                console.log('\n✓ Final transcript received!');
                console.log('>>> Press ENTER to resend audio, or Ctrl+C to exit <<<\n');
            }
        } catch (err) {
            console.error('Error parsing server message:', err);
        }
    });

    ws.on('close', (code, reason) => {
        const detail = reason && reason.length ? `: ${reason}` : '';
        console.log(`WebSocket closed by server (code ${code}${detail})`);
        // Don't exit, stay ready for reconnection
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message || err);
        // Don't exit, let user decide
    });
}

// 6) Set up stdin listener for Enter key
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
}

process.stdin.on('keypress', (str, key) => {
    if (key.name === 'return' && waitingForEnter) {
        // Check if WebSocket is open
        if (ws && ws.readyState === WebSocket.OPEN) {
            waitingForEnter = false;
            sendAudioFile();
        } else {
            // Need to reconnect
            console.log('Reconnecting to server...');
            isReconnecting = true;
            ws = new WebSocket(WS_URL);
            setupWebSocketHandlers();
        }
    } else if (key.ctrl && key.name === 'c') {
        console.log('\nExiting...');
        process.exit(0);
    }
});

// 7) Create initial WebSocket connection
ws = new WebSocket(WS_URL);
setupWebSocketHandlers();
