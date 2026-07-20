"""
install_camera.py — Configure the Raspberry Pi camera interface.
Enables the camera via raspi-config and verifies it can be detected.
"""
import subprocess
import logging

log = logging.getLogger("install.camera")


def install(system_info):
    """
    Enable and verify the camera interface.
    Returns True if camera setup succeeded or was skipped safely.
    """
    if not system_info.is_raspberry_pi:
        log.info("Not a Raspberry Pi — skipping camera configuration")
        return True

    # Enable camera interface
    log.info("Enabling camera interface via raspi-config...")
    ok = _run_quiet(["sudo", "raspi-config", "nonint", "do_camera", "0"])
    if ok:
        log.info("  Camera interface enabled")
    else:
        log.warning("  raspi-config camera command failed (may already be enabled)")

    # Enable serial (UART) for GPS — disable serial console
    log.info("Enabling serial (UART) for GPS module...")
    _run_quiet(["sudo", "raspi-config", "nonint", "do_serial_hw", "0"])
    _run_quiet(["sudo", "raspi-config", "nonint", "do_serial_cons", "1"])
    log.info("  Serial UART enabled, serial console disabled")

    # Verify camera is detectable
    log.info("Checking for connected cameras...")
    camera_found = _check_camera()
    if camera_found:
        log.info("  Camera detected!")
    else:
        log.warning(
            "  No camera detected. This is normal if:\n"
            "    - The camera ribbon cable is not connected yet\n"
            "    - A reboot is needed after enabling the camera interface\n"
            "  The camera will be checked again when VisionBridge starts."
        )

    return True


def _check_camera():
    """Try to detect a connected camera using libcamera or vcgencmd."""
    # Try libcamera first (modern)
    try:
        result = subprocess.run(
            ["libcamera-hello", "--list-cameras"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        output = result.stdout.decode("utf-8", errors="replace")
        if "Available cameras" in output and "No cameras" not in output:
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Fallback: vcgencmd (older systems)
    try:
        result = subprocess.run(
            ["vcgencmd", "get_camera"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
        )
        output = result.stdout.decode("utf-8", errors="replace")
        if "detected=1" in output:
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return False


def _run_quiet(cmd):
    """Run a command silently. Returns True on success."""
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        return result.returncode == 0
    except Exception:
        return False
