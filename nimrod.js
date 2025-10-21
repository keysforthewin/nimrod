// server.js
require('dotenv').config();
const { WebSocketServer } = require('ws');
const {
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand
} = require('@aws-sdk/client-transcribe-streaming');
const {TranslateClient, TranslateTextCommand } = require("@aws-sdk/client-translate");
const fs = require('fs');
const path = require('path');

const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const chunkDurationMs = parseInt(process.env.CHUNK_DURATION_MS, 10) || 20;
const audioSampleRate = parseInt(process.env.SAMPLE_RATE, 10) || 16000;

// Ensure audio logs directory exists
const audioLogsDir = './audio_logs';
if (!fs.existsSync(audioLogsDir)) {
    fs.mkdirSync(audioLogsDir, { recursive: true });
    console.log('Created audio_logs directory');
}

const sockserver = new WebSocketServer({ port: 8550 }, () => {
    console.log('WebSocket server is listening on port 8550');
});

// WAV file writer class
class WavWriter {
    constructor(filename, sampleRate) {
        this.filename = filename;
        this.sampleRate = sampleRate;
        this.bytesWritten = 0;
        this.stream = fs.createWriteStream(filename);
        
        // Write WAV header (will update later with correct size)
        this.writeHeader();
    }

    writeHeader() {
        const header = Buffer.alloc(44);
        
        // RIFF chunk descriptor
        header.write('RIFF', 0);
        header.writeUInt32LE(0, 4); // File size - 8 (will be updated)
        header.write('WAVE', 8);
        
        // fmt sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
        header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
        header.writeUInt16LE(1, 22); // NumChannels (1 = mono)
        header.writeUInt32LE(this.sampleRate, 24); // SampleRate
        header.writeUInt32LE(this.sampleRate * 2, 28); // ByteRate
        header.writeUInt16LE(2, 32); // BlockAlign
        header.writeUInt16LE(16, 34); // BitsPerSample
        
        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(0, 40); // Subchunk2Size (will be updated)
        
        this.stream.write(header);
    }

    writeAudioChunk(chunk) {
        this.stream.write(chunk);
        this.bytesWritten += chunk.length;
    }

    close() {
        // Update the header with the correct sizes
        const fileSize = this.bytesWritten + 44 - 8;
        const dataSize = this.bytesWritten;
        
        const sizeBuffer = Buffer.alloc(4);
        
        // Update file size
        sizeBuffer.writeUInt32LE(fileSize, 0);
        fs.writeSync(fs.openSync(this.filename, 'r+'), sizeBuffer, 0, 4, 4);
        
        // Update data size
        sizeBuffer.writeUInt32LE(dataSize, 0);
        fs.writeSync(fs.openSync(this.filename, 'r+'), sizeBuffer, 0, 4, 40);
        
        this.stream.end();
        console.log(`WAV file saved: ${this.filename} (${this.bytesWritten} bytes of audio data)`);
    }
}

class AudioStream {
    constructor(chunkDurationMs, audioSampleRate, sessionId) {
        this.chunkSize = Math.floor((chunkDurationMs / 1000) * audioSampleRate * 2);
        console.log('Using chunkSize (bytes):', this.chunkSize);

        this.chunkDurationMs = chunkDurationMs;
        this.silenceChunk = Buffer.alloc(this.chunkSize, 0);
        this.maxSilenceChunks = 15;
        this.consecutiveSilenceChunksSent = 0;
        this.dataSent = false;
        this.silenceStartTime = 0;
        this.isClosed = false;
        this.audioBufferQueue = [];
        
        // Initialize WAV writer for this session
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = path.join(audioLogsDir, `audio_session_${timestamp}_${sessionId}.wav`);
        this.wavWriter = new WavWriter(filename, audioSampleRate);
        console.log(`Created audio log file: ${filename}`);
    }

    resetForReconnection() {
        // Reset state for reconnection
        this.consecutiveSilenceChunksSent = 0;
        this.dataSent = false;
        this.silenceStartTime = 0;
        console.log("Audio stream state reset for reconnection");
    }

    async * getAudioStream() {
        console.log("Audio stream generator started");
        
        try {
            while (!this.isClosed) {
                if (this.audioBufferQueue.length === 0) {
                    if (this.dataSent) {
                        if (this.silenceStartTime === 0) {
                            this.silenceStartTime = Date.now();
                        } else {
                            if (Date.now() - this.silenceStartTime > 500) {
                                if (this.consecutiveSilenceChunksSent < this.maxSilenceChunks) {
                                    // Send a chunk of silence
                                    const silenceChunk = this.silenceChunk;
                                    
                                    // Log the silence chunk to WAV file
                                    this.wavWriter.writeAudioChunk(silenceChunk);
                                    
                                    yield {
                                        AudioEvent: {AudioChunk: silenceChunk},
                                    };
                                    this.consecutiveSilenceChunksSent++;
                                    console.log("SENDING SILENCE");
                                    await new Promise((resolve) => setTimeout(resolve, this.chunkDurationMs));
                                    continue;
                                } else {
                                    this.dataSent = false;
                                }
                            }
                        }
                    }

                    await new Promise((resolve) => setTimeout(resolve, 1));
                }

                // We have real audio in the queue: send one chunk from the queue
                const audioChunk = this.audioBufferQueue.shift();
                if (audioChunk) {
                    console.log(`[${new Date().toISOString()}]  audio chunk of length: ${audioChunk.length}`);
                    
                    // Log the audio chunk to WAV file
                    this.wavWriter.writeAudioChunk(audioChunk);
                    
                    yield {
                        AudioEvent: {
                            AudioChunk: audioChunk,
                        },
                    };
                    // reset silence count since we just sent real audio
                    this.dataSent = true;
                    this.silenceStartTime = 0;
                    this.consecutiveSilenceChunksSent = 0;
                }
                await new Promise((resolve) => setTimeout(resolve, this.chunkDurationMs));
            }
        } finally {
            console.log("AUDIO STREAM GENERATOR EXITED");
            
            // Only close the WAV file if the client has disconnected
            if (this.isClosed && this.wavWriter) {
                console.log("Client disconnected, closing WAV file");
                this.wavWriter.close();
            }
        }
    }
}

async function startTranscription(ws, audioStream) {

    const command = new StartStreamTranscriptionCommand({
        LanguageCode: process.env.SOURCE_LANGUAGE_CODE_LOCALE, // or your desired language
        MediaEncoding: 'pcm',  // must match what the client sends
        MediaSampleRateHertz: audioSampleRate, // must match your sample rate
        AudioStream: audioStream.getAudioStream(),
    });

    console.log(`[${new Date().toISOString()}]  Starting transcription stream`);

    try {
        const translationClient = new TranslateClient({ region: region, credentials: {
                accessKeyId,
                secretAccessKey,
            }});

        const client = new TranscribeStreamingClient({
            region,
            credentials: {
                accessKeyId,
                secretAccessKey,
            },
        });

        const transcribeResponse = client.send(command);
        console.log(`[${new Date().toISOString()}]  Sent command to Transcribe`);
        const response = await transcribeResponse;

        for await (const event of response.TranscriptResultStream) {
            if (event.TranscriptEvent) {
                const results = event.TranscriptEvent.Transcript.Results || [];
                for (const result of results) {

                    // Each 'result' can have multiple 'Alternatives'
                    if (result.Alternatives && result.Alternatives.length > 0) {
                        const transcript = result.Alternatives[0].Transcript;
                        console.log(`[${new Date().toISOString()}] Transcript: ${transcript} (partial: ${result.IsPartial})`);
                        // Send partial or final transcript back to the client
                        // 'result.IsPartial' indicates partial vs final
                        ws.send(JSON.stringify({
                            isPartial: result.IsPartial,
                            transcript,
                        }));

                        if (process.env.SOURCE_LANGUAGE_CODE !== process.env.TARGET_LANGUAGE_CODE) {
                            if (process.env.TARGET_LANGUAGE_CODE !== '') {
                                // get translation from AWS and ws.send it
                                try {
                                    const command = new TranslateTextCommand({
                                        SourceLanguageCode: process.env.SOURCE_LANGUAGE_CODE,
                                        TargetLanguageCode: process.env.TARGET_LANGUAGE_CODE,
                                        Text: transcript,
                                    });
                                    const data = await translationClient.send(command);
                                    console.log('Translation:', data);
                                    ws.send(JSON.stringify({
                                        isPartial: result.IsPartial,
                                        translated: true,
                                        transcript: data.TranslatedText
                                    }));
                                    // process data.
                                } catch (error) {
                                    console.log(error)
                                    // error handling.
                                } finally {
                                    // finally.
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error in transcription stream:', err);
        // Reconnect after a delay if the WebSocket is still open.
    } finally {
        console.log('Transcription stream finished');
        setTimeout(() => {
            if (ws.readyState === ws.OPEN) {
                // Reset the audio stream state before reconnecting
                audioStream.resetForReconnection();
                console.log('Reconnecting transcription stream...');
                startTranscription(ws, audioStream);
            } else {
                console.log('WebSocket is closed or audio stream is closed. Not reconnecting transcription stream.');
            }
        }, 10); // Increased delay to 1 second to prevent rapid reconnection attempts
    }
}

// Generate session ID
function generateSessionId() {
    return Math.random().toString(36).substring(2, 8);
}

sockserver.on('connection', async (ws) => {
    const sessionId = generateSessionId();
    console.log(`[${new Date().toISOString()}]  New client connected (session: ${sessionId})`);

    let tempBuffer = Buffer.alloc(0);

    const audioStream = new AudioStream(chunkDurationMs, audioSampleRate, sessionId);

    ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            tempBuffer = Buffer.concat([tempBuffer, data]);

            while (tempBuffer.length >= audioStream.chunkSize) {
                const fullChunk = tempBuffer.slice(0, audioStream.chunkSize);
                audioStream.audioBufferQueue.push(fullChunk);
                tempBuffer = tempBuffer.slice(audioStream.chunkSize);
            }
        } else {
            console.log('Received non-binary data (ignored)');
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected (session: ${sessionId})`);
        audioStream.isClosed = true;
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        audioStream.isClosed = true;
        ws.close();
    });

    await startTranscription(ws, audioStream);
});
