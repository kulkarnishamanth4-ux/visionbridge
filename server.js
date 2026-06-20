require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const os = require('os');
const nodemailer = require('nodemailer');\nconst twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;
const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

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
  if (!genAI && process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    console.log('[Gemini] Client initialized with key ending in:', process.env.GEMINI_API_KEY.slice(-6));
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
  const BASE_DELAY_MS = 600;
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
  try { return JSON.parse(cleaned); } catch { }

  // Find first { ... } block (greedy)
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { }
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
const DETAILED_INSTRUCTION = `You are VisionBridge, an AI assistant helping a blind person navigate safely in India. Your descriptions are their EYES — be thorough, spatial, and safety-focused.

RESPONSE FORMAT — You MUST respond with valid JSON only, no markdown, no extra text:
{
  "description": "A rich, spatial description using clock positions, distances, and navigation guidance",
  "dangers": [
    {
      "type": "vehicle|obstacle|stairs|edge|crowd|animal|pothole|drain|other",
      "severity": "critical|warning|info",
      "description": "Brief urgent description with distance and direction",
      "direction": "left|right|ahead|behind|above|below"
    }
  ],
  "summary": "One sentence: the MOST important thing the user should know or do RIGHT NOW"
}

DESCRIPTION RULES (follow ALL of these):
1. START with the environment: indoor/outdoor, lighting, weather, ground surface type
2. Use CLOCK DIRECTIONS: "at your 2 o'clock", "at your 10 o'clock" — never vague "to the side"
3. ESTIMATE DISTANCES for every object: "about 3 meters ahead", "roughly 5 feet to your left"
4. Describe the WALKABLE PATH: where can the user safely walk? Is the path clear?
5. Note GROUND CONDITIONS: wet, uneven, gravel, broken tiles, mud, slope, speed bumps
6. Mention OBSTACLES with dimensions: "a parked car about 4 meters long blocking the right side"
7. Describe PEOPLE: how many, where, which direction they're moving
8. Note LANDMARKS: doors, signs, shops, pillars, trees, benches — things that help orientation
9. For ROADS: mention lane count, traffic density, direction of traffic flow, any crosswalks or signals
10. Always end with NAVIGATION ADVICE: "The clearest path is straight ahead" or "Move left to avoid the obstacle"

INDIAN ROAD AWARENESS (critical for safety):
- Stray dogs and cows — very common, may be sleeping on the path or moving unpredictably
- Potholes, broken footpaths, missing manhole covers — extremely common and dangerous
- Auto-rickshaws, bikes, scooters driving on footpaths — frequent hazard
- Open storm drains and gutters — sometimes uncovered, severe fall risk
- Speed breakers — raised bumps that can trip
- Vendors, carts, parked vehicles on footpaths — force pedestrians onto the road
- Loose wires, low-hanging cables — head-height hazards
- Construction debris, sand piles, rubble — common obstructions

DANGER PRIORITY (always detect these):
- Moving vehicles approaching the user — CRITICAL
- Open drains, missing manholes, deep potholes — CRITICAL
- Stairs, steps, curbs, elevation changes — CRITICAL
- Animals in the path (especially cows blocking the way) — WARNING
- Wet or slippery surfaces — WARNING
- Obstacles in walking path — WARNING
- Overhead hazards (branches, wires) — WARNING

If there is ANY danger, the summary MUST be about that danger and what the user should do.`;

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
const MEASURE_INSTRUCTION = `You are VisionBridge in MEASURE MODE. Estimate the SIZE, DISTANCE, and MOVEMENT of all visible objects. Be as accurate as possible — a blind person depends on these measurements for safety.

RESPONSE FORMAT — valid JSON only:
{
  "objects": [
    {
      "name": "object name (be specific: sedan, auto-rickshaw, stray dog, pothole, etc.)",
      "size": "estimated dimensions: height × width × depth in meters",
      "distance": "estimated distance from the user in meters",
      "moving": true or false,
      "speed": "estimated speed if moving with km/h, or 'stationary'",
      "direction": "left|right|ahead|away|toward|stationary"
    }
  ],
  "summary": "Spoken summary: nearest object first, then others by distance. Include navigation advice."
}

SIZE REFERENCE (use these for calibration):
- Adult person: ~1.7m tall, ~0.5m wide
- Standard door: ~2.1m tall, ~0.9m wide
- Car (sedan): ~4.5m long, ~1.8m wide, ~1.5m tall
- Auto-rickshaw: ~2.6m long, ~1.3m wide, ~1.7m tall
- Motorcycle/Scooter: ~2m long, ~0.7m wide, ~1.1m tall
- Bicycle: ~1.8m long, ~0.6m wide, ~1m tall
- Bus: ~10-12m long, ~2.5m wide, ~3m tall
- Cow: ~2.5m long, ~1.5m wide, ~1.5m tall
- Dog: ~0.6m long, ~0.3m wide, ~0.5m tall
- Pothole: typically 0.3-1m wide, 5-30cm deep
- Speed breaker: ~3m wide, ~10cm tall
- Footpath height: typically 15-20cm above road

DISTANCE ESTIMATION RULES:
- Use perspective: objects at eye level that appear small are far away
- Objects occupying >50% of frame width are within 2 meters
- Objects occupying ~25% are roughly 4-5 meters away
- Objects occupying ~10% are roughly 8-10 meters away
- Always round to nearest 0.5m for close objects, nearest 1m for far objects

SPEED ESTIMATION:
- Stationary: 0 km/h
- Slow walk: 3-5 km/h
- Normal walk: 5-7 km/h
- Running/cycling: 10-20 km/h
- Scooter/auto in traffic: 20-40 km/h
- Car: 30-60 km/h

IMPORTANT: Sort objects by distance (nearest first). The summary should tell the user about the closest object first and whether the path ahead is clear.`;

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

const QA_SYSTEM_INSTRUCTION = `You are Vision, the AI assistant inside VisionBridge — a device helping a blind person navigate the world. The user is asking a specific question about what they see through their camera.

RULES:
1. Answer the SPECIFIC question directly — don't give a generic scene description unless asked.
2. Use CLOCK DIRECTIONS and DISTANCES: "at your 2 o'clock, about 3 meters away" — never vague.
3. For obstacles: always give SIZE + POSITION + HOW TO NAVIGATE AROUND IT.
4. For text/signs: read the text EXACTLY as written, then explain what it means.
5. For people: describe count, approximate distance, and movement direction.
6. For navigation ("which way", "how to get to"): give step-by-step walking directions.
7. For identification ("what is this", "what color"): be specific — say "a red Toyota sedan" not just "a car".
8. Keep responses 2-4 sentences. Spoken aloud, so be natural and conversational.
9. If you genuinely cannot answer from the image, say so honestly, and describe what you CAN see.
10. Be warm, confident, and reassuring — you are their trusted guide.

INDIAN CONTEXT:
- Recognize Indian vehicles: auto-rickshaws, Tata/Maruti cars, Activa scooters, BEST/BMTC/DTC buses
- Recognize Indian signs: Hindi/regional language text, road signs, shop boards
- Understand Indian road layouts: mixed traffic, no strict lanes, shared pedestrian-vehicle spaces
- Know Indian objects: chai stalls, temple/mosque features, rangoli, sarees, dhotis`;

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
  const rawKey = process.env.GEMINI_API_KEY;
  res.json({
    status: 'ok',
    apiKeyConfigured: !!client,
    keyPresent: !!rawKey,
    keyLength: rawKey ? rawKey.length : 0,
    keyPreview: rawKey ? rawKey.slice(0, 4) + '...' + rawKey.slice(-4) : 'NOT SET',
    sosEmailConfigured: !!(process.env.SOS_EMAIL_USER && process.env.SOS_EMAIL_PASS),
    message: client
      ? 'VisionBridge is ready.'
      : rawKey
        ? 'API key found but client failed to initialize. Key may be invalid.'
        : 'GEMINI_API_KEY environment variable is not set. Add it in Render > Environment.'
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

    const { image, mode = 'detailed', lang = 'en' } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const systemInstruction = MODE_INSTRUCTIONS[mode] || DETAILED_INSTRUCTION;

    // Language names for prompt injection
    const langNames = {
      hi: 'Hindi', kn: 'Kannada', ta: 'Tamil', te: 'Telugu',
      mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', ml: 'Malayalam',
      pa: 'Punjabi', ur: 'Urdu', es: 'Spanish', fr: 'French',
      de: 'German', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
      ar: 'Arabic', pt: 'Portuguese', ru: 'Russian', it: 'Italian'
    };
    const langSuffix = (lang && lang !== 'en' && langNames[lang])
      ? ` IMPORTANT: Write ALL text values (description, summary, danger descriptions) in ${langNames[lang]} language. The JSON keys must stay in English but all text content must be in ${langNames[lang]}.`
      : '';

    const promptTexts = {
      detailed: 'Analyze this scene for a blind person. Describe the surroundings in detail and identify any immediate dangers. Respond in the required JSON format.' + langSuffix,
      danger: 'DANGER SCAN: Only report close-range, immediate dangers. If none, say the path is clear. Respond in JSON.' + langSuffix,
      summary: 'Summarize this entire scene in ONE sentence. Respond in JSON.' + langSuffix,
      measure: 'Estimate the size, distance, and movement speed of all visible objects. Respond in JSON.' + langSuffix
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
        maxOutputTokens: mode === 'summary' ? 256 : mode === 'danger' ? 512 : 1024
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
      config: { systemInstruction: instruction, temperature: 0.2, maxOutputTokens: 800 }
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
        temperature: 0.3,
        maxOutputTokens: 400
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

// =============================================
//   AI ASSISTANT ENDPOINT
//   Conversational assistant with India-aware navigation guidance.
//   Accepts optional image + conversation history for context.
// =============================================

const ASSISTANT_SYSTEM_PROMPT = `You are "Vision", a personal AI assistant built into VisionBridge — a wearable device for blind and visually impaired people in India.

CORE RULES:
1. Speak naturally and conversationally, like a helpful friend walking beside the user.
2. Keep responses SHORT (2-4 sentences max) unless the user asks for detail.
3. Use clock directions for spatial guidance: "at your 2 o'clock", "slightly to your left".
4. Always give ACTIONABLE guidance — tell the user what to DO, not just what you see.
5. When you see an obstacle, ALWAYS tell: what it is, approximate size, exact position, and how to navigate around it.
6. You understand Indian roads and hazards deeply.

NAVIGATION GUIDANCE (CRITICAL):
When describing obstacles, ALWAYS provide:
- WHAT: Name of the object (car, pothole, cow, auto-rickshaw, etc.)
- SIZE: Approximate dimensions (e.g., "about 4 meters long, 1.5 meters wide")  
- POSITION: Exact location relative to user (e.g., "directly ahead, about 3 meters away, slightly to your right")
- NAVIGATION: Clear instructions to get around it (e.g., "Take 2 steps to your left, then continue straight")

INDIAN ROAD HAZARDS (be especially alert for these):
- Stray dogs, cows, goats, monkeys — common on Indian roads. Warn about animals that might be resting on the path or moving unpredictably.
- Potholes and uneven surfaces — extremely common. Warn about any visible road damage or level changes.
- Auto-rickshaws, bikes, two-wheelers — often drive close to pedestrians and on footpaths.
- Open drains and manholes — sometimes uncovered. CRITICAL danger.
- Speed breakers — sudden raised bumps that could cause tripping.
- Parked vehicles on footpaths — force pedestrians onto the road.
- Construction debris, rubble, sand piles — common obstructions.
- Hawkers and street vendors — may narrow the walkable path.
- Loose cables or wires — hanging at head height from poles.
- Wet or muddy surfaces — slippery after rain.

OBSTACLE DIMENSIONS REFERENCE:
- Car: ~4m long × 1.8m wide × 1.5m tall
- Auto-rickshaw: ~2.6m long × 1.3m wide × 1.7m tall  
- Motorcycle/Scooter: ~2m long × 0.7m wide × 1.1m tall
- Bicycle: ~1.8m long × 0.6m wide × 1m tall
- Bus: ~10-12m long × 2.5m wide × 3m tall
- Truck: ~8-10m long × 2.5m wide × 3.5m tall
- Cow: ~2.5m long × 1.5m wide × 1.5m tall, may move unpredictably
- Dog: ~0.6m long × 0.3m wide, may be aggressive or sleeping on path
- Pothole: varies, typically 0.3-1m wide, 5-30cm deep

GENERAL ASSISTANT:
- Answer general knowledge questions concisely.
- For follow-up questions, use the conversation history for context.
- If asked about something you described earlier, reference it.
- Be warm, reassuring, and confident in your guidance.
- If you cannot see clearly, say so honestly and suggest what the user should do.`;

app.post('/api/assistant', async (req, res) => {
  try {
    const client = getGenAI();
    if (!client) {
      return res.status(503).json({
        answer: 'I need an internet connection to answer that question right now.'
      });
    }

    const { question, image, history } = req.body;
    if (!question) {
      return res.status(400).json({ error: 'Question is required.' });
    }

    // Build conversation parts
    const parts = [];

    // Add image if provided (for scene questions)
    if (image) {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Data
        }
      });
    }

    // Build content with history for context
    const contents = [];

    // Add conversation history (last few exchanges)
    if (history && Array.isArray(history)) {
      for (const h of history.slice(-8)) {
        contents.push({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content }]
        });
      }
    }

    // Current question with optional image
    const currentParts = [...parts, { text: question }];
    contents.push({ role: 'user', parts: currentParts });

    const requestConfig = {
      contents,
      config: {
        systemInstruction: ASSISTANT_SYSTEM_PROMPT,
        temperature: 0.5,
        maxOutputTokens: 300
      }
    };

    const response = await callWithFallback(client, requestConfig);
    const answer = response.text.trim();

    res.json({ answer });
  } catch (err) {
    console.error('[Assistant] Error:', err.message);
    res.status(200).json({
      answer: 'I\'m having trouble thinking right now. Please try again in a moment.'
    });
  }
});

// (Old duplicate translate endpoint removed — the fast one is at line ~567)

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

  if (process.env.NUMVERIFY_API_KEY) {
    console.log('[OK] Numverify API configured — phone number validation enabled.');
  } else {
    console.log('[!] NUMVERIFY_API_KEY not set — phone validation will use regex only.');
  }

  if (process.env.MAILBOXLAYER_API_KEY) {
    console.log('[OK] Mailboxlayer API configured — email validation enabled.');
  } else {
    console.log('[!] MAILBOXLAYER_API_KEY not set — email validation will use regex only.');
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
  if (!user || !pass) {
    console.warn('[SMTP] SOS_EMAIL_USER or SOS_EMAIL_PASS not set!');
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

// =============================================
//   EMAIL DIAGNOSTIC ENDPOINT
// =============================================
app.get('/api/test-email', async (req, res) => {
  const user = process.env.SOS_EMAIL_USER;
  const pass = process.env.SOS_EMAIL_PASS;
  if (!user || !pass) {
    return res.json({
      success: false,
      error: 'SOS_EMAIL_USER or SOS_EMAIL_PASS environment variable is not set.',
      SOS_EMAIL_USER_set: !!user,
      SOS_EMAIL_PASS_set: !!pass
    });
  }
  try {
    const transporter = getTransporter();
    await transporter.verify();
    return res.json({
      success: true,
      message: 'SMTP connection verified! Email sending will work.',
      email: user
    });
  } catch (err) {
    return res.json({
      success: false,
      error: 'SMTP connection failed: ' + err.message,
      hint: 'Make sure you are using a Gmail App Password (not your regular password). Get one at https://myaccount.google.com/apppasswords'
    });
  }
});

// =============================================
//   CONTACT VALIDATION (Numverify + Mailboxlayer)
// =============================================

/**
 * Validate a phone number using Numverify API.
 * Returns { valid, international_format, carrier, line_type, country_name }
 */
async function validatePhoneNumverify(phone) {
  const apiKey = process.env.NUMVERIFY_API_KEY;
  if (!apiKey) return { valid: true, skipped: true, reason: 'NUMVERIFY_API_KEY not set, skipping validation.' };

  try {
    const cleanNumber = phone.replace(/[\s\-\(\)]/g, '');
    const url = `http://apilayer.net/api/validate?access_key=${apiKey}&number=${encodeURIComponent(cleanNumber)}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.error) {
      console.warn('[Numverify] API error:', data.error.info);
      return { valid: true, skipped: true, reason: data.error.info };
    }

    console.log(`[Numverify] ${cleanNumber} → valid=${data.valid}, type=${data.line_type}, carrier=${data.carrier}`);
    return {
      valid: data.valid === true,
      international_format: data.international_format || cleanNumber,
      carrier: data.carrier || 'Unknown',
      line_type: data.line_type || 'unknown',
      country_name: data.country_name || 'Unknown',
      location: data.location || ''
    };
  } catch (err) {
    console.warn('[Numverify] Fetch failed:', err.message);
    return { valid: true, skipped: true, reason: 'Validation service unavailable.' };
  }
}

/**
 * Validate an email using Mailboxlayer API.
 * Returns { format_valid, mx_found, smtp_check, disposable, did_you_mean, score }
 */
async function validateEmailMailboxlayer(email) {
  const apiKey = process.env.MAILBOXLAYER_API_KEY;
  if (!apiKey) return { format_valid: true, skipped: true, reason: 'MAILBOXLAYER_API_KEY not set, skipping validation.' };

  try {
    const url = `http://apilayer.net/api/check?access_key=${apiKey}&email=${encodeURIComponent(email)}&smtp=1&format=1`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.error) {
      console.warn('[Mailboxlayer] API error:', data.error.info);
      return { format_valid: true, skipped: true, reason: data.error.info };
    }

    console.log(`[Mailboxlayer] ${email} → format=${data.format_valid}, mx=${data.mx_found}, smtp=${data.smtp_check}, disposable=${data.disposable}, score=${data.score}`);
    return {
      format_valid: data.format_valid === true,
      mx_found: data.mx_found === true,
      smtp_check: data.smtp_check === true,
      disposable: data.disposable === true,
      did_you_mean: data.did_you_mean || '',
      score: data.score || 0,
      free: data.free === true
    };
  } catch (err) {
    console.warn('[Mailboxlayer] Fetch failed:', err.message);
    return { format_valid: true, skipped: true, reason: 'Validation service unavailable.' };
  }
}

// =============================================
//   VALIDATE CONTACT ENDPOINT
// =============================================
app.post('/api/validate-contact', async (req, res) => {
  try {
    const { contact, type } = req.body;
    if (!contact || !type) {
      return res.json({ valid: false, error: 'Contact and type are required.' });
    }

    if (type === 'email') {
      // Basic regex check first
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        return res.json({ valid: false, error: 'Invalid email format. Use: abc@email.com' });
      }

      const result = await validateEmailMailboxlayer(contact);

      if (result.skipped) {
        // API not configured — fall back to regex-only validation
        return res.json({ valid: true, message: 'Email format is valid.', skipped: true });
      }

      if (!result.format_valid) {
        return res.json({ valid: false, error: 'This email address has invalid formatting.' });
      }
      if (result.disposable) {
        return res.json({ valid: false, error: 'Disposable/temporary emails are not allowed for emergency contacts. Please use a permanent email.' });
      }
      if (!result.mx_found) {
        const suggestion = result.did_you_mean ? ` Did you mean: ${result.did_you_mean}?` : '';
        return res.json({ valid: false, error: `The domain "${contact.split('@')[1]}" does not appear to have a mail server.${suggestion}` });
      }
      if (result.did_you_mean) {
        return res.json({ valid: true, message: `Email is valid.`, suggestion: result.did_you_mean, score: result.score });
      }
      if (result.score < 0.4) {
        return res.json({ valid: false, error: 'This email address appears to be invalid or unreachable. Please double-check and try again.' });
      }

      return res.json({
        valid: true,
        message: `Email verified: ${contact}`,
        score: result.score,
        free: result.free
      });
    }

    if (type === 'phone') {
      // Basic regex check first
      const cleanPhone = contact.replace(/[\s\-]/g, '');
      if (!/^\+\d{10,15}$/.test(cleanPhone)) {
        return res.json({ valid: false, error: 'Invalid phone format. Use international format: +919999988888' });
      }

      const result = await validatePhoneNumverify(cleanPhone);

      if (result.skipped) {
        return res.json({ valid: true, message: 'Phone format is valid.', skipped: true });
      }

      if (!result.valid) {
        return res.json({ valid: false, error: `This phone number is not valid. Please check the country code and number.` });
      }
      if (result.line_type === 'landline') {
        return res.json({ valid: false, error: `This appears to be a landline number (${result.carrier}). Please use a mobile number for emergency contact.` });
      }

      return res.json({
        valid: true,
        message: `Phone verified: ${result.international_format || cleanPhone}`,
        carrier: result.carrier,
        line_type: result.line_type,
        country: result.country_name,
        formatted: result.international_format || cleanPhone
      });
    }

    res.json({ valid: false, error: 'Unknown contact type.' });
  } catch (err) {
    console.error('[Validate] Error:', err.message);
    res.json({ valid: true, skipped: true, error: 'Validation service error, proceeding anyway.' });
  }
});

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
//   MULTI-CHANNEL SOS EMERGENCY SYSTEM
//   Channels: Email + Twilio Voice Call + SMS
//   Each channel fires independently — partial
//   failures don't block other channels.
// =============================================

// Twilio client (initialized only if configured)
let twilioClient = null;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE_NUMBER;
if (TWILIO_SID && TWILIO_AUTH && TWILIO_FROM) {
  twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);
  console.log('[SOS] Twilio configured — voice call + SMS enabled');
} else {
  console.log('[SOS] Twilio not configured — email-only mode (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to enable)');
}

// Store last SOS data for the TwiML voice endpoint
let lastSOSData = { reason: '', location: '', mapsLink: '', time: '' };

// TwiML voice endpoint — Twilio fetches this when the call connects
app.post('/api/sos-voice', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  // Pause briefly, then deliver the emergency message clearly
  twiml.pause({ length: 1 });
  twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' },
    'Emergency alert from Vision Bridge. ' +
    (lastSOSData.reason || 'A user has triggered an SOS.') + '. ' +
    (lastSOSData.location || 'Location is not available.') + '. ' +
    'Time of alert: ' + (lastSOSData.time || 'unknown') + '. ' +
    'Please respond immediately. This is an automated emergency call.'
  );
  // Repeat the message once for clarity
  twiml.pause({ length: 2 });
  twiml.say({ voice: 'Polly.Aditi', language: 'en-IN' },
    'Repeating: Emergency alert. ' +
    (lastSOSData.location || '') + '. ' +
    'Please check your SMS or email for the Google Maps location link.'
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// Main SOS endpoint — fires all configured channels simultaneously
app.post('/api/sos', async (req, res) => {
  try {
    const { contact, reason, location, contactType } = req.body;
    if (!contact) {
      return res.json({ success: false, error: 'No emergency contact provided.' });
    }

    // Build location data
    let mapsLink = '';
    let locText = 'Location unavailable';
    if (location && location.lat && location.lng) {
      mapsLink = `https://maps.google.com/?q=${location.lat},${location.lng}`;
      locText = `Lat: ${location.lat}, Lng: ${location.lng}`;
    }
    const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Store for TwiML endpoint
    lastSOSData = { reason: reason || 'Manual SOS', location: locText, mapsLink, time: timeStr };

    // Track results for each channel
    const results = { email: null, call: null, sms: null };

    // --- CHANNEL 1: EMAIL (always attempted if transporter exists) ---
    const emailPromise = (async () => {
      const isEmail = contactType === 'email' || contact.includes('@');
      if (!isEmail) return null;

      const transporter = getTransporter();
      if (!transporter) return { success: false, error: 'Email not configured' };

      const subject = '🚨 EMERGENCY SOS - VisionBridge Alert';
      const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:3px solid #e74c3c;border-radius:12px;">
        <h1 style="color:#e74c3c;text-align:center;">🚨 EMERGENCY SOS</h1>
        <p style="font-size:18px;">A VisionBridge user needs immediate help.</p>
        <hr style="border:1px solid #eee;">
        <p><strong>Reason:</strong> ${reason || 'Manual SOS'}</p>
        <p><strong>Location:</strong> ${locText}</p>
        ${mapsLink ? `<p><a href="${mapsLink}" style="display:inline-block;padding:12px 24px;background:#e74c3c;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">📍 Open in Google Maps</a></p>` : ''}
        <p><strong>Time:</strong> ${timeStr}</p>
        <hr style="border:1px solid #eee;">
        <p style="color:#888;font-size:12px;">Automated alert from VisionBridge Emergency System.</p>
      </div>`;
      const textBody = `EMERGENCY SOS\nReason: ${reason || 'Manual SOS'}\nLocation: ${locText}\n${mapsLink ? 'Maps: ' + mapsLink : ''}\nTime: ${timeStr}`;

      try {
        await transporter.sendMail({
          from: `"VisionBridge SOS" <${process.env.SOS_EMAIL_USER}>`,
          to: contact,
          subject,
          text: textBody,
          html: htmlBody,
          priority: 'high'
        });
        console.log(`[SOS] ✅ Email sent to ${contact}`);
        return { success: true };
      } catch (err) {
        console.error(`[SOS] ❌ Email failed:`, err.message);
        return { success: false, error: err.message };
      }
    })();

    // --- CHANNEL 2: TWILIO VOICE CALL (if configured + phone contact) ---
    const callPromise = (async () => {
      const isPhone = contactType === 'phone' || /^\+?\d{10,15}$/.test(contact.replace(/[\s-]/g, ''));
      if (!isPhone || !twilioClient) return null;

      const phoneNumber = contact.replace(/[\s-]/g, '');
      const toNumber = phoneNumber.startsWith('+') ? phoneNumber : '+91' + phoneNumber;

      // Build the TwiML URL — use the server's own URL
      const protocol = req.get('x-forwarded-proto') || req.protocol;
      const host = req.get('host');
      const twimlUrl = `${protocol}://${host}/api/sos-voice`;

      try {
        const call = await twilioClient.calls.create({
          url: twimlUrl,
          to: toNumber,
          from: TWILIO_FROM,
          timeout: 30
        });
        console.log(`[SOS] ✅ Voice call initiated to ${toNumber} (SID: ${call.sid})`);
        return { success: true, callSid: call.sid };
      } catch (err) {
        console.error(`[SOS] ❌ Voice call failed:`, err.message);
        return { success: false, error: err.message };
      }
    })();

    // --- CHANNEL 3: TWILIO SMS (if configured + phone contact) ---
    const smsPromise = (async () => {
      const isPhone = contactType === 'phone' || /^\+?\d{10,15}$/.test(contact.replace(/[\s-]/g, ''));
      if (!isPhone || !twilioClient) return null;

      const phoneNumber = contact.replace(/[\s-]/g, '');
      const toNumber = phoneNumber.startsWith('+') ? phoneNumber : '+91' + phoneNumber;

      const smsBody = `🚨 VISIONBRIDGE SOS 🚨\n` +
        `Reason: ${reason || 'Emergency'}\n` +
        `Location: ${locText}\n` +
        `${mapsLink ? '📍 Maps: ' + mapsLink : ''}\n` +
        `Time: ${timeStr}\n` +
        `Reply or call back immediately.`;

      try {
        const msg = await twilioClient.messages.create({
          body: smsBody,
          to: toNumber,
          from: TWILIO_FROM
        });
        console.log(`[SOS] ✅ SMS sent to ${toNumber} (SID: ${msg.sid})`);
        return { success: true, msgSid: msg.sid };
      } catch (err) {
        console.error(`[SOS] ❌ SMS failed:`, err.message);
        return { success: false, error: err.message };
      }
    })();

    // Wait for all channels simultaneously (don't let one block others)
    const [emailResult, callResult, smsResult] = await Promise.allSettled([
      emailPromise, callPromise, smsPromise
    ]);

    results.email = emailResult.status === 'fulfilled' ? emailResult.value : { success: false, error: 'Promise rejected' };
    results.call = callResult.status === 'fulfilled' ? callResult.value : { success: false, error: 'Promise rejected' };
    results.sms = smsResult.status === 'fulfilled' ? smsResult.value : { success: false, error: 'Promise rejected' };

    // At least one channel must succeed
    const anySuccess = [results.email, results.call, results.sms].some(r => r && r.success);
    const channelsSent = [
      results.email?.success ? 'Email' : null,
      results.call?.success ? 'Voice Call' : null,
      results.sms?.success ? 'SMS' : null
    ].filter(Boolean);

    console.log(`[SOS] Channels fired: ${channelsSent.join(', ') || 'none'}`);

    res.json({
      success: anySuccess,
      channels: results,
      summary: channelsSent.length > 0
        ? `SOS sent via: ${channelsSent.join(' + ')}`
        : 'All channels failed. Check configuration.',
      error: anySuccess ? null : 'All SOS channels failed.'
    });
  } catch (err) {
    console.error('[SOS] Critical error:', err.message);
    res.json({ success: false, error: err.message });
  }
});
