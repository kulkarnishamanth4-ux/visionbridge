"""
detector.py — Offline object detection using TensorFlow Lite
Uses COCO-SSD MobileNet v2 quantized model (~4MB).
Runs entirely on-device — no internet needed.
Falls back gracefully if TFLite is not installed.
"""
import os
import logging
import numpy as np
from PIL import Image
import io

from config import TFLITE_MODEL_PATH, TFLITE_LABELS_PATH, DETECTION_THRESHOLD

log = logging.getLogger("detector")

_interpreter = None
_labels = []
_input_details = None
_output_details = None
_input_shape = None
_is_ready = False

# Known real-world heights for distance estimation (meters)
KNOWN_HEIGHTS = {
    "person": 1.65, "car": 1.50, "truck": 2.80, "bus": 3.00,
    "motorcycle": 1.10, "bicycle": 1.00, "dog": 0.45, "cat": 0.30,
    "horse": 1.60, "cow": 1.40, "chair": 0.90, "couch": 0.85,
    "bed": 0.60, "dining table": 0.75, "tv": 0.50, "laptop": 0.25,
    "bottle": 0.25, "cup": 0.12, "fire hydrant": 0.60,
    "stop sign": 0.75, "bench": 0.80, "potted plant": 0.50,
    "suitcase": 0.60, "backpack": 0.50, "umbrella": 1.00,
    "refrigerator": 1.70, "oven": 0.85, "toilet": 0.40,
    "bird": 0.15, "elephant": 3.00, "bear": 1.50, "zebra": 1.40,
    "giraffe": 5.50, "sheep": 0.75,
}

DANGER_CLASSES = {
    "car", "truck", "bus", "motorcycle", "bicycle",
    "dog", "horse", "cow", "fire hydrant",
}

# Camera FOV for distance calculation
CAMERA_VFOV = 45 * (3.14159 / 180)  # Pi Camera v2 vertical FOV ~45°


def init():
    """Load the TFLite model and labels."""
    global _interpreter, _labels, _input_details, _output_details, _input_shape, _is_ready

    # Load labels
    if os.path.exists(TFLITE_LABELS_PATH):
        with open(TFLITE_LABELS_PATH, "r") as f:
            _labels = [line.strip() for line in f.readlines()]
        log.info(f"Loaded {len(_labels)} class labels")
    else:
        log.warning(f"Labels file not found: {TFLITE_LABELS_PATH}")
        return False

    # Load TFLite model
    if not os.path.exists(TFLITE_MODEL_PATH):
        log.warning(f"TFLite model not found: {TFLITE_MODEL_PATH}")
        log.info("Run setup.sh to download the model, or download manually.")
        return False

    try:
        # Try tflite_runtime first (lighter), fall back to full tensorflow
        try:
            from tflite_runtime.interpreter import Interpreter
        except ImportError:
            from tensorflow.lite.python.interpreter import Interpreter

        _interpreter = Interpreter(model_path=TFLITE_MODEL_PATH)
        _interpreter.allocate_tensors()
        _input_details = _interpreter.get_input_details()
        _output_details = _interpreter.get_output_details()
        _input_shape = _input_details[0]["shape"]  # e.g., [1, 300, 300, 3]

        log.info(f"TFLite model loaded. Input shape: {_input_shape}")
        _is_ready = True
        return True
    except Exception as e:
        log.error(f"TFLite init failed: {e}")
        return False


def is_ready():
    return _is_ready


def detect(image_array):
    """
    Run object detection on a numpy array (RGB, HxWx3).
    Returns list of detected objects with class, score, bbox, distance.
    """
    if not _is_ready or _interpreter is None:
        return []

    try:
        h, w = image_array.shape[:2]
        input_h, input_w = _input_shape[1], _input_shape[2]

        # Resize to model input size
        img = Image.fromarray(image_array)
        img_resized = img.resize((input_w, input_h))
        input_data = np.expand_dims(np.array(img_resized, dtype=np.uint8), axis=0)

        # Run inference
        _interpreter.set_tensor(_input_details[0]["index"], input_data)
        _interpreter.invoke()

        # Parse outputs (SSD MobileNet format)
        # Output tensors: boxes, classes, scores, count
        boxes = _interpreter.get_tensor(_output_details[0]["index"])[0]
        classes = _interpreter.get_tensor(_output_details[1]["index"])[0]
        scores = _interpreter.get_tensor(_output_details[2]["index"])[0]
        count = int(_interpreter.get_tensor(_output_details[3]["index"])[0])

        results = []
        for i in range(min(count, 20)):
            score = float(scores[i])
            if score < DETECTION_THRESHOLD:
                continue

            class_id = int(classes[i])
            if class_id < 0 or class_id >= len(_labels):
                continue

            label = _labels[class_id]

            # Convert normalized box coordinates to pixel coordinates
            ymin, xmin, ymax, xmax = boxes[i]
            bbox_x = int(xmin * w)
            bbox_y = int(ymin * h)
            bbox_w = int((xmax - xmin) * w)
            bbox_h = int((ymax - ymin) * h)

            # Estimate distance
            distance_m = estimate_distance(label, bbox_h, h)

            # Estimate direction
            cx = bbox_x + bbox_w / 2
            rel_x = cx / w
            if rel_x < 0.33:
                direction = "left"
            elif rel_x > 0.67:
                direction = "right"
            else:
                direction = "ahead"

            # Clock direction
            if rel_x < 0.15:
                clock = "9 o'clock"
            elif rel_x < 0.30:
                clock = "10 o'clock"
            elif rel_x < 0.42:
                clock = "11 o'clock"
            elif rel_x < 0.58:
                clock = "12 o'clock"
            elif rel_x < 0.70:
                clock = "1 o'clock"
            elif rel_x < 0.85:
                clock = "2 o'clock"
            else:
                clock = "3 o'clock"

            results.append({
                "class": label,
                "score": score,
                "confidence": int(score * 100),
                "bbox": [bbox_x, bbox_y, bbox_w, bbox_h],
                "direction": direction,
                "clock": clock,
                "distance_m": round(distance_m, 1),
                "distance_text": distance_label(distance_m),
                "is_danger": label in DANGER_CLASSES and distance_m < 5,
            })

        # Sort by distance (nearest first)
        results.sort(key=lambda x: x["distance_m"])
        return results

    except Exception as e:
        log.error(f"Detection failed: {e}")
        return []


def estimate_distance(obj_class, bbox_h, canvas_h):
    """Estimate distance using pinhole model + fill-based blend."""
    if bbox_h < 3 or canvas_h < 10:
        return 5.0

    fill = bbox_h / canvas_h
    known_h = KNOWN_HEIGHTS.get(obj_class)

    # Fill-based distance lookup
    if fill >= 0.90:
        fill_dist = 0.2
    elif fill >= 0.75:
        fill_dist = 0.4
    elif fill >= 0.60:
        fill_dist = 0.7
    elif fill >= 0.45:
        fill_dist = 1.0
    elif fill >= 0.30:
        fill_dist = 1.8
    elif fill >= 0.20:
        fill_dist = 3.0
    elif fill >= 0.12:
        fill_dist = 5.0
    elif fill >= 0.07:
        fill_dist = 8.0
    elif fill >= 0.04:
        fill_dist = 12.0
    elif fill >= 0.02:
        fill_dist = 18.0
    else:
        fill_dist = 25.0

    if not known_h:
        return max(0.2, min(fill_dist, 25.0))

    # Pinhole: d = (H_real * f) / h_pixels
    import math
    focal_px = (canvas_h / 2) / math.tan(CAMERA_VFOV / 2)
    pinhole_dist = (known_h * focal_px) / bbox_h

    # Blend at extremes
    if fill > 0.70:
        blend = max(0, (0.85 - fill) / 0.15)
    elif fill < 0.05:
        blend = max(0, fill / 0.05)
    else:
        blend = 1.0

    blended = blend * pinhole_dist + (1 - blend) * fill_dist
    return max(0.2, min(round(blended, 1), 25.0))


def distance_label(m):
    """Human-readable distance label."""
    if m <= 0.5:
        return "within arm's reach"
    if m <= 1.0:
        return "very close, about 1 step"
    if m <= 1.5:
        return "close, about 2 steps"
    if m <= 2.5:
        return "nearby, a few steps"
    if m <= 4.0:
        return "a short walk"
    if m <= 7.0:
        return "several steps away"
    if m <= 12.0:
        return "across the room"
    return "far away"


def describe_detections(results):
    """
    Generate a spoken description from detection results.
    Used for offline mode when Gemini is unavailable.
    """
    if not results:
        return "No objects detected. The area appears clear."

    # Count objects
    counts = {}
    for r in results:
        label = r["class"]
        counts[label] = counts.get(label, 0) + 1

    # Build description
    parts = []
    dangers = []

    for r in results[:6]:  # Max 6 objects
        label = r["class"].capitalize()
        dist = r["distance_text"]
        clock = r["clock"]

        if r["is_danger"]:
            dangers.append(f"{label} at your {clock}, {dist}")
        else:
            parts.append(f"{label} at your {clock}, {dist}")

    # Compose speech
    speech = ""
    if dangers:
        speech = "Warning! " + ". ".join(dangers) + ". "
    if parts:
        speech += ". ".join(parts) + "."
    if not speech:
        speech = "The area appears clear."

    return speech


# ─── SELF-TEST ───
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if init():
        print("✅ TFLite detector ready")
        # Test with a blank image
        test_img = np.zeros((480, 640, 3), dtype=np.uint8)
        results = detect(test_img)
        print(f"   Detections on blank image: {len(results)}")
    else:
        print("⚠️  TFLite not available (run setup.sh to download model)")
