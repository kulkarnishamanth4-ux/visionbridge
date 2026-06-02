/**
 * assistant.js — Personal AI Assistant for VisionBridge
 * Routes voice commands to local handlers or Gemini API.
 * Local commands execute instantly (<50ms). Everything else goes to Gemini.
 * Maintains conversation history for contextual follow-ups.
 */
const AssistantModule = (() => {
  'use strict';

  // Conversation history (last 6 exchanges for context)
  const MAX_HISTORY = 6;
  let conversationHistory = [];
  let lastDescription = '';
  let activeTimers = [];

  // =============================================
  //   LOCAL COMMAND DEFINITIONS
  // =============================================
  // Each command: { patterns: RegExp[], handler: fn => string }
  // Handlers return the spoken response string, or null to pass to Gemini.

  const LOCAL_COMMANDS = [
    // --- TIME & DATE ---
    {
      patterns: [/what(?:'s| is) the time/, /tell me the time/, /current time/, /what time/],
      handler: () => {
        const now = new Date();
        const h = now.getHours(), m = now.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        const hour = h % 12 || 12;
        const min = m < 10 ? `oh ${m}` : m;
        return `It's ${hour} ${min} ${ampm}.`;
      }
    },
    {
      patterns: [/what(?:'s| is) the date/, /today(?:'s| is)? date/, /what date/, /what day/],
      handler: () => {
        const now = new Date();
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        return `Today is ${now.toLocaleDateString('en-IN', options)}.`;
      }
    },

    // --- BATTERY ---
    {
      patterns: [/battery/, /charge/, /power level/],
      handler: () => {
        const el = document.getElementById('battery-indicator');
        const text = el?.textContent || 'Battery information unavailable';
        return `Your battery is at ${text.replace('🔋', '').trim()}.`;
      }
    },

    // --- MODE SWITCHING ---
    {
      patterns: [/switch to danger|danger mode|enable danger/],
      handler: () => {
        document.querySelector('[data-mode="danger"]')?.click();
        return 'Switched to danger detection mode. I will focus on alerting you about hazards.';
      }
    },
    {
      patterns: [/switch to summary|summary mode|enable summary/],
      handler: () => {
        document.querySelector('[data-mode="summary"]')?.click();
        return 'Switched to summary mode. I will give you brief descriptions.';
      }
    },
    {
      patterns: [/switch to detailed|detailed mode|full description|enable detailed/],
      handler: () => {
        document.querySelector('[data-mode="detailed"]')?.click();
        return 'Switched to detailed mode. I will describe everything I see in detail.';
      }
    },
    {
      patterns: [/switch to read|read mode|text mode|ocr mode/],
      handler: () => {
        document.querySelector('[data-mode="read"]')?.click();
        return 'Switched to reading mode. Point me at any text and I will read it for you.';
      }
    },
    {
      patterns: [/switch to measure|measure mode|distance mode/],
      handler: () => {
        document.querySelector('[data-mode="measure"]')?.click();
        return 'Switched to measure mode. I will estimate distances to objects around you.';
      }
    },

    // --- REPEAT / STOP ---
    {
      patterns: [/repeat|say (?:that |it )?again|what did you say|last description/],
      handler: () => {
        if (lastDescription) return lastDescription;
        const outputBody = document.getElementById('output-body');
        const last = outputBody?.querySelector('.output-text:last-child');
        return last?.textContent || 'I haven\'t said anything yet. Try scanning first.';
      }
    },
    {
      patterns: [/^stop$|^quiet$|shut up|be quiet|stop talking|stop speaking/],
      handler: () => {
        if (typeof SpeechModule !== 'undefined') SpeechModule.stopSpeaking();
        return null; // Don't speak a response to "stop"
      }
    },

    // --- SCAN ---
    {
      patterns: [/scan now|scan again|take a scan|look around|what do you see/],
      handler: () => {
        document.getElementById('btn-scan')?.click();
        return 'Scanning now...';
      }
    },

    // --- CAMERA ---
    {
      patterns: [/toggle camera|show camera|hide camera|camera preview/],
      handler: () => {
        document.getElementById('btn-camera-toggle')?.click();
        return 'Camera preview toggled.';
      }
    },

    // --- VOLUME / SPEED ---
    {
      patterns: [/(?:turn |)volume up|speak faster|speed up|faster/],
      handler: () => {
        if (typeof SpeechModule !== 'undefined') {
          const current = SpeechModule.getRate ? SpeechModule.getRate() : 1.0;
          const newRate = Math.min(current + 0.2, 2.0);
          SpeechModule.setRate(newRate);
          return `Speech speed increased to ${Math.round(newRate * 100)} percent.`;
        }
        return 'Speech rate adjusted.';
      }
    },
    {
      patterns: [/(?:turn |)volume down|speak slower|slow down|slower/],
      handler: () => {
        if (typeof SpeechModule !== 'undefined') {
          const current = SpeechModule.getRate ? SpeechModule.getRate() : 1.0;
          const newRate = Math.max(current - 0.2, 0.4);
          SpeechModule.setRate(newRate);
          return `Speech speed decreased to ${Math.round(newRate * 100)} percent.`;
        }
        return 'Speech rate adjusted.';
      }
    },

    // --- TIMER ---
    {
      patterns: [/set (?:a )?timer (?:for )?(\d+)\s*(minute|second|min|sec|hour)/],
      handler: (match) => {
        const amount = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        let ms;
        if (unit.startsWith('hour')) ms = amount * 3600000;
        else if (unit.startsWith('min')) ms = amount * 60000;
        else ms = amount * 1000;

        const timerId = setTimeout(() => {
          if (typeof SpeechModule !== 'undefined') {
            SpeechModule.speak(`Timer done! Your ${amount} ${unit} timer has finished.`, 3);
          }
        }, ms);
        activeTimers.push(timerId);

        return `Timer set for ${amount} ${unit}${amount > 1 ? 's' : ''}. I will alert you when it's done.`;
      }
    },
    {
      patterns: [/cancel timer|stop timer|clear timer/],
      handler: () => {
        activeTimers.forEach(id => clearTimeout(id));
        activeTimers = [];
        return 'All timers cancelled.';
      }
    },

    // --- LOCATION ---
    {
      patterns: [/where am i|my location|current location|gps/],
      handler: () => {
        if (!navigator.geolocation) return 'Location services are not available on this device.';
        navigator.geolocation.getCurrentPosition(
          pos => {
            const lat = pos.coords.latitude.toFixed(5);
            const lng = pos.coords.longitude.toFixed(5);
            if (typeof SpeechModule !== 'undefined') {
              SpeechModule.speak(`Your location is latitude ${lat}, longitude ${lng}.`, 2);
            }
          },
          () => {
            if (typeof SpeechModule !== 'undefined') {
              SpeechModule.speak('Could not get your location. Make sure GPS is enabled.', 2);
            }
          },
          { timeout: 5000 }
        );
        return 'Getting your location...';
      }
    },

    // --- SOS ---
    {
      patterns: [/trigger sos|send sos|emergency|i need help|call for help/],
      handler: () => {
        if (typeof FeaturesModule !== 'undefined') {
          FeaturesModule.EmergencySOS.triggerSOS('Voice command: Emergency assistance requested');
        }
        return null; // SOS handler speaks its own messages
      }
    },

    // --- LANGUAGE ---
    {
      patterns: [/what language|current language|which language/],
      handler: () => {
        if (typeof SpeechModule !== 'undefined') {
          const lang = SpeechModule.getLanguage();
          const langNames = {
            en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu',
            kn: 'Kannada', ml: 'Malayalam', bn: 'Bengali', mr: 'Marathi',
            gu: 'Gujarati', pa: 'Punjabi', es: 'Spanish', fr: 'French',
            de: 'German', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic'
          };
          return `The current language is set to ${langNames[lang] || lang}.`;
        }
        return 'English.';
      }
    },

    // --- IDENTITY / HELP ---
    {
      patterns: [/who are you|what(?:'s| is) your name|introduce yourself/],
      handler: () => {
        return 'I am Vision, your personal AI assistant. I help you navigate the world around you by describing what I see, detecting dangers, reading text, and answering your questions. Just say my name anytime you need me.';
      }
    },
    {
      patterns: [/what can you do|help me|your capabilities|your features|how do you work/],
      handler: () => {
        return 'Here is what I can do. I can describe your surroundings, detect dangers like vehicles and obstacles, read text from signs and labels, measure distances, set timers, tell you the time and date, check your battery, switch between modes, trigger an emergency SOS, and answer general knowledge questions. Just ask me anything.';
      }
    },

    // --- OBJECT COUNT ---
    {
      patterns: [/how many (?:objects|things|people|items)/],
      handler: () => {
        const outputBody = document.getElementById('output-body');
        const last = outputBody?.textContent || '';
        // Try to extract object count from last description
        const numMatch = last.match(/(\d+)\s+(?:objects?|people|persons?|items?)/i);
        if (numMatch) return `I detected ${numMatch[1]} ${numMatch[0].replace(numMatch[1], '').trim()} in the last scan.`;
        return 'I need to scan first. Say "scan now" and then ask me again.';
      }
    }
  ];

  // =============================================
  //   INTENT CLASSIFICATION
  // =============================================

  /**
   * Classify a voice command:
   * - 'local': can be handled without API
   * - 'scene': needs camera frame + Gemini (about what's visible)
   * - 'general': needs Gemini but no camera (knowledge question)
   * - 'followup': references previous conversation
   */
  function classifyIntent(text) {
    const lower = text.toLowerCase();

    // Check local commands first
    for (const cmd of LOCAL_COMMANDS) {
      for (const pattern of cmd.patterns) {
        const match = lower.match(pattern);
        if (match) return { type: 'local', command: cmd, match };
      }
    }

    // Scene-related keywords (needs camera)
    const sceneKeywords = [
      /what(?:'s| is) (?:in front|ahead|around|near|behind|beside)/,
      /(?:do you |can you )?see/,
      /describe|look at|read (?:that|this|the)/,
      /is there (?:a |an |any )/,
      /how far|how close|how big|how tall|how wide|distance/,
      /what color|what shape|what size/,
      /which way|which direction|navigate|path|road|sidewalk/,
      /obstacle|pothole|animal|dog|cow|car|truck|bike|bus/,
      /safe (?:to |)(?:cross|walk|go|move)/,
      /door|stair|step|curb|ramp|crossing|signal|traffic light/,
      /how (?:do i |can i |to )(?:get |go |walk |move |navigate )/,
      /around (?:it|that|this|the|them)/,
      /avoid|get past|go around|way around/
    ];

    for (const kw of sceneKeywords) {
      if (kw.test(lower)) return { type: 'scene' };
    }

    // Follow-up keywords (references previous conversation)
    const followupKeywords = [
      /tell me more/, /what (?:do you |did you )?mean/,
      /explain (?:that|more|further)/, /more (?:details|information|about)/,
      /^yes/, /^no/, /^ok/, /why/, /and (?:what|how|where)/,
      /you (?:said|mentioned|told)/
    ];

    for (const kw of followupKeywords) {
      if (kw.test(lower)) return { type: 'followup' };
    }

    // Everything else → general knowledge question
    return { type: 'general' };
  }

  // =============================================
  //   PROCESS VOICE INPUT
  // =============================================

  /**
   * Main entry point: process a voice command.
   * Returns { response: string, needsCamera: boolean, handled: boolean }
   */
  async function processCommand(text, options = {}) {
    const { getFrame, geminiAvailable, detectObjects } = options;
    const intent = classifyIntent(text);

    console.log(`[Assistant] "${text}" → intent: ${intent.type}`);

    // 1. LOCAL COMMANDS — instant, no API
    if (intent.type === 'local') {
      const response = intent.command.handler(intent.match);
      if (response) {
        addToHistory('user', text);
        addToHistory('assistant', response);
      }
      return { response, handled: true, needsCamera: false };
    }

    // 2. SCENE QUESTION — needs camera + Gemini
    if (intent.type === 'scene') {
      if (!geminiAvailable) {
        // Offline: use local detection
        if (detectObjects) {
          const video = document.getElementById('camera-feed');
          if (video && typeof DetectorModule !== 'undefined') {
            const objs = await DetectorModule.detect(video);
            const offlineResult = typeof OfflineModule !== 'undefined'
              ? OfflineModule.describeScene(objs, 'detailed')
              : DetectorModule.processForSpeech(objs, 'detailed');
            const response = offlineResult.description || offlineResult.summary || 'I can\'t see clearly right now.';
            addToHistory('user', text);
            addToHistory('assistant', response);
            return { response, handled: true, needsCamera: false };
          }
        }
        return { response: 'I need an internet connection to answer detailed scene questions. But I can still detect objects around you.', handled: true, needsCamera: false };
      }

      // Get camera frame and send to Gemini assistant endpoint
      const frame = getFrame ? getFrame() : null;
      if (!frame) {
        return { response: 'Camera is not active. I need to see to answer that.', handled: true, needsCamera: false };
      }

      try {
        const history = getRecentHistory();
        const result = await ApiModule.askAssistant(text, frame, history);
        const response = result.answer || 'I couldn\'t analyze the scene right now. Try again.';
        addToHistory('user', text);
        addToHistory('assistant', response);
        lastDescription = response;
        return { response, handled: true, needsCamera: true };
      } catch {
        return { response: 'The AI service is busy. Please try again in a moment.', handled: true, needsCamera: false };
      }
    }

    // 3. FOLLOW-UP — send with history, optionally with camera
    if (intent.type === 'followup') {
      if (!geminiAvailable) {
        return { response: 'I need an internet connection to continue our conversation. Try asking a simpler question.', handled: true, needsCamera: false };
      }

      const frame = getFrame ? getFrame() : null;
      try {
        const history = getRecentHistory();
        const result = await ApiModule.askAssistant(text, frame, history);
        const response = result.answer || 'Could you rephrase that?';
        addToHistory('user', text);
        addToHistory('assistant', response);
        lastDescription = response;
        return { response, handled: true, needsCamera: !!frame };
      } catch {
        return { response: 'The AI service is busy. Try again shortly.', handled: true, needsCamera: false };
      }
    }

    // 4. GENERAL KNOWLEDGE — no camera needed
    if (!geminiAvailable) {
      return { response: 'I need an internet connection to answer knowledge questions. I can still detect objects and dangers for you offline.', handled: true, needsCamera: false };
    }

    try {
      const history = getRecentHistory();
      const result = await ApiModule.askAssistant(text, null, history);
      const response = result.answer || 'I\'m not sure about that. Try asking differently.';
      addToHistory('user', text);
      addToHistory('assistant', response);
      return { response, handled: true, needsCamera: false };
    } catch {
      return { response: 'The AI service is busy right now. Try again in a moment.', handled: true, needsCamera: false };
    }
  }

  // =============================================
  //   CONVERSATION HISTORY
  // =============================================

  function addToHistory(role, content) {
    conversationHistory.push({ role, content, time: Date.now() });
    if (conversationHistory.length > MAX_HISTORY * 2) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY * 2);
    }
  }

  function getRecentHistory() {
    return conversationHistory.slice(-MAX_HISTORY * 2).map(h => ({
      role: h.role,
      content: h.content
    }));
  }

  function clearHistory() {
    conversationHistory = [];
  }

  function setLastDescription(desc) {
    lastDescription = desc;
  }

  return {
    processCommand,
    classifyIntent,
    clearHistory,
    setLastDescription,
    getRecentHistory
  };
})();
