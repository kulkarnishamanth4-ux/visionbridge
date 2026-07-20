"""
verify.py — Post-installation verification.
Tests that all critical Python modules can be imported and
that key system tools are available.
"""
import subprocess
import sys
import os
import logging

log = logging.getLogger("install.verify")

# Modules to verify: (import_name, display_name, critical)
PYTHON_MODULES = [
    ("picamera2", "Pi Camera (picamera2)", False),
    ("cv2", "OpenCV (cv2)", False),
    ("serial", "Serial/GPS (pyserial)", False),
    ("speech_recognition", "Speech Recognition", True),
    ("pyttsx3", "Text-to-Speech (pyttsx3)", True),
    ("PIL", "Pillow (PIL)", True),
    ("google.genai", "Google Gemini AI", True),
    ("twilio", "Twilio (SOS)", False),
    ("numpy", "NumPy", False),
]

# System commands to verify
SYSTEM_COMMANDS = [
    ("espeak", "Text-to-Speech engine"),
    ("aplay", "ALSA audio player"),
    ("raspi-config", "Raspberry Pi configuration"),
    ("git", "Git version control"),
]


def verify(venv_python=None):
    """
    Run all verification checks.
    Returns (passed_count, failed_count, results_list).
    """
    python_path = venv_python or sys.executable
    results = []
    passed = 0
    failed = 0

    print()
    print("=" * 55)
    print("  POST-INSTALLATION VERIFICATION")
    print("=" * 55)
    print(f"  Python: {python_path}")
    print()

    # --- Python module checks ---
    print("  Python Modules:")
    for module_name, display_name, critical in PYTHON_MODULES:
        ok = _check_python_import(python_path, module_name)
        status = "OK" if ok else ("MISSING (critical)" if critical else "MISSING (optional)")
        icon = "[PASS]" if ok else "[FAIL]"
        print(f"    {icon} {display_name}")
        results.append((display_name, ok, critical))
        if ok:
            passed += 1
        else:
            failed += 1
            if critical:
                log.warning(f"Critical module missing: {module_name}")

    print()

    # --- System command checks ---
    print("  System Commands:")
    for cmd, description in SYSTEM_COMMANDS:
        ok = _check_command(cmd)
        icon = "[PASS]" if ok else "[FAIL]"
        print(f"    {icon} {description} ({cmd})")
        results.append((description, ok, False))
        if ok:
            passed += 1
        else:
            failed += 1

    print()

    # --- Model file check ---
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model_path = os.path.join(script_dir, "models", "coco_ssd_mobilenet_v2.tflite")
    labels_path = os.path.join(script_dir, "models", "coco_labels.txt")

    print("  Model Files:")
    for path, name in [(model_path, "TFLite model"), (labels_path, "COCO labels")]:
        exists = os.path.exists(path)
        size = os.path.getsize(path) if exists else 0
        icon = "[PASS]" if exists else "[FAIL]"
        size_str = f" ({size:,} bytes)" if exists else ""
        print(f"    {icon} {name}{size_str}")
        results.append((name, exists, False))
        if exists:
            passed += 1
        else:
            failed += 1

    print()

    # --- Summary ---
    total = passed + failed
    critical_failures = sum(1 for _, ok, crit in results if not ok and crit)

    print("=" * 55)
    print(f"  Results: {passed}/{total} passed, {failed} failed")
    if critical_failures > 0:
        print(f"  WARNING: {critical_failures} critical module(s) missing!")
        print("  The system may not function correctly.")
    elif failed > 0:
        print("  All critical modules present. Optional features may be limited.")
    else:
        print("  ALL CHECKS PASSED!")
    print("=" * 55)
    print()

    return passed, failed, results


def _check_python_import(python_path, module_name):
    """Check if a Python module can be imported."""
    try:
        result = subprocess.run(
            [python_path, "-c", f"import {module_name}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        return result.returncode == 0
    except Exception:
        return False


def _check_command(cmd):
    """Check if a system command is available."""
    try:
        result = subprocess.run(
            ["which", cmd],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


# --- Self-test ---
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    passed, failed, _ = verify()
    sys.exit(0 if failed == 0 else 1)
