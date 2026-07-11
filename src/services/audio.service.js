'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('../config');
const { normalizeMark } = require('../utils/helpers');
const { createTimeout } = require('../utils/helpers');

// ---------------------------------------------------------------------------
// Step A — Transcribe audio via your Flask Whisper API
// ---------------------------------------------------------------------------

/**
 * Send an audio file to your Flask Whisper API and return the transcript.
 * The Flask server runs Whisper large-v3 locally and is exposed via ngrok.
 *
 * @param {string} filePath  Absolute path to the saved audio file
 * @param {string} mimeType  e.g. "audio/webm"
 * @returns {Promise<{ text: string, language: string, language_probability: number, time_sec: number }>}
 */
async function transcribeAudio(filePath, mimeType) {
  const apiUrl = CONFIG.audioApiUrl.replace(/\/+$/, '');
  console.log(`[Audio] Flask API URL: ${apiUrl}/transcribe`);

  const start = Date.now();
  const { signal, clear } = createTimeout(CONFIG.timeouts?.whisper ?? 120_000);
  try {
    const audioBuffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath) || '.webm';

    const formData = new FormData();
    formData.append('audio', new Blob([audioBuffer], { type: mimeType }), `audio${ext}`);

    const response = await fetch(`${apiUrl}/transcribe`, {
      method: 'POST',
      body: formData,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Flask Whisper API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const elapsed = (Date.now() - start) / 1000;

    return {
      text: data.text,
      language: data.language || 'en',
      language_probability: data.language_probability ?? 0.95,
      time_sec: Math.round(elapsed * 100) / 100,
    };
  } finally {
    clear();
  }
}

// ---------------------------------------------------------------------------
// Step B — Extract marks via your Flask API (Qwen2.5-7B)
// ---------------------------------------------------------------------------

/**
 * Send raw text + student dataset to your Flask API's /extract endpoint.
 * The Flask server runs Qwen2.5-7B-Instruct locally and handles fuzzy matching.
 *
 * @param {string} text     Raw transcript or text
 * @param {Array<{id: string, name: string}>} dataset  Known students
 * @returns {Promise<{ result: Array<{id: string, mark: number}>, unmatched: string[], time_sec: number }>}
 */
async function extractViaFlaskApi(text, dataset) {
  const apiUrl = CONFIG.audioApiUrl.replace(/\/+$/, '');
  console.log(`[Audio] Flask API URL: ${apiUrl}/extract`);

  const start = Date.now();
  const { signal, clear } = createTimeout(120_000);
  try {
    const response = await fetch(`${apiUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, dataset }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Flask Extract API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const elapsed = (Date.now() - start) / 1000;

    return {
      result: data.result || [],
      unmatched: data.unmatched || [],
      time_sec: Math.round(elapsed * 100) / 100,
    };
  } finally {
    clear();
  }
}

// ---------------------------------------------------------------------------
// Step C — Extract marks from text (delegates to Flask API)
// ---------------------------------------------------------------------------

/**
 * Full pipeline: send text + dataset to Flask API for LLM extraction + matching.
 *
 * @param {string} text     Raw transcript or text
 * @param {Array<{id: string, name: string}>} dataset  Known students
 * @returns {{ result: Array<{id: string, mark: number}>, unmatched: string[], time_sec: number }}
 */
async function extractMarksFromText(text, dataset) {
  return extractViaFlaskApi(text, dataset);
}

// ---------------------------------------------------------------------------
// Step D — Extract marks from transcript via Flask API (replaces DeepSeek)
// ---------------------------------------------------------------------------

/**
 * Send the Whisper transcript to your Flask API for extraction.
 * Returns result in the same format parseDeepSeekOutput expects
 * for backward compatibility.
 *
 * @param {string} transcriptText
 * @param {Array<{id: string, name: string}>} [students]
 * @returns {Promise<string>} JSON string of [{ "student id": "...", mark: N }]
 */
async function extractMarksWithDeepSeek(transcriptText, students = []) {
  const result = await extractViaFlaskApi(transcriptText, students);
  const mapped = result.result.map(r => ({ 'student id': r.id, mark: r.mark }));
  return JSON.stringify(mapped);
}

// ---------------------------------------------------------------------------
// Step E — Parse DeepSeek's raw output into a normalised record array
// (kept for backward compatibility; now parses Flask API response format)
// ---------------------------------------------------------------------------

/**
 * Parse the JSON string produced by extractMarksWithDeepSeek into
 * an array of { "student id": string, mark: number } objects.
 * @param {string} rawJson
 * @returns {Array<{ "student id": string, mark: number }>}
 */
function parseDeepSeekOutput(rawJson) {
  const parsed = JSON.parse(rawJson);
  if (!Array.isArray(parsed)) throw new Error('Expected an array');
  return parsed.map(item => ({
    'student id': item['student id'] || item.id || item.studentId || item.student_id || 'N/A',
    mark: normalizeMark(item.mark),
  }));
}

module.exports = { transcribeAudio, extractViaFlaskApi, extractMarksFromText, extractMarksWithDeepSeek, parseDeepSeekOutput };
