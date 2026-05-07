/**
 * app.js â€” Main VisionBridge application controller
 * 
 * HYBRID ARCHITECTURE:
 * - PRIMARY: TensorFlow.js COCO-SSD runs locally in the browser (always works)
 * - OPTIONAL: Gemini API adds richer descriptions when available
 * 
 * The app NEVER stops working, even if the API is down.
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

  // --- Initialization ---
  const status = await ApiModule.checkStatus();
  geminiAvailable = status.apiKeyConfigured;
  UIModule.setApiStatus(status.apiKeyConfigured);

  const voices = await SpeechModule.initSynthesis();
  const enVoices = voices.filter(v => v.lang.startsWith('en'));
  UIModule.populateVoices(voices);

  // --- Mode Descriptions ---
  const MODE_NAMES = {
    detailed: 'Detailed mode. Full scene description with danger alerts.',
    danger: 'Danger mode. Only immediate, close-range threats.',
    summary: 'Summary mode. One sentence scene overview.',
    measure: 'Measure mode. Object sizes and movement speeds.'
  };

  // --- Event: Mode Tabs ---
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      if (mode === currentMode) return;
      currentMode = mode;
      document.querySelectorAll('.mode-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      SpeechModule.speak(MODE_NAMES[mode], SpeechModule.PRIORITY.INFO);
    });
  });

  // --- Event: Onboarding ---
  UIModule.els.btnStart.addEventListener('click', async () => {
    UIModule.hideOnboarding();
    SpeechModule.unlockAudio();

    // Start camera
    const camResult = await CameraModule.startCamera();
    if (camResult.success) {
      SpeechModule.speak('Welcome to VisionBridge. Loading object detection model...', SpeechModule.PRIORITY.INFO);
    } else {
      SpeechModule.speak('Could not access camera. Please grant permission and reload.', SpeechModule.PRIORITY.INFO);
      return;
    }

    // Load local TF.js model in background
    loadLocalDetector();

    // Start speech recognition
    if (SpeechModule.isSupported) {
      SpeechModule.startListening();
    }
  });

  async function loadLocalDetector() {
    try {
      UIModule.setMode('scanning');
      UIModule.els.statusLabel.textContent = 'Loading AI...';
      localDetectorReady = await DetectorModule.init();
      if (localDetectorReady) {
        SpeechModule.speak('Object detection ready. Tap Scan to analyze your surroundings.', SpeechModule.PRIORITY.INFO);
        UIModule.setMode('idle');
      } else {
        SpeechModule.speak('Local detection could not load. I will use the cloud AI instead.', SpeechModule.PRIORITY.INFO);
        UIModule.setMode('idle');
      }
    } catch (err) {
      console.error('Detector init failed:', err);
      UIModule.setMode('idle');
    }
  }

  // --- Event: Scan Button ---
  UIModule.els.btnScan.addEventListener('click', () => performScan());

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input, select, textarea, button')) {
      e.preventDefault();
      performScan();
    }
  });

  // --- Event: Ask Button ---
  UIModule.els.btnListen.addEventListener('click', () => {
    if (!SpeechModule.isSupported) {
      SpeechModule.speak('Voice recognition is not supported in this browser.', SpeechModule.PRIORITY.INFO);
      return;
    }
    SpeechModule.speak('What would you like to know?', SpeechModule.PRIORITY.INFO);
    UIModule.setMode('listening');
    UIModule.setListenActive(true);
    SpeechModule.triggerQuestionMode();
  });

  // --- Event: Auto Scan Toggle ---
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

  // --- Settings Events ---
  UIModule.els.btnSettings.addEventListener('click', () => UIModule.showSettings());
  UIModule.els.closeSettings.addEventListener('click', () => UIModule.hideSettings());
  UIModule.els.settingsBackdrop.addEventListener('click', () => UIModule.hideSettings());

  UIModule.els.scanInterval.addEventListener('input', (e) => {
    scanInterval = parseInt(e.target.value) * 1000;
    UIModule.els.scanIntervalValue.textContent = e.target.value + 's';
    if (autoScanEnabled) { stopAutoScan(); startAutoScan(); }
  });

  UIModule.els.voiceSelect.addEventListener('change', (e) => {
    const voice = enVoices[parseInt(e.target.value)];
    if (voice) SpeechModule.setVoice(voice);
  });

  UIModule.els.speechRate.addEventListener('input', (e) => {
    SpeechModule.setRate(parseFloat(e.target.value));
    UIModule.els.speechRateValue.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
  });

  UIModule.els.wakeWordInput.addEventListener('change', (e) => {
    SpeechModule.setWakeWord(e.target.value);
  });

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

  // --- Wake Word ---
  SpeechModule.onWakeWord(() => {
    SpeechModule.stopSpeaking();
    SpeechModule.speak('I\'m listening. What would you like to know?', SpeechModule.PRIORITY.DESCRIPTION);
    UIModule.setMode('listening');
    UIModule.setListenActive(true);
  });

  // --- Question Received ---
  SpeechModule.onTranscript(async (question) => {
    UIModule.setListenActive(false);
    UIModule.setMode('scanning');
    SpeechModule.speak('Let me look...', SpeechModule.PRIORITY.INFO);

    const frame = CameraModule.captureFrame();
    if (!frame) {
      SpeechModule.speak('Camera not active.', SpeechModule.PRIORITY.DESCRIPTION);
      UIModule.setMode('idle');
      return;
    }

    // Try Gemini for Q&A (local detector can't answer arbitrary questions)
    if (geminiAvailable) {
      const result = await ApiModule.askQuestion(frame, question);
      UIModule.addQA(question, result.answer);
      UIModule.setMode('speaking');
      SpeechModule.speak(result.answer, SpeechModule.PRIORITY.DESCRIPTION);
    } else {
      // Fall back to local detection description
      const video = document.getElementById('camera-feed');
      const localObjs = await DetectorModule.detect(video);
      const localResult = DetectorModule.processForSpeech(localObjs, 'detailed');
      const answer = localResult.description || 'I can detect objects but cannot answer specific questions without the AI service.';
      UIModule.addQA(question, answer);
      SpeechModule.speak(answer, SpeechModule.PRIORITY.DESCRIPTION);
    }
  });

  // --- Speech Callbacks ---
  SpeechModule.onSpeakStart(() => {
    if (!UIModule.els.statusRing.classList.contains('danger')) {
      UIModule.setMode('speaking');
    }
  });

  SpeechModule.onSpeakEnd(() => {
    if (!isProcessing) {
      UIModule.setMode(autoScanEnabled ? 'scanning' : 'idle');
    }
  });

  // ==========================================
  //    CORE SCAN â€” LOCAL FIRST, API OPTIONAL
  // ==========================================

  async function performScan() {
    if (isProcessing) return;
    isProcessing = true;

    UIModule.setMode('scanning');
    UIModule.showScanAnimation();

    const video = document.getElementById('camera-feed');
    if (!video || !video.videoWidth) {
      SpeechModule.speak('Camera is not available.', SpeechModule.PRIORITY.DESCRIPTION);
      isProcessing = false;
      UIModule.setMode('idle');
      return;
    }

    if (currentMode === 'measure') {
      await performMeasureScan(video);
    } else {
      await performStandardScan(video);
    }

    isProcessing = false;
  }

  // --- Standard Scan: local detection + optional Gemini enhancement ---
  async function performStandardScan(video) {
    // STEP 1: Always run local detection (instant, never fails)
    let localResult = null;
    if (localDetectorReady) {
      const localObjs = await DetectorModule.detect(video);
      localResult = DetectorModule.processForSpeech(localObjs, currentMode);

      // Show dangers IMMEDIATELY from local detection
      if (localResult.dangers && localResult.dangers.length > 0) {
        UIModule.setMode('danger');
        UIModule.showDangers(localResult.dangers);

        const critical = localResult.dangers.filter(d => d.severity === 'critical');
        if (critical.length > 0) {
          SpeechModule.playDangerBeep();
          SpeechModule.speak('Warning! ' + critical.map(d => d.description).join('. '), SpeechModule.PRIORITY.DANGER);
        }
      } else {
        UIModule.showDangers([]);
      }
    }

    // STEP 2: Try Gemini for richer description (non-blocking, optional)
    let geminiResult = null;
    if (geminiAvailable) {
      try {
        const frame = CameraModule.captureFrame();
        if (frame) {
          // Fire API call but don't wait forever â€” use a 15s race
          geminiResult = await Promise.race([
            ApiModule.analyzeScene(frame, currentMode),
            new Promise(resolve => setTimeout(() => resolve(null), 15000))
          ]);
        }
      } catch (err) {
        console.warn('[Scan] Gemini enhancement failed:', err.message);
      }
    }

    // STEP 3: Decide what to show and speak
    const hasGemini = geminiResult && geminiResult.description && !geminiResult._cached
      && !geminiResult.description.includes('AI service');

    if (currentMode === 'danger') {
      handleDangerResult(localResult, geminiResult, hasGemini);
    } else if (currentMode === 'summary') {
      handleSummaryResult(localResult, geminiResult, hasGemini);
    } else {
      handleDetailedResult(localResult, geminiResult, hasGemini);
    }
  }

  function handleDangerResult(local, gemini, hasGemini) {
    if (hasGemini && gemini.dangers && gemini.dangers.length > 0) {
      // Use Gemini's richer danger descriptions
      UIModule.setMode('danger');
      UIModule.showDangers(gemini.dangers);
      SpeechModule.playDangerBeep();
      const text = gemini.dangers.map(d => `${d.description}, ${d.direction}`).join('. ');
      SpeechModule.speak('Danger! ' + text, SpeechModule.PRIORITY.DANGER);
    } else if (local && local.dangers && local.dangers.length > 0) {
      // Already spoken by local detection above
    } else {
      const msg = (hasGemini && gemini.summary) ? gemini.summary
        : (local ? local.summary : 'No immediate dangers detected. Path appears clear.');
      UIModule.addDescription(msg);
      SpeechModule.speak(msg, SpeechModule.PRIORITY.DESCRIPTION);
    }
  }

  function handleSummaryResult(local, gemini, hasGemini) {
    const text = hasGemini ? (gemini.summary || gemini.description)
      : (local ? local.summary : 'Could not generate summary.');
    UIModule.addDescription(text);
    SpeechModule.speak(text, SpeechModule.PRIORITY.DESCRIPTION);
  }

  function handleDetailedResult(local, gemini, hasGemini) {
    if (hasGemini) {
      // Gemini gave a good response â€” use its richer description
      if (gemini.dangers && gemini.dangers.length > 0) {
        UIModule.setMode('danger');
        UIModule.showDangers(gemini.dangers);
        const critical = gemini.dangers.filter(d => d.severity === 'critical');
        if (critical.length > 0) {
          SpeechModule.playDangerBeep();
          SpeechModule.speak('Warning! ' + critical.map(d => d.description).join('. '), SpeechModule.PRIORITY.DANGER);
        }
      }
      UIModule.addDescription(gemini.description);
      SpeechModule.speak(gemini.description, SpeechModule.PRIORITY.DESCRIPTION);
    } else if (local) {
      // Use local detection result
      if (local.description) {
        UIModule.addDescription(local.description);
        SpeechModule.speak(local.description, SpeechModule.PRIORITY.DESCRIPTION);
      } else {
        UIModule.addDescription(local.summary);
        SpeechModule.speak(local.summary, SpeechModule.PRIORITY.DESCRIPTION);
      }
    } else {
      SpeechModule.speak('Could not analyze the scene. Please try again.', SpeechModule.PRIORITY.DESCRIPTION);
    }
  }

  // --- Measure Scan: local object detection with size + speed ---
  async function performMeasureScan(video) {
    if (!localDetectorReady) {
      SpeechModule.speak('Object detection model is still loading. Please wait.', SpeechModule.PRIORITY.INFO);
      isProcessing = false;
      return;
    }

    SpeechModule.speak('Measuring objects. Hold steady...', SpeechModule.PRIORITY.INFO);

    // First detection
    await DetectorModule.detect(video);

    // Wait 1 second for motion comparison
    await new Promise(r => setTimeout(r, 1000));

    // Second detection (motion tracked automatically)
    const objects = await DetectorModule.detect(video);

    if (objects && objects.length > 0) {
      const objectsHTML = objects.map(obj => {
        const movingClass = obj.moving ? 'measure-moving' : 'measure-stationary';
        const motionLabel = obj.moving ? `Moving ${obj.moveDir} at ${obj.speed}` : 'Stationary';
        return `
          <li class="measure-object">
            <div class="measure-name">${obj.label} (${obj.confidence}%)</div>
            <div class="measure-details">
              <span class="measure-detail-label">Size:</span><span>${obj.size}</span>
              <span class="measure-detail-label">Distance:</span><span>${obj.distance}</span>
              <span class="measure-detail-label">Motion:</span><span class="${movingClass}">${motionLabel}</span>
            </div>
          </li>`;
      }).join('');

      UIModule.addDescription(`<ul class="measure-objects">${objectsHTML}</ul>`, true);

      const spoken = objects.map(o =>
        `${o.label}, about ${o.distance} away, ${o.moving ? 'moving ' + o.moveDir + ' at ' + o.speed : 'stationary'}`
      ).join('. ');
      SpeechModule.speak(spoken, SpeechModule.PRIORITY.DESCRIPTION);
    } else {
      UIModule.addDescription('No objects detected for measurement.');
      SpeechModule.speak('No objects detected to measure.', SpeechModule.PRIORITY.DESCRIPTION);
    }
  }

  // --- Auto Scan ---
  function startAutoScan() {
    stopAutoScan();
    performScan();
    autoScanTimer = setInterval(() => {
      if (!isProcessing) performScan();
    }, scanInterval);
  }

  function stopAutoScan() {
    if (autoScanTimer) {
      clearInterval(autoScanTimer);
      autoScanTimer = null;
    }
  }

})();
