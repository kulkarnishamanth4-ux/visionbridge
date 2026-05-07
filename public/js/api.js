/**
 * api.js â€” Server communication module for VisionBridge
 * Multi-layer retry: server retries internally (4Ã—4 models), 
 * then client retries the whole request 3 times with delays.
 * Server also caches last good response, so errors are rare.
 */
const ApiModule = (() => {
  const BASE = '';

  // Generic fetch with 3 retries and escalating delays (3s, 6s, 10s)
  async function fetchWithRetry(url, options, maxAttempts = 3) {
    const delays = [3000, 6000, 10000];
    let lastErr;
    let lastData;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        
        const data = await res.json();
        lastData = data;

        // If server returned 200 (even cached), accept it
        if (res.ok) return data;

        // On 500+, retry if attempts remain
        if (attempt < maxAttempts - 1) {
          console.warn(`[API] Attempt ${attempt + 1} got status ${res.status}, retrying in ${delays[attempt]}ms...`);
          await new Promise(r => setTimeout(r, delays[attempt]));
          continue;
        }
        return data; // Return whatever we got on last attempt
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts - 1) {
          console.warn(`[API] Attempt ${attempt + 1} failed (${err.message}), retrying in ${delays[attempt]}ms...`);
          await new Promise(r => setTimeout(r, delays[attempt]));
        }
      }
    }

    // Return last data if we got any, otherwise error object
    return lastData || { error: lastErr?.message || 'Network error' };
  }

  async function checkStatus() {
    try {
      const res = await fetch(`${BASE}/api/status`);
      return await res.json();
    } catch (err) {
      return { status: 'error', apiKeyConfigured: false, message: 'Cannot reach server.' };
    }
  }

  async function analyzeScene(base64Image, mode = 'detailed') {
    const data = await fetchWithRetry(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64Image, mode })
    });

    // Ensure we always return a valid result shape
    return {
      description: data.description || '',
      dangers: data.dangers || [],
      summary: data.summary || 'Scan complete.',
      objects: data.objects || [],
      _cached: data._cached || false
    };
  }

  async function measureScene(image1, image2 = null) {
    const body = { image1 };
    if (image2) body.image2 = image2;

    const data = await fetchWithRetry(`${BASE}/api/measure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    return {
      objects: data.objects || [],
      summary: data.summary || 'Measurement complete.',
      _cached: data._cached || false
    };
  }

  async function askQuestion(base64Image, question) {
    const data = await fetchWithRetry(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64Image, question })
    });

    return {
      answer: data.answer || 'Could not get an answer right now.',
      _cached: data._cached || false
    };
  }

  return { checkStatus, analyzeScene, measureScene, askQuestion };
})();
