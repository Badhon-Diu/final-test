'use strict';

const fs   = require('fs');
const path = require('path');
const { Router } = require('express');
const { AUDIO_DIR } = require('../config');
const { audioUpload } = require('../middleware/upload');
const { transcribeAudio, extractViaFlaskApi, extractMarksFromText } = require('../services/audio.service');
const { deleteFile } = require('../utils/helpers');

const router = Router();

/**
 * POST /api/analyze-audio/transcribe
 *
 * Accepts a multipart audio file and returns the Whisper transcript.
 *
 * Input (multipart/form-data):
 *   audio : audio file (.mp3, .wav, .m4a, .webm, .ogg etc.)
 *
 * Output (JSON):
 *   { text, language, language_probability, time_sec }
 */
router.post('/transcribe', audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file. Send file with key "audio"' });

  const filePath = req.file.path;
  const mimeType = req.file.mimetype;

  try {
    const result = await transcribeAudio(filePath, mimeType);
    res.status(200).json(result);
  } catch (err) {
    console.error('[Audio] Transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    deleteFile(filePath);
  }
});

/**
 * POST /api/analyze-audio/extract
 *
 * Extract student marks from text using LLM + fuzzy matching against a dataset.
 *
 * Input (JSON body):
 *   { text: "...", dataset: [{ id, name }, ...] }
 *
 * Output (JSON):
 *   { result: [{ id, mark }], unmatched: [key, ...], time_sec }
 */
router.post('/extract', async (req, res) => {
  const { text, dataset } = req.body;

  if (!text)  return res.status(400).json({ error: "'text' field is required" });
  if (!dataset) return res.status(400).json({ error: "'dataset' field is required" });
  if (!Array.isArray(dataset)) return res.status(400).json({ error: "'dataset' must be an array" });

  try {
    const output = await extractMarksFromText(text, dataset);
    res.status(200).json(output);
  } catch (err) {
    console.error('[Audio] Extract error:', err.message);
    res.status(500).json({ error: err.message, raw: err.raw || undefined });
  }
});

/**
 * POST /api/analyze-audio
 *
 * Accepts JSON body: { audio: "<base64 string>", assessment: "quiz1" }
 * The extension records audio in the browser, base64-encodes it, and POSTs JSON —
 * so we decode the base64 here and write a temp file for Whisper.
 *
 * Pipeline: base64 decode → temp file → Whisper (Flask API) → Qwen2.5 (Flask API) → JSON marks
 *
 * ALL audio analysis goes through your Flask API — no HuggingFace/DeepSeek calls.
 *
 * Response:
 *   200  { results: [{ "student id": "...", mark: N }], transcript: "..." }
 *   400  { error: "No audio data provided" }
 *   500  { error: "...", details: "..." }
 */
router.post('/', async (req, res) => {
  const { audio: base64Audio, assessment, students } = req.body;
  if (!base64Audio) return res.status(400).json({ error: 'No audio data provided' });

  console.log(`[Audio] Received base64 audio for assessment: ${assessment}`);

  const audioBuffer = Buffer.from(base64Audio, 'base64');
  const tempFile    = path.join(AUDIO_DIR, `audio-${Date.now()}.webm`);
  fs.writeFileSync(tempFile, audioBuffer);
  console.log(`[Audio] Saved temp file: ${tempFile} (${audioBuffer.length} bytes)`);

  try {
    console.log('[Audio] Sending to Whisper via Flask API...');
    const whisperResult = await transcribeAudio(tempFile, 'audio/webm');
    const transcript = whisperResult.text;
    console.log(`[Audio] Transcript: "${transcript}"`);

    if (!transcript || transcript.trim() === '') {
      return res.status(200).json({ results: [], transcript: '' });
    }

    console.log('[Audio] Sending transcript to Qwen2.5 via Flask API...');
    const extraction = await extractViaFlaskApi(transcript, students || []);

    const results = extraction.result.map(r => ({ 'student id': r.id, mark: r.mark }));
    console.log('[Audio] Final results:', results);

    res.status(200).json({ results, transcript });

  } catch (err) {
    console.error('[Audio] Error:', err.message);
    if (err.cause) console.error('[Audio] Cause:', err.cause);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to analyze audio',
        details: err.message,
        cause: err.cause ? String(err.cause) : undefined,
      });
    }
  } finally {
    deleteFile(tempFile);
  }
});

module.exports = router;
