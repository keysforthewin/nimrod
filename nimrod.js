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

const sockserver = new WebSocketServer({ port: 8550 }, () => {
    console.log('WebSocket server is listening on port 8550');
});

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
const maxSilenceChunks = 10;
let consecutiveSilenceChunksSent = 0;
let dataSent = false;
let silenceStartTime = 0;
async function* getAudioStream() {
    while (!isClosed) {
        if (audioBufferQueue.length === 0) {
            if (dataSent) {
                if (silenceStartTime === 0) {
                    silenceStartTime = Date.now();
                } else {
                    if (Date.now() - silenceStartTime > 500) {
                        if (consecutiveSilenceChunksSent < maxSilenceChunks) {
                            // Send a chunk of silence
                            yield {
                                AudioEvent: {AudioChunk: silenceChunk},
                            };
                            consecutiveSilenceChunksSent++;
                            console.log("SENDING SILENCE");
                            await new Promise((resolve) => setTimeout(resolve, chunkDurationMs));
                            continue;
                        } else {
                            dataSent = false;
                        }
                    }
                }
            }

            await new Promise((resolve) => setTimeout(resolve, 1));
        }

        // We have real audio in the queue: send one chunk from the queue
        const audioChunk = audioBufferQueue.shift();
        if (audioChunk) {
            // append this to session.wav so we can hear what we sent
            fs.appendFileSync(outputPath, audioChunk);
            console.log(`[${new Date().toISOString()}]  audio chunk of length: ${audioChunk.length}`);
            yield {
                AudioEvent: {
                    AudioChunk: audioChunk,
                },
            };
            // reset silence count since we just sent real audio
            dataSent = true;
            silenceStartTime = 0;
            consecutiveSilenceChunksSent = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

let isClosed = false; // to signal when the client disconnects

async function startTranscription(ws) {
    const command = new StartStreamTranscriptionCommand({
        LanguageCode: process.env.SOURCE_LANGUAGE_CODE_LOCALE, // or your desired language
        MediaEncoding: 'pcm',  // must match what the client sends
        MediaSampleRateHertz: audioSampleRate, // must match your sample rate
        AudioStream: getAudioStream(),
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
                startTranscription(ws);
            } else {
                console.log('WebSocket is closed. Not reconnecting transcription stream.');
            }
        }, 100);
    }
}

sockserver.on('connection', async (ws) => {
    console.log(`[${new Date().toISOString()}]  New client connected`);
    ws.on('message', (data) => {
        // If the client sends text, handle that if needed
        // We assume raw binary audio frames
        if (Buffer.isBuffer(data)) {
            //console.log('Received binary data of length:', data.length);

            // 1) Append inbound data to tempBuffer
            tempBuffer = Buffer.concat([tempBuffer, data]);
            //console.log("tempbufferlen: ", tempBuffer.length);

            // 2) While we have enough data in tempBuffer to form a full chunk:
            while (tempBuffer.length >= chunkSize) {
                // Slice out chunkSize bytes
                const fullChunk = tempBuffer.slice(0, chunkSize);
                // convert from source format to target format

                // Push that into our queue
                audioBufferQueue.push(fullChunk);
                // Remove those bytes from tempBuffer
                tempBuffer = tempBuffer.slice(chunkSize);
                // log length
                //console.log('Pushed audio chunk of length:', fullChunk.length);
                //console.log('Remaining tempBuffer length:', tempBuffer.length);
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

    await startTranscription(ws);
});
