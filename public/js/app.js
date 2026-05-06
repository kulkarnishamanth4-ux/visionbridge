/**
 * app.js — Main VisionGuard application controller
 * Orchestrates camera, speech, API, and UI modules.
 */
(async function VisionGuardApp() {
  'use strict';

  // --- State ---
  let autoScanEnabled = false;
  let autoScanTimer = null;
  let scanInterval = 6000;
  let isProcessing = false;
  let cameraPreviewVisible = false;

  // --- Initialization ---

  // Check API status
  const status = await ApiModule.checkStatus();
  UIModule.setApiStatus(status.apiKeyConfigured);

  if (!status.apiKeyConfigured) {
    console.warn('VisionGuard: API key not configured.');
  }

  // Initialize speech synthesis
  const voices = await SpeechModule.initSynthesis();
  const enVoices = voices.filter(v => v.lang.startsWith('en'));
  UIModule.populateVoices(voices);

  // --- Event: Onboarding ---
  UIModule.els.btnStart.addEventListener('click', async () => {
    UIModule.hideOnboarding();

    // Unlock audio on user gesture (required by Chrome for TTS and AudioContext)
    SpeechModule.unlockAudio();

    // Start camera
    const camResult = await CameraModule.startCamera();
    if (camResult.success) {
      SpeechModule.speak('Welcome to VisionGuard. Your camera is active. Tap Scan to analyze your surroundings, or say Hey Vision to ask a question.', SpeechModule.PRIORITY.INFO);
    } else {
      SpeechModule.speak('Welcome to VisionGuard. I could not access your camera. Please grant camera permission and reload the page.', SpeechModule.PRIORITY.INFO);
    }

    // Start speech recognition
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

  // --- Event: Ask Button (manual trigger) ---
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

  // Settings: Scan interval
  UIModule.els.scanInterval.addEventListener('input', (e) => {
    scanInterval = parseInt(e.target.value) * 1000;
    UIModule.els.scanIntervalValue.textContent = e.target.value + 's';
    if (autoScanEnabled) { stopAutoScan(); startAutoScan(); }
  });

  // Settings: Voice select
  UIModule.els.voiceSelect.addEventListener('change', (e) => {
    const voice = enVoices[parseInt(e.target.value)];
    if (voice) SpeechModule.setVoice(voice);
  });

  // Settings: Speech rate
  UIModule.els.speechRate.addEventListener('input', (e) => {
    SpeechModule.setRate(parseFloat(e.target.value));
    UIModule.els.speechRateValue.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
  });

  // Settings: Wake word
  UIModule.els.wakeWordInput.addEventListener('change', (e) => {
    SpeechModule.setWakeWord(e.target.value);
  });

  // Settings: Camera preview toggle
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
    // Don't override danger mode
    if (!UIModule.els.statusRing.classList.contains('danger')) {
      UIModule.setMode('speaking');
    }
  });

  SpeechModule.onSpeakEnd(() => {
    if (!isProcessing) {
      UIModule.setMode(autoScanEnabled ? 'scanning' : 'idle');
    }
  });

  // --- Core: Perform Scene Scan ---
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

    const result = await ApiModule.analyzeScene(frame);

    // Handle dangers first (highest priority)
    if (result.dangers && result.dangers.length > 0) {
      UIModule.setMode('danger');
      UIModule.showDangers(result.dangers);

      const criticalDangers = result.dangers.filter(d => d.severity === 'critical');
      if (criticalDangers.length > 0) {
        // Play beep immediately for audible danger feedback
        SpeechModule.playDangerBeep();
        const dangerText = 'Warning! ' + criticalDangers.map(d => d.description).join('. ');
        SpeechModule.speak(dangerText, SpeechModule.PRIORITY.DANGER);
      }

      // Also speak non-critical dangers
      const warnings = result.dangers.filter(d => d.severity !== 'critical');
      if (warnings.length > 0) {
        const warnText = 'Also be aware: ' + warnings.map(d => d.description).join('. ');
        SpeechModule.speak(warnText, SpeechModule.PRIORITY.DESCRIPTION);
      }
    } else {
      UIModule.showDangers([]);
    }

    // Speak description
    if (result.description) {
      UIModule.addDescription(result.description);
      SpeechModule.speak(result.description, SpeechModule.PRIORITY.DESCRIPTION);
    } else if (result.summary) {
      UIModule.addDescription(result.summary);
      SpeechModule.speak(result.summary, SpeechModule.PRIORITY.DESCRIPTION);
    }

    isProcessing = false;
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
