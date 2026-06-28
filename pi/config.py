"""
config.py — VisionBridge Raspberry Pi Configuration
All settings, API keys, pin assignments, and tuning parameters.
Copy this file to config_local.py and fill in your API keys.
"""
import os

# ─── API KEYS (set via environment variables or edit directly) ───
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "YOUR_GEMINI_API_KEY_HERE")
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE_NUMBER = os.environ.get("TWILIO_PHONE_NUMBER", "")  # e.g. "+1234567890"

# ─── EMERGENCY CONTACT ───
SOS_CONTACT = os.environ.get("SOS_CONTACT", "+919876543210")
SOS_CONTACT_TYPE = "phone"  # "phone" or "email"
SOS_EMAIL_USER = os.environ.get("SOS_EMAIL_USER", "")
SOS_EMAIL_PASS = os.environ.get("SOS_EMAIL_PASS", "")

# ─── GPIO PIN ASSIGNMENTS (BCM numbering) ───
# Ultrasonic Left
PIN_ULTRA_L_TRIG = 23
PIN_ULTRA_L_ECHO = 24

# Ultrasonic Right
PIN_ULTRA_R_TRIG = 25
PIN_ULTRA_R_ECHO = 8

# Buzzer (via NPN transistor)
PIN_BUZZER = 18

# Buttons (with internal pull-up, active LOW)
PIN_SOS_BUTTON = 17
PIN_MODE_BUTTON = 27

# ─── GPS ───
GPS_SERIAL_PORT = "/dev/serial0"
GPS_BAUD_RATE = 9600

# ─── VOICE ───
WAKE_WORD = "hey vision"
WAKE_WORD_VARIANTS = [
    "hey vision", "he vision", "hay vision", "hey wishn",
    "a vision", "hey visions", "hey vijan", "hey vishon",
    "hey wision", "hae vision", "hey vision bridge",
]
LANGUAGE = "en-IN"
COMMAND_TIMEOUT = 3  # seconds to wait for command after wake word
WAKE_FUZZY_THRESHOLD = 0.35  # Levenshtein edit distance tolerance

# ─── CAMERA ───
CAMERA_WIDTH = 640
CAMERA_HEIGHT = 480
JPEG_QUALITY = 65  # 0-100

# ─── AI ───
GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_FALLBACK = "gemini-2.0-flash-lite"

# ─── ULTRASONIC ───
ULTRA_DANGER_CM = 80  # distance in cm to trigger danger beep
ULTRA_WARNING_CM = 150  # distance in cm to trigger warning beep
ULTRA_POLL_INTERVAL = 0.3  # seconds between readings
ULTRA_SMOOTHING = 3  # number of readings to average

# ─── DETECTION (TFLite) ───
TFLITE_MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "coco_ssd_mobilenet_v2.tflite")
TFLITE_LABELS_PATH = os.path.join(os.path.dirname(__file__), "models", "coco_labels.txt")
DETECTION_THRESHOLD = 0.4

# ─── SYSTEM ───
LOG_LEVEL = "INFO"
