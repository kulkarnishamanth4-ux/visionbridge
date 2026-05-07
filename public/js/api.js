/**
 * api.js — Server communication module for VisionGuard
 * Includes client-side retry with delay for transient failures.
 * Supports mode parameter and measure endpoint.
 */
const ApiModule = (() => {
  const BASE = '';
  const CLIENT_RETRY_DELAY_MS = 2000;

  async function checkStatus() {
    try {
      const res = await fetch(`${BASE}/api/status`);
      return await res.json();
    } catch (err) {
      return { status: 'error', apiKeyConfigured: false, message: 'Cannot reach server.' };
    }
  }

  async function analyzeScene(base64Image, mode = 'detailed') {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Image, mode })
        });
        const data = await res.json();
        if (attempt === 1 && res.status === 500) {
          console.warn('[API] Server error on attempt 1, retrying...');
          await new Promise(r => setTimeout(r, CLIENT_RETRY_DELAY_MS));
          continue;
        }
        return data;
      } catch (err) {
        if (attempt === 1) {
          console.warn('[API] Network error on attempt 1, retrying...');
          await new Promise(r => setTimeout(r, CLIENT_RETRY_DELAY_MS));
          continue;
        }
        return {
          description: 'I could not reach the server. Please check your connection.',
          dangers: [],
          summary: 'Connection error — please check your internet.'
        };
      }
    }
  }

  // Measure endpoint — sends one or two frames for size/speed estimation
  async function measureScene(image1, image2 = null) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const body = { image1 };
        if (image2) body.image2 = image2;
        const res = await fetch(`${BASE}/api/measure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (attempt === 1 && res.status === 500) {
          await new Promise(r => setTimeout(r, CLIENT_RETRY_DELAY_MS));
          continue;
        }
        return data;
      } catch (err) {
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, CLIENT_RETRY_DELAY_MS));
          continue;
        }
        return { objects: [], summary: 'Could not reach the server.' };
      }
    }
  }

  async function askQuestion(base64Image, question) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Image, question })
        });
        const data = await res.json();
        if (attempt === 1 && res.status === 500) {
          await new Promise(r => setTimeout(r, CLIENT_RETRY_DELAY_MS));
          continue;
        }
        return data;
      } catch (err) {
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, CLIENT_RETRY_DELAY_MS));
          continue;
        }
        return { answer: 'I could not reach the server. Please check your connection.' };
      }
    }
  }

  return { checkStatus, analyzeScene, measureScene, askQuestion };
})();
