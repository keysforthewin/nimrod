/**
 * ffmpeg-client.js
 *
 * Requirements:
 *   1) ffmpeg must be installed and on your PATH.
 *   2) npm install ws
 *
 * Usage:
 *   node ffmpeg-client.js path/to/audio.wav
 */

const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');

// 1) Parse command-line argument for input file
const inputFile = process.argv[2];
if (!inputFile) {
    console.error('Please provide a path to a WAV file.');
    process.exit(1);
}

// 2) Set up your WebSocket URL (point to your local proxy)
const WS_URL = 'ws://localhost:8550';

// 3) Create the WebSocket connection
const ws = new WebSocket(WS_URL);

// 4) On successful connection, run ffmpeg
ws.on('open', () => {
    console.log('Connected to the Transcribe proxy server.');

    /**
     * Spawn ffmpeg with the following arguments:
     * -i            Input file
     * -ac 1         Convert to 1 channel (mono)
     * -ar 16000     Resample to 16 kHz
     * -sample_fmt s16  16-bit samples
     * -f s16le      Output raw 16-bit little-endian PCM
     * pipe:1        Send all output to stdout
     */
    const ffmpeg = spawn('ffmpeg', [
        '-i', inputFile,
        '-ac', '1',
        '-ar', '16000',
        '-sample_fmt', 's16',
        '-f', 's16le',
        'pipe:1'
    ]);

    // 5) Whenever ffmpeg outputs a chunk of audio, send it to the WebSocket
    ffmpeg.stdout.on('data', (chunk) => {
        console.log(`[${new Date().toISOString()}] sending chunk of size: ${chunk.length}`);
        ws.send(chunk);
    });

    // 6) If ffmpeg has an error, print it to stderr
    ffmpeg.stderr.on('data', (data) => {
        console.error('ffmpeg error:', data.toString());
    });

    // 7) When ffmpeg is done, send END_OF_AUDIO signal to trigger finalization
    ffmpeg.on('close', (code) => {
        console.log(`ffmpeg process exited with code ${code}`);
        console.log(`[${new Date().toISOString()}] All audio data sent. Sending END_OF_AUDIO signal...`);
        
        // Send END_OF_AUDIO text message to trigger Deepgram finalization
        ws.send('END_OF_AUDIO');
        console.log(`[${new Date().toISOString()}] END_OF_AUDIO sent. Waiting for final transcripts...`);
        
        // Note: Server will close the WebSocket after final transcript is received
    });
});

// 8) Handle messages from the server (transcribed text)
ws.on('message', (data) => {
    try {
        // Expect JSON of the form { transcript, isPartial }
        const { transcript, isPartial } = JSON.parse(data);
        if (transcript) {
            console.log(`[${new Date().toISOString()}] ${transcript} (partial: ${isPartial})`);
        }
    } catch (err) {
        console.error('Error parsing server message:', err);
    }
});

// 9) Handle WebSocket close/error
ws.on('close', () => {
    console.log('WebSocket closed');
});

ws.on('error', (err) => {
    console.error('WebSocket error:', err);
});
