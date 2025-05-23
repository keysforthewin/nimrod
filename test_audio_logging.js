// Test script to verify audio logging functionality
const fs = require('fs');
const path = require('path');

console.log('Audio Logging Test Summary:');
console.log('=========================');

// Check if audio_logs directory exists
const audioLogsDir = './audio_logs';
if (fs.existsSync(audioLogsDir)) {
    console.log('✓ audio_logs directory exists');
    
    // List any existing audio files
    const files = fs.readdirSync(audioLogsDir);
    const wavFiles = files.filter(f => f.endsWith('.wav'));
    
    if (wavFiles.length > 0) {
        console.log(`\nFound ${wavFiles.length} WAV file(s):`);
        wavFiles.forEach(file => {
            const filePath = path.join(audioLogsDir, file);
            const stats = fs.statSync(filePath);
            console.log(`  - ${file} (${stats.size} bytes)`);
        });
    } else {
        console.log('\nNo WAV files found yet. Files will be created when clients connect and send audio.');
    }
} else {
    console.log('ℹ audio_logs directory will be created when the server starts');
}

console.log('\nImplementation Details:');
console.log('- Each WebSocket connection creates a unique WAV file');
console.log('- Filename format: audio_session_[timestamp]_[sessionId].wav');
console.log('- Audio is saved as 16-bit PCM, mono, at your configured sample rate');
console.log('- Both real audio chunks and silence chunks are logged');
console.log('- Files contain exactly what AWS Transcribe receives');

console.log('\nTo test:');
console.log('1. Start the server: node nimrod.js');
console.log('2. Connect a client and send audio');
console.log('3. Check the audio_logs directory for the generated WAV file');
console.log('4. Click/open the WAV file to hear what the transcription service heard');
