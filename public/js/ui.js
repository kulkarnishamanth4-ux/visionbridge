/**
 * ui.js — UI update and accessibility module for VisionGuard
 */
const UIModule = (() => {
  // Element references
  const els = {
    apiStatus: document.getElementById('api-status'),
    statusRing: document.getElementById('status-ring'),
    statusLabel: document.getElementById('status-label'),
    scanLine: document.getElementById('scan-line'),
    dangerPanel: document.getElementById('danger-panel'),
    dangerList: document.getElementById('danger-list'),
    outputBody: document.getElementById('output-body'),
    outputPlaceholder: document.getElementById('output-placeholder'),
    outputTime: document.getElementById('output-time'),
    cameraSection: document.getElementById('camera-section'),
    settingsModal: document.getElementById('settings-modal'),
    onboarding: document.getElementById('onboarding'),
    // Icons
    iconScanning: document.getElementById('icon-scanning'),
    iconListening: document.getElementById('icon-listening'),
    iconSpeaking: document.getElementById('icon-speaking'),
    iconDanger: document.getElementById('icon-danger'),
    // Buttons
    btnScan: document.getElementById('btn-scan'),
    btnListen: document.getElementById('btn-listen'),
    btnAuto: document.getElementById('btn-auto'),
    btnSettings: document.getElementById('btn-settings'),
    btnStart: document.getElementById('btn-start'),
    closeSettings: document.getElementById('close-settings'),
    settingsBackdrop: document.getElementById('settings-backdrop'),
    cameraToggle: document.getElementById('camera-preview-toggle'),
    toggleCameraView: document.getElementById('toggle-camera-view'),
    // Settings
    scanInterval: document.getElementById('scan-interval'),
    scanIntervalValue: document.getElementById('scan-interval-value'),
    voiceSelect: document.getElementById('voice-select'),
    speechRate: document.getElementById('speech-rate'),
    speechRateValue: document.getElementById('speech-rate-value'),
    wakeWordInput: document.getElementById('wake-word-input'),
  };

  const modes = ['scanning', 'listening', 'speaking', 'danger', 'idle'];
  const icons = { scanning: els.iconScanning, listening: els.iconListening, speaking: els.iconSpeaking, danger: els.iconDanger };

  function setMode(mode) {
    // Update ring
    modes.forEach(m => els.statusRing.classList.remove(m));
    if (mode !== 'idle') els.statusRing.classList.add(mode);

    // Update icon
    Object.values(icons).forEach(i => i.classList.remove('active'));
    if (icons[mode]) icons[mode].classList.add('active');
    else els.iconScanning.classList.add('active');

    // Labels
    const labels = {
      scanning: 'Scanning', listening: 'Listening',
      speaking: 'Speaking', danger: '⚠ Danger', idle: 'Ready'
    };
    els.statusLabel.textContent = labels[mode] || 'Ready';
  }

  function setApiStatus(configured) {
    els.apiStatus.className = 'status-badge ' + (configured ? 'ready' : 'error');
    els.apiStatus.querySelector('.status-text').textContent = configured ? 'Ready' : 'No API Key';
  }

  function showScanAnimation() {
    els.scanLine.classList.remove('active');
    void els.scanLine.offsetWidth; // Force reflow
    els.scanLine.classList.add('active');
  }

  function showDangers(dangers) {
    if (!dangers || dangers.length === 0) {
      els.dangerPanel.classList.add('hidden');
      return;
    }

    els.dangerList.innerHTML = dangers.map(d => `
      <li>
        <span class="danger-severity ${d.severity || 'warning'}">${d.severity || 'warning'}</span>
        <span>${d.description || d.type} ${d.direction ? '— ' + d.direction : ''}</span>
      </li>
    `).join('');

    els.dangerPanel.classList.remove('hidden');
  }

  function addDescription(text, isHTML = false) {
    if (els.outputPlaceholder) els.outputPlaceholder.remove();

    const entry = document.createElement('div');
    entry.className = 'output-entry';

    // Choose icon based on current mode tab
    const activeTab = document.querySelector('.mode-tab.active');
    const modeIcons = { detailed: '🔍', danger: '⚠️', summary: '📝', measure: '📏' };
    const icon = modeIcons[activeTab?.dataset.mode] || '🔍';
    const modeLabels = { detailed: 'Scene Analysis', danger: 'Danger Scan', summary: 'Summary', measure: 'Measurements' };
    const label = modeLabels[activeTab?.dataset.mode] || 'Scene Analysis';

    entry.innerHTML = `
      <div class="entry-label">${icon} ${label}</div>
      <div class="entry-text">${isHTML ? text : escapeHtml(text)}</div>
    `;
    els.outputBody.appendChild(entry);
    els.outputBody.scrollTop = els.outputBody.scrollHeight;
    els.outputTime.textContent = new Date().toLocaleTimeString();
  }

  function addQA(question, answer) {
    if (els.outputPlaceholder) els.outputPlaceholder.remove();

    const entry = document.createElement('div');
    entry.className = 'output-entry question';
    entry.innerHTML = `
      <div class="entry-label">🎤 You asked</div>
      <div class="entry-text">${escapeHtml(question)}</div>
    `;
    els.outputBody.appendChild(entry);

    const ansEntry = document.createElement('div');
    ansEntry.className = 'output-entry';
    ansEntry.innerHTML = `
      <div class="entry-label">💬 Answer</div>
      <div class="entry-text">${escapeHtml(answer)}</div>
    `;
    els.outputBody.appendChild(ansEntry);
    els.outputBody.scrollTop = els.outputBody.scrollHeight;
    els.outputTime.textContent = new Date().toLocaleTimeString();
  }

  function showSettings() { els.settingsModal.classList.remove('hidden'); }
  function hideSettings() { els.settingsModal.classList.add('hidden'); }
  function hideOnboarding() { els.onboarding.classList.add('hidden'); }

  function toggleCameraPreview(show) {
    if (show) els.cameraSection.classList.add('visible');
    else els.cameraSection.classList.remove('visible');
  }

  function setAutoActive(active) {
    if (active) els.btnAuto.classList.add('active');
    else els.btnAuto.classList.remove('active');
  }

  function setListenActive(active) {
    if (active) els.btnListen.classList.add('active');
    else els.btnListen.classList.remove('active');
  }

  function populateVoices(voices) {
    els.voiceSelect.innerHTML = voices
      .filter(v => v.lang.startsWith('en'))
      .map((v, i) => `<option value="${i}">${v.name} (${v.lang})</option>`)
      .join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return {
    els, setMode, setApiStatus, showScanAnimation,
    showDangers, addDescription, addQA,
    showSettings, hideSettings, hideOnboarding,
    toggleCameraPreview, setAutoActive, setListenActive,
    populateVoices
  };
})();
