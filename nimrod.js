// server.js
require('dotenv').config();
const { WebSocketServer } = require('ws');
const {
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand
} = require('@aws-sdk/client-transcribe-streaming');
const {TranslateClient, TranslateTextCommand } = require("@aws-sdk/client-translate");

// ---------------------------------------------------------------------
// 1) Configure AWS Transcribe client
// ---------------------------------------------------------------------
const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

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

// ---------------------------------------------------------------------
// 2) Start WebSocket server
// ---------------------------------------------------------------------
const sockserver = new WebSocketServer({ port: 8550 }, () => {
    console.log('WebSocket server is listening on port 8550');
});

// ---------------------------------------------------------------------
// 3) Handle connections
// ---------------------------------------------------------------------
sockserver.on('connection', async (ws) => {
    console.log('New client connected');

    // Queue to store "fixed-size" audio chunks for AWS.
    const audioBufferQueue = [];

    // Temp buffer accumulates partial data until we have a "full" chunk.
    let tempBuffer = Buffer.alloc(0);

    // Suppose you want a 20ms chunk size (for example).
    // chunkDurationMs can come from .env or be hardcoded.
    const chunkDurationMs = parseInt(process.env.CHUNK_DURATION_MS, 10) || 20;

    // We'll need sample rate as a number.
    const audioSampleRate = parseInt(process.env.SAMPLE_RATE, 10) || 16000;

    // Computed chunk size in bytes: chunkDurationMs / 1000 * sampleRate * 2
    const chunkSize = Math.floor((chunkDurationMs / 1000) * audioSampleRate * 2);
    console.log('Using chunkSize (bytes):', chunkSize);

    // Pre-create a silence chunk of the same size.
    const silenceChunk = Buffer.alloc(chunkSize, 0);

    // We'll send silence if we run out of real audio. How many consecutive
    // silence chunks do we want to send before deciding it's truly over?
    // (You can adjust this to control how quickly AWS decides to finalize).
    const maxSilenceChunks = 66;
    let consecutiveSilenceChunksSent = 0;

    let isClosed = false; // to signal when the client disconnects

    // ---------------------------------------------------------------------
    // 4) Define an async generator to feed audio into AWS Transcribe
    // ---------------------------------------------------------------------
    async function* getAudioStream() {
        while (!isClosed) {
            if (audioBufferQueue.length === 0) {
                // No real audio to send right now
                if (consecutiveSilenceChunksSent < maxSilenceChunks) {
                    // Send a chunk of silence
                    yield {
                        AudioEvent: { AudioChunk: silenceChunk },
                    };
                    consecutiveSilenceChunksSent++;
                    // small wait so we don't busy-loop
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    continue;
                } else {
                    // We already sent enough silence. We could keep sending more
                    // if you want to keep the stream alive longer.
                    // If you prefer to finalize the stream, simply keep yielding or break.
                    // For demonstration, let’s just keep sending periodic silence
                    // in small amounts. (But you could break and let AWS finalize).
                    yield {
                        AudioEvent: { AudioChunk: silenceChunk },
                    };
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    continue;
                }
            }

            // We have real audio in the queue: send one chunk from the queue
            const audioChunk = audioBufferQueue.shift();
            if (audioChunk) {
                // log that we’re sending
                console.log('Sending audio chunk of length:', audioChunk.length);
                yield {
                    AudioEvent: {
                        AudioChunk: audioChunk,
                    },
                };
                // reset silence count since we just sent real audio
                consecutiveSilenceChunksSent = 0;
            }
        }
    }

    // ---------------------------------------------------------------------
    // 5) Build the Transcribe command
    // ---------------------------------------------------------------------
    const command = new StartStreamTranscriptionCommand({
        LanguageCode: process.env.SOURCE_LANGUAGE_CODE_LOCALE, // or your desired language
        MediaEncoding: 'pcm',  // must match what the client sends
        MediaSampleRateHertz: audioSampleRate, // must match your sample rate
        AudioStream: getAudioStream(),
    });

    // ---------------------------------------------------------------------
    // 6) Send the command to Transcribe and handle transcription events
    // ---------------------------------------------------------------------
    const transcribeResponse = client.send(command);
    console.log('Sent command to Transcribe');

    // Kick off an async operation to read the transcription results
    (async () => {
        try {
            const response = await transcribeResponse;
            console.log('Got response from Transcribe', response);
            for await (const event of response.TranscriptResultStream) {
                if (event.TranscriptEvent) {
                    const results = event.TranscriptEvent.Transcript.Results || [];
                    for (const result of results) {
                        console.log('Got result', result);

                        // Each 'result' can have multiple 'Alternatives'
                        if (result.Alternatives && result.Alternatives.length > 0) {
                            const transcript = result.Alternatives[0].Transcript;

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
        } finally {
            console.log('Transcription stream closed');
            ws.close();
        }
    })();

    // ---------------------------------------------------------------------
    // 7) Handle incoming WebSocket messages (binary audio data)
    // ---------------------------------------------------------------------
    ws.on('message', (data) => {
        // If the client sends text, handle that if needed
        // We assume raw binary audio frames
        if (Buffer.isBuffer(data)) {
            console.log('Received binary data of length:', data.length);

            // 1) Append inbound data to tempBuffer
            tempBuffer = Buffer.concat([tempBuffer, data]);

            // 2) While we have enough data in tempBuffer to form a full chunk:
            while (tempBuffer.length >= chunkSize) {
                // Slice out chunkSize bytes
                const fullChunk = tempBuffer.slice(0, chunkSize);
                // Push that into our queue
                audioBufferQueue.push(fullChunk);
                // Remove those bytes from tempBuffer
                tempBuffer = tempBuffer.slice(chunkSize);
            }
        } else {
            console.log('Received non-binary data (ignored)');
        }
    });

    // ---------------------------------------------------------------------
    // 8) Clean up when client disconnects
    // ---------------------------------------------------------------------
    ws.on('close', () => {
        console.log('Client disconnected');
        isClosed = true;
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        isClosed = true;
        ws.close();
    });
});
