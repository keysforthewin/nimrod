// server.js
require('dotenv').config();
const { WebSocketServer } = require('ws');
const { createClient } = require('@deepgram/sdk');
const { TranslateClient, TranslateTextCommand } = require("@aws-sdk/client-translate");
const fs = require('fs');
const path = require('path');

const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

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

// Generate session ID
function generateSessionId() {
    return Math.random().toString(36).substring(2, 8);
}

async function handleTranscription(ws, sessionId, wavWriter) {
    const deepgram = createClient(deepgramApiKey);
    
    // Initialize translation client if needed
    let translationClient = null;
    const needsTranslation = process.env.SOURCE_LANGUAGE_CODE !== process.env.TARGET_LANGUAGE_CODE 
                          && process.env.TARGET_LANGUAGE_CODE !== '';
    
    if (needsTranslation) {
        translationClient = new TranslateClient({ 
            region: region, 
            credentials: {
                accessKeyId,
                secretAccessKey,
            }
        });
    }

    // Create Deepgram live transcription connection
    const dgConnection = deepgram.listen.live({
        encoding: 'linear16',
        sample_rate: audioSampleRate,
        channels: 1,
        language: process.env.SOURCE_LANGUAGE_CODE_LOCALE || 'en-US',
        interim_results: true,
        punctuate: true,
        smart_format: true,
    });

    // Handle Deepgram connection open
    dgConnection.on('open', () => {
        console.log(`[${new Date().toISOString()}] Deepgram connection opened (session: ${sessionId})`);
    });

    // Handle Deepgram transcripts
    dgConnection.on('Results', async (data) => {
        const transcript = data.channel.alternatives[0].transcript;
        
        if (transcript && transcript.length > 0) {
            const isPartial = data.is_final === false;
            
            console.log(`[${new Date().toISOString()}] Transcript: ${transcript} (partial: ${isPartial})`);
            
            // Send original transcript
            ws.send(JSON.stringify({
                isPartial: isPartial,
                transcript: transcript,
            }));

            // Send translation if needed
            if (needsTranslation && translationClient) {
                try {
                    const command = new TranslateTextCommand({
                        SourceLanguageCode: process.env.SOURCE_LANGUAGE_CODE,
                        TargetLanguageCode: process.env.TARGET_LANGUAGE_CODE,
                        Text: transcript,
                    });
                    const translationData = await translationClient.send(command);
                    console.log('Translation:', translationData);
                    ws.send(JSON.stringify({
                        isPartial: isPartial,
                        translated: true,
                        transcript: translationData.TranslatedText
                    }));
                } catch (error) {
                    console.error('Translation error:', error);
                }
            }
        }
    });

    // Handle Deepgram errors
    dgConnection.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] Deepgram error (session: ${sessionId}):`, error);
    });

    // Handle Deepgram connection close
    dgConnection.on('close', () => {
        console.log(`[${new Date().toISOString()}] Deepgram connection closed (session: ${sessionId})`);
    });

    // Handle Deepgram metadata
    dgConnection.on('Metadata', (data) => {
        console.log(`[${new Date().toISOString()}] Deepgram metadata:`, data);
    });

    return dgConnection;
}

sockserver.on('connection', async (ws) => {
    const sessionId = generateSessionId();
    console.log(`[${new Date().toISOString()}] New client connected (session: ${sessionId})`);

    // Initialize WAV writer for this session
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(audioLogsDir, `audio_session_${timestamp}_${sessionId}.wav`);
    const wavWriter = new WavWriter(filename, audioSampleRate);
    console.log(`Created audio log file: ${filename}`);

    // Create Deepgram connection
    let dgConnection = null;
    try {
        dgConnection = await handleTranscription(ws, sessionId, wavWriter);
    } catch (error) {
        console.error('Failed to create Deepgram connection:', error);
        ws.close();
        return;
    }

    // Handle incoming audio from client
    ws.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            // Log audio to WAV file
            wavWriter.writeAudioChunk(data);
            
            // Forward audio to Deepgram
            if (dgConnection && dgConnection.getReadyState() === 1) {
                dgConnection.send(data);
            }
        } else {
            console.log('Received non-binary data (ignored)');
        }
    });

    // Handle client disconnect
    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected (session: ${sessionId})`);
        
        // Close Deepgram connection
        if (dgConnection) {
            dgConnection.finish();
        }
        
        // Close WAV file
        if (wavWriter) {
            wavWriter.close();
        }
    });

    // Handle WebSocket errors
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        if (dgConnection) {
            dgConnection.finish();
        }
        ws.close();
    });
});