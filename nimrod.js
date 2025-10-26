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

// Helper function to format log messages with session context
function formatLog(clientId, sessionId, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}][client:${clientId}][session:${sessionId}] ${message}`;
}

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
    constructor(chunkDurationMs, audioSampleRate, clientId, sessionId) {
        this.clientId = clientId;
        this.sessionId = sessionId;
        this.chunkSize = Math.floor((chunkDurationMs / 1000) * audioSampleRate * 2);
        console.log(formatLog(clientId, sessionId, `Using chunkSize (bytes): ${this.chunkSize}`));

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
        console.log(formatLog(clientId, sessionId, `Created audio log file: ${filename}`));
    }


    async * getAudioStream() {
        console.log(formatLog(this.clientId, this.sessionId, "Audio stream generator started"));
        
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
                                    console.log(formatLog(this.clientId, this.sessionId, "Sending silence chunk"));
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
                        console.log(formatLog(this.clientId, this.sessionId, `Processing audio chunk: ${audioChunk.length} bytes, queue size: ${this.audioBufferQueue.length}`));
                        
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
                        console.log(formatLog(this.clientId, this.sessionId, "Processing END_OF_AUDIO from queue - all audio chunks processed"));
                        
                        // Yield the control message so it can be processed by the caller
                        yield {
                            ControlEvent: {
                                message: 'END_OF_AUDIO'
                            }
                        };
                    }
                }
                // Send chunks as fast as possible - no artificial delay
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        } finally {
            console.log(formatLog(this.clientId, this.sessionId, "Audio stream generator exited"));
            
            // Only close the WAV file if the client has disconnected
            if (this.isClosed && this.wavWriter) {
                console.log(formatLog(this.clientId, this.sessionId, "Client disconnected, closing WAV file"));
                this.wavWriter.close();
            }
        }
    }
}

async function startTranscription(ws, audioStream, audioGenerator, connectionState, clientId, sessionId) {
    console.log(formatLog(clientId, sessionId, "Starting Deepgram transcription stream"));

    let deepgramChunksSent = 0;
    let deepgramConnectionOpenTime = null;

    try {
        // Initialize Deepgram client
        console.log(formatLog(clientId, sessionId, `Initializing Deepgram client with API key: ${process.env.DEEPGRAM_API_KEY ? '***' + process.env.DEEPGRAM_API_KEY.slice(-4) : 'MISSING'}`));
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
            vad_events: false,
            channels: 1,
        };
        console.log(formatLog(clientId, sessionId, `Creating Deepgram live connection with config: ${JSON.stringify(deepgramConfig, null, 2)}`));
        connectionState.deepgramConnection = deepgram.listen.live(deepgramConfig);
        const deepgramConnection = connectionState.deepgramConnection;

        // Handle Deepgram connection open
        deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
            deepgramConnectionOpenTime = Date.now();
            console.log(formatLog(clientId, sessionId, "✓ Deepgram connection OPENED successfully"));
            console.log(formatLog(clientId, sessionId, `Ready state: ${deepgramConnection.getReadyState()}`));

            // Flush any pending audio chunks that were buffered while waiting for connection
            if (connectionState.pendingAudioChunks.length > 0) {
                console.log(formatLog(clientId, sessionId, `Flushing ${connectionState.pendingAudioChunks.length} pending audio chunks`));
                for (const chunk of connectionState.pendingAudioChunks) {
                    deepgramConnection.send(chunk);
                    deepgramChunksSent++;
                }
                console.log(formatLog(clientId, sessionId, `✓ Flushed all pending chunks. Total sent: ${deepgramChunksSent}`));
                connectionState.pendingAudioChunks = [];
            }

            // Start keep-alive interval (send every 5 seconds to prevent auto-close after 10s of silence)
            connectionState.keepAliveInterval = setInterval(() => {
                if (connectionState.deepgramConnection && connectionState.deepgramConnection.getReadyState() === 1) {
                    console.log(formatLog(clientId, sessionId, "Sending KeepAlive to Deepgram"));
                    connectionState.deepgramConnection.keepAlive();
                }
            }, 5000);
            console.log(formatLog(clientId, sessionId, "Started keep-alive interval (every 5s)"));

            // Start ready state monitoring (check every 500ms)
            let lastReadyState = 1;
            connectionState.readyStateMonitor = setInterval(() => {
                if (connectionState.deepgramConnection) {
                    const currentState = connectionState.deepgramConnection.getReadyState();
                    
                    // Detect state transitions
                    if (currentState !== lastReadyState) {
                        const stateNames = {0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED'};
                        console.log(formatLog(clientId, sessionId, `⚠️ Deepgram ready state changed: ${stateNames[lastReadyState]} (${lastReadyState}) → ${stateNames[currentState]} (${currentState})`));
                        console.log(formatLog(clientId, sessionId, `State change context: ${JSON.stringify({
                            pendingChunks: connectionState.pendingAudioChunks.length,
                            queueSize: audioStream.audioBufferQueue.length,
                            chunksSent: deepgramChunksSent,
                            endOfAudioPending: connectionState.endOfAudioPending,
                            reconnectionAttempts: connectionState.reconnectionAttempts
                        })}`));
                        
                        // If transitioning to CLOSING and we have pending chunks, attempt reconnection
                        if (currentState === 2 && connectionState.pendingAudioChunks.length > 0 && connectionState.reconnectionAttempts < connectionState.maxReconnectionAttempts) {
                            console.log(formatLog(clientId, sessionId, `🔄 Attempting reconnection (attempt ${connectionState.reconnectionAttempts + 1}/${connectionState.maxReconnectionAttempts})...`));
                            connectionState.reconnectionAttempts++;
                            
                            // Clear old keep-alive interval before reconnecting
                            if (connectionState.keepAliveInterval) {
                                clearInterval(connectionState.keepAliveInterval);
                                connectionState.keepAliveInterval = null;
                                console.log(formatLog(clientId, sessionId, "Cleared old keep-alive interval before reconnection"));
                            }
                            
                            // Close current connection
                            try {
                                connectionState.deepgramConnection.finish();
                            } catch (err) {
                                console.error(formatLog(clientId, sessionId, `Error finishing old connection: ${err.message}`));
                            }
                            
                            // Create new connection
                            setTimeout(() => {
                                console.log(formatLog(clientId, sessionId, "Creating new Deepgram connection..."));
                                const newConnection = deepgram.listen.live(deepgramConfig);
                                
                                // Set up event handlers for new connection
                                newConnection.on(LiveTranscriptionEvents.Open, () => {
                                    console.log(formatLog(clientId, sessionId, `✓ Reconnection successful - flushing ${connectionState.pendingAudioChunks.length} buffered chunks`));
                                    connectionState.deepgramConnection = newConnection;
                                    
                                    // Flush pending chunks
                                    for (const chunk of connectionState.pendingAudioChunks) {
                                        newConnection.send(chunk);
                                        deepgramChunksSent++;
                                    }
                                    console.log(formatLog(clientId, sessionId, `✓ Reconnection complete. Chunks sent: ${deepgramChunksSent}`));
                                    connectionState.pendingAudioChunks = [];
                                    connectionState.reconnectionAttempts = 0;
                                    
                                    // Restart keep-alive interval for new connection
                                    connectionState.keepAliveInterval = setInterval(() => {
                                        if (connectionState.deepgramConnection && connectionState.deepgramConnection.getReadyState() === 1) {
                                            console.log(formatLog(clientId, sessionId, "Sending KeepAlive to Deepgram (reconnected)"));
                                            connectionState.deepgramConnection.keepAlive();
                                        }
                                    }, 5000);
                                    console.log(formatLog(clientId, sessionId, "Restarted keep-alive interval after reconnection (every 5s)"));
                                });
                                
                                newConnection.on(LiveTranscriptionEvents.Error, (err) => {
                                    console.error(formatLog(clientId, sessionId, `✗ Reconnection failed: ${err.message}`));
                                });
                                
                                // Copy transcript handler to new connection
                                newConnection.on(LiveTranscriptionEvents.Transcript, deepgramConnection.listeners(LiveTranscriptionEvents.Transcript)[0]);
                            }, 100);
                        } else if (currentState === 2 && connectionState.pendingAudioChunks.length > 0) {
                            console.warn(formatLog(clientId, sessionId, `⚠️ Max reconnection attempts reached - ${connectionState.pendingAudioChunks.length} chunks will be lost`));
                        }
                        
                        lastReadyState = currentState;
                    }
                }
            }, 500);
            console.log(formatLog(clientId, sessionId, "Started ready state monitoring (every 500ms)"));

            // Start sending audio chunks
            (async () => {
                try {
                    console.log(formatLog(clientId, sessionId, "Starting audio chunk sending loop to Deepgram"));
                    for await (const audioEvent of audioGenerator) {
                        if (audioEvent && audioEvent.AudioEvent && audioEvent.AudioEvent.AudioChunk) {
                            const audioChunk = audioEvent.AudioEvent.AudioChunk;
                            const readyState = deepgramConnection ? deepgramConnection.getReadyState() : -1;
                            
                            if (deepgramConnection && readyState === 1) {
                                deepgramConnection.send(audioChunk);
                                deepgramChunksSent++;
                                console.log(formatLog(clientId, sessionId, `✓ Sent chunk #${deepgramChunksSent} to Deepgram (${audioChunk.length} bytes, ready state: ${readyState})`));
                            } else {
                                // Buffer the chunk instead of skipping it
                                connectionState.pendingAudioChunks.push(audioChunk);
                                console.log(formatLog(clientId, sessionId, `⏳ Buffered chunk (${audioChunk.length} bytes) - Deepgram not ready yet. Ready state: ${readyState}, Buffered: ${connectionState.pendingAudioChunks.length}`));
                            }
                        } else if (audioEvent && audioEvent.ControlEvent && audioEvent.ControlEvent.message === 'END_OF_AUDIO') {
                            console.log(formatLog(clientId, sessionId, "✓ END_OF_AUDIO control message received from queue"));
                            
                            // Set flag to indicate END_OF_AUDIO is pending
                            connectionState.endOfAudioPending = true;
                            console.log(formatLog(clientId, sessionId, "Waiting for pending chunks to clear before finalizing..."));
                            
                            // Store interval ID to prevent duplicate intervals
                            if (connectionState.checkPendingChunksInterval) {
                                console.warn(formatLog(clientId, sessionId, "⚠️ checkPendingChunks interval already exists - clearing old one"));
                                clearInterval(connectionState.checkPendingChunksInterval);
                            }
                            
                            // Wait for all pending chunks to be sent before finalizing
                            connectionState.checkPendingChunksInterval = setInterval(() => {
                                const pendingCount = connectionState.pendingAudioChunks.length;
                                console.log(formatLog(clientId, sessionId, `Pending chunks remaining: ${pendingCount}`));
                                
                                if (pendingCount === 0 && connectionState.endOfAudioPending) {
                                    clearInterval(connectionState.checkPendingChunksInterval);
                                    connectionState.checkPendingChunksInterval = null;
                                    console.log(formatLog(clientId, sessionId, "✓ All pending chunks sent - now finalizing Deepgram"));
                                    
                                    // Now finalize the Deepgram connection after all audio has been sent
                                    if (connectionState.deepgramConnection && connectionState.deepgramConnection.getReadyState() === 1) {
                                        console.log(formatLog(clientId, sessionId, "Sending Finalize to Deepgram"));
                                        connectionState.deepgramConnection.finalize();
                                        connectionState.waitingForFinalTranscript = true;
                                        connectionState.endOfAudioPending = false;
                                        
                                        // Set timeout in case we don't get final transcript
                                        connectionState.finalizeTimeout = setTimeout(() => {
                                            console.log(formatLog(clientId, sessionId, "Timeout waiting for final transcript - closing connections"));
                                            if (connectionState.deepgramConnection) {
                                                connectionState.deepgramConnection.requestClose();
                                            }
                                            if (ws.readyState === ws.OPEN) {
                                                ws.close();
                                            }
                                        }, 10000);
                                    } else {
                                        console.warn(formatLog(clientId, sessionId, `Cannot finalize - Deepgram not ready (state: ${connectionState.deepgramConnection ? connectionState.deepgramConnection.getReadyState() : 'null'})`));
                                        connectionState.endOfAudioPending = false;
                                    }
                                }
                            }, 100);
                            
                            // Safety timeout to prevent infinite waiting
                            setTimeout(() => {
                                if (connectionState.endOfAudioPending) {
                                    console.warn(formatLog(clientId, sessionId, `⚠️ Timeout waiting for pending chunks - forcing finalization with ${connectionState.pendingAudioChunks.length} chunks remaining`));
                                    connectionState.endOfAudioPending = false;
                                    if (connectionState.checkPendingChunksInterval) {
                                        clearInterval(connectionState.checkPendingChunksInterval);
                                        connectionState.checkPendingChunksInterval = null;
                                    }
                                }
                            }, 10000);
                        } else {
                            console.warn(formatLog(clientId, sessionId, `Audio event missing AudioChunk: ${JSON.stringify(audioEvent)}`));
                        }
                    }
                    console.log(formatLog(clientId, sessionId, `Audio generator loop completed. Total chunks sent: ${deepgramChunksSent}`));
                } catch (err) {
                    console.error(formatLog(clientId, sessionId, `Error sending audio to Deepgram: ${err.message}`));
                    console.error(formatLog(clientId, sessionId, `Error stack: ${err.stack}`));
                    console.error(formatLog(clientId, sessionId, `Chunks sent before error: ${deepgramChunksSent}`));
                }
            })();
        });

        // Handle Deepgram transcription results
        deepgramConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
            console.log(formatLog(clientId, sessionId, "📝 Deepgram transcript event received"));
            
            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const confidence = data.channel?.alternatives?.[0]?.confidence;
            const words = data.channel?.alternatives?.[0]?.words;
            const duration = data.duration;
            const isFinal = data.is_final;
            const isSpeechFinal = data.from_finalize;
            
            console.log(formatLog(clientId, sessionId, `Transcript details: ${JSON.stringify({
                transcript: transcript || '(empty)',
                isSpeechFinal: isSpeechFinal,
                isFinal: isFinal,
                confidence: confidence,
                wordCount: words ? words.length : 0,
                duration: duration
            })}`));
            
            if (transcript && transcript.length > 0) {
                console.log(formatLog(clientId, sessionId, `✓ Deepgram Transcript: "${transcript}" (is_speech_final: ${isSpeechFinal}, is_final: ${isFinal}, confidence: ${confidence})`));
                
                // Accumulate non-partial transcripts to completedTranscript
                if (isFinal) {
                    connectionState.completedTranscript += (connectionState.completedTranscript ? ' ' : '') + transcript;
                    console.log(formatLog(clientId, sessionId, `Accumulated completed transcript: "${connectionState.completedTranscript}"`));
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
            } else {
                console.log(formatLog(clientId, sessionId, `Empty transcript received from Deepgram (is_final: ${isFinal}, is_speech_final: ${isSpeechFinal})`));
            }

            // Handle isSpeechFinal regardless of whether transcript is empty
            if (isSpeechFinal) {
                console.log(formatLog(clientId, sessionId, "Final transcript received (speech_final=true) - closing DeepGram session"));
                
                // Send final completedTranscript to client if we haven't already
                // (this handles the case where final transcript is empty but we have accumulated text)
                if ((!transcript || transcript.length === 0) && connectionState.completedTranscript) {
                    console.log(formatLog(clientId, sessionId, `Sending accumulated transcript as final: "${connectionState.completedTranscript}"`));
                    ws.send(JSON.stringify({
                        isPartial: false,
                        transcript: connectionState.completedTranscript,
                    }));
                }
                
                // Clear timers immediately - don't wait for Close event
                if (connectionState.keepAliveInterval) {
                    clearInterval(connectionState.keepAliveInterval);
                    connectionState.keepAliveInterval = null;
                    console.log(formatLog(clientId, sessionId, "Cleared keep-alive interval after final transcript"));
                }
                
                if (connectionState.finalizeTimeout) {
                    clearTimeout(connectionState.finalizeTimeout);
                    connectionState.finalizeTimeout = null;
                    console.log(formatLog(clientId, sessionId, "Cleared finalize timeout after final transcript"));
                }
                
                if (connectionState.checkPendingChunksInterval) {
                    clearInterval(connectionState.checkPendingChunksInterval);
                    connectionState.checkPendingChunksInterval = null;
                    console.log(formatLog(clientId, sessionId, "Cleared checkPendingChunks interval after final transcript"));
                }
                
                // Reset state flags for next session
                connectionState.completedTranscript = '';
                connectionState.waitingForFinalTranscript = false;
                connectionState.endOfAudioReceived = false;
                connectionState.deepgramConnected = false;
                console.log(formatLog(clientId, sessionId, "Reset connection state for next session"));
                
                // Request close from Deepgram
                if (connectionState.deepgramConnection) {
                    console.log(formatLog(clientId, sessionId, "Sending CloseStream to Deepgram"));
                    connectionState.deepgramConnection.requestClose();
                    connectionState.deepgramConnection = null;
                }
                
                // Initialize new session for next transcription
                if (connectionState.initializeNewSession) {
                    connectionState.initializeNewSession();
                }
                
                console.log(formatLog(clientId, sessionId, "DeepGram session closed - WebSocket ready for new sessions"));
            }
        });

        // Handle Deepgram metadata events
        deepgramConnection.on(LiveTranscriptionEvents.Metadata, (data) => {
            console.log(formatLog(clientId, sessionId, `📊 Deepgram metadata event: ${JSON.stringify(data, null, 2)}`));
        });

        // Handle Deepgram errors
        deepgramConnection.on(LiveTranscriptionEvents.Error, (err) => {
            const uptime = deepgramConnectionOpenTime ? (Date.now() - deepgramConnectionOpenTime) / 1000 : 0;
            console.error(formatLog(clientId, sessionId, `✗ Deepgram connection error: ${err.message}`));
            console.error(formatLog(clientId, sessionId, `Error details: ${JSON.stringify({
                message: err.message,
                code: err.code,
                readyState: deepgramConnection ? deepgramConnection.getReadyState() : 'null',
                chunksSent: deepgramChunksSent,
                uptimeSeconds: uptime.toFixed(2),
                audioQueueSize: audioStream.audioBufferQueue.length
            })}`));
            console.error(formatLog(clientId, sessionId, `Error stack: ${err.stack}`));
            
            // Clean up intervals and timeouts
            if (connectionState.keepAliveInterval) {
                clearInterval(connectionState.keepAliveInterval);
                connectionState.keepAliveInterval = null;
                console.log(formatLog(clientId, sessionId, "Cleared keep-alive interval due to error"));
            }
            if (connectionState.readyStateMonitor) {
                clearInterval(connectionState.readyStateMonitor);
                connectionState.readyStateMonitor = null;
                console.log(formatLog(clientId, sessionId, "Cleared ready state monitor due to error"));
            }
            if (connectionState.finalizeTimeout) {
                clearTimeout(connectionState.finalizeTimeout);
                connectionState.finalizeTimeout = null;
                console.log(formatLog(clientId, sessionId, "Cleared finalize timeout due to error"));
            }
            if (connectionState.checkPendingChunksInterval) {
                clearInterval(connectionState.checkPendingChunksInterval);
                connectionState.checkPendingChunksInterval = null;
                console.log(formatLog(clientId, sessionId, "Cleared checkPendingChunks interval due to error"));
            }
        });

        // Handle Deepgram connection close
        deepgramConnection.on(LiveTranscriptionEvents.Close, (code, reason) => {
            const uptime = deepgramConnectionOpenTime ? (Date.now() - deepgramConnectionOpenTime) / 1000 : 0;
            console.log(formatLog(clientId, sessionId, "Deepgram connection closed"));
            console.log(formatLog(clientId, sessionId, `Close details: ${JSON.stringify({
                code: code,
                reason: reason || '(no reason provided)',
                totalChunksSent: deepgramChunksSent,
                uptimeSeconds: uptime.toFixed(2),
                audioQueueSize: audioStream.audioBufferQueue.length
            })}`));
            
            // Clean up intervals and timeouts
            if (connectionState.keepAliveInterval) {
                clearInterval(connectionState.keepAliveInterval);
                connectionState.keepAliveInterval = null;
                console.log(formatLog(clientId, sessionId, "Cleared keep-alive interval on close"));
            }
            if (connectionState.readyStateMonitor) {
                clearInterval(connectionState.readyStateMonitor);
                connectionState.readyStateMonitor = null;
                console.log(formatLog(clientId, sessionId, "Cleared ready state monitor on close"));
            }
            if (connectionState.finalizeTimeout) {
                clearTimeout(connectionState.finalizeTimeout);
                connectionState.finalizeTimeout = null;
                console.log(formatLog(clientId, sessionId, "Cleared finalize timeout on close"));
            }
            if (connectionState.checkPendingChunksInterval) {
                clearInterval(connectionState.checkPendingChunksInterval);
                connectionState.checkPendingChunksInterval = null;
                console.log(formatLog(clientId, sessionId, "Cleared checkPendingChunks interval on close"));
            }
        });

        // Keep the connection alive
        await new Promise((resolve) => {
            deepgramConnection.on(LiveTranscriptionEvents.Close, resolve);
        });

    } catch (err) {
        console.error(formatLog(clientId, sessionId, `Error in Deepgram transcription stream: ${err.message}`));
        
        // Clean up intervals and timeouts on error
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(formatLog(clientId, sessionId, "Cleared keep-alive interval due to catch error"));
        }
        if (connectionState.readyStateMonitor) {
            clearInterval(connectionState.readyStateMonitor);
            connectionState.readyStateMonitor = null;
            console.log(formatLog(clientId, sessionId, "Cleared ready state monitor due to catch error"));
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(formatLog(clientId, sessionId, "Cleared finalize timeout due to catch error"));
        }
        if (connectionState.checkPendingChunksInterval) {
            clearInterval(connectionState.checkPendingChunksInterval);
            connectionState.checkPendingChunksInterval = null;
            console.log(formatLog(clientId, sessionId, "Cleared checkPendingChunks interval due to catch error"));
        }
    } finally {
        console.log(formatLog(clientId, sessionId, "Deepgram transcription stream finished"));
        
        // Clean up intervals and timeouts in finally block
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(formatLog(clientId, sessionId, "Cleared keep-alive interval in finally"));
        }
        if (connectionState.readyStateMonitor) {
            clearInterval(connectionState.readyStateMonitor);
            connectionState.readyStateMonitor = null;
            console.log(formatLog(clientId, sessionId, "Cleared ready state monitor in finally"));
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(formatLog(clientId, sessionId, "Cleared finalize timeout in finally"));
        }
        if (connectionState.checkPendingChunksInterval) {
            clearInterval(connectionState.checkPendingChunksInterval);
            connectionState.checkPendingChunksInterval = null;
            console.log(formatLog(clientId, sessionId, "Cleared checkPendingChunks interval in finally"));
        }
        
        // Clean up Deepgram connection
        if (connectionState.deepgramConnection) {
            try {
                connectionState.deepgramConnection.finish();
            } catch (err) {
                console.error(formatLog(clientId, sessionId, `Error closing Deepgram connection: ${err.message}`));
            }
        }
        
        // Session completed - client can start new sessions on same WebSocket
        console.log(formatLog(clientId, sessionId, "Deepgram session completed - ready for new sessions"));
    }
}

// Generate session ID
function generateSessionId() {
    return Math.random().toString(36).substring(2, 8);
}

sockserver.on('connection', async (ws) => {
    const clientId = generateSessionId();
    console.log(formatLog(clientId, 'connecting', `New client connected`));

    // Session-specific state that needs to be recreated for each DeepGram session
    let tempBuffer = Buffer.alloc(0);
    let audioStream = null;
    let audioGenerator = null;
    let currentSessionId = null;
    
    // State variables for Deepgram connection lifecycle
    let deepgramConnection = null;
    let keepAliveInterval = null;
    let readyStateMonitor = null;
    let checkPendingChunksInterval = null;
    let endOfAudioReceived = false;
    let endOfAudioPending = false;
    let waitingForFinalTranscript = false;
    let finalizeTimeout = null;
    let deepgramConnected = false;
    let completedTranscript = '';
    let reconnectionAttempts = 0;
    let maxReconnectionAttempts = 3;
    
    // Function to initialize a new session
    function initializeNewSession() {
        currentSessionId = generateSessionId();
        console.log(formatLog(clientId, currentSessionId, "Initializing new session"));
        
        // Close previous WAV file if it exists
        if (audioStream && audioStream.wavWriter) {
            audioStream.wavWriter.close();
        }
        
        // Create new AudioStream for this session
        audioStream = new AudioStream(chunkDurationMs, audioSampleRate, clientId, currentSessionId);
        
        // Create new audio generator for this session
        audioGenerator = audioStream.getAudioStream();
        
        // Reset buffer
        tempBuffer = Buffer.alloc(0);
        
        console.log(formatLog(clientId, currentSessionId, "New session initialized"));
    }
    
    // Initialize first session
    initializeNewSession();

    ws.on('message', async (data) => {
        // Check if this is a text message (END_OF_AUDIO signal)
        // Text messages can arrive as Buffers, so check for small buffers (< 15 chars) first
        let isTextMessage = false;
        let message = '';
        
        if (Buffer.isBuffer(data) && data.length < 15) {
            // Small buffer - likely a text control message
            message = data.toString('utf8');
            isTextMessage = true;
            console.log(formatLog(clientId, currentSessionId, `Detected small buffer as text message: "${message}"`));
        } else if (typeof data === 'string') {
            // Actual string type
            message = data;
            isTextMessage = true;
            console.log(formatLog(clientId, currentSessionId, `Received string message: "${message}"`));
        }
        
        if (isTextMessage) {
            if (message === 'END_OF_AUDIO') {
                console.log(formatLog(clientId, currentSessionId, "✓ END_OF_AUDIO DETECTED - adding to queue for processing after audio"));
                connectionState.endOfAudioReceived = true;
                
                // Add END_OF_AUDIO as a control message to the queue
                // It will be processed after all audio chunks are sent to Deepgram
                audioStream.audioBufferQueue.push({
                    type: 'control',
                    message: 'END_OF_AUDIO',
                    connectionState: connectionState,
                    ws: ws
                });
                console.log(formatLog(clientId, currentSessionId, `END_OF_AUDIO added to queue. Queue size: ${audioStream.audioBufferQueue.length}`));
            } else {
                console.log(formatLog(clientId, currentSessionId, `Received text message but not END_OF_AUDIO: "${message}"`));
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
                    console.log(formatLog(clientId, currentSessionId, "First audio data received - establishing DeepGram connection"));
                    connectionState.deepgramConnected = true;
                    await startTranscription(ws, audioStream, audioGenerator, connectionState, clientId, currentSessionId);
                }
            } else {
                console.log(formatLog(clientId, currentSessionId, `Discarding late-arriving audio chunk (${data.length} bytes) - END_OF_AUDIO already processed for this session`));
            }
        }
    });

    ws.on('close', () => {
        console.log(formatLog(clientId, currentSessionId, "Client disconnected"));
        
        // Close AudioStream and WAV file
        if (audioStream) {
            audioStream.isClosed = true;
            if (audioStream.wavWriter) {
                console.log(formatLog(clientId, currentSessionId, "Closing WAV file on client disconnect"));
                audioStream.wavWriter.close();
            }
        }
        
        // Clean up intervals and timeouts when client disconnects
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared keep-alive interval on client disconnect"));
        }
        if (connectionState.readyStateMonitor) {
            clearInterval(connectionState.readyStateMonitor);
            connectionState.readyStateMonitor = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared ready state monitor on client disconnect"));
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared finalize timeout on client disconnect"));
        }
        if (connectionState.checkPendingChunksInterval) {
            clearInterval(connectionState.checkPendingChunksInterval);
            connectionState.checkPendingChunksInterval = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared checkPendingChunks interval on client disconnect"));
        }
        
        // Close DeepGram connection if still open
        if (connectionState.deepgramConnection) {
            try {
                connectionState.deepgramConnection.requestClose();
            } catch (err) {
                console.error(formatLog(clientId, currentSessionId, `Error closing DeepGram on client disconnect: ${err.message}`));
            }
        }
    });

    ws.on('error', (err) => {
        console.error(formatLog(clientId, currentSessionId, `WebSocket error: ${err.message}`));
        
        // Close AudioStream and WAV file
        if (audioStream) {
            audioStream.isClosed = true;
            if (audioStream.wavWriter) {
                console.log(formatLog(clientId, currentSessionId, "Closing WAV file on WebSocket error"));
                audioStream.wavWriter.close();
            }
        }
        
        // Clean up intervals and timeouts on WebSocket error
        if (connectionState.keepAliveInterval) {
            clearInterval(connectionState.keepAliveInterval);
            connectionState.keepAliveInterval = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared keep-alive interval on WebSocket error"));
        }
        if (connectionState.readyStateMonitor) {
            clearInterval(connectionState.readyStateMonitor);
            connectionState.readyStateMonitor = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared ready state monitor on WebSocket error"));
        }
        if (connectionState.finalizeTimeout) {
            clearTimeout(connectionState.finalizeTimeout);
            connectionState.finalizeTimeout = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared finalize timeout on WebSocket error"));
        }
        if (connectionState.checkPendingChunksInterval) {
            clearInterval(connectionState.checkPendingChunksInterval);
            connectionState.checkPendingChunksInterval = null;
            console.log(formatLog(clientId, currentSessionId, "Cleared checkPendingChunks interval on WebSocket error"));
        }
        
        // Close DeepGram connection if still open
        if (connectionState.deepgramConnection) {
            try {
                connectionState.deepgramConnection.requestClose();
            } catch (err) {
                console.error(formatLog(clientId, currentSessionId, `Error closing DeepGram on WebSocket error: ${err.message}`));
            }
        }
        
        ws.close();
    });

    // Create connection state object to share between handlers
    const connectionState = {
        deepgramConnection,
        keepAliveInterval,
        readyStateMonitor,
        checkPendingChunksInterval,
        endOfAudioReceived,
        endOfAudioPending,
        waitingForFinalTranscript,
        finalizeTimeout,
        deepgramConnected,
        completedTranscript,
        reconnectionAttempts,
        maxReconnectionAttempts,
        pendingAudioChunks: [],  // Buffer for chunks received before Deepgram is ready
        initializeNewSession  // Add session initialization function to state
    };

    // No longer start transcription immediately - wait for first audio data
});
