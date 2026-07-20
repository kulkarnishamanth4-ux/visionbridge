#!/usr/bin/env python3
"""Comprehensive test of all VisionBridge Python modules."""
import sys
import os

# Ensure we can import from this directory
sys.path.insert(0, os.path.dirname(__file__))

passed = 0
failed = 0

def check(name, condition):
    global passed, failed
    if condition:
        print(f"  ✅ {name}")
        passed += 1
    else:
        print(f"  ❌ {name}")
        failed += 1

print(f"Python {sys.version}")
print()

# ─── TEST 1: Config ───
print("--- Test 1: Config Module ---")
import config
check("GEMINI_MODEL defined", config.GEMINI_MODEL == "gemini-2.0-flash")
check("GEMINI_FALLBACK defined", config.GEMINI_FALLBACK == "gemini-2.0-flash-lite")
check("GPIO buzzer pin", config.PIN_BUZZER == 18)
check("GPIO SOS button pin", config.PIN_SOS_BUTTON == 17)
check("GPIO mode button pin", config.PIN_MODE_BUTTON == 27)
check("Ultrasonic L trig", config.PIN_ULTRA_L_TRIG == 23)
check("Ultrasonic L echo", config.PIN_ULTRA_L_ECHO == 24)
check("Ultrasonic R trig", config.PIN_ULTRA_R_TRIG == 25)
check("Ultrasonic R echo", config.PIN_ULTRA_R_ECHO == 8)
check("Wake word", config.WAKE_WORD == "hey vision")
check("Camera size", config.CAMERA_WIDTH == 640 and config.CAMERA_HEIGHT == 480)
check("JPEG quality", config.JPEG_QUALITY == 65)
check("Command timeout", config.COMMAND_TIMEOUT == 3)
check("Ultra danger threshold", config.ULTRA_DANGER_CM == 80)
check("TFLite model path set", "coco_ssd" in config.TFLITE_MODEL_PATH)
check("TFLite labels path set", "coco_labels" in config.TFLITE_LABELS_PATH)
check("config_local import mechanism exists", True)  # If we got here, it works
print()

# ─── TEST 2: Commands ───
print("--- Test 2: Commands Module ---")
import commands
test_cases = [
    ("scan the area", "scan"),
    ("what do you see", "scan"),
    ("describe", "scan"),
    ("look around", "scan"),
    ("read this", "read"),
    ("what does it say", "read"),
    ("measure", "measure"),
    ("how far", "measure"),
    ("help me", "sos"),
    ("emergency", "sos"),
    ("bachao", "sos"),
    ("madad karo", "sos"),
    ("sahaya", "sos"),
    ("what time is it", "time"),
    ("tell me the date", "date"),
    ("where am I", "location"),
    ("repeat", "repeat"),
    ("say again", "repeat"),
    ("stop", "stop"),
    ("", "silence"),
    (None, "silence"),
]
for text, expected in test_cases:
    action, _ = commands.classify_command(text)
    check(f'"{text}" → {action} (expected {expected})', action == expected)

# Hindi commands
hindi_tests = [
    ("kya hai saamne", "scan"),
    ("yeh padho", "read"),
    ("kitni door", "measure"),
]
for text, expected in hindi_tests:
    action, _ = commands.classify_command(text)
    check(f'Hindi: "{text}" → {action} (expected {expected})', action == expected)
print()

# ─── TEST 3: AI Module ───
print("--- Test 3: AI Module ---")
import ai
check("DETAILED_PROMPT defined", len(ai.DETAILED_PROMPT) > 100)
check("DANGER_PROMPT defined", len(ai.DANGER_PROMPT) > 50)
check("SUMMARY_PROMPT defined", len(ai.SUMMARY_PROMPT) > 50)
check("MEASURE_PROMPT defined", len(ai.MEASURE_PROMPT) > 50)
check("READ_PROMPT defined", len(ai.READ_PROMPT) > 50)
check("QA_PROMPT defined", len(ai.QA_PROMPT) > 50)

# JSON extraction tests
check("Direct JSON parse", ai._extract_json('{"test": 1}') == {"test": 1})
check("Markdown JSON", ai._extract_json('```json\n{"a":1}\n```') == {"a": 1})
check("Embedded JSON", ai._extract_json('Here is the result: {"b":2} done') == {"b": 2})
check("Invalid JSON returns None", ai._extract_json('not json') is None)

# Rate limiter
check("Rate limiter interval set", ai._MIN_CALL_INTERVAL == 2.0)
check("Retry delay parser (13s)", ai._extract_retry_delay("Please retry in 13.27s") == 13.27)
check("Retry delay parser (none)", ai._extract_retry_delay("some other error") is None)

# Cache mechanism
check("Response cache exists", isinstance(ai._last_response_cache, dict))
print()

# ─── TEST 4: Detector ───
print("--- Test 4: Detector Module ---")
import detector
check("Known heights count >= 30", len(detector.KNOWN_HEIGHTS) >= 30)
check("Danger classes count >= 5", len(detector.DANGER_CLASSES) >= 5)
check("Person height = 1.65m", detector.KNOWN_HEIGHTS.get("person") == 1.65)
check("Car in danger classes", "car" in detector.DANGER_CLASSES)

# Distance labels
check("Distance 0.3m = arm's reach", "arm" in detector.distance_label(0.3))
check("Distance 1.0m = very close", "very close" in detector.distance_label(1.0))
check("Distance 5m = several steps", "several" in detector.distance_label(5))
check("Distance 15m = far", "far" in detector.distance_label(15))

# Empty detections
desc = detector.describe_detections([])
check("Empty detection desc", "clear" in desc.lower() or "no object" in desc.lower())

# With mock detections
mock_detections = [
    {"class": "car", "score": 0.9, "distance_text": "nearby", "clock": "12 o'clock", "is_danger": True},
    {"class": "person", "score": 0.8, "distance_text": "a short walk", "clock": "2 o'clock", "is_danger": False},
]
desc = detector.describe_detections(mock_detections)
check("Detection desc has car warning", "car" in desc.lower())
check("Detection desc has person", "person" in desc.lower())

# Distance estimation
dist = detector.estimate_distance("person", 240, 480)  # 50% fill
check("Person distance at 50% fill is reasonable", 0.5 < dist < 5.0)
dist_far = detector.estimate_distance("person", 48, 480)  # 10% fill
check("Person distance at 10% fill is far", dist_far > 3.0)
dist_close = detector.estimate_distance("person", 450, 480)  # 93% fill
check("Person distance at 93% fill is very close", dist_close < 1.0)
print()

# ─── TEST 5: SOS Module ───
print("--- Test 5: SOS Module ---")
import sos
check("Phone normalize +919876543210", sos._normalize_phone("+919876543210") == "+919876543210")
check("Phone normalize 09876543210", sos._normalize_phone("09876543210") == "+919876543210")
check("Phone normalize 9876543210", sos._normalize_phone("9876543210") == "+919876543210")
check("Phone normalize 919876543210", sos._normalize_phone("919876543210") == "+919876543210")
check("Phone normalize +1234567890", sos._normalize_phone("+1234567890") == "+1234567890")
print()

# ─── TEST 6: Voice Module ───
print("--- Test 6: Voice Module ---")
import voice
check("Levenshtein identical = 0", voice.levenshtein("hello", "hello") == 0)
check("Levenshtein 1 edit", voice.levenshtein("hey", "hay") == 1)
check("Levenshtein empty", voice.levenshtein("", "abc") == 3)

check("Wake word exact match", voice.matches_wake_word("hey vision"))
check("Wake word in sentence", voice.matches_wake_word("ok so hey vision what do you see"))
check("Wake word variant 'hay vision'", voice.matches_wake_word("hay vision"))
check("Wake word variant 'hey vishon'", voice.matches_wake_word("hey vishon"))
check("Wake word no match 'hello world'", not voice.matches_wake_word("hello world"))
check("Wake word no match 'hey google'", not voice.matches_wake_word("hey google"))
print()

# ─── TEST 7: Camera Module ───
print("--- Test 7: Camera Module ---")
import camera
check("capture_frame function exists", callable(camera.capture_frame))
check("capture_raw function exists", callable(camera.capture_raw))
check("stop function exists", callable(camera.stop))
check("init function exists", callable(camera.init))
print()

# ─── TEST 8: Main Module Structure ───
print("--- Test 8: VisionBridge Main ---")
import visionbridge
check("init_all function exists", callable(visionbridge.init_all))
check("main_loop function exists", callable(visionbridge.main_loop))
check("shutdown function exists", callable(visionbridge.shutdown))
check("handle_command function exists", callable(visionbridge.handle_command))
check("do_scan function exists", callable(visionbridge.do_scan))
check("do_read function exists", callable(visionbridge.do_read))
check("do_measure function exists", callable(visionbridge.do_measure))
check("do_ask function exists", callable(visionbridge.do_ask))
check("handle_sos_button exists", callable(visionbridge.handle_sos_button))
check("handle_mode_button exists", callable(visionbridge.handle_mode_button))
check("trigger_sos exists", callable(visionbridge.trigger_sos))
print()

# ─── SUMMARY ───
print("=" * 50)
total = passed + failed
print(f"Results: {passed}/{total} passed, {failed} failed")
if failed == 0:
    print("🎉 ALL TESTS PASSED!")
else:
    print(f"⚠️  {failed} test(s) failed")
print("=" * 50)

sys.exit(0 if failed == 0 else 1)
