/**
 * camera.js — Camera management module for VisionGuard
 * Handles camera initialization, frame capture, and lifecycle.
 * Prefers rear camera on mobile devices.
 */
const CameraModule = (() => {
  let stream = null;
  const video = document.getElementById('camera-feed');
  const canvas = document.getElementById('capture-canvas');
  const ctx = canvas.getContext('2d');

  async function startCamera() {
    try {
      // Prefer rear camera for mobile
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();

      // Set canvas to match video dimensions
      video.addEventListener('loadedmetadata', () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      });

      return { success: true };
    } catch (err) {
      console.error('Camera error:', err);
      return { success: false, error: err.message };
    }
  }

  function captureFrame() {
    if (!stream || !video.videoWidth) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    // Compress as JPEG for smaller payload
    return canvas.toDataURL('image/jpeg', 0.7);
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
