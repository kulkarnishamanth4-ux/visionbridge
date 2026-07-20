"""
install_system.py — Install system-level apt packages.
Uses OS-version-specific package mappings so the right packages
are installed on Bullseye, Bookworm, and Trixie.
"""
import subprocess
import logging

log = logging.getLogger("install.system")

# Package groups — each is installed separately so one group failing
# doesn't block the rest.
#
# Format: { "group_name": { "packages": [...], "os_overrides": { codename: [...] } } }
# If a codename has an override, those packages replace the default for that group.

PACKAGE_GROUPS = {
    "core": {
        "description": "Core system tools",
        "packages": [
            "python3-pip", "python3-venv", "python3-dev",
            "git", "wget", "unzip", "curl",
        ],
    },
    "camera": {
        "description": "Camera drivers and libraries",
        "packages": ["python3-picamera2"],
        "optional": True,  # non-critical if it fails (e.g. no camera connected)
    },
    "audio": {
        "description": "Audio and speech",
        "packages": [
            "libportaudio2", "portaudio19-dev",
            "espeak", "espeak-data",
            "flac", "alsa-utils",
        ],
    },
    "math_libs": {
        "description": "Math/BLAS libraries for numpy/scipy",
        "packages": ["libatlas-base-dev"],
        "os_overrides": {
            # libatlas-base-dev was removed in Trixie
            "trixie": ["libopenblas-dev"],
        },
    },
    "serial": {
        "description": "Serial/UART for GPS",
        "packages": ["python3-serial"],
        "optional": True,
    },
}


def install(system_info):
    """
    Install all system package groups.
    Returns a dict of { group_name: True/False } indicating success.
    """
    results = {}

    # First, update package lists
    log.info("Updating package lists...")
    ok = _run_apt(["sudo", "apt-get", "update", "-y"])
    if not ok:
        log.error("apt-get update failed! Check your internet connection.")
        return {"update": False}
    results["update"] = True

    # Install each group
    for group_name, group_info in PACKAGE_GROUPS.items():
        desc = group_info.get("description", group_name)
        optional = group_info.get("optional", False)

        # Determine packages for this OS
        packages = list(group_info["packages"])
        overrides = group_info.get("os_overrides", {})
        if system_info.codename in overrides:
            packages = list(overrides[system_info.codename])
            log.info(f"  OS override for {system_info.codename}: {packages}")

        # Check which packages are actually available before installing
        available = []
        unavailable = []
        for pkg in packages:
            if _package_exists(pkg):
                available.append(pkg)
            else:
                unavailable.append(pkg)

        if unavailable:
            log.warning(f"  Packages not found in repos (skipped): {unavailable}")

        if not available:
            msg = f"No packages available for group '{group_name}'"
            if optional:
                log.warning(f"  {msg} — skipping (optional)")
                results[group_name] = True
            else:
                log.error(f"  {msg} — CRITICAL")
                results[group_name] = False
            continue

        # Install
        log.info(f"Installing {desc}: {available}")
        ok = _run_apt(["sudo", "apt-get", "install", "-y"] + available)

        if ok:
            log.info(f"  {desc}: OK")
            results[group_name] = True
        elif optional:
            log.warning(f"  {desc}: FAILED (optional, continuing)")
            results[group_name] = True
        else:
            log.error(f"  {desc}: FAILED")
            results[group_name] = False

        # Verify installed
        for pkg in available:
            if _is_installed(pkg):
                log.info(f"    Verified: {pkg}")
            else:
                log.warning(f"    NOT verified: {pkg}")

    return results


def _run_apt(cmd):
    """Run an apt command. Returns True on success."""
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,  # 10 minute timeout
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            log.error(f"Command failed: {' '.join(cmd)}")
            log.error(f"  stderr: {stderr[:500]}")
            return False
        return True
    except subprocess.TimeoutExpired:
        log.error(f"Command timed out: {' '.join(cmd)}")
        return False
    except Exception as e:
        log.error(f"Command error: {e}")
        return False


def _package_exists(package_name):
    """Check if a package exists in the apt cache."""
    try:
        result = subprocess.run(
            ["apt-cache", "policy", package_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        output = result.stdout.decode("utf-8", errors="replace")
        # If "Candidate: (none)" or empty, package doesn't exist
        if "Candidate: (none)" in output or not output.strip():
            return False
        return result.returncode == 0
    except Exception:
        return False


def _is_installed(package_name):
    """Check if a package is installed via dpkg."""
    try:
        result = subprocess.run(
            ["dpkg", "-l", package_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        output = result.stdout.decode("utf-8", errors="replace")
        # dpkg -l shows "ii" for installed packages
        for line in output.splitlines():
            if line.startswith("ii"):
                return True
        return False
    except Exception:
        return False


# --- Self-test ---
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    from install.detect_os import detect
    info = detect()
    print(f"\nWould install for: {info}")
    for group_name, group_info in PACKAGE_GROUPS.items():
        packages = list(group_info["packages"])
        overrides = group_info.get("os_overrides", {})
        if info.codename in overrides:
            packages = overrides[info.codename]
        print(f"  {group_name}: {packages}")
