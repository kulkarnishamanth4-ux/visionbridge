"""
detect_os.py — Detect Raspberry Pi OS version and hardware model.
Reads /etc/os-release and /proc/device-tree/model to determine
which packages and configurations to use.
"""
import os
import platform
import logging

log = logging.getLogger("install.detect_os")


class SystemInfo:
    """Detected system information."""

    def __init__(self):
        self.codename = "unknown"       # bullseye, bookworm, trixie
        self.version_id = "0"           # 11, 12, 13
        self.os_name = "unknown"        # Raspbian, Debian
        self.pi_model = "unknown"       # e.g. "Raspberry Pi 3 Model B Plus"
        self.architecture = platform.machine()  # aarch64, armv7l
        self.is_raspberry_pi = False
        self.is_64bit = self.architecture in ("aarch64", "arm64")

    def __str__(self):
        return (
            f"OS: {self.os_name} {self.version_id} ({self.codename}) | "
            f"Pi: {self.pi_model} | Arch: {self.architecture}"
        )


def detect():
    """Detect the current OS and hardware. Returns a SystemInfo object."""
    info = SystemInfo()

    # --- Read /etc/os-release ---
    os_release = _read_os_release()
    if os_release:
        info.codename = os_release.get("VERSION_CODENAME", "unknown").lower()
        info.version_id = os_release.get("VERSION_ID", "0")
        info.os_name = os_release.get("ID", "unknown").capitalize()
        log.info(f"Detected OS: {info.os_name} {info.version_id} ({info.codename})")
    else:
        log.warning("Could not read /etc/os-release — OS detection failed")

    # --- Read Pi model ---
    info.pi_model = _read_pi_model()
    info.is_raspberry_pi = "raspberry pi" in info.pi_model.lower()
    if info.is_raspberry_pi:
        log.info(f"Detected hardware: {info.pi_model}")
    else:
        log.warning(f"Hardware: {info.pi_model} (not a Raspberry Pi — simulation mode)")

    # --- Validate known codenames ---
    known = ("bullseye", "bookworm", "trixie")
    if info.codename not in known:
        log.warning(
            f"Unknown OS codename '{info.codename}'. "
            f"Known versions: {', '.join(known)}. "
            f"Will attempt Trixie-compatible installation."
        )

    log.info(f"Architecture: {info.architecture} ({'64-bit' if info.is_64bit else '32-bit'})")
    return info


def _read_os_release():
    """Parse /etc/os-release into a dictionary."""
    path = "/etc/os-release"
    if not os.path.exists(path):
        return None
    data = {}
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if "=" in line:
                    key, _, value = line.partition("=")
                    data[key] = value.strip('"')
    except Exception as e:
        log.error(f"Failed to read {path}: {e}")
        return None
    return data


def _read_pi_model():
    """Read the Pi hardware model string."""
    path = "/proc/device-tree/model"
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return f.read().strip().rstrip("\x00")
        except Exception:
            pass

    # Fallback: check /proc/cpuinfo
    cpuinfo_path = "/proc/cpuinfo"
    if os.path.exists(cpuinfo_path):
        try:
            with open(cpuinfo_path, "r") as f:
                for line in f:
                    if line.startswith("Model"):
                        return line.split(":", 1)[1].strip()
        except Exception:
            pass

    return platform.node() or "Unknown device"


# --- Self-test ---
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    info = detect()
    print(f"\n  {info}")
