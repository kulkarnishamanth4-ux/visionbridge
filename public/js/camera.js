/**
 * camera.js â€” Camera management module for VisionBridge
 * Handles camera initialization, frame capture, and lifecycle.
 * Prefers rear camera on mobile devices.
 */
const CameraModule = (() => {
  let stream = null;
  const video = document.getElementById('camera-feed');
  const canvas = document.getElementById('capture-canvas');
  const ctx = canvas.getContext('2d');

  // Smaller images = faster API calls = fewer timeouts
  const MAX_DIM = 384;
  const JPEG_QUALITY = 0.35;

  async function startCamera() {
    try {
      // Prefer rear camera for mobile, request moderate resolution
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 }
        },
        audio: false
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();

      return { success: true };
    } catch (err) {
      // Fallback: try without constraints (some browsers reject specific facingMode)
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = stream;
        await video.play();
        return { success: true };
      } catch (err2) {
        console.error('Camera error:', err2);
        return { success: false, error: err2.message };
      }
    }
  }

  function captureFrame() {
    if (!stream || !video.videoWidth) return null;

    // Scale down to MAX_DIM on the longest side to keep payloads small
    let w = video.videoWidth;
    let h = video.videoHeight;
    if (w > MAX_DIM || h > MAX_DIM) {
      const scale = MAX_DIM / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
      video.srcObject = null;
    }
  }

  function isActive() {
    return !!stream;
  }

  return { startCamera, captureFrame, stopCamera, isActive };
})();
