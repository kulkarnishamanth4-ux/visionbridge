"""
install_python.py — Create a virtual environment and install Python packages.
Uses --system-site-packages so apt-installed packages (picamera2, etc.)
are visible inside the venv.
"""
import subprocess
import os
import sys
import logging

log = logging.getLogger("install.python")

VENV_DIR = "venv"


def install(project_dir):
    """
    Create a venv and install requirements.txt.
    Returns (venv_python_path, success_bool).
    """
    venv_path = os.path.join(project_dir, VENV_DIR)
    venv_python = os.path.join(venv_path, "bin", "python3")
    venv_pip = os.path.join(venv_path, "bin", "pip3")
    requirements = os.path.join(project_dir, "requirements.txt")

    # Step 1: Create venv with system-site-packages
    log.info(f"Creating virtual environment at: {venv_path}")
    if os.path.exists(venv_python):
        log.info("  venv already exists, reusing it.")
    else:
        ok = _run([
            sys.executable, "-m", "venv",
            "--system-site-packages",
            venv_path,
        ])
        if not ok:
            log.error("Failed to create virtual environment!")
            return None, False

    # Verify venv python exists
    if not os.path.exists(venv_python):
        log.error(f"venv Python not found at {venv_python}")
        return None, False

    log.info(f"  venv Python: {venv_python}")

    # Step 2: Upgrade pip inside the venv
    log.info("Upgrading pip inside venv...")
    _run([venv_python, "-m", "pip", "install", "--upgrade", "pip"])

    # Step 3: Install requirements.txt
    if os.path.exists(requirements):
        log.info(f"Installing packages from {requirements}...")
        ok = _run([venv_pip, "install", "-r", requirements])
        if not ok:
            log.warning("Some pip packages failed to install (trying one by one)...")
            _install_one_by_one(venv_pip, requirements)
    else:
        log.warning(f"requirements.txt not found at {requirements}")

    # Step 4: Try tflite-runtime separately (often fails, non-critical)
    log.info("Attempting tflite-runtime install (optional)...")
    ok = _run([venv_pip, "install", "tflite-runtime"])
    if ok:
        log.info("  tflite-runtime: OK")
    else:
        log.warning("  tflite-runtime: FAILED (offline detection will be disabled)")

    return venv_python, True


def _install_one_by_one(pip_path, requirements_path):
    """Install packages one at a time for better error isolation."""
    with open(requirements_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            log.info(f"  Installing: {line}")
            ok = _run([pip_path, "install", line])
            if ok:
                log.info(f"    {line}: OK")
            else:
                log.warning(f"    {line}: FAILED (non-critical)")


def _run(cmd):
    """Run a command, return True on success."""
    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            log.debug(f"Command failed: {' '.join(cmd)}")
            log.debug(f"  stderr: {stderr[:500]}")
            return False
        return True
    except subprocess.TimeoutExpired:
        log.error(f"Command timed out: {' '.join(cmd)}")
        return False
    except Exception as e:
        log.error(f"Command error: {e}")
        return False
