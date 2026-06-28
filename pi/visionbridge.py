#!/usr/bin/env python3
"""
visionbridge.py — Main entry point for VisionBridge on Raspberry Pi
Boots all modules, runs the voice-first control loop.

Usage:
    python3 visionbridge.py

The system is fully voice-controlled:
    "Hey Vision" → beep → command or auto-scan after 3s silence
"""
import sys
import signal
import logging
import time
from datetime import datetime

# ─── LOGGING SETUP ───
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("main")

# ─── IMPORTS ───
import camera
import voice as voice_module
import ai
import commands
import sensors
import sos
from config import COMMAND_TIMEOUT


# ─── GLOBALS ───
voice_engine = None
buzzer = None
gps = None
proximity = None
last_response = ""
current_mode = "detailed"  # detailed, danger, summary


def init_all():
    """Initialize all modules. Returns True if core modules are ready."""
    global voice_engine, buzzer, gps, proximity

    log.info("=" * 50)
    log.info("  VisionBridge — Raspberry Pi Edition")
    log.info("=" * 50)

    # Camera
    log.info("[1/6] Initializing camera...")
    if not camera.init():
        log.error("Camera init failed! Check connection.")
        return False

    # Voice
    log.info("[2/6] Initializing voice engine...")
    voice_engine = voice_module.VoiceEngine()
    try:
        voice_engine.init()
    except Exception as e:
        log.error(f"Voice init failed: {e}")
        return False

    # AI
    log.info("[3/6] Initializing Gemini AI...")
    if not ai.init():
        log.warning("Gemini AI not available — will work offline only")

    # SOS
    log.info("[4/6] Initializing SOS system...")
    sos.init()

    # Hardware sensors
    log.info("[5/6] Initializing sensors...")
    buzzer = sensors.Buzzer()

    # Ultrasonic sensors
    ultra_left = sensors.UltrasonicSensor(
        sensors.PIN_ULTRA_L_TRIG, sensors.PIN_ULTRA_L_ECHO, "left"
    )
    ultra_right = sensors.UltrasonicSensor(
        sensors.PIN_ULTRA_R_TRIG, sensors.PIN_ULTRA_R_ECHO, "right"
    )
    proximity = sensors.ProximitySweep(ultra_left, ultra_right, buzzer)

    # GPS
    gps = sensors.GPS()
    if gps.init():
        gps.start()

    # Buttons
    log.info("[6/6] Registering buttons...")
    buttons = sensors.Buttons()
    buttons.register(
        sos_callback=handle_sos_button,
        mode_callback=handle_mode_button,
    )

    # Calibrate microphone
    voice_engine.calibrate()

    # Start proximity monitoring
    proximity.start()

    log.info("✅ All systems initialized!")
    return True


def handle_sos_button():
    """Called when physical SOS button is pressed."""
    log.warning("🚨 SOS BUTTON PRESSED")
    if buzzer:
        buzzer.sos_beep()
    if voice_engine:
        voice_engine.speak("Emergency SOS activated!")
    trigger_sos("Physical SOS button pressed")


def handle_mode_button():
    """Cycle through scan modes: detailed → danger → summary."""
    global current_mode
    modes = ["detailed", "danger", "summary"]
    idx = modes.index(current_mode)
    current_mode = modes[(idx + 1) % len(modes)]
    log.info(f"Mode switched to: {current_mode}")
    if buzzer:
        buzzer.beep(0.1)
    if voice_engine:
        voice_engine.speak(f"Mode: {current_mode}")


def trigger_sos(reason):
    """Fire multi-channel SOS with GPS coordinates."""
    lat, lng = None, None
    if gps:
        lat, lng = gps.get_location()
    result = sos.trigger_sos(reason=reason, lat=lat, lng=lng, buzzer=buzzer)
    if voice_engine:
        voice_engine.speak(result.get("summary", "SOS sent"))


def handle_command(action, text):
    """Execute a voice command."""
    global last_response, current_mode

    log.info(f"Handling command: {action}")

    if action == "silence":
        # Auto-scan on silence (3s after wake word)
        return do_scan(current_mode)

    elif action == "scan":
        return do_scan(current_mode)

    elif action == "read":
        return do_read()

    elif action == "measure":
        return do_measure()

    elif action == "sos":
        trigger_sos(f"Voice command: {text}")
        return

    elif action == "stop":
        voice_engine.speak("Stopping.")
        return

    elif action == "repeat":
        if last_response:
            voice_engine.speak(last_response)
        else:
            voice_engine.speak("Nothing to repeat.")
        return

    elif action == "time":
        now = datetime.now()
        time_str = now.strftime("%-I:%M %p" if sys.platform != "win32" else "%I:%M %p")
        voice_engine.speak(f"The time is {time_str}")
        return

    elif action == "date":
        now = datetime.now()
        date_str = now.strftime("%A, %B %d, %Y")
        voice_engine.speak(f"Today is {date_str}")
        return

    elif action == "location":
        lat, lng = None, None
        if gps:
            lat, lng = gps.get_location()
        if lat and lng:
            voice_engine.speak(
                f"Your GPS location is {lat:.4f} latitude, {lng:.4f} longitude."
            )
        else:
            voice_engine.speak("GPS location is not available yet. Please wait for satellite fix.")
        return

    elif action == "battery":
        voice_engine.speak("Battery monitoring is not available on this device.")
        return

    elif action == "ask":
        return do_ask(text)

    else:
        voice_engine.speak("I didn't understand that. Try saying 'scan' or 'help'.")


def do_scan(mode="detailed"):
    """Capture frame and analyze with Gemini."""
    global last_response
    voice_engine.speak("Scanning...")

    frame = camera.capture_frame()
    if not frame:
        voice_engine.speak("Camera is not available.")
        return

    result = ai.analyze_scene(frame, mode)

    # Build response
    if mode == "danger":
        response = result.get("summary", "No dangers detected.")
    elif mode == "summary":
        response = result.get("summary", "Scene analyzed.")
    else:
        # Detailed: read description, then summary
        desc = result.get("description", "")
        summary = result.get("summary", "")
        response = desc if desc else summary

    # Announce dangers first if any
    dangers = result.get("dangers", [])
    if dangers:
        danger_text = ". ".join(
            d.get("description", "") for d in dangers[:3]
        )
        voice_engine.speak(f"Warning! {danger_text}")
        time.sleep(0.3)

    if response:
        voice_engine.speak(response)
        last_response = response


def do_read():
    """Capture frame and read text."""
    global last_response
    voice_engine.speak("Reading text...")

    frame = camera.capture_frame()
    if not frame:
        voice_engine.speak("Camera is not available.")
        return

    result = ai.read_text(frame)
    response = result.get("summary", result.get("text", "No text found."))
    voice_engine.speak(response)
    last_response = response


def do_measure():
    """Measure objects — combine ultrasonic + AI."""
    global last_response

    # Get ultrasonic readings
    parts = []
    if proximity:
        dl, dr = proximity.get_distances()
        if dl > 0:
            parts.append(f"Left sensor: {dl:.0f} centimeters")
        if dr > 0:
            parts.append(f"Right sensor: {dr:.0f} centimeters")

    # Get AI measurements
    voice_engine.speak("Measuring...")
    frame = camera.capture_frame()
    if frame:
        result = ai.measure_scene(frame)
        ai_summary = result.get("summary", "")
        if ai_summary:
            parts.append(ai_summary)

    if parts:
        response = ". ".join(parts)
        voice_engine.speak(response)
        last_response = response
    else:
        voice_engine.speak("No measurements available.")


def do_ask(question):
    """Answer a freeform question about the scene."""
    global last_response
    voice_engine.speak("Let me check...")

    frame = camera.capture_frame()
    if not frame:
        voice_engine.speak("Camera is not available.")
        return

    answer = ai.ask_question(frame, question)
    voice_engine.speak(answer)
    last_response = answer


# ─── MAIN LOOP ───

def main_loop():
    """
    The core voice-first control loop:
    1. Listen for wake word
    2. Beep to confirm
    3. Listen for command (3s timeout)
    4. If silence → auto-scan
    5. If command → execute
    6. Beep when ready again
    """
    log.info("Entering main loop — listening for 'Hey Vision'...")
    voice_engine.speak("VisionBridge ready. Say Hey Vision to start.")

    while True:
        try:
            # Step 1: Listen for wake word (blocks until heard)
            if voice_engine.listen_for_wake_word():

                # Step 2: Confirm with buzzer
                if buzzer:
                    buzzer.double_beep()

                # Temporarily disable proximity beeping (so it doesn't interfere)
                if proximity:
                    proximity.enabled = False

                # Step 3: Pre-capture frame (while user is still talking)
                pre_frame = camera.capture_frame()

                # Step 4: Listen for command
                command_text = voice_engine.listen_for_command(COMMAND_TIMEOUT)

                # Step 5: Classify and execute
                action, text = commands.classify_command(command_text)
                handle_command(action, text)

                # Step 6: Ready beep
                time.sleep(0.3)
                if buzzer:
                    buzzer.beep(0.08)

                # Re-enable proximity
                if proximity:
                    proximity.enabled = True

        except KeyboardInterrupt:
            break
        except Exception as e:
            log.error(f"Main loop error: {e}", exc_info=True)
            time.sleep(1)


def shutdown(signum=None, frame=None):
    """Clean shutdown on SIGTERM/SIGINT."""
    log.info("Shutting down VisionBridge...")
    if voice_engine:
        voice_engine.speak("VisionBridge shutting down. Goodbye.")
    if proximity:
        proximity.stop()
    if gps:
        gps.stop()
    camera.stop()
    sensors.cleanup()
    log.info("Goodbye!")
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    if init_all():
        main_loop()
    else:
        log.error("Initialization failed. Check connections and try again.")
        sys.exit(1)
