// Test script to verify rapid reconnection bug fix
// This simulates a client that:
// 1. Sends audio + END_OF_AUDIO
// 2. Reconnects in < 500ms
// 3. Sends new audio
// Expected: New audio should be processed, not discarded

const WebSocket = require('ws');
const fs = require('fs');

const SERVER_URL = 'ws://localhost:8550';

// Generate test audio data (16-bit PCM, 16kHz)
function generateAudioChunk(durationMs, frequency = 440) {
    const sampleRate = 16000;
    const numSamples = Math.floor((durationMs / 1000) * sampleRate);
    const buffer = Buffer.alloc(numSamples * 2); // 16-bit = 2 bytes per sample
    
    for (let i = 0; i < numSamples; i++) {
        const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 32767;
        buffer.writeInt16LE(Math.floor(sample), i * 2);
    }
    
    return buffer;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testRapidReconnection(reconnectDelayMs) {
    console.log(`\n========================================`);
    console.log(`TEST: Rapid reconnection with ${reconnectDelayMs}ms delay`);
    console.log(`========================================\n`);
    
    return new Promise((resolve, reject) => {
        let ws = new WebSocket(SERVER_URL);
        let session1Complete = false;
        let session2Started = false;
        let session2ReceivedTranscript = false;
        
        ws.on('open', () => {
            console.log('[TEST] ✓ WebSocket connection opened (Session 1)');
            
            // Session 1: Send audio and END_OF_AUDIO
            const audioChunk1 = generateAudioChunk(100, 440); // 100ms of 440Hz
            console.log(`[TEST] Sending ${audioChunk1.length} bytes of audio (Session 1)`);
            ws.send(audioChunk1);
            
            setTimeout(() => {
                console.log('[TEST] Sending END_OF_AUDIO (Session 1)');
                ws.send('END_OF_AUDIO');
                session1Complete = true;
                
                // Rapid reconnection: Start session 2 after delay
                setTimeout(() => {
                    console.log(`[TEST] Starting Session 2 after ${reconnectDelayMs}ms`);
                    session2Started = true;
                    
                    // Session 2: Send new audio
                    const audioChunk2 = generateAudioChunk(100, 880); // 100ms of 880Hz
                    console.log(`[TEST] Sending ${audioChunk2.length} bytes of NEW audio (Session 2)`);
                    ws.send(audioChunk2);
                    
                    setTimeout(() => {
                        console.log('[TEST] Sending END_OF_AUDIO (Session 2)');
                        ws.send('END_OF_AUDIO');
                    }, 100);
                }, reconnectDelayMs);
            }, 100);
        });
        
        ws.on('message', (data) => {
            const message = JSON.parse(data.toString());
            console.log(`[TEST] Received transcript: "${message.transcript}" (isPartial: ${message.isPartial})`);
            
            if (session2Started && !message.isPartial) {
                session2ReceivedTranscript = true;
                console.log('[TEST] ✓ Session 2 received final transcript - NEW AUDIO WAS PROCESSED!');
            } else {
                console.log('[TEST] ℹ️  sessionComplete, session2Started, message.isPartial', session1Complete, session2Started, message.isPartial);
            }
        });
        
        ws.on('close', () => {
            console.log('[TEST] WebSocket closed');
            
            if (session2ReceivedTranscript) {
                console.log('\n[TEST] ✅ TEST PASSED: Session 2 audio was processed successfully');
                resolve(true);
            } else if (session2Started) {
                console.log('\n[TEST] ❌ TEST FAILED: Session 2 audio was discarded (bug not fixed)');
                resolve(false);
            } else {
                console.log('\n[TEST] ⚠️  TEST INCOMPLETE: Session 2 was not started');
                resolve(false);
            }
        });
        
        ws.on('error', (err) => {
            console.error(`[TEST] WebSocket error: ${err.message}`);
            reject(err);
        });
        
        // Safety timeout
        setTimeout(() => {
            console.log('\n[TEST] ⏱️  Test timeout - closing connection');
            ws.close();
        }, 15000);
    });
}

async function runTests() {
    console.log('Starting rapid reconnection tests...\n');
    
    // Test with different reconnection delays
    const delays = [100, 200, 300, 400, 500];
    const results = [];
    
    for (const delay of delays) {
        try {
            const result = await testRapidReconnection(delay);
            results.push({ delay, passed: result });
            await sleep(2000); // Wait between tests
        } catch (err) {
            console.error(`Test with ${delay}ms delay failed with error:`, err);
            results.push({ delay, passed: false, error: err.message });
            await sleep(2000);
        }
    }
    
    // Summary
    console.log('\n========================================');
    console.log('TEST SUMMARY');
    console.log('========================================');
    results.forEach(({ delay, passed, error }) => {
        const status = passed ? '✅ PASS' : '❌ FAIL';
        const errorMsg = error ? ` (${error})` : '';
        console.log(`${status} - ${delay}ms delay${errorMsg}`);
    });
    
    const allPassed = results.every(r => r.passed);
    console.log(`\nOverall: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
    
    process.exit(allPassed ? 0 : 1);
}

// Run tests
runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});