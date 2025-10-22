// server.js
require('dotenv').config();
const { WebSocketServer } = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
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

                // We have items in the queue: process one item from the queue
                const queueItem = this.audioBufferQueue.shift();
                if (queueItem) {
                    // Check if this is an audio chunk or control message
                    if (queueItem.type === 'audio') {
                        const audioChunk = queueItem.data;
                        console.log(`[${new Date().toISOString()}]  audio chunk of length: ${audioChunk.length}`);
                        console.log(`Queue size: ${this.audioBufferQueue.length}, chunk: ${audioChunk.length}`);

                        
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
                    } else if (queueItem.type === 'control' && queueItem.message === 'END_OF_AUDIO') {
                        console.log(`[${new Date().toISOString()}] Processing END_OF_AUDIO from queue - all audio chunks processed`);
                        
                        // Yield the control message so it can be processed by the caller
                        yield {
                            ControlEvent: {
                                message: 'END_OF_AUDIO'
                            }
                        };
                    }
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

async function startTranscription(ws, audioStream, audioGenerator, connectionState) {
    console.log(`[${new Date().toISOString()}]  Starting Deepgram transcription stream`);

    let deepgramChunksSent = 0;
    let deepgramConnectionOpenTime = null;

    try {
        // Initialize Deepgram client
        console.log(`[${new Date().toISOString()}] Initializing Deepgram client with API key: ${process.env.DEEPGRAM_API_KEY ? '***' + process.env.DEEPGRAM_API_KEY.slice(-4) : 'MISSING'}`);
        const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

        // Create live transcription connection with nova-3 model
        const deepgramConfig = {
            model: 'nova-3',
            language: process.env.SOURCE_LANGUAGE_CODE_LOCALE || 'en-US',
            encoding: 'linear16',
            sample_rate: audioSampleRate,
            endpointing: false,
            smart_format: true,
            interim_results: true,
            numerals: false,
            mip_opt_out: false,
            punctuate: true,
            profanity_filter: false,
            redact: false,
            vad_events: true,
            channels: 1,
        };
        console.log(`[${new Date().toISOString()}] Creating Deepgram live connection with config:`, JSON.stringify(deepgramConfig, null, 2));
        connectionState.deepgramConnection = deepgram.listen.live(deepgramConfig);
        const deepgramConnection = connectionState.deepgramConnection;

        // Handle Deepgram connection open
        deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
            deepgramConnectionOpenTime = Date.now();
            console.log(`[${new Date().toISOString()}] ✓ Deepgram connection OPENED successfully`);
            console.log(`[${new Date().toISOString()}] Ready state: ${deepgramConnection.getReadyState()}`);

            // Start keep-alive interval (send every 5 seconds to prevent auto-close after 10s of silence)
            connectionState.keepAliveInterval = setInterval(() => {
                if (connectionState.deepgramConnection && connectionState.deepgramConnection.getReadyState() === 1) {
                    console.log(`[${new Date().toISOString()}] Sending KeepAlive to Deepgram`);
                    connectionState.deepgramConnection.keepAlive();
                }
            }, 5000);
            console.log(`[${new Date().toISOString()}] Started keep-alive interval (5s)`);

            // Start sending audio chunks
            (async () => {
                try {
                    console.log(`[${new Date().toISOString()}] Starting audio chunk sending loop to Deepgram`);
                    for await (const audioEvent of audioGenerator) {
                        if (audioEvent && audioEvent.AudioEvent && audioEvent.AudioEvent.AudioChunk) {
                            const audioChunk = audioEvent.AudioEvent.AudioChunk;
                            const readyState = deepgramConnection ? deepgramConnection.getReadyState() : -1;
                            
                            console.log(`[${new Date().toISOString()}] Audio generator yielded chunk #${deepgramChunksSent + 1}, size: ${audioChunk.length} bytes, ready state: ${readyState}`);
                            
                            if (deepgramConnection && readyState === 1) {
                                deepgramConnection.send(audioChunk);
                                deepgramChunksSent++;
                                console.log(`[${new Date().toISOString()}] ✓ Sent chunk #${deepgramChunksSent} to Deepgram (${audioChunk.length} bytes)`);
                            } else {
                                console.warn(`[${new Date().toISOString()}] ✗ SKIPPED chunk - Deepgram not ready! Ready state: ${readyState} (expected: 1)`);
                            }
                        } else if (audioEvent && audioEvent.ControlEvent && audioEvent.ControlEvent.message === 'END_OF_AUDIO') {
                            console.log(`[${new Date().toISOString()}] ✓ END_OF_AUDIO control message received from queue - all audio chunks sent`);
                            
                            // Now finalize the Deepgram connection after all audio has been sent
                            if (connectionState.deepgramConnection && connectionState.deepgramConnection.getReadyState() === 1) {
                                console.log(`[${new Date().toISOString()}] Sending Finalize to Deepgram`);
                                connectionState.deepgramConnection.finalize();
                                connectionState.waitingForFinalTranscript = true;
                                
                                // Set timeout in case we don't get final transcript
                                connectionState.finalizeTimeout = setTimeout(() => {
                                    console.log(`[${new Date().toISOString()}] Timeout waiting for final transcript - closing connections`);
                                    if (connectionState.deepgramConnection) {
                                        connectionState.deepgramConnection.requestClose();
                                    }
                                    if (ws.readyState === ws.OPEN) {
                                        ws.close();
                                    }
                                }, 10000);
                            } else {
                                console.warn(`[${new Date().toISOString()}] Cannot finalize - Deepgram not ready (state: ${connectionState.deepgramConnection ? connectionState.deepgramConnection.getReadyState() : 'null'})`);
                            }
                        } else {
                            console.warn(`[${new Date().toISOString()}] Audio event missing AudioChunk:`, audioEvent);
                        }
                    }
                    console.log(`[${new Date().toISOString()}] Audio generator loop completed. Total chunks sent: ${deepgramChunksSent}`);
                } catch (err) {
                    console.error(`[${new Date().toISOString()}] Error sending audio to Deepgram:`, err);
                    console.error(`[${new Date().toISOString()}] Error stack:`, err.stack);
                    console.error(`[${new Date().toISOString()}] Chunks sent before error: ${deepgramChunksSent}`);
                }
            })();
        });

        // Handle Deepgram transcription results
        deepgramConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
            console.log(`[${new Date().toISOString()}] 📝 Deepgram transcript event received`);
            console.log(data);
            
            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const confidence = data.channel?.alternatives?.[0]?.confidence;
            const words = data.channel?.alternatives?.[0]?.words;
            const duration = data.duration;
            const isFinal = data.is_final;
            const isSpeechFinal = data.from_finalize;
            
            console.log(`[${new Date().toISOString()}] Transcript details:`, {
                transcript: transcript || '(empty)',
                isSpeechFinal: isSpeechFinal,
                isFinal: isFinal,
                confidence: confidence,
                wordCount: words ? words.length : 0,
                duration: duration,
                channelsAvailable: Object.keys(data).join(', ')
            });
            
            if (transcript && transcript.length > 0) {
                console.log(`[${new Date().toISOString()}] ✓ Deepgram Transcript: "${transcript}" (is_speech_final: ${isSpeechFinal}, is_final: ${isFinal}, confidence: ${confidence})`);
                
                // Accumulate non-partial transcripts to completedTranscript
                if (isFinal) {
                    connectionState.completedTranscript += (connectionState.completedTranscript ? ' ' : '') + transcript;
                    console.log(`[${new Date().toISOString()}] Accumulated completed transcript: "${connectionState.completedTranscript}"`);
                }
                
                // Combine completed and current transcript
                const combinedTranscript = !isFinal
                    ? (connectionState.completedTranscript ? connectionState.completedTranscript + ' ' + transcript : transcript)
                    : connectionState.completedTranscript;
                
                const clientIsPartial = !isSpeechFinal;
                ws.send(JSON.stringify({
                    isPartial: clientIsPartial,
                    transcript: combinedTranscript,
                }));

                // If this is final, close connections immediately
                if (isSpeechFinal) {
                    console.log(`[${new Date().toISOString()}] Final transcript received - closing connections`);
                    
                    // Request close from Deepgram
                    if (connectionState.deepgramConnection) {
                        console.log(`[${new Date().toISOString()}] Sending CloseStream to Deepgram`);
                        connectionState.deepgramConnection.requestClose();
                    }
                    
                    // Close the client WebSocket
                    if (ws.readyState === ws.OPEN) {
                        console.log(`[${new Date().toISOString()}] Closing client WebSocket`);
                        ws.close();
                    }
                }
            } else {
                console.log(`[${new Date().toISOString()}] Empty transcript received from Deepgram (is_final: ${isFinal})`);
            }
        });

        // Handle Deepgram metadata events
        deepgramConnection.on(LiveTranscriptionEvents.Metadata, (data) => {
            console.log(`[${new Date().toISOString()}] 📊 Deepgram metadata event:`, JSON.stringify(data, null, 2));
        });

        // Handle Deepgram errors
        deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
            const uptime = deepgramConnectionOpenTime ? (Date.now() - deepgramConnectionOpenTime) / 1000 : 0;
            console.error(`[${new Date().toISOString()}] ✗ Deepgram connection error:`, err);
            console.error(`[${new Date().toISOString()}] Error details:`, {
                message: err.message,
                code: err.code,
                readyState: deepgramConnection ? deepgramConnection.getReadyState() : 'null',
                chunksSent: deepgramChunksSent,
                uptimeSeconds: uptime.toFixed(2),
                audioQueueSize: audioStream.audioBufferQueue.length
            });
            console.error(`[${new Date().toISOString()}] Error stack:`, err.stack);
            
            // Clean up intervals and timeouts
            if (connectionState.keepAliveInterval) {
                clearInterval(connectionState.keepAliveInterval);
                connectionState.keepAliveInterval = null;
                console.log(`[${new Date().toISOString()}] Cleared keep-alive interval due to error`);
            }
            if (connectionState.finalizeTimeout) {
                clearTimeout(connectionState.finalizeTimeout);
                connectionState.finalizeTimeout = null;
                console.log(`[${new Date().toISOString()}] Cleared finalize timeout due to error`);
            }
        });

        // Handle Deepgram connection close
        deepgramConnection.on(LiveTranscriptionEvents.Close, (code, reason) => {
            const uptime = deepgramConnectionOpenTime ? (Date.now() - deepgramConnectionOpenTime) / 1000 : 0;
            console.log(`[${new Date().toISOString()}] Deepgram connection closed`);
            console.log(`[${new Date().toISOString()}] Close details:`, {
                code: code,
                reason: reason || '(no reason provided)',
                totalChunksSent: deepgramChunksSent,
                uptimeSeconds: uptime.toFixed(2),
                audioQueueSize: audioStream.audioBufferQueue.length
            });
            
            // Clean up intervals and timeouts
            if (connectionState.keepAliveInterval) {
                clearInterval(connectionState.keepAliveInterval);
                connectionState.keepAliveInterval = null;
                console.log(`[${new Date().toISOString()}] Cleared keep-alive interval on close`);
            }
            if (connectionState.finalizeTimeout) {
                clearTimeout(connectionState.finalizeTimeout);
                connectionState.finalizeTimeout = null;
                console.log(`[${new Date().toISOString()}] Cleared finalize timeout on close`);
            }
        });

        // Keep the connection alive
        await new Promise((resolve) => {
            deepgramConnection.on(LiveTranscriptionEvents.Close, resolve);
        });

    } catch (err) {
        console.error('Error in Deepgram transcription stream:', err);
        
        // Clean up intervals and timeouts on error
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(`[${new Date().toISOString()}] Cleared keep-alive interval due to catch error`);
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(`[${new Date().toISOString()}] Cleared finalize timeout due to catch error`);
        }
    } finally {
        console.log('Deepgram transcription stream finished');
        
        // Clean up intervals and timeouts in finally block
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(`[${new Date().toISOString()}] Cleared keep-alive interval in finally`);
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(`[${new Date().toISOString()}] Cleared finalize timeout in finally`);
        }
        
        // Clean up Deepgram connection
        if (connectionState.deepgramConnection) {
            try {
                connectionState.deepgramConnection.finish();
            } catch (err) {
                console.error('Error closing Deepgram connection:', err);
            }
        }
        
        // No reconnection logic - single-use sessions only
        console.log('Deepgram session completed - no reconnection');
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
    
    // State variables for Deepgram connection lifecycle
    let deepgramConnection = null;
    let keepAliveInterval = null;
    let endOfAudioReceived = false;
    let waitingForFinalTranscript = false;
    let finalizeTimeout = null;
    let deepgramConnected = false;
    let completedTranscript = '';

    const audioStream = new AudioStream(chunkDurationMs, audioSampleRate, sessionId);
    
    // Create the audio generator once
    const audioGenerator = audioStream.getAudioStream();

    ws.on('message', async (data) => {
        // Check if this is a text message (END_OF_AUDIO signal)
        // Text messages can arrive as Buffers, so check for small buffers (< 15 chars) first
        let isTextMessage = false;
        let message = '';
        
        if (Buffer.isBuffer(data) && data.length < 15) {
            // Small buffer - likely a text control message
            message = data.toString('utf8');
            isTextMessage = true;
            console.log(`[${new Date().toISOString()}] Detected small buffer as text message: "${message}"`);
        } else if (typeof data === 'string') {
            // Actual string type
            message = data;
            isTextMessage = true;
            console.log(`[${new Date().toISOString()}] Received string message: "${message}"`);
        }
        
        if (isTextMessage) {
            if (message === 'END_OF_AUDIO') {
                console.log(`[${new Date().toISOString()}] ✓ END_OF_AUDIO DETECTED - adding to queue for processing after audio`);
                connectionState.endOfAudioReceived = true;
                
                // Add END_OF_AUDIO as a control message to the queue
                // It will be processed after all audio chunks are sent to Deepgram
                audioStream.audioBufferQueue.push({
                    type: 'control',
                    message: 'END_OF_AUDIO',
                    connectionState: connectionState,
                    ws: ws
                });
                console.log(`[${new Date().toISOString()}] END_OF_AUDIO added to queue. Queue size: ${audioStream.audioBufferQueue.length}`);
            } else {
                console.log(`[${new Date().toISOString()}] Received text message but not END_OF_AUDIO: "${message}"`);
            }
        } else if (Buffer.isBuffer(data) && data.length >= 15) {
            // Only process audio if END_OF_AUDIO hasn't been received
            if (!connectionState.endOfAudioReceived) {
                tempBuffer = Buffer.concat([tempBuffer, data]);

                while (tempBuffer.length >= audioStream.chunkSize) {
                    const fullChunk = tempBuffer.slice(0, audioStream.chunkSize);
                    audioStream.audioBufferQueue.push({ type: 'audio', data: fullChunk });
                    tempBuffer = tempBuffer.slice(audioStream.chunkSize);
                }
                
                // Start DeepGram connection on first audio data
                if (!connectionState.deepgramConnected && audioStream.audioBufferQueue.length > 0) {
                    console.log(`[${new Date().toISOString()}] First audio data received - establishing DeepGram connection`);
                    connectionState.deepgramConnected = true;
                    await startTranscription(ws, audioStream, audioGenerator, connectionState);
                }
            } else {
                console.log(`[${new Date().toISOString()}] Ignoring audio data - END_OF_AUDIO already received`);
            }
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected (session: ${sessionId})`);
        audioStream.isClosed = true;
        
        // Clean up intervals and timeouts when client disconnects
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(`[${new Date().toISOString()}] Cleared keep-alive interval on client disconnect`);
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(`[${new Date().toISOString()}] Cleared finalize timeout on client disconnect`);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        audioStream.isClosed = true;
        
        // Clean up intervals and timeouts on WebSocket error
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(`[${new Date().toISOString()}] Cleared keep-alive interval on WebSocket error`);
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(`[${new Date().toISOString()}] Cleared finalize timeout on WebSocket error`);
        }
        
        ws.close();
    });

    // Create connection state object to share between handlers
    const connectionState = {
        deepgramConnection,
        keepAliveInterval,
        endOfAudioReceived,
        waitingForFinalTranscript,
        finalizeTimeout,
        deepgramConnected,
        completedTranscript
    };

    // No longer start transcription immediately - wait for first audio data
});
