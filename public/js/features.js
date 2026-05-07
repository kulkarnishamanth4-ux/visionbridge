/**
 * features.js — All 17 innovation features for VisionBridge
 * 
 * 1.  SpatialAudio       — 3D HRTF audio panning for danger direction
 * 2.  OCR                — Text/sign reading via Tesseract.js
 * 3.  Haptic             — Vibration patterns for danger types
 * 4.  SceneMemory        — Detect and announce scene changes
 * 5.  EmergencySOS       — Fall detection + voice trigger + GPS alert
 * 6.  IndoorNav          — Remember locations by object fingerprint
 * 7.  CurrencyID         — Identify currency/products via Gemini
 * 8.  NightMode          — Adaptive low-light behavior
 * 9.  AmbientSound       — Classify environmental sounds
 * 10. BatteryAware       — Adjust scan rate based on battery level
 * 11. ShakeToScan        — Shake phone to trigger scan
 * 12. Favorites          — Bookmark important descriptions
 * 13. MultiLangTTS       — Switch TTS language
 * 14. ScanHistory        — Persistent log of all scans
 * 15. ShareScan          — Share last description via Web Share API
 * 16. OfflineIndicator   — Show online/offline status
 * 17. DistanceAlert      — Beep frequency scales with proximity
 * +   PerformanceScore   — Real-time scoring of each capability
 */
const Features = (() => {
  'use strict';

  // =============================================
  // 1. SPATIAL / 3D AUDIO
  // =============================================
  const SpatialAudio = (() => {
    let audioCtx = null;

    function init() {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { console.warn('[SpatialAudio] Not supported'); }
    }

    function playDirectional(direction, severity, distanceM) {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const panner = audioCtx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 20;

      // Position in 3D based on direction
      const positions = {
        left: [-2, 0, 0], right: [2, 0, 0], ahead: [0, 0, -2],
        behind: [0, 0, 2], above: [0, 2, 0], below: [0, -2, 0]
      };
      const [x, y, z] = positions[direction] || [0, 0, -1];
      const scale = Math.max(0.5, Math.min(distanceM || 3, 10));
      panner.positionX.value = x * (scale / 3);
      panner.positionY.value = y;
      panner.positionZ.value = z * (scale / 3);

      // Tone based on severity
      const freqs = { critical: 880, warning: 660, info: 440 };
      osc.frequency.value = freqs[severity] || 550;
      osc.type = severity === 'critical' ? 'sawtooth' : 'sine';

      const vol = severity === 'critical' ? 0.5 : 0.3;
      gain.gain.setValueAtTime(vol, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.6);

      osc.connect(gain).connect(panner).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.6);
    }

    function playForDangers(dangers) {
      if (!dangers || !dangers.length) return;
      dangers.forEach((d, i) => {
        setTimeout(() => playDirectional(d.direction, d.severity, d.distanceM), i * 300);
      });
    }

    return { init, playDirectional, playForDangers };
  })();

  // =============================================
  // 2. OCR — TEXT & SIGN READING
  // =============================================
  const OCR = (() => {
    let worker = null;
    let ready = false;
    let initializing = false;

    async function init() {
      if (ready || initializing) return ready;
      if (typeof Tesseract === 'undefined') {
        console.warn('[OCR] Tesseract.js not loaded');
        return false;
      }
      initializing = true;
      try {
        // Tesseract.js v5 API
        worker = await Tesseract.createWorker('eng', 1, {
          logger: m => { if (m.status === 'recognizing text') console.log('[OCR] Progress:', Math.round(m.progress * 100) + '%'); }
        });
        ready = true;
        initializing = false;
        console.log('[OCR] Ready');
        return true;
      } catch (e) {
        console.warn('[OCR] Init failed, trying fallback...', e.message);
        // Fallback: try without logger
        try {
          worker = await Tesseract.createWorker('eng');
          ready = true;
          initializing = false;
          console.log('[OCR] Ready (fallback)');
          return true;
        } catch (e2) {
          console.error('[OCR] All init methods failed:', e2);
          initializing = false;
          return false;
        }
      }
    }

    /**
     * Capture the current video frame onto a canvas and run OCR.
     * Must pass the video element so we get a fresh frame.
     */
    async function readFromVideo(videoElement) {
      if (!ready || !worker) return '';
      if (!videoElement || !videoElement.videoWidth) return '';
      try {
        // Draw current video frame to an offscreen canvas
        const c = document.createElement('canvas');
        c.width = videoElement.videoWidth;
        c.height = videoElement.videoHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(videoElement, 0, 0, c.width, c.height);

        // Run OCR on the fresh frame
        const { data: { text } } = await worker.recognize(c);
        const cleaned = text.trim().replace(/\s+/g, ' ');
        return cleaned;
      } catch (e) {
        console.warn('[OCR] Read error:', e);
        return '';
      }
    }

    /** Read text from an existing canvas (for backward compat). */
    async function readText(canvas) {
      if (!ready || !worker || !canvas) return '';
      try {
        const { data: { text } } = await worker.recognize(canvas);
        return text.trim().replace(/\s+/g, ' ');
      } catch (e) { return ''; }
    }

    return { init, readFromVideo, readText, get isReady() { return ready; } };
  })();

  // =============================================
  // 3. HAPTIC FEEDBACK
  // =============================================
  const Haptic = (() => {
    const supported = 'vibrate' in navigator;

    const patterns = {
      critical: [200, 100, 200, 100, 200],
      warning: [400, 200, 400],
      info: [100],
      clear: [50],
      sos: [300, 100, 300, 100, 300, 300, 600, 100, 600, 100, 600, 300, 300, 100, 300, 100, 300]
    };

    function vibrate(type) {
      if (!supported) return;
      navigator.vibrate(patterns[type] || patterns.info);
    }

    function vibrateForDangers(dangers) {
      if (!supported || !dangers?.length) return;
      const worst = dangers.reduce((a, b) =>
        (a.severity === 'critical' ? a : b.severity === 'critical' ? b : a), dangers[0]);
      vibrate(worst.severity);
    }

    function stop() { if (supported) navigator.vibrate(0); }

    return { vibrate, vibrateForDangers, stop, supported };
  })();

  // =============================================
  // 4. SCENE MEMORY & CHANGE DETECTION
  // =============================================
  const SceneMemory = (() => {
    let previousObjects = [];

    function detectChanges(currentObjects) {
      if (!currentObjects?.length) return null;
      if (!previousObjects.length) {
        previousObjects = currentObjects.map(o => o.class || o.label);
        return null;
      }

      const prevSet = new Set(previousObjects);
      const currSet = new Set(currentObjects.map(o => o.class || o.label));

      const appeared = [...currSet].filter(x => !prevSet.has(x));
      const disappeared = [...prevSet].filter(x => !currSet.has(x));

      previousObjects = [...currSet];

      if (!appeared.length && !disappeared.length) return null;

      const parts = [];
      if (appeared.length) parts.push(`New: ${appeared.join(', ')}`);
      if (disappeared.length) parts.push(`Gone: ${disappeared.join(', ')}`);
      return parts.join('. ');
    }

    function reset() { previousObjects = []; }

    return { detectChanges, reset };
  })();

  // =============================================
  // 5. EMERGENCY SOS
  // =============================================
  const EmergencySOS = (() => {
    let motionHandler = null;
    let lastAccel = { x: 0, y: 0, z: 0, time: 0 };
    let shakeCount = 0;
    let onSOSCallback = null;
    let sosContact = localStorage.getItem('vb_sos_contact') || '';
    let sosActive = false;

    function init(callback) {
      onSOSCallback = callback;
      if (window.DeviceMotionEvent) {
        motionHandler = (e) => {
          const a = e.accelerationIncludingGravity;
          if (!a) return;
          const delta = Math.abs(a.x - lastAccel.x) + Math.abs(a.y - lastAccel.y) + Math.abs(a.z - lastAccel.z);
          lastAccel = { x: a.x, y: a.y, z: a.z, time: Date.now() };
          // Detect fall: very large sudden acceleration
          if (delta > 40) {
            triggerSOS('Fall detected');
          }
        };
        window.addEventListener('devicemotion', motionHandler);
      }
    }

    function triggerSOS(reason) {
      if (sosActive) return;
      sosActive = true;
      Haptic.vibrate('sos');
      const location = getLocation();
      if (onSOSCallback) onSOSCallback(reason, location);
      setTimeout(() => { sosActive = false; }, 10000); // Cooldown
    }

    function getLocation() {
      return new Promise(resolve => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          () => resolve(null), { timeout: 5000 }
        );
      });
    }

    function setContact(contact) {
      sosContact = contact;
      localStorage.setItem('vb_sos_contact', contact);
    }

    function getContact() { return sosContact; }

    return { init, triggerSOS, setContact, getContact, getLocation };
  })();

  // =============================================
  // 6. INDOOR NAVIGATION MEMORY
  // =============================================
  const IndoorNav = (() => {
    const STORAGE_KEY = 'vb_locations';

    function getFingerprint(objects) {
      if (!objects?.length) return '';
      return objects.map(o => o.class || o.label || o.name).sort().join(',');
    }

    function saveLocation(name, objects) {
      const locations = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      locations[name] = { fingerprint: getFingerprint(objects), time: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(locations));
    }

    function recognizeLocation(objects) {
      const fp = getFingerprint(objects);
      if (!fp) return null;
      const locations = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const [name, data] of Object.entries(locations)) {
        const overlap = calcOverlap(fp, data.fingerprint);
        if (overlap > 0.6) return name;
      }
      return null;
    }

    function calcOverlap(fp1, fp2) {
      const s1 = new Set(fp1.split(','));
      const s2 = new Set(fp2.split(','));
      const inter = [...s1].filter(x => s2.has(x)).length;
      return inter / Math.max(s1.size, s2.size, 1);
    }

    return { saveLocation, recognizeLocation };
  })();

  // =============================================
  // 7. CURRENCY & PRODUCT ID (via Gemini)
  // =============================================
  const CurrencyID = (() => {
    async function identify(imageBase64) {
      try {
        const result = await ApiModule.askQuestion(imageBase64,
          'Identify any currency notes, coins, or product labels/brands visible. State the denomination or product name clearly.');
        return result?.answer || '';
      } catch { return ''; }
    }
    return { identify };
  })();

  // =============================================
  // 8. ADAPTIVE NIGHT MODE
  // =============================================
  const NightMode = (() => {
    let isNight = false;

    function analyzeBrightness(canvas) {
      try {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let total = 0;
        const step = 16; // Sample every 16th pixel for speed
        let count = 0;
        for (let i = 0; i < data.length; i += step * 4) {
          total += (data[i] + data[i + 1] + data[i + 2]) / 3;
          count++;
        }
        const avg = total / count;
        isNight = avg < 60;
        document.body.classList.toggle('night-mode', isNight);
        return { brightness: Math.round(avg), isNight };
      } catch { return { brightness: 128, isNight: false }; }
    }

    return { analyzeBrightness, get isNight() { return isNight; } };
  })();

  // =============================================
  // 9. AMBIENT SOUND CLASSIFICATION
  // =============================================
  const AmbientSound = (() => {
    let analyser = null, audioCtx = null, mic = null;
    let isListening = false;
    let onSoundCallback = null;

    async function init(callback) {
      onSoundCallback = callback;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mic = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        mic.connect(analyser);
        isListening = true;
      } catch (e) { console.warn('[AmbientSound] No mic access'); }
    }

    function classify() {
      if (!analyser) return null;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);

      const low = avg(data, 0, 20);    // <500Hz — engines, rumble
      const mid = avg(data, 20, 80);   // 500-2kHz — speech, horns
      const high = avg(data, 80, 200); // 2-5kHz — alarms, whistles
      const overall = avg(data, 0, 200);

      if (overall < 30) return { type: 'quiet', label: 'Quiet environment', level: overall };
      if (high > 100) return { type: 'alarm', label: 'High-pitched sound detected (possible alarm or siren)', level: high };
      if (mid > 120) return { type: 'horn', label: 'Loud sound detected (possible horn or shouting)', level: mid };
      if (low > 100) return { type: 'engine', label: 'Low rumbling sound (possible vehicle engine)', level: low };
      if (overall > 80) return { type: 'noise', label: 'Noisy environment', level: overall };
      return { type: 'normal', label: 'Normal ambient noise', level: overall };
    }

    function avg(arr, from, to) {
      let s = 0;
      for (let i = from; i < to && i < arr.length; i++) s += arr[i];
      return s / (to - from);
    }

    return { init, classify, get isListening() { return isListening; } };
  })();

  // =============================================
  // 10. BATTERY-AWARE SCANNING
  // =============================================
  const BatteryAware = (() => {
    let battery = null;
    let level = 1;
    let charging = true;

    async function init() {
      try {
        if (navigator.getBattery) {
          battery = await navigator.getBattery();
          level = battery.level;
          charging = battery.charging;
          battery.addEventListener('levelchange', () => { level = battery.level; update(); });
          battery.addEventListener('chargingchange', () => { charging = battery.charging; update(); });
          update();
        }
      } catch { /* Battery API not supported */ }
    }

    function update() {
      const el = document.getElementById('battery-indicator');
      if (el) {
        const pct = Math.round(level * 100);
        el.textContent = charging ? `⚡${pct}%` : `🔋${pct}%`;
        el.className = 'badge ' + (pct < 20 ? 'badge-danger' : pct < 50 ? 'badge-warn' : 'badge-ok');
      }
    }

    function getRecommendedInterval(baseMs) {
      if (charging) return baseMs;
      if (level < 0.1) return baseMs * 4;
      if (level < 0.2) return baseMs * 3;
      if (level < 0.4) return baseMs * 2;
      return baseMs;
    }

    return { init, getRecommendedInterval, get level() { return level; }, get charging() { return charging; } };
  })();

  // =============================================
  // 11. SHAKE TO SCAN
  // =============================================
  const ShakeToScan = (() => {
    let onShakeCallback = null;
    let lastShake = 0;
    const COOLDOWN = 2000;
    const THRESHOLD = 25;

    function init(callback) {
      onShakeCallback = callback;
      let last = { x: 0, y: 0, z: 0 };
      window.addEventListener('devicemotion', (e) => {
        const a = e.accelerationIncludingGravity;
        if (!a) return;
        const d = Math.abs(a.x - last.x) + Math.abs(a.y - last.y) + Math.abs(a.z - last.z);
        last = { x: a.x, y: a.y, z: a.z };
        if (d > THRESHOLD && Date.now() - lastShake > COOLDOWN) {
          lastShake = Date.now();
          Haptic.vibrate('clear');
          if (onShakeCallback) onShakeCallback();
        }
      });
    }

    return { init };
  })();

  // =============================================
  // 12. FAVORITES / BOOKMARKS
  // =============================================
  const Favorites = (() => {
    const KEY = 'vb_favorites';

    function save(text, mode) {
      const favs = JSON.parse(localStorage.getItem(KEY) || '[]');
      favs.unshift({ text, mode, time: Date.now(), id: Date.now() });
      if (favs.length > 50) favs.pop();
      localStorage.setItem(KEY, JSON.stringify(favs));
      return favs.length;
    }

    function getAll() { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    function remove(id) {
      const favs = getAll().filter(f => f.id !== id);
      localStorage.setItem(KEY, JSON.stringify(favs));
    }
    function clear() { localStorage.removeItem(KEY); }

    return { save, getAll, remove, clear };
  })();

  // =============================================
  // 13. MULTI-LANGUAGE TTS
  // =============================================
  const MultiLangTTS = (() => {
    const languages = [
      { code: 'en', label: 'English' },
      { code: 'hi', label: 'Hindi' },
      { code: 'es', label: 'Spanish' },
      { code: 'fr', label: 'French' },
      { code: 'de', label: 'German' },
      { code: 'ja', label: 'Japanese' },
      { code: 'ko', label: 'Korean' },
      { code: 'zh', label: 'Chinese' },
      { code: 'ar', label: 'Arabic' },
      { code: 'pt', label: 'Portuguese' },
      { code: 'ta', label: 'Tamil' },
      { code: 'te', label: 'Telugu' },
      { code: 'kn', label: 'Kannada' }
    ];

    let currentLang = localStorage.getItem('vb_tts_lang') || 'en';

    function setLanguage(code) {
      currentLang = code;
      localStorage.setItem('vb_tts_lang', code);
    }

    function getLanguage() { return currentLang; }
    function getLanguages() { return languages; }

    return { setLanguage, getLanguage, getLanguages };
  })();

  // =============================================
  // 14. SCAN HISTORY LOG
  // =============================================
  const ScanHistory = (() => {
    const KEY = 'vb_history';
    const MAX = 100;

    function add(entry) {
      const hist = getAll();
      hist.unshift({
        ...entry,
        id: Date.now(),
        time: new Date().toISOString()
      });
      if (hist.length > MAX) hist.length = MAX;
      localStorage.setItem(KEY, JSON.stringify(hist));
    }

    function getAll() { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    function clear() { localStorage.removeItem(KEY); }
    function count() { return getAll().length; }

    return { add, getAll, clear, count };
  })();

  // =============================================
  // 15. SHARE SCAN
  // =============================================
  const ShareScan = (() => {
    const supported = !!navigator.share;

    async function share(text, title = 'VisionBridge Scan') {
      if (supported) {
        try {
          await navigator.share({ title, text });
          return true;
        } catch { return false; }
      } else {
        // Fallback: copy to clipboard
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch { return false; }
      }
    }

    return { share, supported };
  })();

  // =============================================
  // 16. OFFLINE MODE INDICATOR
  // =============================================
  const OfflineIndicator = (() => {
    let isOnline = navigator.onLine;

    function init() {
      update();
      window.addEventListener('online', () => { isOnline = true; update(); });
      window.addEventListener('offline', () => { isOnline = false; update(); });
    }

    function update() {
      const el = document.getElementById('offline-indicator');
      if (el) {
        el.textContent = isOnline ? '🌐 Online' : '📴 Offline';
        el.className = 'badge ' + (isOnline ? 'badge-ok' : 'badge-warn');
      }
    }

    return { init, get isOnline() { return isOnline; } };
  })();

  // =============================================
  // 17. DISTANCE-BASED ALERT FREQUENCY
  // =============================================
  const DistanceAlert = (() => {
    let intervalId = null;
    const audioCtx = SpatialAudio; // reuse

    function startProximityBeep(distanceM, direction) {
      stop();
      if (distanceM > 10) return; // Too far, no beep
      // Closer = faster beeping (like parking sensors)
      const rate = Math.max(150, Math.min(1500, distanceM * 200));
      let on = true;
      intervalId = setInterval(() => {
        if (on) SpatialAudio.playDirectional(direction, 'warning', distanceM);
        on = !on;
      }, rate);
      // Auto-stop after 5 seconds
      setTimeout(stop, 5000);
    }

    function stop() {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    }

    return { startProximityBeep, stop };
  })();

  // =============================================
  // PERFORMANCE SCORE
  // =============================================
  const PerformanceScore = (() => {
    const metrics = {
      totalScans: 0,
      successfulScans: 0,
      dangersDetected: 0,
      avgConfidence: 0,
      totalConfidence: 0,
      confCount: 0,
      avgLatencyMs: 0,
      totalLatency: 0,
      latCount: 0,
      apiSuccesses: 0,
      apiAttempts: 0,
      ocrReads: 0,
      objectsDetected: 0
    };

    function recordScan(success, latencyMs, objectCount, dangers) {
      metrics.totalScans++;
      if (success) metrics.successfulScans++;
      if (latencyMs) { metrics.totalLatency += latencyMs; metrics.latCount++; }
      if (objectCount) metrics.objectsDetected += objectCount;
      if (dangers) metrics.dangersDetected += dangers;
    }

    function recordConfidence(conf) {
      metrics.totalConfidence += conf;
      metrics.confCount++;
    }

    function recordAPI(success) {
      metrics.apiAttempts++;
      if (success) metrics.apiSuccesses++;
    }

    function recordOCR() { metrics.ocrReads++; }

    function getScores() {
      const s = metrics;
      const detectionRate = s.totalScans ? Math.round((s.successfulScans / s.totalScans) * 100) : 0;
      const avgConf = s.confCount ? Math.round(s.totalConfidence / s.confCount) : 0;
      const avgLat = s.latCount ? Math.round(s.totalLatency / s.latCount) : 0;
      const apiRate = s.apiAttempts ? Math.round((s.apiSuccesses / s.apiAttempts) * 100) : 100;
      const dangerRate = s.totalScans ? Math.round((s.dangersDetected / s.totalScans) * 100) : 0;

      // Overall weighted score
      const overall = Math.round(
        detectionRate * 0.3 + avgConf * 0.25 + Math.min(100, (1000 / Math.max(avgLat, 100)) * 100) * 0.2 +
        apiRate * 0.15 + Math.min(100, s.objectsDetected) * 0.1
      );

      return {
        overall: Math.min(100, overall),
        detection: { score: detectionRate, label: 'Detection Rate', detail: `${s.successfulScans}/${s.totalScans} scans` },
        accuracy: { score: avgConf, label: 'Avg Confidence', detail: `${avgConf}%` },
        speed: { score: Math.min(100, Math.round((1000 / Math.max(avgLat, 100)) * 100)), label: 'Response Speed', detail: `${avgLat}ms avg` },
        apiHealth: { score: apiRate, label: 'API Health', detail: `${s.apiSuccesses}/${s.apiAttempts}` },
        danger: { score: Math.min(100, dangerRate * 5), label: 'Danger Detection', detail: `${s.dangersDetected} found` },
        objects: { score: Math.min(100, s.objectsDetected * 2), label: 'Objects Detected', detail: `${s.objectsDetected} total` },
        ocr: { score: Math.min(100, s.ocrReads * 20), label: 'Text Reading', detail: `${s.ocrReads} reads` }
      };
    }

    function renderHTML() {
      const s = getScores();
      const bar = (score, color) => `<div class="perf-bar"><div class="perf-fill" style="width:${score}%;background:${color}"></div></div>`;
      const color = (v) => v >= 80 ? '#00ff88' : v >= 50 ? '#ffaa00' : '#ff3366';

      return `
        <div class="perf-overall">
          <div class="perf-ring" style="--score:${s.overall}">
            <span class="perf-number">${s.overall}</span>
          </div>
          <span class="perf-label">Overall Score</span>
        </div>
        <div class="perf-grid">
          ${Object.entries(s).filter(([k]) => k !== 'overall').map(([, v]) => `
            <div class="perf-item">
              <div class="perf-item-header"><span>${v.label}</span><span class="perf-val">${v.score}%</span></div>
              ${bar(v.score, color(v.score))}
              <span class="perf-detail">${v.detail}</span>
            </div>
          `).join('')}
        </div>`;
    }

    return { recordScan, recordConfidence, recordAPI, recordOCR, getScores, renderHTML };
  })();

  // =============================================
  // PUBLIC API
  // =============================================
  return {
    SpatialAudio, OCR, Haptic, SceneMemory, EmergencySOS,
    IndoorNav, CurrencyID, NightMode, AmbientSound,
    BatteryAware, ShakeToScan, Favorites, MultiLangTTS,
    ScanHistory, ShareScan, OfflineIndicator, DistanceAlert,
    PerformanceScore
  };
})();
