"""
camera.py — Pi Camera Module v2 interface for VisionBridge
Captures JPEG frames from the CSI camera and returns base64 for Gemini API.
Falls back to USB webcam if CSI camera is not available.
"""
import base64
import io
import logging
import time

from config import CAMERA_WIDTH, CAMERA_HEIGHT, JPEG_QUALITY

log = logging.getLogger("camera")

# Try picamera2 first (Pi Camera), fall back to OpenCV (USB webcam)
_backend = None
_camera = None


def init():
    """Initialize the camera. Call once at startup."""
    global _backend, _camera

    # Try Pi Camera (CSI) via picamera2
    try:
        from picamera2 import Picamera2
        cam = Picamera2()
        cam_config = cam.create_still_configuration(
            main={"size": (CAMERA_WIDTH, CAMERA_HEIGHT), "format": "RGB888"}
        )
        cam.configure(cam_config)
        cam.start()
        time.sleep(1)  # warm-up
        _camera = cam
        _backend = "picamera2"
        log.info(f"Camera initialized: Pi Camera v2 ({CAMERA_WIDTH}x{CAMERA_HEIGHT})")
        return True
    except Exception as e:
        log.warning(f"picamera2 not available: {e}")

    # Fallback: USB webcam via OpenCV
    try:
        import cv2
        cap = cv2.VideoCapture(0)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)
        if cap.isOpened():
            _camera = cap
            _backend = "opencv"
            log.info(f"Camera initialized: USB webcam via OpenCV ({CAMERA_WIDTH}x{CAMERA_HEIGHT})")
            return True
        else:
            cap.release()
            log.error("OpenCV: could not open camera")
    except Exception as e:
        log.warning(f"OpenCV not available: {e}")

    log.error("No camera available!")
    return False


def capture_frame():
    """
    Capture a JPEG frame and return as base64 data URI string.
    Returns None if camera is not available.
    """
    if _camera is None:
        log.warning("Camera not initialized")
        return None

    try:
        if _backend == "picamera2":
            return _capture_picamera2()
        elif _backend == "opencv":
            return _capture_opencv()
    except Exception as e:
        log.error(f"Frame capture failed: {e}")
        return None


def capture_raw():
    """Capture a raw numpy array frame (for TFLite detection)."""
    if _camera is None:
        return None
    try:
        if _backend == "picamera2":
            return _camera.capture_array()
        elif _backend == "opencv":
            import cv2
            ret, frame = _camera.read()
            if ret:
                return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    except Exception as e:
        log.error(f"Raw capture failed: {e}")
    return None


def _capture_picamera2():
    """Capture from Pi Camera via picamera2."""
    from PIL import Image
    arr = _camera.capture_array()
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:image/jpeg;base64,{b64}"


def _capture_opencv():
    """Capture from USB webcam via OpenCV."""
    import cv2
    ret, frame = _camera.read()
    if not ret:
        return None
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    b64 = base64.b64encode(buf.tobytes()).decode("utf-8")
    return f"data:image/jpeg;base64,{b64}"


def stop():
    """Release camera resources."""
    global _camera, _backend
    if _camera:
        try:
            if _backend == "picamera2":
                _camera.stop()
            elif _backend == "opencv":
                _camera.release()
        except Exception:
            pass
        _camera = None
        _backend = None
        log.info("Camera stopped")


# ─── SELF-TEST ───
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if init():
        frame = capture_frame()
        if frame:
            # Save test image
            raw = base64.b64decode(frame.split(",")[1])
            with open("test_capture.jpg", "wb") as f:
                f.write(raw)
            print(f"✅ Captured frame ({len(raw)} bytes) → test_capture.jpg")
        stop()
    else:
        print("❌ No camera found")
