// server.js
require('dotenv').config();
const { WebSocketServer } = require('ws');
const {
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand
} = require('@aws-sdk/client-transcribe-streaming');
const {TranslateClient, TranslateTextCommand } = require("@aws-sdk/client-translate");

const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const chunkDurationMs = parseInt(process.env.CHUNK_DURATION_MS, 10) || 20;
const audioSampleRate = parseInt(process.env.SAMPLE_RATE, 10) || 16000;

const sockserver = new WebSocketServer({ port: 8550 }, () => {
    console.log('WebSocket server is listening on port 8550');
});

class AudioStream {
    constructor(chunkDurationMs, audioSampleRate) {
        this.chunkSize = Math.floor((chunkDurationMs / 1000) * audioSampleRate * 2);
        console.log('Using chunkSize (bytes):', this.chunkSize);

        this.chunkDurationMs = chunkDurationMs;
        this.silenceChunk = Buffer.alloc(this.chunkSize, 0);
        this.maxSilenceChunks = 10;
        this.consecutiveSilenceChunksSent = 0;
        this.dataSent = false;
        this.silenceStartTime = 0;
        this.isClosed = false;
        this.audioBufferQueue = [];
    }

    async * getAudioStream() {
        while (!this.isClosed) {
            if (this.audioBufferQueue.length === 0) {
                if (this.dataSent) {
                    if (this.silenceStartTime === 0) {
                        this.silenceStartTime = Date.now();
                    } else {
                        if (Date.now() - this.silenceStartTime > 500) {
                            if (this.consecutiveSilenceChunksSent < this.maxSilenceChunks) {
                                // Send a chunk of silence
                                yield {
                                    AudioEvent: {AudioChunk: this.silenceChunk},
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
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
        console.log("AUDIO STREAM CLOSED, WHAT NOW!");
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
                console.log('Reconnecting transcription stream...');
                startTranscription(ws, audioStream);
            } else {
                console.log('WebSocket is closed. Not reconnecting transcription stream.');
            }
        }, 100);
    }
}

sockserver.on('connection', async (ws) => {
    console.log(`[${new Date().toISOString()}]  New client connected`);

    let tempBuffer = Buffer.alloc(0);

    const audioStream = new AudioStream(chunkDurationMs, audioSampleRate);

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
        console.log('Client disconnected');
        audioStream.isClosed = true;
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        audioStream.isClosed = true;
        ws.close();
    });

    await startTranscription(ws, audioStream);
});
