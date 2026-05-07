/**
 * app.js — Main VisionGuard application controller
 * Orchestrates camera, speech, API, and UI modules.
 * Supports 4 analysis modes: Detailed, Danger, Summary, Measure.
 */
(async function VisionGuardApp() {
  'use strict';

  // --- State ---
  let autoScanEnabled = false;
  let autoScanTimer = null;
  let scanInterval = 6000;
  let isProcessing = false;
  let cameraPreviewVisible = false;
  let currentMode = 'detailed'; // detailed | danger | summary | measure

  // --- Initialization ---
  const status = await ApiModule.checkStatus();
  UIModule.setApiStatus(status.apiKeyConfigured);

  if (!status.apiKeyConfigured) {
    console.warn('VisionGuard: API key not configured.');
  }

  const voices = await SpeechModule.initSynthesis();
  const enVoices = voices.filter(v => v.lang.startsWith('en'));
  UIModule.populateVoices(voices);

  // --- Mode Descriptions (spoken on switch) ---
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

      // Update tab UI
      document.querySelectorAll('.mode-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      // Announce mode change
      SpeechModule.speak(MODE_NAMES[mode], SpeechModule.PRIORITY.INFO);

      console.log('[App] Mode switched to:', mode);
    });
  });

  // --- Event: Onboarding ---
  UIModule.els.btnStart.addEventListener('click', async () => {
    UIModule.hideOnboarding();
    SpeechModule.unlockAudio();

    const camResult = await CameraModule.startCamera();
    if (camResult.success) {
      SpeechModule.speak('Welcome to VisionGuard. Your camera is active. Select a mode above, then tap Scan.', SpeechModule.PRIORITY.INFO);
    } else {
      SpeechModule.speak('Welcome to VisionGuard. I could not access your camera. Please grant camera permission and reload.', SpeechModule.PRIORITY.INFO);
    }

    if (SpeechModule.isSupported) {
      SpeechModule.startListening();
    }
  });

  // --- Event: Scan Button ---
  UIModule.els.btnScan.addEventListener('click', () => {
    performScan();
  });

  // Keyboard: Space to scan
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input, select, textarea, button')) {
      e.preventDefault();
      performScan();
    }
  });

  // --- Event: Ask Button ---
  UIModule.els.btnListen.addEventListener('click', () => {
    if (!SpeechModule.isSupported) {
      SpeechModule.speak('Voice recognition is not supported in this browser. Please use Chrome or Edge.', SpeechModule.PRIORITY.INFO);
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

  // --- Event: Settings ---
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

  // --- Wake Word Callback ---
  SpeechModule.onWakeWord(() => {
    SpeechModule.stopSpeaking();
    SpeechModule.speak('I\'m listening. What would you like to know?', SpeechModule.PRIORITY.DESCRIPTION);
    UIModule.setMode('listening');
    UIModule.setListenActive(true);
  });

  // --- Question Received Callback ---
  SpeechModule.onTranscript(async (question) => {
    UIModule.setListenActive(false);
    UIModule.setMode('scanning');

    SpeechModule.speak('Let me look...', SpeechModule.PRIORITY.INFO);

    const frame = CameraModule.captureFrame();
    if (!frame) {
      SpeechModule.speak('I cannot see anything. The camera may not be active.', SpeechModule.PRIORITY.DESCRIPTION);
      UIModule.setMode('idle');
      return;
    }

    const result = await ApiModule.askQuestion(frame, question);
    UIModule.addQA(question, result.answer);
    UIModule.setMode('speaking');
    SpeechModule.speak(result.answer, SpeechModule.PRIORITY.DESCRIPTION);
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
  // ===  CORE SCAN LOGIC (mode-aware)  ===
  // ==========================================

  async function performScan() {
    if (isProcessing) return;
    isProcessing = true;

    UIModule.setMode('scanning');
    UIModule.showScanAnimation();

    const frame = CameraModule.captureFrame();
    if (!frame) {
      SpeechModule.speak('Camera is not available. Please make sure camera access is granted.', SpeechModule.PRIORITY.DESCRIPTION);
      isProcessing = false;
      UIModule.setMode('idle');
      return;
    }

    if (currentMode === 'measure') {
      await performMeasureScan(frame);
    } else {
      await performStandardScan(frame);
    }

    isProcessing = false;
  }

  // --- Standard scan (Detailed, Danger, Summary modes) ---
  async function performStandardScan(frame) {
    const result = await ApiModule.analyzeScene(frame, currentMode);

    // --- DANGER MODE: speak only dangers ---
    if (currentMode === 'danger') {
      if (result.dangers && result.dangers.length > 0) {
        UIModule.setMode('danger');
        UIModule.showDangers(result.dangers);

        SpeechModule.playDangerBeep();
        const dangerText = result.dangers.map(d => {
          const dist = d.distance ? ` ${d.distance}` : '';
          return `${d.description}${dist}, ${d.direction}`;
        }).join('. ');
        SpeechModule.speak('Danger! ' + dangerText, SpeechModule.PRIORITY.DANGER);
      } else {
        UIModule.showDangers([]);
        const safeMsg = result.summary || 'No immediate dangers detected. Path appears clear.';
        UIModule.addDescription(safeMsg);
        SpeechModule.speak(safeMsg, SpeechModule.PRIORITY.DESCRIPTION);
      }
      return;
    }

    // --- SUMMARY MODE: speak only summary ---
    if (currentMode === 'summary') {
      const summaryText = result.summary || result.description || 'Could not generate summary.';
      UIModule.addDescription(summaryText);
      SpeechModule.speak(summaryText, SpeechModule.PRIORITY.DESCRIPTION);
      return;
    }

    // --- DETAILED MODE: full description + dangers ---
    if (result.dangers && result.dangers.length > 0) {
      UIModule.setMode('danger');
      UIModule.showDangers(result.dangers);

      const criticalDangers = result.dangers.filter(d => d.severity === 'critical');
      if (criticalDangers.length > 0) {
        SpeechModule.playDangerBeep();
        const dangerText = 'Warning! ' + criticalDangers.map(d => d.description).join('. ');
        SpeechModule.speak(dangerText, SpeechModule.PRIORITY.DANGER);
      }

      const warnings = result.dangers.filter(d => d.severity !== 'critical');
      if (warnings.length > 0) {
        const warnText = 'Also be aware: ' + warnings.map(d => d.description).join('. ');
        SpeechModule.speak(warnText, SpeechModule.PRIORITY.DESCRIPTION);
      }
    } else {
      UIModule.showDangers([]);
    }

    if (result.description) {
      UIModule.addDescription(result.description);
      SpeechModule.speak(result.description, SpeechModule.PRIORITY.DESCRIPTION);
    } else if (result.summary) {
      UIModule.addDescription(result.summary);
      SpeechModule.speak(result.summary, SpeechModule.PRIORITY.DESCRIPTION);
    }
  }

  // --- Measure scan: capture two frames ~1s apart, send both for comparison ---
  async function performMeasureScan(frame1) {
    SpeechModule.speak('Measuring objects. Hold steady...', SpeechModule.PRIORITY.INFO);

    // Wait 1 second, then capture second frame
    await new Promise(r => setTimeout(r, 1000));
    const frame2 = CameraModule.captureFrame();

    const result = await ApiModule.measureScene(frame1, frame2);

    // Build spoken output
    if (result.objects && result.objects.length > 0) {
      // Build HTML for output card
      const objectsHTML = result.objects.map(obj => {
        const movingClass = obj.moving ? 'measure-moving' : 'measure-stationary';
        const movingLabel = obj.moving ? `Moving ${obj.direction || ''} at ${obj.speed}` : 'Stationary';
        return `
          <li class="measure-object">
            <div class="measure-name">${obj.name}</div>
            <div class="measure-details">
              <span class="measure-detail-label">Size:</span><span>${obj.size}</span>
              <span class="measure-detail-label">Distance:</span><span>${obj.distance}</span>
              <span class="measure-detail-label">Motion:</span><span class="${movingClass}">${movingLabel}</span>
            </div>
          </li>`;
      }).join('');

      UIModule.addDescription(`<ul class="measure-objects">${objectsHTML}</ul>`, true);

      // Speak summary
      const spokenSummary = result.summary || result.objects.map(o =>
        `${o.name}: ${o.size}, ${o.distance} away, ${o.moving ? 'moving ' + (o.speed || '') : 'stationary'}`
      ).join('. ');

      SpeechModule.speak(spokenSummary, SpeechModule.PRIORITY.DESCRIPTION);
    } else {
      const fallbackText = result.summary || 'No objects could be measured.';
      UIModule.addDescription(fallbackText);
      SpeechModule.speak(fallbackText, SpeechModule.PRIORITY.DESCRIPTION);
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
