const { OpenAI } = require('openai');
const textToSpeech = require('@google-cloud/text-to-speech');
const fs = require('fs');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

// Wrap raw LINEAR16 PCM bytes in a minimal WAV container so Whisper accepts it
function wrapInWav(pcmBuffer, sampleRate = 8000, channels = 1, bitDepth = 16) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);                               // PCM chunk size
  header.writeUInt16LE(1, 20);                                // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
  header.writeUInt16LE(channels * (bitDepth / 8), 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// STT via OpenAI Whisper (supports Sinhala + English)
// hints: array of phrases likely to be spoken — passed as a prompt to guide Whisper
async function speechToText(buffer, lang = 'si', hints = []) {
  const language = lang === 'si' ? 'si' : 'en';

  // Wrap raw PCM in a WAV container Whisper can parse
  const wavBuffer = wrapInWav(buffer);
  const tmpFile = `/tmp/stt_${Date.now()}.wav`;
  fs.writeFileSync(tmpFile, wavBuffer);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language,
      // Whisper uses the prompt as prior context — inject likely words to improve accuracy
      prompt: hints.length ? hints.slice(0, 20).join(', ') : undefined,
    });
    return transcription.text?.trim() || '';
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// TTS - Convert text to speech and save as WAV file for Asterisk playback
async function textToSpeechFile(text, lang = 'si') {
  if (!text || text.trim().length === 0) return null;

  let languageCode = (lang === 'si') ? 'si-LK' : 'en-US';
  const voiceName = (lang === 'si') ? null : 'en-US-Standard-C';

  let response;
  try {
    [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: (lang === 'si')
        ? { languageCode, ssmlGender: 'FEMALE' }
        : { languageCode, name: voiceName, ssmlGender: 'FEMALE' },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: 8000,  // Phone quality for Asterisk
        speakingRate: 0.9       // Slightly slower for clarity
      }
    });
  } catch (err) {
    // If Sinhala (si-LK) voice isn't available, retry with generic 'si' locale
    if (lang === 'si') {
      try {
        languageCode = 'si';
        [response] = await ttsClient.synthesizeSpeech({
          input: { text },
          voice: { languageCode, ssmlGender: 'FEMALE' },
          audioConfig: {
            audioEncoding: 'LINEAR16',
            sampleRateHertz: 8000,
            speakingRate: 0.9
          }
        });
      } catch (err2) {
        throw err;
      }
    } else {
      throw err;
    }
  }

  // Save to temp file
  const filename = `/tmp/tts_${Date.now()}.wav`;
  fs.writeFileSync(filename, response.audioContent, 'binary');

  return filename;
}

module.exports = { speechToText, textToSpeechFile };
