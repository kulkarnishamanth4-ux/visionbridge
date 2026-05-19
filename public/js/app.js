/**
 * app.js — Main VisionBridge application controller
 * Integrates all 17 innovation features with local+cloud hybrid detection.
 */
(async function VisionBridgeApp() {
  'use strict';

  // --- State ---
  let autoScanEnabled = false;
  let autoScanTimer = null;
  let scanInterval = 6000;
  let isProcessing = false;
  let cameraPreviewVisible = false;
  let currentMode = 'detailed';
  let localDetectorReady = false;
  let geminiAvailable = false;
  let lastDescription = '';

  // --- Refs ---
  const F = Features;
  const P = F.PerformanceScore;

  // --- Init core systems ---
  const status = await ApiModule.checkStatus();
  geminiAvailable = status.apiKeyConfigured;
  UIModule.setApiStatus(status.apiKeyConfigured);

  const voices = await SpeechModule.initSynthesis();
  UIModule.populateVoices(voices);

  // --- Init all feature modules ---
  F.SpatialAudio.init();
  F.OfflineIndicator.init();
  F.BatteryAware.init();

  // Populate language selector
  const langSelect = document.getElementById('tts-language');
  if (langSelect) {
    langSelect.innerHTML = F.MultiLangTTS.getLanguages()
      .map(l => `<option value="${l.code}" ${l.code === F.MultiLangTTS.getLanguage() ? 'selected' : ''}>${l.label}</option>`)
      .join('');
    langSelect.addEventListener('change', (e) => {
      const lang = e.target.value;
      F.MultiLangTTS.setLanguage(lang);
      SpeechModule.setLanguage(lang);
      SpeechModule.speak('Language changed.', SpeechModule.PRIORITY.INFO);
    });
  }

  // Load SOS contact settings
  const sosTypeSelect = document.getElementById('sos-type');
  const sosEmailInput = document.getElementById('sos-contact-email');
  const sosPhoneInput = document.getElementById('sos-contact-phone');
  const sosEmailGroup = document.getElementById('sos-email-group');
  const sosPhoneGroup = document.getElementById('sos-phone-group');

  if (sosTypeSelect) {
    sosTypeSelect.value = F.EmergencySOS.getContactType();
    // Show/hide the correct field on load
    if (F.EmergencySOS.getContactType() === 'phone') {
      if (sosEmailGroup) sosEmailGroup.classList.add('hidden');
      if (sosPhoneGroup) sosPhoneGroup.classList.remove('hidden');
    }
    sosTypeSelect.addEventListener('change', (e) => {
      F.EmergencySOS.setContactType(e.target.value);
      if (e.target.value === 'phone') {
        if (sosEmailGroup) sosEmailGroup.classList.add('hidden');
        if (sosPhoneGroup) sosPhoneGroup.classList.remove('hidden');
      } else {
        if (sosEmailGroup) sosEmailGroup.classList.remove('hidden');
        if (sosPhoneGroup) sosPhoneGroup.classList.add('hidden');
      }
    });
  }
  if (sosEmailInput) {
    sosEmailInput.value = F.EmergencySOS.getEmail();
    sosEmailInput.addEventListener('change', (e) => F.EmergencySOS.setEmail(e.target.value));
  }
  if (sosPhoneInput) {
    sosPhoneInput.value = F.EmergencySOS.getPhone();
    sosPhoneInput.addEventListener('change', (e) => F.EmergencySOS.setPhone(e.target.value));
  }

  // --- Mode Descriptions ---
  const MODE_NAMES = {
    detailed: 'Detailed mode. Full scene description with danger alerts.',
    danger: 'Danger mode. Only immediate, close-range threats.',
    summary: 'Summary mode. One sentence scene overview.',
    measure: 'Measure mode. Object sizes and movement speeds.',
    read: 'Read mode. I will read any text or signs in view.'
  };

  // --- Mode Tabs ---
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      if (mode === currentMode) return;
      currentMode = mode;
      document.querySelectorAll('.mode-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      SpeechModule.speak(MODE_NAMES[mode], SpeechModule.PRIORITY.INFO);
    });
  });

  // --- Onboarding ---
  UIModule.els.btnStart.addEventListener('click', async () => {
    UIModule.hideOnboarding();
    SpeechModule.unlockAudio();
    const camResult = await CameraModule.startCamera();
    if (camResult.success) {
      SpeechModule.speak('Welcome to VisionBridge. Loading detection systems...', SpeechModule.PRIORITY.INFO);
    } else {
      SpeechModule.speak('Could not access camera. Please grant permission.', SpeechModule.PRIORITY.INFO);
      return;
    }
    loadLocalDetector();
    F.OCR.init();
    if (SpeechModule.isSupported) SpeechModule.startListening();

    // Init features that need user interaction first
    F.ShakeToScan.init(() => { if (!isProcessing) performScan(); });
    F.EmergencySOS.init(handleSOS);

    // Start ambient sound monitoring
    try {
      await F.AmbientSound.init();
      setInterval(updateAmbientSound, 2000);
    } catch { /* no mic access */ }
  });

  // --- SOS handler ---
  function handleSOS(reason, locationPromise) {
    const panel = document.getElementById('sos-panel');
    const reasonEl = document.getElementById('sos-reason');
    const locEl = document.getElementById('sos-location');
    panel.classList.remove('hidden');
    reasonEl.textContent = reason;
    locEl.textContent = 'Getting location...';
    F.Haptic.vibrate('sos');
    SpeechModule.speak('Emergency SOS activated! ' + reason, SpeechModule.PRIORITY.DANGER);

    const contactType = F.EmergencySOS.getContactType();
    const contact = F.EmergencySOS.getContact();

    const processLocation = async (loc) => {
      let locText = 'Location unavailable';
      let mapsLink = '';
      if (loc) {
        locText = `Lat: ${loc.lat.toFixed(5)}, Lng: ${loc.lng.toFixed(5)}`;
        mapsLink = `https://maps.google.com/?q=${loc.lat},${loc.lng}`;
      }
      locEl.textContent = locText;

      if (!contact) {
        SpeechModule.speak('No emergency contact configured. Please go to settings and add a phone number or email.', SpeechModule.PRIORITY.DANGER);
        locEl.textContent = locText + ' \u2014 No contact configured!';
        return;
      }

      // ---- PHONE: Instantly place a call ----
      if (contactType === 'phone') {
        locEl.textContent = locText + ' \u2014 Calling ' + contact + '...';
        SpeechModule.speak('Calling your emergency contact now.', SpeechModule.PRIORITY.DANGER);
        window.location.href = 'tel:' + encodeURIComponent(contact);
        return;
      }

      // ---- EMAIL: Send directly via formsubmit.co (no server config needed) ----
      locEl.textContent = locText + ' \u2014 Sending SOS email...';
      const messageBody = `EMERGENCY SOS - VisionBridge Alert\n\nA VisionBridge user needs immediate help.\n\nReason: ${reason}\nLocation: ${locText}\n${mapsLink ? 'Google Maps: ' + mapsLink : ''}\nTime: ${new Date().toLocaleString()}\n\nThis is an automated emergency alert from VisionBridge.`;

      try {
        // Try formsubmit.co first (works without any server config)
        const formRes = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(contact), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            _subject: 'EMERGENCY SOS - VisionBridge Alert',
            reason: reason,
            location: locText,
            maps_link: mapsLink || 'Not available',
            time: new Date().toLocaleString(),
            message: messageBody
          })
        });
        const formData = await formRes.json();

        if (formData.success === 'true' || formData.success === true) {
          locEl.textContent = locText + ' \u2014 SOS email sent!';
          SpeechModule.speak('SOS email sent successfully to ' + contact, SpeechModule.PRIORITY.DANGER);
          return;
        }
      } catch { /* formsubmit failed, try server fallback */ }

      // Fallback: try server-side Nodemailer
      try {
        const response = await fetch('/api/sos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact, reason, location: loc ? { lat: loc.lat, lng: loc.lng } : null })
        });
        const result = await response.json();
        if (result.success) {
          locEl.textContent = locText + ' \u2014 SOS email sent!';
          SpeechModule.speak('SOS email sent to ' + contact, SpeechModule.PRIORITY.DANGER);
          return;
        }
      } catch { /* server also failed */ }

      // Last resort: native share
      locEl.textContent = locText + ' \u2014 Opening share...';
      SpeechModule.speak('Opening share to send your SOS message.', SpeechModule.PRIORITY.DANGER);
      if (navigator.share) {
        await navigator.share({ title: 'EMERGENCY SOS', text: messageBody }).catch(() => {});
      } else {
        window.open('mailto:' + contact + '?subject=EMERGENCY SOS&body=' + encodeURIComponent(messageBody), '_blank');
      }
    };

    if (locationPromise && typeof locationPromise.then === 'function') {
      locationPromise.then(processLocation);
    } else {
      F.EmergencySOS.getLocation().then(processLocation);
    }
  }

  document.getElementById('sos-cancel')?.addEventListener('click', () => {
    document.getElementById('sos-panel').classList.add('hidden');
    F.Haptic.stop();
    SpeechModule.speak('SOS cancelled.', SpeechModule.PRIORITY.INFO);
  });

  // --- Ambient Sound Update ---
  function updateAmbientSound() {
    const result = F.AmbientSound.classify();
    if (!result) return;
    const bar = document.getElementById('ambient-sound');
    const icon = document.getElementById('ambient-icon');
    const label = document.getElementById('ambient-label');
    const fill = document.getElementById('ambient-level-fill');
    if (bar) bar.classList.remove('hidden');
    const icons = { quiet: '🔇', normal: '🔈', noise: '🔊', horn: '📢', alarm: '🚨', engine: '🚗' };
    if (icon) icon.textContent = icons[result.type] || '🔈';
    if (label) label.textContent = result.label;
    if (fill) fill.style.width = Math.min(100, result.level) + '%';
  }

  async function loadLocalDetector() {
    UIModule.setMode('scanning');
    UIModule.els.statusLabel.textContent = 'Loading AI...';
    localDetectorReady = await DetectorModule.init();
    if (localDetectorReady) {
      SpeechModule.speak('Detection ready. Tap Scan to analyze.', SpeechModule.PRIORITY.INFO);
    }
    UIModule.setMode('idle');
  }

  // --- Scan Button ---
  UIModule.els.btnScan.addEventListener('click', () => performScan());
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input, select, textarea, button')) { e.preventDefault(); performScan(); }
  });

  // --- Ask Button ---
  UIModule.els.btnListen.addEventListener('click', () => {
    if (!SpeechModule.isSupported) { SpeechModule.speak('Voice not supported in this browser.', SpeechModule.PRIORITY.INFO); return; }
    SpeechModule.speak('What would you like to know?', SpeechModule.PRIORITY.INFO);
    UIModule.setMode('listening'); UIModule.setListenActive(true);
    SpeechModule.triggerQuestionMode();
  });

  // --- Auto Scan ---
  UIModule.els.btnAuto.addEventListener('click', () => {
    autoScanEnabled = !autoScanEnabled;
    UIModule.setAutoActive(autoScanEnabled);
    if (autoScanEnabled) {
      SpeechModule.speak('Continuous scanning enabled.', SpeechModule.PRIORITY.INFO);
      startAutoScan();
    } else {
      SpeechModule.speak('Continuous scanning disabled.', SpeechModule.PRIORITY.INFO);
      stopAutoScan();
    }
  });

  // --- SOS Button ---
  document.getElementById('btn-sos')?.addEventListener('click', () => {
    F.EmergencySOS.triggerSOS('Manual SOS activated');
  });

  // --- Score Button ---
  document.getElementById('btn-score')?.addEventListener('click', () => {
    const modal = document.getElementById('score-modal');
    const content = document.getElementById('score-content');
    if (content) content.innerHTML = P.renderHTML();
    if (modal) modal.classList.remove('hidden');
  });
  document.getElementById('close-score')?.addEventListener('click', () => document.getElementById('score-modal')?.classList.add('hidden'));
  document.getElementById('score-backdrop')?.addEventListener('click', () => document.getElementById('score-modal')?.classList.add('hidden'));

  // --- Bookmark ---
  document.getElementById('btn-bookmark')?.addEventListener('click', () => {
    if (lastDescription) {
      const count = F.Favorites.save(lastDescription, currentMode);
      SpeechModule.speak(`Bookmarked! ${count} saved.`, SpeechModule.PRIORITY.INFO);
      F.Haptic.vibrate('clear');
    }
  });

  // --- Share ---
  document.getElementById('btn-share')?.addEventListener('click', async () => {
    if (lastDescription) {
      const ok = await F.ShareScan.share(lastDescription);
      SpeechModule.speak(ok ? 'Shared!' : 'Could not share.', SpeechModule.PRIORITY.INFO);
    }
  });

  // --- History ---
  document.getElementById('btn-history')?.addEventListener('click', () => {
    const modal = document.getElementById('history-modal');
    const list = document.getElementById('history-list');
    const items = F.ScanHistory.getAll();
    list.innerHTML = items.length ? items.map(h => `
      <div class="history-item">
        <div class="history-time">${new Date(h.time).toLocaleString()}</div>
        <div class="history-mode">${h.mode}</div>
        <div>${h.text?.slice(0, 200) || 'No description'}${h.text?.length > 200 ? '...' : ''}</div>
      </div>
    `).join('') : '<p style="color:var(--text-secondary);font-size:0.8rem">No scan history yet.</p>';
    modal.classList.remove('hidden');
  });
  document.getElementById('close-history')?.addEventListener('click', () => document.getElementById('history-modal')?.classList.add('hidden'));
  document.getElementById('history-backdrop')?.addEventListener('click', () => document.getElementById('history-modal')?.classList.add('hidden'));
  document.getElementById('clear-history')?.addEventListener('click', () => {
    F.ScanHistory.clear();
    document.getElementById('history-list').innerHTML = '<p style="color:var(--text-secondary);font-size:0.8rem">History cleared.</p>';
  });

  // --- Settings ---
  UIModule.els.btnSettings.addEventListener('click', () => UIModule.showSettings());
  UIModule.els.closeSettings.addEventListener('click', () => UIModule.hideSettings());
  UIModule.els.settingsBackdrop.addEventListener('click', () => UIModule.hideSettings());
  UIModule.els.scanInterval.addEventListener('input', (e) => {
    scanInterval = parseInt(e.target.value) * 1000;
    UIModule.els.scanIntervalValue.textContent = e.target.value + 's';
    if (autoScanEnabled) { stopAutoScan(); startAutoScan(); }
  });
  UIModule.els.voiceSelect.addEventListener('change', (e) => {
    const enVoices = voices.filter(v => v.lang.startsWith('en'));
    const voice = enVoices[parseInt(e.target.value)];
    if (voice) SpeechModule.setVoice(voice);
  });
  UIModule.els.speechRate.addEventListener('input', (e) => {
    SpeechModule.setRate(parseFloat(e.target.value));
    UIModule.els.speechRateValue.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
  });
  UIModule.els.wakeWordInput.addEventListener('change', (e) => SpeechModule.setWakeWord(e.target.value));
  UIModule.els.cameraToggle.addEventListener('click', () => {
    cameraPreviewVisible = !cameraPreviewVisible;
    UIModule.els.cameraToggle.setAttribute('aria-checked', cameraPreviewVisible);
    UIModule.toggleCameraPreview(cameraPreviewVisible);
  });
  UIModule.els.toggleCameraView.addEventListener('click', () => {
    cameraPreviewVisible = !cameraPreviewVisible;
    UIModule.els.cameraToggle.setAttribute('aria-checked', cameraPreviewVisible);
    UIModule.toggleCameraPreview(cameraPreviewVisible);
  });

  // --- Wake Word & Transcript ---
  SpeechModule.onWakeWord(() => {
    SpeechModule.stopSpeaking();
    SpeechModule.speak("I'm listening.", SpeechModule.PRIORITY.DESCRIPTION);
    UIModule.setMode('listening'); UIModule.setListenActive(true);
  });

  SpeechModule.onTranscript(async (question) => {
    UIModule.setListenActive(false); UIModule.setMode('scanning');
    // Check for SOS voice trigger
    if (question.toLowerCase().includes('help') || question.toLowerCase().includes('emergency')) {
      F.EmergencySOS.triggerSOS('Voice SOS: "' + question + '"');
      return;
    }
    SpeechModule.speak('Let me look...', SpeechModule.PRIORITY.INFO);
    const frame = CameraModule.captureFrame();
    if (!frame) { SpeechModule.speak('Camera not active.', SpeechModule.PRIORITY.DESCRIPTION); UIModule.setMode('idle'); return; }
    if (geminiAvailable) {
      const result = await ApiModule.askQuestion(frame, question);
      P.recordAPI(!result._cached);
      UIModule.addQA(question, result.answer);
      SpeechModule.speak(result.answer, SpeechModule.PRIORITY.DESCRIPTION);
    } else {
      const video = document.getElementById('camera-feed');
      const objs = await DetectorModule.detect(video);
      const r = DetectorModule.processForSpeech(objs, 'detailed');
      UIModule.addQA(question, r.description || 'I can detect objects but need the AI for specific questions.');
      SpeechModule.speak(r.description || r.summary, SpeechModule.PRIORITY.DESCRIPTION);
    }
  });

  SpeechModule.onSpeakStart(() => { if (!UIModule.els.statusRing.classList.contains('danger')) UIModule.setMode('speaking'); });
  SpeechModule.onSpeakEnd(() => { if (!isProcessing) UIModule.setMode(autoScanEnabled ? 'scanning' : 'idle'); });

  // ==========================================
  //   CORE SCAN — ALL FEATURES INTEGRATED
  // ==========================================

  async function performScan() {
    if (isProcessing) return;
    isProcessing = true;
    const scanStart = Date.now();
    UIModule.setMode('scanning');
    UIModule.showScanAnimation();

    const video = document.getElementById('camera-feed');
    if (!video || !video.videoWidth) {
      SpeechModule.speak('Camera not available.', SpeechModule.PRIORITY.DESCRIPTION);
      isProcessing = false; UIModule.setMode('idle'); return;
    }

    // Night mode check
    const canvas = document.getElementById('capture-canvas');
    F.NightMode.analyzeBrightness(canvas);

    if (currentMode === 'read') {
      await performOCRScan(video);
    } else if (currentMode === 'measure') {
      await performMeasureScan(video);
    } else {
      await performStandardScan(video, canvas);
    }

    // Record performance
    const latency = Date.now() - scanStart;
    P.recordScan(true, latency, 0, 0);

    // Log to history
    if (lastDescription) {
      F.ScanHistory.add({ mode: currentMode, text: lastDescription });
    }

    isProcessing = false;
  }

  // --- OCR / Read Mode ---
  async function performOCRScan(video) {
    SpeechModule.speak('Reading text... Hold steady.', SpeechModule.PRIORITY.INFO);

    // Try local OCR first (Tesseract.js)
    if (F.OCR.isReady) {
      const text = await F.OCR.readFromVideo(video);
      if (text && text.length > 2) {
        lastDescription = text;
        UIModule.addDescription('\uD83D\uDCD6 Text found:\n' + text);
        SpeechModule.speak(text, SpeechModule.PRIORITY.DESCRIPTION);
        P.recordOCR();
        return;
      }
    }

    // Fallback: Use Gemini API for text reading
    if (geminiAvailable) {
      const frame = CameraModule.captureFrame();
      if (frame) {
        const result = await ApiModule.askQuestion(frame,
          'Read ALL text visible in this image. If there are signs, labels, or writing, read them word for word. If no text is visible, say so.');
        if (result && result.answer) {
          lastDescription = result.answer;
          UIModule.addDescription('\uD83D\uDCD6 ' + result.answer);
          SpeechModule.speak(result.answer, SpeechModule.PRIORITY.DESCRIPTION);
          P.recordOCR();
          return;
        }
      }
    }

    // Both failed
    if (!F.OCR.isReady) {
      SpeechModule.speak('Text reader is still loading. Try again in a moment.', SpeechModule.PRIORITY.INFO);
    } else {
      UIModule.addDescription('No readable text found. Try pointing at text more directly and ensure good lighting.');
      SpeechModule.speak('No readable text found. Try moving closer to the text.', SpeechModule.PRIORITY.DESCRIPTION);
    }
  }

  // --- Standard Scan (Detailed/Danger/Summary) ---
  async function performStandardScan(video, canvas) {
    // LOCAL DETECTION (instant, always works)
    let localResult = null;
    let detectedObjects = [];
    if (localDetectorReady) {
      detectedObjects = await DetectorModule.detect(video) || [];
      localResult = DetectorModule.processForSpeech(detectedObjects, currentMode);

      // Record confidence
      detectedObjects.forEach(o => { if (o.score) P.recordConfidence(Math.round(o.score * 100)); });

      // Scene change detection
      const changes = F.SceneMemory.detectChanges(detectedObjects);
      if (changes) {
        SpeechModule.speak('Scene changed: ' + changes, SpeechModule.PRIORITY.INFO);
      }

      // Indoor nav recognition
      const place = F.IndoorNav.recognizeLocation(detectedObjects);
      if (place) {
        SpeechModule.speak(`This looks like your saved location: ${place}.`, SpeechModule.PRIORITY.INFO);
      }

      // Immediate danger handling
      if (localResult.dangers?.length > 0) {
        UIModule.setMode('danger');
        UIModule.showDangers(localResult.dangers);
        F.Haptic.vibrateForDangers(localResult.dangers);
        F.SpatialAudio.playForDangers(localResult.dangers);

        const closest = localResult.dangers.reduce((a, b) => (a.distanceM < b.distanceM ? a : b), localResult.dangers[0]);
        if (closest.distanceM) F.DistanceAlert.startProximityBeep(closest.distanceM, closest.direction);

        const critical = localResult.dangers.filter(d => d.severity === 'critical');
        if (critical.length) {
          SpeechModule.speak('Warning! ' + critical.map(d => d.description).join('. '), SpeechModule.PRIORITY.DANGER);
        }
        P.recordScan(true, 0, detectedObjects.length, localResult.dangers.length);
      } else {
        UIModule.showDangers([]);
      }
    }

    // GEMINI ENHANCEMENT (optional, 10s timeout)
    let geminiResult = null;
    if (geminiAvailable) {
      try {
        const frame = CameraModule.captureFrame();
        if (frame) {
          geminiResult = await Promise.race([
            ApiModule.analyzeScene(frame, currentMode),
            new Promise(r => setTimeout(() => r(null), 10000))
          ]);
          P.recordAPI(!!geminiResult && !geminiResult._cached);
        }
      } catch { P.recordAPI(false); }
    }

    const hasGemini = geminiResult?.description && !geminiResult._cached && !geminiResult.description.includes('AI service');

    // SPEAK RESULTS
    if (currentMode === 'danger') {
      if (hasGemini && geminiResult.dangers?.length) {
        UIModule.showDangers(geminiResult.dangers);
        F.SpatialAudio.playForDangers(geminiResult.dangers);
        F.Haptic.vibrateForDangers(geminiResult.dangers);
        lastDescription = geminiResult.dangers.map(d => d.description).join('. ');
        SpeechModule.speak('Danger! ' + lastDescription, SpeechModule.PRIORITY.DANGER);
      } else if (!localResult?.dangers?.length) {
        lastDescription = 'No immediate dangers detected. Path appears clear.';
        UIModule.addDescription(lastDescription);
        SpeechModule.speak(lastDescription, SpeechModule.PRIORITY.DESCRIPTION);
        F.Haptic.vibrate('clear');
      }
    } else if (currentMode === 'summary') {
      const text = hasGemini ? geminiResult.summary : (localResult?.summary || 'No objects detected.');
      lastDescription = text;
      UIModule.addDescription(text);
      SpeechModule.speak(text, SpeechModule.PRIORITY.DESCRIPTION);
    } else {
      // Detailed
      if (hasGemini) {
        if (geminiResult.dangers?.length) {
          UIModule.setMode('danger');
          UIModule.showDangers(geminiResult.dangers);
          F.SpatialAudio.playForDangers(geminiResult.dangers);
          F.Haptic.vibrateForDangers(geminiResult.dangers);
        }
        lastDescription = geminiResult.description;
        UIModule.addDescription(geminiResult.description);
        SpeechModule.speak(geminiResult.description, SpeechModule.PRIORITY.DESCRIPTION);
      } else if (localResult) {
        const text = localResult.description || localResult.summary;
        lastDescription = text;
        UIModule.addDescription(text);
        SpeechModule.speak(text, SpeechModule.PRIORITY.DESCRIPTION);
      }
    }

    // Night mode warning
    if (F.NightMode.isNight) {
      SpeechModule.speak('Note: low light conditions. Detection may be less accurate.', SpeechModule.PRIORITY.INFO);
    }
  }

  // --- Measure Scan ---
  async function performMeasureScan(video) {
    if (!localDetectorReady) {
      SpeechModule.speak('Detection model loading. Please wait.', SpeechModule.PRIORITY.INFO);
      isProcessing = false; return;
    }
    SpeechModule.speak('Measuring. Hold steady...', SpeechModule.PRIORITY.INFO);
    await DetectorModule.detect(video);
    await new Promise(r => setTimeout(r, 1000));
    const objects = await DetectorModule.detect(video);
    if (objects?.length) {
      const html = objects.map(obj => {
        const motion = obj.moving ? `Moving ${obj.moveDir} at ${obj.speed}` : 'Stationary';
        const cls = obj.moving ? 'measure-moving' : 'measure-stationary';
        return `<li class="measure-object"><div class="measure-name">${obj.label} (${obj.confidence}%)</div>
          <div class="measure-details"><span class="measure-detail-label">Size:</span><span>${obj.size}</span>
          <span class="measure-detail-label">Distance:</span><span>${obj.distance}</span>
          <span class="measure-detail-label">Motion:</span><span class="${cls}">${motion}</span></div></li>`;
      }).join('');
      UIModule.addDescription(`<ul class="measure-objects">${html}</ul>`, true);
      lastDescription = objects.map(o => `${o.label}: ${o.distance}, ${o.moving ? o.speed : 'stationary'}`).join('. ');
      SpeechModule.speak(lastDescription, SpeechModule.PRIORITY.DESCRIPTION);
    } else {
      lastDescription = 'No objects detected for measurement.';
      UIModule.addDescription(lastDescription);
      SpeechModule.speak(lastDescription, SpeechModule.PRIORITY.DESCRIPTION);
    }
  }

  // ==========================================
  //   REAL-TIME CONTINUOUS DETECTION ENGINE
  // ==========================================

  let realtimeActive = false;
  let realtimeTimer = null;
  let prevObjects = [];           // Object labels from last frame
  let lastGeminiTime = 0;         // Timestamp of last Gemini call
  let lastLocalAnnounce = 0;      // Timestamp of last local announcement
  const REALTIME_INTERVAL = 1000; // Local detection every 1s
  const GEMINI_INTERVAL = 10000;  // Rich Gemini description every 10s
  const ANNOUNCE_COOLDOWN = 2000; // Don't repeat local announcements within 2s

  function startRealtime() {
    if (realtimeActive) return;
    realtimeActive = true;
    prevObjects = [];
    lastGeminiTime = 0;
    lastLocalAnnounce = 0;
    realtimeLoop();
  }

  function stopRealtime() {
    realtimeActive = false;
    if (realtimeTimer) { clearTimeout(realtimeTimer); realtimeTimer = null; }
  }

  async function realtimeLoop() {
    if (!realtimeActive) return;

    const video = document.getElementById('camera-feed');
    if (!video || !video.videoWidth || !localDetectorReady) {
      realtimeTimer = setTimeout(realtimeLoop, REALTIME_INTERVAL);
      return;
    }

    try {
      // --- Local detection (instant, every frame) ---
      const objects = await DetectorModule.detect(video) || [];
      const now = Date.now();

      // Extract labels for comparison
      const curLabels = objects.map(o => o.label).sort();
      const prevLabels = prevObjects.map(o => o.label).sort();

      // Detect dangers immediately
      const result = DetectorModule.processForSpeech(objects, currentMode);
      if (result.dangers?.length > 0) {
        UIModule.setMode('danger');
        UIModule.showDangers(result.dangers);
        F.Haptic.vibrateForDangers(result.dangers);
        F.SpatialAudio.playForDangers(result.dangers);

        const critical = result.dangers.filter(d => d.severity === 'critical');
        if (critical.length) {
          SpeechModule.speak('Warning! ' + critical.map(d => d.description).join('. '), SpeechModule.PRIORITY.DANGER);
        }
      } else {
        if (UIModule.els.statusRing.classList.contains('danger')) {
          UIModule.showDangers([]);
          UIModule.setMode('scanning');
        }
      }

      // Scene change detection: announce only when objects change
      const sceneChanged = !arraysEqual(curLabels, prevLabels);
      if (sceneChanged && now - lastLocalAnnounce > ANNOUNCE_COOLDOWN && !isProcessing) {
        const newItems = curLabels.filter(l => !prevLabels.includes(l));
        const goneItems = prevLabels.filter(l => !curLabels.includes(l));

        let announcement = '';
        if (newItems.length && goneItems.length) {
          announcement = `Now I see: ${countItems(curLabels)}.`;
        } else if (newItems.length) {
          announcement = `${newItems.join(', ')} appeared.`;
        } else if (goneItems.length) {
          announcement = `${goneItems.join(', ')} no longer visible.`;
        }

        if (announcement && currentMode !== 'read' && currentMode !== 'measure') {
          lastDescription = result.description || result.summary || announcement;
          UIModule.addDescription(lastDescription);
          // Only speak short local updates, don't talk over Gemini
          if (!SpeechModule.isSpeakingNow()) {
            SpeechModule.speak(announcement, SpeechModule.PRIORITY.INFO);
          }
          lastLocalAnnounce = now;
          F.ScanHistory.add({ mode: currentMode, text: lastDescription });
        }
      }

      prevObjects = objects;

      // Scene memory + indoor nav (runs silently)
      F.SceneMemory.detectChanges(objects);
      F.IndoorNav.recognizeLocation(objects);

      // Record performance
      objects.forEach(o => { if (o.score) P.recordConfidence(Math.round(o.score * 100)); });

      // --- Gemini enrichment (every 15s, non-blocking) ---
      if (geminiAvailable && now - lastGeminiTime > GEMINI_INTERVAL && !isProcessing
          && currentMode !== 'read' && currentMode !== 'measure') {
        lastGeminiTime = now;
        // Fire and forget - don't block the realtime loop
        enrichWithGemini();
      }

    } catch (e) {
      console.warn('[Realtime] Error:', e.message);
    }

    // Schedule next frame
    const interval = F.BatteryAware.getRecommendedInterval(REALTIME_INTERVAL);
    realtimeTimer = setTimeout(realtimeLoop, interval);
  }

  async function enrichWithGemini() {
    try {
      const frame = CameraModule.captureFrame();
      if (!frame) return;
      const result = await Promise.race([
        ApiModule.analyzeScene(frame, currentMode),
        new Promise(r => setTimeout(() => r(null), 8000))
      ]);
      P.recordAPI(!!result && !result._cached);

      if (result?.description && !result._cached && !result.description.includes('AI service')) {
        lastDescription = result.description;
        UIModule.addDescription(result.description);
        if (!SpeechModule.isSpeakingNow()) {
          SpeechModule.speak(result.description, SpeechModule.PRIORITY.DESCRIPTION);
        }
        if (result.dangers?.length) {
          UIModule.showDangers(result.dangers);
          F.SpatialAudio.playForDangers(result.dangers);
        }
      }
    } catch { P.recordAPI(false); }
  }

  // Helpers
  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
    return true;
  }

  function countItems(labels) {
    const counts = {};
    labels.forEach(l => { counts[l] = (counts[l] || 0) + 1; });
    return Object.entries(counts).map(([k, v]) => v > 1 ? `${v} ${k}s` : k).join(', ');
  }

  // --- Auto Scan toggle now activates real-time mode ---
  function startAutoScan() {
    stopAutoScan();
    startRealtime();
  }
  function stopAutoScan() {
    stopRealtime();
  }

})();

