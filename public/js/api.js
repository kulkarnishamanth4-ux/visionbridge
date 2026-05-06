/**
 * api.js — Server communication module for VisionGuard
 */
const ApiModule = (() => {
  const BASE = '';

  async function checkStatus() {
    try {
      const res = await fetch(`${BASE}/api/status`);
      return await res.json();
    } catch (err) {
      return { status: 'error', apiKeyConfigured: false, message: 'Cannot reach server.' };
    }
  }

  async function analyzeScene(base64Image) {
    try {
      const res = await fetch(`${BASE}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Image })
      });
      return await res.json();
    } catch (err) {
      return {
        description: 'I could not analyze the scene due to a connection issue.',
        dangers: [],
        summary: 'Connection error — please check your internet.'
      };
    }
  }

  async function askQuestion(base64Image, question) {
    try {
      const res = await fetch(`${BASE}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Image, question })
      });
      return await res.json();
    } catch (err) {
      return { answer: 'I could not process your question due to a connection issue.' };
    }
  }

  return { checkStatus, analyzeScene, askQuestion };
})();
