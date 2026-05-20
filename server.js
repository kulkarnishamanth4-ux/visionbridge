require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const os = require('os');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.0-flash-lite'];

const responseCache = { analyze: null, measure: null, ask: null };

// --- OTP store: { contact: { otp, expiresAt, verified } } ---
const otpStore = {};

// --- Middleware ---
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Gemini Client ---
let genAI = null;

function getGenAI() {
  if (!genAI && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_api_key_here') {
    genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return genAI;
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Determine if an error is worth retrying (rate limit / overload)
function isRetryable(err) {
  const msg = (err.message || '').toLowerCase();
  return msg.includes('503') || msg.includes('429') || msg.includes('unavailable')
    || msg.includes('overload') || msg.includes('resource exhausted') || msg.includes('quota');
}

/**
 * Try each model in MODELS, retrying retryable errors with exponential backoff.
 * Per-model: up to MAX_RETRIES attempts. Falls through to next model on exhaustion.
 */
async function callWithFallback(client, requestConfig) {
  const MAX_RETRIES = 2;
  const BASE_DELAY_MS = 1000;  // 1s, 2s
  let lastErr;

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await client.models.generateContent({ model, ...requestConfig });
        console.log(`[${model}] success on attempt ${attempt}`);
        return response;
      } catch (err) {
        lastErr = err;
        const retryable = isRetryable(err);
        console.warn(`[${model}] attempt ${attempt}/${MAX_RETRIES} failed (retryable=${retryable}):`, err.message?.slice(0, 120));

        if (!retryable) break;
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`  Waiting ${delay}ms before retry...`);
          await sleep(delay);
        }
      }
    }
    console.warn(`Model ${model} exhausted all retries, moving to next model...`);
  }

  throw lastErr;
}

/**
 * Robustly extract a JSON object from the model's text response.
 * Handles markdown fences, truncated JSON, and partial wrapping.
 */
function extractJSON(text) {
  // Strip markdown code fences
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Try direct parse first
  try { return JSON.parse(cleaned); } catch {}

  // Find first { ... } block (greedy)
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }

  // Handle TRUNCATED JSON: try to extract known fields via regex
  const descMatch = cleaned.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)/i);
  const summaryMatch = cleaned.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/i);
  if (descMatch || summaryMatch) {
    return {
      description: descMatch ? descMatch[1] : (summaryMatch ? summaryMatch[1] : ''),
      dangers: [],
      summary: summaryMatch ? summaryMatch[1] : (descMatch ? descMatch[1].slice(0, 120) : '')
    };
  }

  // Return null to signal parse failure
  return null;
}

/**
 * Strip JSON/markdown artifacts from raw text for display fallback.
 */
function cleanRawText(text) {
  return text
    .replace(/```json\s*/gi, '').replace(/```\s*/g, '')
    .replace(/^\s*\{[^}]*"description"\s*:\s*"/i, '')
    .replace(/"\s*,\s*"dangers".*$/s, '')
    .replace(/"\s*,\s*"summary".*$/s, '')
    .replace(/^[\s"{}:,]+/, '').replace(/[\s"{}:,]+$/, '')
    .trim();
}

// ========== SYSTEM INSTRUCTIONS PER MODE ==========

// DETAILED MODE (default) -- full spatial scene description + dangers
const DETAILED_INSTRUCTION = `You are VisionBridge, an AI assistant helping a blind person understand their surroundings through a camera feed. Your role is critically important for their safety and independence.

RESPONSE FORMAT -- You MUST respond with valid JSON only, no markdown, no extra text:
{
  "description": "A detailed, spatial description of the scene using clock positions and distances",
  "dangers": [
    {
      "type": "vehicle|obstacle|stairs|edge|crowd|animal|other",
      "severity": "critical|warning|info",
      "description": "Brief, urgent description of the danger",
      "direction": "left|right|ahead|behind|above|below"
    }
  ],
  "summary": "A single sentence summary of the most important thing the user should know right now"
}

DESCRIPTION GUIDELINES:
- Use spatial language: "directly ahead", "to your left at about 10 o'clock", "on your right side"
- Estimate distances: "about 5 feet ahead", "roughly 3 meters to your left"
- Describe the environment type first: indoor/outdoor, lighting, weather
- Mention floor/ground conditions: wet, uneven, stairs, curb
- Describe people and their positions relative to the user
- Note doorways, exits, furniture, and navigational landmarks
- Be specific about colors, shapes, and textures when helpful

DANGER DETECTION -- HIGHEST PRIORITY:
- Moving vehicles (cars, bikes, scooters) -- always critical
- Stairs, steps, curbs, or elevation changes -- critical
- Wet or slippery surfaces -- warning
- Obstacles in the walking path (poles, signs, chairs) -- warning
- Construction zones or uneven ground -- warning
- Crowds or fast-moving people -- info
- Low-hanging branches or overhead hazards -- warning
- Open edges, drops, or water -- critical

Always prioritize dangers in your response. If there is immediate danger, the summary should be about that danger.`;

// DANGER MODE -- ONLY immediate, close-up threats. Ultra-concise.
const DANGER_INSTRUCTION = `You are VisionBridge in DANGER MODE. You ONLY report immediate, close-range dangers to a blind person. Ignore everything else.

RESPONSE FORMAT -- valid JSON only, no markdown:
{
  "description": "",
  "dangers": [
    {
      "type": "vehicle|obstacle|stairs|edge|crowd|animal|other",
      "severity": "critical|warning",
      "description": "Urgent 5-10 word description",
      "direction": "left|right|ahead|behind|above|below",
      "distance": "estimated distance in feet/meters"
    }
  ],
  "summary": "Most urgent danger in one sentence, or 'No immediate dangers detected' if safe"
}

RULES:
- ONLY report dangers within approximately 15 feet / 5 meters of the camera
- If NO close danger exists, return empty dangers array and summary = "No immediate dangers detected. Path appears clear."
- Focus on: vehicles approaching, steps/curbs/edges directly ahead, obstacles in walking path, open water/drops
- Be extremely concise -- this will be spoken urgently
- Do NOT describe the general scene, furniture, or background objects
- Every danger MUST include an estimated distance`;

// SUMMARY MODE -- entire scene in one sentence
const SUMMARY_INSTRUCTION = `You are VisionBridge in SUMMARY MODE. Describe the ENTIRE scene in exactly ONE clear sentence for a blind person.

RESPONSE FORMAT -- valid JSON only:
{
  "description": "",
  "dangers": [],
  "summary": "One comprehensive sentence describing the full scene, environment, key objects, and any notable features"
}

RULES:
- The summary must be ONE sentence, maximum 30 words
- Cover: environment type, key objects, people, and overall atmosphere
- Use spatial references when possible
- Example: "You are on a busy sidewalk with shops on your left, a crosswalk ahead, and several people walking toward you."
- If there is an obvious danger, mention it in the sentence`;

// MEASURE MODE -- object sizes and motion estimation
const MEASURE_INSTRUCTION = `You are VisionBridge in MEASURE MODE. Estimate the approximate SIZE of all visible objects and whether they appear to be MOVING.

RESPONSE FORMAT -- valid JSON only:
{
  "objects": [
    {
      "name": "object name",
      "size": "estimated dimensions (height x width) in feet/meters",
      "distance": "estimated distance from camera in feet/meters",
      "moving": true or false,
      "speed": "estimated speed if moving (slow/walking/fast/very fast) with approximate mph/kmh, or 'stationary'",
      "direction": "left|right|ahead|away|toward|stationary"
    }
  ],
  "summary": "Brief overview of the objects, their sizes, and any movement"
}

SIZE ESTIMATION GUIDELINES:
- Use common reference objects: doors (~7ft/2.1m tall), cars (~14ft/4.3m long, ~5ft/1.5m tall), people (~5.5ft/1.7m tall)
- Estimate using perspective cues, relative sizes, and known object dimensions
- Give dimensions in both feet and meters
- Include distance from the camera

SPEED ESTIMATION GUIDELINES:
- "slow" = under 3 mph / 5 kmh (shuffling, drifting)
- "walking" = 3-4 mph / 5-6 kmh (normal human pace)
- "fast" = 5-15 mph / 8-24 kmh (running, cycling)
- "very fast" = 15+ mph / 24+ kmh (vehicles)
- Base speed estimates on apparent motion blur, object type, and context`;

// MEASURE MODE with two frames -- for actual motion detection
const MEASURE_DUAL_INSTRUCTION = `You are VisionBridge analyzing TWO consecutive camera frames taken approximately 1 second apart. Estimate object SIZES, DISTANCES, and MOVEMENT/SPEED by comparing object positions between the two frames.

RESPONSE FORMAT -- valid JSON only:
{
  "objects": [
    {
      "name": "object name",
      "size": "estimated dimensions (height x width) in feet/meters",
      "distance": "estimated distance from camera",
      "moving": true or false,
      "speed": "estimated speed with approximate mph/kmh, or 'stationary'",
      "direction": "direction of movement (left, right, toward, away, stationary)"
    }
  ],
  "summary": "Brief spoken summary of sizes and movement for a blind person"
}

COMPARE THE TWO FRAMES:
- Image 1 was taken first, Image 2 about 1 second later
- Objects that shifted position are MOVING -- estimate speed from displacement
- Objects in the same position are STATIONARY
- Use known object sizes (person ~1.7m, car ~4.3m long) to calibrate distance and speed
- If an object is larger in frame 2, it is moving TOWARD the camera
- If smaller in frame 2, it is moving AWAY`;

const QA_SYSTEM_INSTRUCTION = `You are VisionBridge, an AI assistant helping a blind person understand their surroundings. The user is asking you a specific question about what they are seeing through their camera.

Answer their question directly, clearly, and concisely. Use spatial references (left, right, ahead, behind) and distance estimates. Keep your response conversational and natural -- it will be read aloud via text-to-speech.

If you cannot determine the answer from the image, say so honestly and describe what you can see instead. Be warm and helpful.

Keep responses under 3 sentences unless more detail is specifically asked for.`;

// Map mode names to system instructions
const MODE_INSTRUCTIONS = {
  detailed: DETAILED_INSTRUCTION,
  danger: DANGER_INSTRUCTION,
  summary: SUMMARY_INSTRUCTION,
  measure: MEASURE_INSTRUCTION
};


// --- API Routes ---

// Health check + API key status
app.get('/api/status', (req, res) => {
  const client = getGenAI();
  res.json({
    status: 'ok',
    apiKeyConfigured: !!client,
    message: client
      ? 'VisionBridge is ready.'
      : 'API key not configured. Please add GEMINI_API_KEY to your .env file.'
  });
});

// Analyze scene from camera frame (supports mode: detailed, danger, summary, measure)
app.post('/api/analyze', async (req, res) => {
  try {
    const client = getGenAI();
    if (!client) {
      return res.status(503).json({
        error: 'API key not configured',
        description: 'I cannot analyze the scene right now. The API key needs to be configured.',
        dangers: [],
        summary: 'System is not configured. Please add your Gemini API key.'
      });
    }

    const { image, mode = 'detailed' } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const systemInstruction = MODE_INSTRUCTIONS[mode] || DETAILED_INSTRUCTION;

    const promptTexts = {
      detailed: 'Analyze this scene for a blind person. Describe the surroundings in detail and identify any immediate dangers. Respond in the required JSON format.',
      danger: 'DANGER SCAN: Only report close-range, immediate dangers. If none, say the path is clear. Respond in JSON.',
      summary: 'Summarize this entire scene in ONE sentence. Respond in JSON.',
      measure: 'Estimate the size, distance, and movement speed of all visible objects. Respond in JSON.'
    };

    const requestConfig = {
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
            { text: promptTexts[mode] || promptTexts.detailed }
          ]
        }
      ],
      config: {
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens: mode === 'summary' ? 256 : mode === 'danger' ? 512 : 768
      }
    };

    const response = await callWithFallback(client, requestConfig);
    const text = response.text.trim();

    const parsed = extractJSON(text) || {
      description: cleanRawText(text),
      dangers: [],
      summary: cleanRawText(text).slice(0, 120)
    };

    if (!parsed.dangers) parsed.dangers = [];
    if (!parsed.summary && parsed.description) parsed.summary = parsed.description.slice(0, 100);

    // Cache successful response
    responseCache.analyze = parsed;

    res.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err.message);

    // FALLBACK: Return cached response if available (never show "service busy")
    if (responseCache.analyze) {
      console.log('Returning cached analyze response as fallback.');
      return res.json({
        ...responseCache.analyze,
        _cached: true,
        summary: responseCache.analyze.summary + ' (using previous scan -- AI service is busy)'
      });
    }

    // Last resort: return a useful message instead of a hard error
    res.status(200).json({
      description: 'The AI service is currently experiencing high demand. I will keep trying automatically. Your camera is still active.',
      dangers: [],
      summary: 'AI service is loading. Please scan again in a few seconds.'
    });
  }
});

// Measure endpoint -- accepts TWO frames for motion/speed detection
app.post('/api/measure', async (req, res) => {
  try {
    const client = getGenAI();
    if (!client) {
      return res.status(503).json({ objects: [], summary: 'API key not configured.' });
    }

    const { image1, image2 } = req.body;
    if (!image1) {
      return res.status(400).json({ error: 'At least one image is required' });
    }

    const base64_1 = image1.replace(/^data:image\/\w+;base64,/, '');
    const parts = [{ inlineData: { mimeType: 'image/jpeg', data: base64_1 } }];

    let instruction = MEASURE_INSTRUCTION;
    let promptText = 'Estimate the size, distance, and movement of all visible objects. Respond in JSON.';

    if (image2) {
      const base64_2 = image2.replace(/^data:image\/\w+;base64,/, '');
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64_2 } });
      instruction = MEASURE_DUAL_INSTRUCTION;
      promptText = 'Compare these two frames taken ~1 second apart. Estimate sizes, distances, and movement speeds. Respond in JSON.';
    }

    parts.push({ text: promptText });

    const requestConfig = {
      contents: [{ role: 'user', parts }],
      config: { systemInstruction: instruction, temperature: 0.2, maxOutputTokens: 512 }
    };

    const response = await callWithFallback(client, requestConfig);
    const parsed = extractJSON(response.text.trim()) || { objects: [], summary: response.text.trim() };
    if (!parsed.objects) parsed.objects = [];

    responseCache.measure = parsed;
    res.json(parsed);
  } catch (err) {
    console.error('Measure error:', err.message);
    if (responseCache.measure) {
      return res.json({ ...responseCache.measure, _cached: true });
    }
    res.status(200).json({ objects: [], summary: 'Measurement is loading. Please try again in a moment.' });
  }
});

// Answer a specific question about the scene
app.post('/api/ask', async (req, res) => {
  try {
    const client = getGenAI();
    if (!client) {
      return res.status(503).json({
        answer: 'I cannot answer questions right now. The API key needs to be configured.'
      });
    }

    const { image, question } = req.body;
    if (!image || !question) {
      return res.status(400).json({ error: 'Image and question are required' });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

    const requestConfig = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
              }
            },
            { text: question }
          ]
        }
      ],
      config: {
        systemInstruction: QA_SYSTEM_INSTRUCTION,
        temperature: 0.4,
        maxOutputTokens: 256
      }
    };

    const response = await callWithFallback(client, requestConfig);
    const answer = response.text.trim();

    responseCache.ask = answer;
    res.json({ answer });
  } catch (err) {
    console.error('Ask error:', err.message);
    if (responseCache.ask) {
      return res.json({ answer: responseCache.ask + ' (Note: AI is busy, this may be a previous answer)', _cached: true });
    }
    res.status(200).json({
      answer: 'The AI service is loading. Please try asking again in a few seconds.'
    });
  }
});

// ========== TRANSLATION ENDPOINT ==========
app.post('/api/translate', async (req, res) => {
  const { text, targetLang } = req.body;
  if (!text || !targetLang) return res.status(400).json({ error: 'text and targetLang required' });
  if (targetLang === 'en') return res.json({ translated: text });

  const langNames = {
    hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese',
    ko: 'Korean', zh: 'Chinese (Simplified)', ar: 'Arabic', pt: 'Portuguese',
    ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ru: 'Russian', it: 'Italian'
  };
  const langName = langNames[targetLang] || targetLang;

  try {
    const client = getGenAI();
    if (!client) return res.json({ translated: text });

    const response = await callWithFallback(client, {
      contents: [{
        role: 'user',
        parts: [{ text: `Translate the following text to ${langName}. Return ONLY the translated text, nothing else. Do not add quotes or explanations.\n\n${text}` }]
      }]
    });

    const translated = response.text?.trim() || text;
    res.json({ translated });
  } catch (err) {
    console.warn('[Translate] Error:', err.message?.slice(0, 80));
    res.json({ translated: text }); // Fallback to original
  }
});

// --- Helper: Get local IP addresses ---
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

// --- Start Server ---
app.listen(PORT, '0.0.0.0', () => {
  const client = getGenAI();
  const ips = getLocalIPs();

  console.log(`\n[VisionBridge] Server is running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`   Network: http://${ip.address}:${PORT}  (${ip.name})`));

  if (client) {
    console.log('\n[OK] Gemini API key configured and ready.');
  } else {
    console.log('\n[!] No API key found. Copy .env.example to .env and add your key.');
    console.log('   Get a free key at: https://aistudio.google.com/');
  }

  if (process.env.SOS_EMAIL_USER && process.env.SOS_EMAIL_PASS) {
    console.log('[OK] SOS Email configured and ready.');
  } else {
    console.log('[!] SOS Email not configured. Set SOS_EMAIL_USER and SOS_EMAIL_PASS in .env');
  }

  console.log('\n[TIP] To access from your phone or any device, run this in a NEW terminal:');
  console.log('   npx ngrok http 3000');
  console.log('   Then open the https://xxxx.ngrok-free.app URL on any device.\n');
});

// =============================================
//   TRANSLATION ENDPOINT (for multi-language TTS)
//   Uses a FAST single-model call — no retries, no fallback chain.
//   Translation must be instant for TTS to work smoothly.
// =============================================
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    if (!text || !targetLang || targetLang === 'en') {
      return res.json({ translated: text });
    }

    const client = getGenAI();
    if (!client) {
      return res.json({ translated: text });
    }

    const langNames = {
      hi: 'Hindi', kn: 'Kannada', ta: 'Tamil', te: 'Telugu',
      mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', ml: 'Malayalam',
      pa: 'Punjabi', ur: 'Urdu', es: 'Spanish', fr: 'French',
      de: 'German', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
      ar: 'Arabic', pt: 'Portuguese', ru: 'Russian', it: 'Italian'
    };
    const langName = langNames[targetLang] || targetLang;

    // Direct single-model call — NO retries, NO fallback chain.
    // Translation must be fast for TTS to feel instant.
    const response = await client.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{
        role: 'user',
        parts: [{ text: `Translate the following text to ${langName}. Output ONLY the translation, no explanation, no quotes, no formatting.\n\n${text}` }]
      }],
      config: { maxOutputTokens: 256, temperature: 0.1 }
    });

    const translated = response.text.trim() || text;
    console.log(`[Translate] ${targetLang}: "${text.slice(0, 40)}..." -> "${translated.slice(0, 40)}..."`);
    res.json({ translated });
  } catch (err) {
    console.warn('[Translate] Error:', err.message?.slice(0, 80));
    res.json({ translated: req.body.text || '' });
  }
});

// =============================================
//   SMTP TRANSPORTER HELPER
// =============================================
function getTransporter() {
  const user = process.env.SOS_EMAIL_USER;
  const pass = process.env.SOS_EMAIL_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

// =============================================
//   OTP VERIFICATION ENDPOINTS
// =============================================
app.post('/api/send-otp', async (req, res) => {
  try {
    const { contact, type } = req.body;
    if (!contact || !type) {
      return res.json({ success: false, error: 'Contact and type are required.' });
    }

    // Validate format
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
      return res.json({ success: false, error: 'Invalid email format. Use: abc@email.com' });
    }
    if (type === 'phone' && !/^\+\d{10,15}$/.test(contact.replace(/[\s-]/g, ''))) {
      return res.json({ success: false, error: 'Invalid phone format. Use: +919999988888' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    otpStore[contact] = { otp, expiresAt: Date.now() + 10 * 60 * 1000, verified: false };

    if (type === 'email') {
      const transporter = getTransporter();
      if (!transporter) {
        return res.json({ success: false, error: 'Email service not configured. Set SOS_EMAIL_USER and SOS_EMAIL_PASS in Render environment variables.' });
      }
      await transporter.sendMail({
        from: `"VisionBridge" <${process.env.SOS_EMAIL_USER}>`,
        to: contact,
        subject: 'VisionBridge - Verify your emergency contact',
        text: `Your VisionBridge verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px;border:2px solid #7b61ff;border-radius:12px;text-align:center;"><h2 style="color:#7b61ff;">VisionBridge Verification</h2><p style="font-size:16px;">Your verification code is:</p><h1 style="font-size:36px;letter-spacing:8px;color:#00d4ff;">${otp}</h1><p style="color:#888;">This code expires in 10 minutes.</p></div>`
      });
      console.log(`[OTP] Sent to email: ${contact}`);
      return res.json({ success: true, message: 'OTP sent to your email.' });
    }

    if (type === 'phone') {
      // Phone OTP: we can't send SMS without Twilio, but we verify the format
      // For demo: the OTP is logged server-side and returned in a hint
      console.log(`[OTP] Phone verification for ${contact}: ${otp}`);
      // In production, integrate Twilio here
      return res.json({ success: true, message: 'Phone verified by format. For SMS OTP, Twilio integration is required.', directVerify: true });
    }

    res.json({ success: false, error: 'Unknown contact type.' });
  } catch (err) {
    console.error('[OTP] Error:', err.message);
    res.json({ success: false, error: 'Failed to send OTP: ' + err.message });
  }
});

app.post('/api/verify-otp', (req, res) => {
  const { contact, otp } = req.body;
  const entry = otpStore[contact];

  if (!entry) {
    return res.json({ success: false, error: 'No OTP was sent to this contact. Please request a new one.' });
  }
  if (Date.now() > entry.expiresAt) {
    delete otpStore[contact];
    return res.json({ success: false, error: 'OTP expired. Please request a new one.' });
  }
  if (entry.otp !== otp) {
    return res.json({ success: false, error: 'Incorrect OTP. Please try again.' });
  }

  entry.verified = true;
  console.log(`[OTP] Contact verified: ${contact}`);
  res.json({ success: true, message: 'Contact verified successfully!' });
});

// =============================================
//   SOS EMERGENCY ENDPOINT
// =============================================
app.post('/api/sos', async (req, res) => {
  try {
    const { contact, reason, location } = req.body;
    if (!contact) {
      return res.json({ success: false, error: 'No emergency contact provided.' });
    }

    let mapsLink = '';
    let locText = 'Location unavailable';
    if (location && location.lat && location.lng) {
      mapsLink = `https://maps.google.com/?q=${location.lat},${location.lng}`;
      locText = `Lat: ${location.lat}, Lng: ${location.lng}`;
    }

    const subject = 'EMERGENCY SOS - VisionBridge Alert';
    const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:3px solid #e74c3c;border-radius:12px;"><h1 style="color:#e74c3c;text-align:center;">\u{1F6A8} EMERGENCY SOS</h1><p style="font-size:18px;">A VisionBridge user needs immediate help.</p><hr style="border:1px solid #eee;"><p><strong>Reason:</strong> ${reason || 'Manual SOS'}</p><p><strong>Location:</strong> ${locText}</p>${mapsLink ? `<p><a href="${mapsLink}" style="display:inline-block;padding:12px 24px;background:#e74c3c;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">\u{1F4CD} Open in Google Maps</a></p>` : ''}<p><strong>Time:</strong> ${new Date().toLocaleString()}</p><hr style="border:1px solid #eee;"><p style="color:#888;font-size:12px;">Automated alert from VisionBridge.</p></div>`;
    const textBody = `EMERGENCY SOS\nReason: ${reason || 'Manual SOS'}\nLocation: ${locText}\n${mapsLink ? 'Maps: ' + mapsLink : ''}\nTime: ${new Date().toLocaleString()}`;

    const transporter = getTransporter();
    if (!transporter) {
      return res.json({ success: false, error: 'Email not configured. Set SOS_EMAIL_USER and SOS_EMAIL_PASS in Render.', notConfigured: true });
    }

    await transporter.sendMail({
      from: `"VisionBridge SOS" <${process.env.SOS_EMAIL_USER}>`,
      to: contact,
      subject,
      text: textBody,
      html: htmlBody,
      priority: 'high'
    });

    console.log(`[SOS] Emergency email sent to ${contact}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[SOS] Failed:', err.message);
    res.json({ success: false, error: err.message });
  }
});
