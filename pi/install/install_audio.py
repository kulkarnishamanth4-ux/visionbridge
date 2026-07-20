"""
install_audio.py — Configure audio output on the Raspberry Pi.
Detects available audio devices and configures the 3.5mm jack
only if the hardware supports it.
"""
import subprocess
import logging

log = logging.getLogger("install.audio")


def install(system_info):
    """
    Configure audio output. Detects devices before configuring.
    Returns True on success.
    """
    if not system_info.is_raspberry_pi:
        log.info("Not a Raspberry Pi — skipping audio configuration")
        return True

    # Detect available audio devices
    devices = _detect_audio_devices()
    if not devices:
        log.warning("No audio output devices detected")
        return True

    log.info(f"Detected audio devices: {devices}")

    # Try raspi-config to set 3.5mm jack
    has_analog = any("headphone" in d.lower() or "analog" in d.lower() or "bcm" in d.lower() for d in devices)
    if has_analog:
        log.info("Analog audio output detected — configuring 3.5mm jack...")
        _run_quiet(["sudo", "raspi-config", "nonint", "do_audio", "1"])
        _run_quiet(["amixer", "cset", "numid=3", "1"])
        log.info("  Audio output set to 3.5mm jack")
    else:
        log.info("No analog audio found — using default audio output (HDMI or USB)")

    # Test audio output
    log.info("Testing audio output with a short beep...")
    ok = _test_audio()
    if ok:
        log.info("  Audio test: OK")
    else:
        log.warning("  Audio test failed — earphones may not be connected yet")

    return True


def _detect_audio_devices():
    """List available ALSA playback devices."""
    try:
        result = subprocess.run(
            ["aplay", "-l"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
        )
        output = result.stdout.decode("utf-8", errors="replace")
        devices = []
        for line in output.splitlines():
            if line.startswith("card "):
                devices.append(line.strip())
        return devices
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []


def _test_audio():
    """Play a short test tone to verify audio output works."""
    try:
        # Generate a short beep using speaker-test
        result = subprocess.run(
            ["speaker-test", "-t", "sine", "-f", "440", "-l", "1", "-p", "1"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _run_quiet(cmd):
    """Run a command silently. Returns True on success."""
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False
