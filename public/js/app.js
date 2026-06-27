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

  // ===== SOS SETTINGS WITH OTP VERIFICATION =====
  const sosTypeSelect = document.getElementById('sos-type');
  const sosEmailInput = document.getElementById('sos-contact-email');
  const sosPhoneInput = document.getElementById('sos-contact-phone');
  const sosEmailGroup = document.getElementById('sos-email-group');
  const sosPhoneGroup = document.getElementById('sos-phone-group');
  const sosSendOtpBtn = document.getElementById('sos-send-otp');
  const sosOtpGroup = document.getElementById('sos-otp-group');
  const sosOtpInput = document.getElementById('sos-otp-input');
  const sosVerifyBtn = document.getElementById('sos-verify-otp');
  const sosStatusDiv = document.getElementById('sos-status');
  const sosStatusText = document.getElementById('sos-status-text');

  function showSosStatus(msg, type) {
    if (!sosStatusDiv || !sosStatusText) return;
    sosStatusDiv.style.display = 'block';
    sosStatusText.textContent = msg;
    sosStatusText.style.background = type === 'ok' ? '#1a3a1a' : type === 'err' ? '#3a1a1a' : '#1a2a3a';
    sosStatusText.style.color = type === 'ok' ? '#4ade80' : type === 'err' ? '#f87171' : '#60a5fa';
  }

  function updateSosTypeUI(type) {
    if (type === 'phone') {
      if (sosEmailGroup) sosEmailGroup.classList.add('hidden');
      if (sosPhoneGroup) sosPhoneGroup.classList.remove('hidden');
    } else {
      if (sosEmailGroup) sosEmailGroup.classList.remove('hidden');
      if (sosPhoneGroup) sosPhoneGroup.classList.add('hidden');
    }
  }

  // Load saved state
  if (sosTypeSelect) {
    sosTypeSelect.value = F.EmergencySOS.getContactType();
    updateSosTypeUI(F.EmergencySOS.getContactType());
    sosTypeSelect.addEventListener('change', (e) => {
      F.EmergencySOS.setContactType(e.target.value);
      updateSosTypeUI(e.target.value);
      if (sosOtpGroup) sosOtpGroup.classList.add('hidden');
      if (sosStatusDiv) sosStatusDiv.style.display = 'none';
    });
  }
  if (sosEmailInput) {
    sosEmailInput.value = F.EmergencySOS.getEmail();
    sosEmailInput.addEventListener('input', (e) => {
      F.EmergencySOS.setEmail(e.target.value.trim());
      if (sosOtpGroup) sosOtpGroup.classList.add('hidden');
      if (sosStatusDiv) sosStatusDiv.style.display = 'none';
    });
  }
  if (sosPhoneInput) {
    sosPhoneInput.value = F.EmergencySOS.getPhone();
    sosPhoneInput.addEventListener('input', (e) => {
      F.EmergencySOS.setPhone(e.target.value.trim());
      if (sosOtpGroup) sosOtpGroup.classList.add('hidden');
      if (sosStatusDiv) sosStatusDiv.style.display = 'none';
    });
  }

  // Show verified badge if already verified
  if (F.EmergencySOS.isVerified() && F.EmergencySOS.getContact()) {
    showSosStatus('\u2705 Contact verified: ' + F.EmergencySOS.getContact(), 'ok');
  }

  // SEND OTP button (with Numverify/Mailboxlayer validation)
  if (sosSendOtpBtn) {
    sosSendOtpBtn.addEventListener('click', async () => {
      const type = F.EmergencySOS.getContactType();
      const contact = F.EmergencySOS.getContact();
      if (!contact) {
        showSosStatus('Please enter a contact first.', 'err');
        return;
      }
      // Quick client-side format check
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        showSosStatus('Invalid email. Use format: abc@email.com', 'err');
        return;
      }
      if (type === 'phone' && !/^\+\d{10,15}$/.test(contact.replace(/[\s-]/g, ''))) {
        showSosStatus('Invalid phone. Use format: +919999988888', 'err');
        return;
      }

      sosSendOtpBtn.disabled = true;
      sosSendOtpBtn.textContent = 'Validating...';
      showSosStatus('Validating your contact...', 'info');

      // Step 1: Validate contact via Numverify/Mailboxlayer
      try {
        const valRes = await fetch('/api/validate-contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact, type })
        });
        const valData = await valRes.json();

        if (!valData.valid) {
          showSosStatus(valData.error || 'Contact validation failed.', 'err');
          sosSendOtpBtn.disabled = false;
          sosSendOtpBtn.textContent = 'Send Verification Code';
          return;
        }

        // Show validation details
        let validMsg = '';
        if (type === 'phone' && valData.carrier) {
          validMsg = `✅ Valid ${valData.line_type || 'mobile'} number (${valData.carrier}, ${valData.country || ''})`;
          showSosStatus(validMsg, 'ok');
        } else if (type === 'email' && valData.score) {
          validMsg = `✅ Email verified (quality: ${Math.round(valData.score * 100)}%)`;
          showSosStatus(validMsg, 'ok');
        }

        // Show suggestion if email has a typo
        if (valData.suggestion) {
          showSosStatus(`⚠️ Did you mean: ${valData.suggestion}? Proceeding with ${contact}...`, 'info');
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch {
        // Validation service down — proceed anyway (graceful degradation)
        console.warn('[SOS] Validation service unreachable, proceeding with OTP.');
      }

      // Step 2: Send OTP
      sosSendOtpBtn.textContent = 'Sending OTP...';
      showSosStatus('Sending verification code...', 'info');

      try {
        const res = await fetch('/api/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact, type })
        });
        const data = await res.json();
        if (data.success) {
          if (data.directVerify) {
            // Phone: verified directly by format (no SMS service)
            F.EmergencySOS.setVerified(true);
            showSosStatus('✅ Phone number verified: ' + contact, 'ok');
          } else {
            // Email: OTP sent, show input field
            showSosStatus('✉️ Code sent to ' + contact + '. Check your inbox.', 'ok');
            if (sosOtpGroup) sosOtpGroup.classList.remove('hidden');
            if (sosOtpInput) sosOtpInput.focus();
          }
        } else {
          showSosStatus(data.error || 'Failed to send OTP.', 'err');
        }
      } catch {
        showSosStatus('Network error. Check your connection.', 'err');
      }
      sosSendOtpBtn.disabled = false;
      sosSendOtpBtn.textContent = 'Send Verification Code';
    });
  }

  // VERIFY OTP button
  if (sosVerifyBtn) {
    sosVerifyBtn.addEventListener('click', async () => {
      const otp = sosOtpInput?.value?.trim();
      const contact = F.EmergencySOS.getContact();
      if (!otp || otp.length !== 6) {
        showSosStatus('Enter the 6-digit code.', 'err');
        return;
      }
      sosVerifyBtn.disabled = true;
      sosVerifyBtn.textContent = 'Verifying...';
      try {
        const res = await fetch('/api/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contact, otp })
        });
        const data = await res.json();
        if (data.success) {
          F.EmergencySOS.setVerified(true);
          showSosStatus('\u2705 Contact verified: ' + contact, 'ok');
          if (sosOtpGroup) sosOtpGroup.classList.add('hidden');
          SpeechModule.speak('Emergency contact verified successfully.', SpeechModule.PRIORITY.INFO);
        } else {
          showSosStatus(data.error || 'Verification failed.', 'err');
        }
      } catch {
        showSosStatus('Network error.', 'err');
      }
      sosVerifyBtn.disabled = false;
      sosVerifyBtn.textContent = 'Verify';
    });
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

  // --- Onboarding: Step 1 → Step 2 ---
  const step1 = document.getElementById('onboarding-step-1');
  const step2 = document.getElementById('onboarding-step-2');
  const btnNextStep = document.getElementById('btn-next-step');
  const wakeSetupInput = document.getElementById('wake-word-setup-input');
  const btnConfirmWake = document.getElementById('btn-confirm-wake');
  const wakeConfirmText = document.getElementById('wake-confirm-text');
  const wakeMicIcon = document.getElementById('wake-mic-icon');
  const wakeHint = document.getElementById('wake-hint');
  const wakeStatus = document.getElementById('wake-status');
  const wakeStatusIcon = document.getElementById('wake-status-icon');
  const wakeStatusText = document.getElementById('wake-status-text');
  const btnSkipWake = document.getElementById('btn-skip-wake');

  let wakeWordConfirmed = false;

  // Step 1 → Step 2 transition
  btnNextStep.addEventListener('click', () => {
    step1.classList.add('hidden');
    step2.classList.remove('hidden');
  });

  // Wake word confirmation: listen for the user saying their chosen wake word
  btnConfirmWake.addEventListener('click', async () => {
    const chosenWord = wakeSetupInput.value.trim().toLowerCase();
    if (!chosenWord || chosenWord.length < 2) {
      showWakeStatus('error', '⚠️', 'Please type a wake word first');
      wakeSetupInput.focus();
      return;
    }

    // Set the wake word in SpeechModule so matchesWakeWord works
    SpeechModule.setWakeWord(chosenWord);

    // Visual: switch to listening state
    btnConfirmWake.classList.add('listening');
    btnConfirmWake.classList.remove('confirmed');
    wakeConfirmText.textContent = 'Listening... Say "' + chosenWord + '"';
    wakeHint.textContent = 'Speak clearly into your microphone';
    hideWakeStatus();

    try {
      const transcript = await SpeechModule.listenOnce(8000);
      const heard = transcript.toLowerCase();

      if (SpeechModule.matchesWakeWord(heard)) {
        // Success!
        wakeWordConfirmed = true;
        btnConfirmWake.classList.remove('listening');
        btnConfirmWake.classList.add('confirmed');
        wakeConfirmText.textContent = '✓ Wake word confirmed!';
        wakeHint.textContent = 'We heard: "' + transcript + '"';
        showWakeStatus('success', '✅', 'Wake word "' + chosenWord + '" is set and working!');
        // Also update the settings input
        if (UIModule.els.wakeWordInput) UIModule.els.wakeWordInput.value = chosenWord;
      } else {
        // Didn't match
        btnConfirmWake.classList.remove('listening');
        wakeConfirmText.textContent = 'Tap & Say Your Wake Word';
        wakeHint.textContent = 'We heard "' + transcript + '" — try again';
        showWakeStatus('error', '❌', 'Didn\'t match. We heard: "' + transcript + '"');
      }
    } catch (err) {
      btnConfirmWake.classList.remove('listening');
      wakeConfirmText.textContent = 'Tap & Say Your Wake Word';
      if (err.message === 'timeout' || err.message === 'no-speech') {
        wakeHint.textContent = 'No speech detected. Tap the button and speak.';
        showWakeStatus('error', '🔇', 'No speech detected. Please try again.');
      } else if (err.message === 'not-allowed') {
        wakeHint.textContent = 'Microphone access denied.';
        showWakeStatus('error', '🚫', 'Microphone access is required. Please allow it in your browser settings.');
      } else {
        wakeHint.textContent = 'Could not listen. Try again.';
        showWakeStatus('error', '⚠️', 'Speech recognition error: ' + err.message);
      }
    }
  });

  function showWakeStatus(type, icon, text) {
    wakeStatus.className = 'wake-status ' + type;
    wakeStatusIcon.textContent = icon;
    wakeStatusText.textContent = text;
  }
  function hideWakeStatus() {
    wakeStatus.className = 'wake-status hidden';
  }

  // Common function to finalize onboarding and start the app
  async function finalizeOnboarding() {
    // Set the wake word from the input (even if not confirmed by voice)
    const chosenWord = wakeSetupInput.value.trim().toLowerCase();
    if (chosenWord && chosenWord.length >= 2) {
      SpeechModule.setWakeWord(chosenWord);
      if (UIModule.els.wakeWordInput) UIModule.els.wakeWordInput.value = chosenWord;
    }

    UIModule.hideOnboarding();
    SpeechModule.unlockAudio();
    const camResult = await CameraModule.startCamera();
    if (camResult.success) {
      SpeechModule.speak('Welcome to VisionBridge. Your wake word is set to "' + (chosenWord || 'hey vision') + '". Loading detection systems...', SpeechModule.PRIORITY.INFO);
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
      setInterval(updateAmbientSound, 5000);
    } catch { /* no mic access */ }
  }

  // Get Started button (Step 2)
  UIModule.els.btnStart.addEventListener('click', () => finalizeOnboarding());

  // Skip wake word setup
  btnSkipWake.addEventListener('click', () => finalizeOnboarding());

  // --- SOS handler (fully automated, zero user interaction) ---
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
    const isVerified = F.EmergencySOS.isVerified();

    const processLocation = async (loc) => {
      let locText = 'Location unavailable';
      if (loc) {
        locText = `Lat: ${loc.lat.toFixed(5)}, Lng: ${loc.lng.toFixed(5)}`;
      }
      locEl.textContent = locText;

      // No contact configured
      if (!contact) {
        locEl.textContent = locText + ' \u2014 No contact configured!';
        SpeechModule.speak('No emergency contact set. Open settings to add one.', SpeechModule.PRIORITY.DANGER);
        return;
      }

      // Not verified
      if (!isVerified) {
        locEl.textContent = locText + ' \u2014 Contact not verified!';
        SpeechModule.speak('Emergency contact is not verified. Open settings and verify your contact first.', SpeechModule.PRIORITY.DANGER);
        return;
      }

      // ---- MULTI-CHANNEL SOS: server channels FIRST, dialer as fallback ----
      locEl.textContent = locText + ' \u2014 Sending SOS alerts...';
      SpeechModule.speak('Sending emergency alerts now.', SpeechModule.PRIORITY.DANGER);

      // Send to server for automated channels (Twilio call + SMS + email)
      let serverWorked = false;
      let twilioCallWorked = false;
      try {
        console.log('[SOS] Sending to server:', { contact, contactType, reason });
        const response = await fetch('/api/sos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contact,
            contactType,
            reason,
            location: loc ? { lat: loc.lat, lng: loc.lng } : null
          })
        });
        const result = await response.json();
        console.log('[SOS] Server response:', result);

        if (result.success) {
          serverWorked = true;
          const summary = result.summary || 'SOS sent!';
          locEl.textContent = locText + ' \u2014 \u2705 ' + summary;
          SpeechModule.speak(summary, SpeechModule.PRIORITY.DANGER);

          // Check if Twilio voice call specifically succeeded
          if (result.channels && result.channels.call && result.channels.call.success) {
            twilioCallWorked = true;
          }

          // Announce channel details
          if (result.channels) {
            const details = [];
            if (result.channels.call?.success) details.push('Automated phone call placed');
            if (result.channels.sms?.success) details.push('SMS delivered');
            if (result.channels.email?.success) details.push('Email sent');
            if (details.length > 0) {
              SpeechModule.speak(details.join('. ') + '.', SpeechModule.PRIORITY.INFO);
            }
          }
        } else {
          console.warn('[SOS] Server returned failure:', result.error);
          locEl.textContent = locText + ' \u2014 Server: ' + (result.error || 'failed');
        }
      } catch (err) {
        console.error('[SOS] Network error:', err);
        locEl.textContent = locText + ' \u2014 Network error sending SOS';
      }

      // FALLBACK: Open tel: dialer ONLY if Twilio call didn't work
      if (contactType === 'phone' && !twilioCallWorked) {
        console.log('[SOS] Twilio call did not succeed, opening tel: dialer as fallback');
        SpeechModule.speak(
          serverWorked ? 'Also opening your phone dialer.' : 'Opening phone dialer as emergency fallback.',
          SpeechModule.PRIORITY.DANGER
        );
        const callLink = document.createElement('a');
        callLink.href = 'tel:' + contact.replace(/\s/g, '');
        callLink.style.display = 'none';
        document.body.appendChild(callLink);
        callLink.click();
        setTimeout(() => callLink.remove(), 1000);
      }

      // If nothing worked at all
      if (!serverWorked && contactType !== 'phone') {
        SpeechModule.speak('All SOS channels failed. Please check your internet connection.', SpeechModule.PRIORITY.DANGER);
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

  // --- Wake Word & Transcript → AI Assistant ---
  let wakeAutoScanTimer = null;
  let preWakeFrame = null;

  SpeechModule.onWakeWord(() => {
    SpeechModule.stopSpeaking();
    // No TTS "I'm listening" — the wake beep (played in speech.js) is the instant cue
    UIModule.setMode('listening'); UIModule.setListenActive(true);

    // Pre-capture a frame NOW for faster response when command arrives
    preWakeFrame = CameraModule.captureFrame();

    // Auto-scan after 3 seconds of silence (user said wake word but no follow-up)
    clearTimeout(wakeAutoScanTimer);
    wakeAutoScanTimer = setTimeout(() => {
      wakeAutoScanTimer = null;
      preWakeFrame = null;
      UIModule.setListenActive(false);
      if (!isProcessing) performScan();
    }, 3000);
  });

  SpeechModule.onTranscript(async (question) => {
    // Cancel auto-scan timer — user is speaking a command
    clearTimeout(wakeAutoScanTimer);
    wakeAutoScanTimer = null;

    UIModule.setListenActive(false); UIModule.setMode('scanning');

    // Route everything through the AI Assistant
    if (typeof AssistantModule !== 'undefined') {
      const result = await AssistantModule.processCommand(question, {
        getFrame: () => preWakeFrame || CameraModule.captureFrame(),
        geminiAvailable,
        detectObjects: true
      });
      preWakeFrame = null; // consumed

      if (result.response === null) {
        // Command handled silently (e.g., "stop")
        UIModule.setMode(autoScanEnabled ? 'scanning' : 'idle');
        return;
      }

      if (result.response) {
        UIModule.addQA(question, result.response);
        SpeechModule.speak(result.response, SpeechModule.PRIORITY.DESCRIPTION);
        AssistantModule.setLastDescription(result.response);
      }
    } else {
      preWakeFrame = null;
      // Fallback: original behavior if AssistantModule not loaded
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
    }
  });

  SpeechModule.onSpeakStart(() => { if (!UIModule.els.statusRing.classList.contains('danger')) UIModule.setMode('speaking'); });
  SpeechModule.onSpeakEnd(() => {
    if (!isProcessing) UIModule.setMode(autoScanEnabled ? 'scanning' : 'idle');
    // Soft ready beep after finishing speech — tells the user the system is listening again
    setTimeout(() => SpeechModule.playReadyBeep(), 300);
  });

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
            ApiModule.analyzeScene(frame, currentMode, SpeechModule.getLanguage()),
            new Promise(r => setTimeout(() => r(null), 15000))
          ]);
          P.recordAPI(!!geminiResult && !geminiResult._cached);
        }
      } catch { P.recordAPI(false); }
    }

    const hasGemini = geminiResult?.description && !geminiResult.description.includes('AI service');

    // OFFLINE FALLBACK: Use OfflineModule when Gemini is unavailable
    // This generates natural descriptions from local COCO-SSD detections
    let offlineResult = null;
    if (!hasGemini && detectedObjects.length > 0 && typeof OfflineModule !== 'undefined') {
      offlineResult = OfflineModule.describeScene(detectedObjects, currentMode);
    }

    // Choose best available result
    const bestResult = hasGemini ? geminiResult : offlineResult;

    // SPEAK RESULTS
    if (currentMode === 'danger') {
      const dangers = bestResult?.dangers || localResult?.dangers || [];
      if (dangers.length > 0) {
        UIModule.showDangers(dangers);
        F.SpatialAudio.playForDangers(dangers);
        F.Haptic.vibrateForDangers(dangers);
        lastDescription = dangers.map(d => d.description).join('. ');
        SpeechModule.speak('Danger! ' + lastDescription, SpeechModule.PRIORITY.DANGER);
      } else {
        lastDescription = 'No immediate dangers detected. Path appears clear.';
        UIModule.addDescription(lastDescription);
        SpeechModule.speak(lastDescription, SpeechModule.PRIORITY.DESCRIPTION);
        F.Haptic.vibrate('clear');
      }
    } else if (currentMode === 'summary') {
      const text = bestResult?.summary || localResult?.summary || 'No objects detected.';
      lastDescription = text;
      UIModule.addDescription(text);
      SpeechModule.speak(text, SpeechModule.PRIORITY.DESCRIPTION);
    } else {
      // Detailed mode
      if (bestResult?.description) {
        if (bestResult.dangers?.length) {
          UIModule.setMode('danger');
          UIModule.showDangers(bestResult.dangers);
          F.SpatialAudio.playForDangers(bestResult.dangers);
          F.Haptic.vibrateForDangers(bestResult.dangers);
        }
        lastDescription = bestResult.description;
        UIModule.addDescription(bestResult.description);
        SpeechModule.speak(bestResult.description, SpeechModule.PRIORITY.DESCRIPTION);
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
    SpeechModule.speak('Measuring objects. Hold steady...', SpeechModule.PRIORITY.INFO);

    // Try Gemini API first for accurate measurements
    if (geminiAvailable) {
      try {
        const frame1 = CameraModule.captureFrame();
        if (frame1) {
          // Take second frame after 1 second for motion detection
          await new Promise(r => setTimeout(r, 1000));
          const frame2 = CameraModule.captureFrame();

          const geminiMeasure = await Promise.race([
            ApiModule.measureScene(frame1, frame2),
            new Promise(r => setTimeout(() => r(null), 15000))
          ]);

          if (geminiMeasure?.objects?.length) {
            const html = geminiMeasure.objects.map(obj => {
              const motion = obj.moving ? `Moving ${obj.direction || ''} at ${obj.speed}` : 'Stationary';
              const cls = obj.moving ? 'measure-moving' : 'measure-stationary';
              return `<li class="measure-object"><div class="measure-name">${obj.name}</div>
                <div class="measure-details"><span class="measure-detail-label">Size:</span><span>${obj.size}</span>
                <span class="measure-detail-label">Distance:</span><span>${obj.distance}</span>
                <span class="measure-detail-label">Motion:</span><span class="${cls}">${motion}</span></div></li>`;
            }).join('');
            UIModule.addDescription(`<ul class="measure-objects">${html}</ul>`, true);
            lastDescription = geminiMeasure.summary || geminiMeasure.objects.map(o => `${o.name}: ${o.distance}, ${o.moving ? o.speed : 'stationary'}`).join('. ');
            SpeechModule.speak(lastDescription, SpeechModule.PRIORITY.DESCRIPTION);
            return;
          }
        }
      } catch { /* fall through to local detector */ }
    }

    // Fallback: local detector
    if (!localDetectorReady) {
      SpeechModule.speak('Detection model loading. Please wait.', SpeechModule.PRIORITY.INFO);
      isProcessing = false; return;
    }
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
  const GEMINI_INTERVAL = 15000;  // Rich Gemini description every 15s
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
        ApiModule.analyzeScene(frame, currentMode, SpeechModule.getLanguage()),
        new Promise(r => setTimeout(() => r(null), 12000))
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

