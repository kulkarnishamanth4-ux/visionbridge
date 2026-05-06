require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];  // Fallback chain

// --- Middleware ---
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

// System instruction for scene analysis
const SCENE_SYSTEM_INSTRUCTION = `You are VisionGuard, an AI assistant helping a blind person understand their surroundings through a camera feed. Your role is critically important for their safety and independence.

RESPONSE FORMAT — You MUST respond with valid JSON only, no markdown, no extra text:
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

DANGER DETECTION — HIGHEST PRIORITY:
- Moving vehicles (cars, bikes, scooters) — always critical
- Stairs, steps, curbs, or elevation changes — critical
- Wet or slippery surfaces — warning
- Obstacles in the walking path (poles, signs, chairs) — warning
- Construction zones or uneven ground — warning
- Crowds or fast-moving people — info
- Low-hanging branches or overhead hazards — warning
- Open edges, drops, or water — critical

Always prioritize dangers in your response. If there is immediate danger, the summary should be about that danger.`;

const QA_SYSTEM_INSTRUCTION = `You are VisionGuard, an AI assistant helping a blind person understand their surroundings. The user is asking you a specific question about what they are seeing through their camera.

Answer their question directly, clearly, and concisely. Use spatial references (left, right, ahead, behind) and distance estimates. Keep your response conversational and natural — it will be read aloud via text-to-speech.

If you cannot determine the answer from the image, say so honestly and describe what you can see instead. Be warm and helpful.

Keep responses under 3 sentences unless more detail is specifically asked for.`;


// --- API Routes ---

// Health check + API key status
app.get('/api/status', (req, res) => {
  const client = getGenAI();
  res.json({
    status: 'ok',
    apiKeyConfigured: !!client,
    message: client
      ? 'VisionGuard is ready.'
      : 'API key not configured. Please add GEMINI_API_KEY to your .env file.'
  });
});

// Analyze scene from camera frame
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

    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Strip the data URL prefix if present
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
            { text: 'Analyze this scene for a blind person. Describe the surroundings in detail and identify any immediate dangers. Respond in the required JSON format.' }
          ]
        }
      ],
      config: {
        systemInstruction: SCENE_SYSTEM_INSTRUCTION,
        temperature: 0.3,
        maxOutputTokens: 1024
      }
    };

    // Try models with fallback
    let response;
    for (const model of MODELS) {
      try {
        response = await client.models.generateContent({ model, ...requestConfig });
        break;
      } catch (modelErr) {
        console.warn(`Model ${model} failed:`, modelErr.message);
        if (model === MODELS[MODELS.length - 1]) throw modelErr;
      }
    }

    const text = response.text.trim();

    // Parse JSON from response (handle potential markdown wrapping)
    let parsed;
    try {
      const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = {
        description: text,
        dangers: [],
        summary: text.substring(0, 100)
      };
    }

    res.json(parsed);
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({
      error: err.message,
      description: 'I had trouble analyzing the scene. Let me try again.',
      dangers: [],
      summary: 'Analysis temporarily unavailable.'
    });
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
        temperature: 0.5,
        maxOutputTokens: 512
      }
    };

    // Try models with fallback
    let response;
    for (const model of MODELS) {
      try {
        response = await client.models.generateContent({ model, ...requestConfig });
        break;
      } catch (modelErr) {
        console.warn(`Model ${model} failed:`, modelErr.message);
        if (model === MODELS[MODELS.length - 1]) throw modelErr;
      }
    }

    res.json({ answer: response.text.trim() });
  } catch (err) {
    console.error('Ask error:', err.message);
    res.status(500).json({
      answer: 'I had trouble processing your question. Please try asking again.'
    });
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

  console.log(`\n🛡️  VisionGuard is running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`   Network: http://${ip.address}:${PORT}  (${ip.name})`));

  if (client) {
    console.log('\n✅ Gemini API key configured and ready.');
  } else {
    console.log('\n⚠️  No API key found. Copy .env.example to .env and add your key.');
    console.log('   Get a free key at: https://aistudio.google.com/');
  }

  console.log('\n📱 To access from your phone or any device, run this in a NEW terminal:');
  console.log('   npx ngrok http 3000');
  console.log('   Then open the https://xxxx.ngrok-free.app URL on any device.\n');
});
