'use strict';

require('dotenv').config();
const fs = require('fs');

const IS_VERCEL    = process.env.VERCEL === '1';
const AUDIO_DIR    = IS_VERCEL ? '/tmp/uploads'          : 'uploads';
const SESSIONS_DIR = IS_VERCEL ? '/tmp/uploads/sessions' : 'uploads/sessions';

// Ensure upload directories exist at startup
if (!fs.existsSync(AUDIO_DIR))    fs.mkdirSync(AUDIO_DIR,    { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const CONFIG = {
  port: process.env.PORT || 3001,
  hfToken: process.env.HF_TOKEN,

  // Whisper: custom Flask server running Whisper locally (URL from .env)
  audioApiUrl: process.env.AUDIO_API_URL || (() => { throw new Error('AUDIO_API_URL not set in .env'); })(),

  // Image analysis API (your own endpoint — no HuggingFace)
  imageApiUrl: process.env.IMAGE_API_URL || 'https://image-api-u5dy.onrender.com/api/analyze-images',

  // DeepSeek-V4-Flash: 13B activated params (MoE), fast, smart enough for JSON extraction
  deepSeekModel: 'deepseek-ai/DeepSeek-V4-Flash:novita',

  // Vision model: Gemma 4 31B — not used anymore (image API handles it)
  visionModel: 'google/gemma-4-31B-it:novita',

  // Max images processed in parallel per batch
  imageBatchSize: 3,

  // Timeout limits for each external AI service (milliseconds)
  timeouts: {
    whisper: 30_000,  // 30s — audio transcription can be slow
    vision: 40_000,   // 40s — vision model needs time for image analysis
  },
};

module.exports = { CONFIG, IS_VERCEL, AUDIO_DIR, SESSIONS_DIR };
