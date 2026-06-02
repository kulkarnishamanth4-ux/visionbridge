/**
 * speech.js â€” Voice I/O module for VisionBridge
 * Handles wake word detection, speech recognition, and text-to-speech with priority queue.
 */
const SpeechModule = (() => {
  // --- Speech Recognition ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;
  let wakeWord = 'hey vision';
  let onWakeWordCallback = null;
  let onTranscriptCallback = null;
  let awaitingQuestion = false;
  let recognitionSupported = !!SpeechRecognition;

  // --- Speech Synthesis ---
  const synth = window.speechSynthesis;
  let selectedVoice = null;
  let speechRate = 1.0;
  let isSpeaking = false;
  let speechQueue = [];
  let currentUtterance = null;
  let onSpeakStartCallback = null;
  let onSpeakEndCallback = null;
  let audioUnlocked = false;
  let chromeResumeInterval = null;

  // --- Translation ---
  let currentLang = 'en';
  const translateCache = new Map();

  // --- Audio Context for beep alerts ---
  let audioCtx = null;

  // Priority levels: 3 = danger (interrupts all), 2 = description, 1 = info
  const PRIORITY = { DANGER: 3, DESCRIPTION: 2, INFO: 1 };

  /**
   * Unlock audio on first user gesture (required by Chrome/Safari).
   * Call this from a click/tap handler.
   */
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;

    // Create AudioContext for beep sounds
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Speak a silent utterance to unlock TTS in Chrome
    const silent = new SpeechSynthesisUtterance('');
    silent.volume = 0;
    synth.speak(silent);

    console.log('[Speech] Audio unlocked via user gesture');
  }

  /**
   * Play a beep tone for danger alerts (works even if TTS is delayed)
   */
  function playDangerBeep() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Three rapid beeps
    for (let i = 0; i < 3; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 880;
      osc.type = 'square';
      gain.gain.value = 0.3;
      const t = audioCtx.currentTime + i * 0.2;
      osc.start(t);
      osc.stop(t + 0.12);
    }
  }

  function initRecognition() {
    if (!SpeechRecognition) return false;

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (!last.isFinal) return;

      const transcript = last[0].transcript.trim().toLowerCase();
      console.log('[Speech] Heard:', transcript);

      if (awaitingQuestion) {
        // User is answering after wake word
        awaitingQuestion = false;
        if (onTranscriptCallback) {
          onTranscriptCallback(last[0].transcript.trim());
        }
      } else if (matchesWakeWord(transcript)) {
        // Wake word detected
        console.log('[Speech] Wake word detected!');
        awaitingQuestion = true;
        if (onWakeWordCallback) onWakeWordCallback();

        // Auto-reset after 15 seconds if no question received
        setTimeout(() => { awaitingQuestion = false; }, 15000);
      }
    };

    recognition.onerror = (event) => {
      console.warn('[Speech] Recognition error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        recognitionSupported = false;
      }
      // On network or transient errors, let onend handle restart
    };

    recognition.onend = () => {
      // Auto-restart if we should still be listening
      if (isListening && recognitionSupported) {
        setTimeout(() => {
          try { recognition.start(); } catch (e) { /* already started */ }
        }, 300); // Small delay prevents rapid restart loops
      }
    };

    return true;
  }

  // Flexible wake word matching: handles partial recognition and common misheard variants
  function matchesWakeWord(transcript) {
    if (transcript.includes(wakeWord)) return true;
    // Handle common misheard variants
    const words = wakeWord.split(' ');
    if (words.length >= 2) {
      // Match if at least 2 words appear close together
      const allPresent = words.every(w => transcript.includes(w));
      if (allPresent) return true;
    }
    // Fuzzy: "hey vision" can be heard as "a vision", "hey visions", etc.
    const fuzzy = wakeWord.replace(/\s+/g, '').toLowerCase();
    const tClean = transcript.replace(/\s+/g, '').toLowerCase();
    if (tClean.includes(fuzzy)) return true;
    return false;
  }

  function startListening() {
    if (!recognition && !initRecognition()) return false;
    if (isListening) return true;

    try {
      recognition.start();
      isListening = true;
      return true;
    } catch (e) {
      console.error('[Speech] Start error:', e);
      return false;
    }
  }

  function stopListening() {
    isListening = false;
    awaitingQuestion = false;
    if (recognition) {
      try { recognition.stop(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * One-shot listen: creates a temporary recognition session that resolves
   * with the heard transcript after the first final result, or rejects on
   * timeout (default 8s). Used for wake word confirmation during onboarding.
   */
  function listenOnce(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!SpeechRecognition) {
        return reject(new Error('Speech recognition not supported'));
      }

      const tempRec = new SpeechRecognition();
      tempRec.continuous = false;
      tempRec.interimResults = false;
      tempRec.lang = 'en-US';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { tempRec.stop(); } catch (e) { /* ignore */ }
          reject(new Error('timeout'));
        }
      }, timeoutMs);

      tempRec.onresult = (event) => {
        if (settled) return;
        const last = event.results[event.results.length - 1];
        if (!last.isFinal) return;
        settled = true;
        clearTimeout(timer);
        try { tempRec.stop(); } catch (e) { /* ignore */ }
        resolve(last[0].transcript.trim());
      };

      tempRec.onerror = (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(event.error));
      };

      tempRec.onend = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('no-speech'));
        }
      };

      try {
        tempRec.start();
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function triggerQuestionMode() {
    awaitingQuestion = true;
    setTimeout(() => { awaitingQuestion = false; }, 10000);
  }

  // --- Speech Synthesis ---
  function loadVoices() {
    return new Promise(resolve => {
      let voices = synth.getVoices();
      if (voices.length) return resolve(voices);

      synth.onvoiceschanged = () => {
        voices = synth.getVoices();
        resolve(voices);
      };

      // Fallback timeout
      setTimeout(() => resolve(synth.getVoices()), 1000);
    });
  }

  async function initSynthesis() {
    const voices = await loadVoices();

    // Prefer high-quality English voices
    const preferred = voices.filter(v => v.lang.startsWith('en'));
    const premium = preferred.find(v =>
      v.name.includes('Google') || v.name.includes('Natural') ||
      v.name.includes('Enhanced') || v.name.includes('Premium')
    );

    selectedVoice = premium || preferred[0] || voices[0] || null;
    return voices;
  }

  async function speak(text, priority = PRIORITY.DESCRIPTION) {
    if (!synth) return;

    // Danger priority: interrupt everything
    if (priority === PRIORITY.DANGER) {
      synth.cancel();
      speechQueue = speechQueue.filter(q => q.priority >= PRIORITY.DANGER);
      currentUtterance = null;
    }

    // Text is already in the target language (Gemini generates it directly).
    // No separate translation call needed.
    speechQueue.push({ text, priority });
    speechQueue.sort((a, b) => b.priority - a.priority);

    processQueue();
  }

  async function translateText(text, lang) {
    const cacheKey = `${lang}:${text}`;
    if (translateCache.has(cacheKey)) return translateCache.get(cacheKey);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5s max
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang: lang }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data = await res.json();
      const translated = data.translated || text;
      console.log(`[Speech] Translated to ${lang}: "${translated.slice(0, 50)}..."`);
      translateCache.set(cacheKey, translated);
      if (translateCache.size > 200) {
        const first = translateCache.keys().next().value;
        translateCache.delete(first);
      }
      return translated;
    } catch (e) {
      console.warn('[Speech] Translation failed:', e.message || 'timeout');
      return text;
    }
  }

  function processQueue() {
    if (isSpeaking || speechQueue.length === 0) return;

    const item = speechQueue.shift();
    
    // Split text into short sentences — Chrome kills speech after ~15s
    if (item.text.length > 120) {
      const sentences = item.text.match(/[^.!?,;:]+[.!?,;:]+|[^.!?,;:]+$/g) || [item.text];
      // Push sentences back in reverse order so first sentence is processed first
      for (let i = sentences.length - 1; i >= 0; i--) {
        const s = sentences[i].trim();
        if (s) speechQueue.unshift({ text: s, priority: item.priority });
      }
      processQueue();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(item.text);

    if (selectedVoice) utterance.voice = selectedVoice;
    if (currentLang && currentLang !== 'en') {
      utterance.lang = selectedVoice ? selectedVoice.lang : currentLang;
    }
    utterance.rate = speechRate;
    utterance.pitch = item.priority === PRIORITY.DANGER ? 1.2 : 1.0;
    utterance.volume = 1.0;

    // Watchdog: if Chrome silently kills speech, force-reset after timeout
    let watchdog = null;

    utterance.onstart = () => {
      isSpeaking = true;
      currentUtterance = utterance;
      if (onSpeakStartCallback) onSpeakStartCallback();

      // Chrome workaround: pause/resume to keep alive
      clearInterval(chromeResumeInterval);
      chromeResumeInterval = setInterval(() => {
        if (synth.speaking && !synth.paused) {
          synth.pause();
          synth.resume();
        }
      }, 5000);

      // Watchdog: if speech hasn't ended in 20s, force-continue
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (isSpeaking) {
          console.warn('[Speech] Watchdog: speech stuck, force-resetting');
          synth.cancel();
          isSpeaking = false;
          currentUtterance = null;
          clearInterval(chromeResumeInterval);
          processQueue();
        }
      }, 12000);
    };

    utterance.onend = () => {
      isSpeaking = false;
      currentUtterance = null;
      clearInterval(chromeResumeInterval);
      clearTimeout(watchdog);
      if (onSpeakEndCallback) onSpeakEndCallback();
      processQueue();
    };

    utterance.onerror = (e) => {
      console.warn('[Speech] Synthesis error:', e.error);
      isSpeaking = false;
      currentUtterance = null;
      clearInterval(chromeResumeInterval);
      clearTimeout(watchdog);
      processQueue();
    };

    synth.speak(utterance);
  }

  function stopSpeaking() {
    synth.cancel();
    speechQueue = [];
    isSpeaking = false;
    currentUtterance = null;
  }

  function setWakeWord(word) { wakeWord = word.toLowerCase().trim(); }
  function setVoice(voice) { selectedVoice = voice; }
  function setRate(rate) { speechRate = rate; }

  function setLanguage(langCode) {
    currentLang = langCode;
    translateCache.clear();
    const allVoices = synth.getVoices();

    // Map short codes to full locale codes for better voice matching
    const localeMap = {
      en: 'en', hi: 'hi', kn: 'kn', ta: 'ta', te: 'te',
      mr: 'mr', bn: 'bn', gu: 'gu', ml: 'ml', pa: 'pa', ur: 'ur',
      es: 'es', fr: 'fr', de: 'de', ja: 'ja', ko: 'ko',
      zh: 'zh', ar: 'ar', pt: 'pt', ru: 'ru', it: 'it'
    };

    // Find voices matching the language (check both 'hi' and 'hi-IN' formats)
    const candidates = allVoices.filter(v => {
      const vLang = v.lang.toLowerCase();
      return vLang === langCode
        || vLang.startsWith(langCode + '-')
        || vLang.startsWith(langCode + '_');
    });

    if (candidates.length > 0) {
      // Rank by quality: Google > Natural > Enhanced > Premium > Remote > Local
      const ranked = candidates.sort((a, b) => {
        const score = (v) => {
          const n = v.name.toLowerCase();
          if (n.includes('google')) return 6;
          if (n.includes('natural')) return 5;
          if (n.includes('enhanced')) return 4;
          if (n.includes('premium')) return 4;
          if (n.includes('wavenet')) return 3;
          if (n.includes('online')) return 2;
          if (!v.localService) return 1; // Remote voices are usually higher quality
          return 0;
        };
        return score(b) - score(a);
      });
      selectedVoice = ranked[0];
      console.log('[Speech] Language set to:', selectedVoice.lang, selectedVoice.name,
        `(${candidates.length} voices available, picked best quality)`);
    } else {
      // No voice found for this language — clear selectedVoice
      // The utterance.lang will be set directly so the browser can still try
      selectedVoice = null;
      console.warn('[Speech] No voice for:', langCode, '- setting utterance.lang directly');
    }

    // Adjust rate for naturalness per language
    if (langCode === 'en') {
      speechRate = 1.0;
    } else {
      // Slightly slower for non-English for clarity
      speechRate = 0.9;
    }
  }

  function onWakeWord(cb) { onWakeWordCallback = cb; }
  function onTranscript(cb) { onTranscriptCallback = cb; }
  function onSpeakStart(cb) { onSpeakStartCallback = cb; }
  function onSpeakEnd(cb) { onSpeakEndCallback = cb; }

  function isSpeakingNow() {
    return isSpeaking || synth.speaking;
  }

  return {
    initRecognition, startListening, stopListening,
    triggerQuestionMode, listenOnce, matchesWakeWord,
    initSynthesis, loadVoices,
    speak, stopSpeaking, isSpeakingNow,
    unlockAudio, playDangerBeep,
    setWakeWord, setVoice, setRate, setLanguage,
    onWakeWord, onTranscript, onSpeakStart, onSpeakEnd,
    getLanguage() { return currentLang; },
    getRate() { return speechRate; },
    get isListening() { return isListening; },
    get isSpeaking() { return isSpeaking; },
    get isSupported() { return recognitionSupported; },
    PRIORITY
  };
})();
