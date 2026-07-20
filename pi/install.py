#!/usr/bin/env python3
"""
install.py — VisionBridge Modular Installer
Orchestrates all installation steps with OS detection, error isolation,
logging, and verification.

Usage:
    python3 install.py             # Full install
    python3 install.py --dry-run   # Show what would be done
    python3 install.py --verify    # Run verification only
"""
import sys
import os
import time
import logging
import argparse
from datetime import datetime

# Ensure we can import the install package
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from install.detect_os import detect as detect_os
from install import install_system
from install import install_python
from install import install_camera
from install import install_audio
from install import install_models
from install import create_service
from install import verify


def main():
    parser = argparse.ArgumentParser(description="VisionBridge Installer")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without installing")
    parser.add_argument("--verify", action="store_true", help="Run verification only")
    parser.add_argument("--skip-system", action="store_true", help="Skip system package installation")
    parser.add_argument("--skip-python", action="store_true", help="Skip Python venv/pip setup")
    args = parser.parse_args()

    # --- Setup logging ---
    log_file = os.path.join(SCRIPT_DIR, "visionbridge-install.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(log_file, mode="w", encoding="utf-8"),
        ],
    )
    log = logging.getLogger("install")

    # Banner
    print()
    print("=" * 55)
    print("  VisionBridge Installer v2.0")
    print("  Modular | OS-Aware | Robust")
    print("=" * 55)
    print(f"  Log file: {log_file}")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 55)
    print()

    start_time = time.time()
    step_results = {}

    # ──────────────────────────────────────────────
    # STEP 1: Detect OS and Hardware
    # ──────────────────────────────────────────────
    log.info("[Step 1/7] Detecting operating system and hardware...")
    system_info = detect_os()
    step_results["OS Detection"] = True
    print(f"  >> {system_info}")
    print()

    if args.dry_run:
        _show_dry_run(system_info)
        return 0

    if args.verify:
        venv_python = os.path.join(SCRIPT_DIR, "venv", "bin", "python3")
        if not os.path.exists(venv_python):
            venv_python = None
        passed, failed, _ = verify.verify(venv_python)
        return 0 if failed == 0 else 1

    # ──────────────────────────────────────────────
    # STEP 2: Install System Packages
    # ──────────────────────────────────────────────
    if args.skip_system:
        log.info("[Step 2/7] Skipping system packages (--skip-system)")
        step_results["System Packages"] = True
    else:
        log.info("[Step 2/7] Installing system packages...")
        results = install_system.install(system_info)
        all_ok = all(results.values())
        step_results["System Packages"] = all_ok
        if not all_ok:
            failed_groups = [k for k, v in results.items() if not v]
            log.error(f"  Failed groups: {failed_groups}")
            log.error("  Continuing with remaining steps...")
    print()

    # ──────────────────────────────────────────────
    # STEP 3: Create Python Virtual Environment
    # ──────────────────────────────────────────────
    venv_python = None
    if args.skip_python:
        log.info("[Step 3/7] Skipping Python setup (--skip-python)")
        step_results["Python Environment"] = True
    else:
        log.info("[Step 3/7] Setting up Python virtual environment...")
        venv_python, ok = install_python.install(SCRIPT_DIR)
        step_results["Python Environment"] = ok
        if venv_python:
            log.info(f"  venv Python: {venv_python}")
        else:
            log.warning("  venv creation failed — will use system Python")
    print()

    # ──────────────────────────────────────────────
    # STEP 4: Configure Camera
    # ──────────────────────────────────────────────
    log.info("[Step 4/7] Configuring camera interface...")
    try:
        ok = install_camera.install(system_info)
        step_results["Camera Setup"] = ok
    except Exception as e:
        log.error(f"  Camera setup error: {e}")
        step_results["Camera Setup"] = False
    print()

    # ──────────────────────────────────────────────
    # STEP 5: Configure Audio
    # ──────────────────────────────────────────────
    log.info("[Step 5/7] Configuring audio output...")
    try:
        ok = install_audio.install(system_info)
        step_results["Audio Setup"] = ok
    except Exception as e:
        log.error(f"  Audio setup error: {e}")
        step_results["Audio Setup"] = False
    print()

    # ──────────────────────────────────────────────
    # STEP 6: Download Models
    # ──────────────────────────────────────────────
    log.info("[Step 6/7] Downloading detection models...")
    try:
        ok = install_models.install(SCRIPT_DIR)
        step_results["Model Download"] = ok
    except Exception as e:
        log.error(f"  Model download error: {e}")
        step_results["Model Download"] = False
    print()

    # ──────────────────────────────────────────────
    # STEP 7: Create Systemd Service
    # ──────────────────────────────────────────────
    log.info("[Step 7/7] Creating auto-start service...")
    try:
        ok = create_service.install(SCRIPT_DIR, venv_python)
        step_results["Auto-Start Service"] = ok
    except Exception as e:
        log.error(f"  Service creation error: {e}")
        step_results["Auto-Start Service"] = False
    print()

    # ──────────────────────────────────────────────
    # VERIFICATION
    # ──────────────────────────────────────────────
    log.info("Running post-installation verification...")
    try:
        passed, failed, _ = verify.verify(venv_python)
        step_results["Verification"] = (failed == 0)
    except Exception as e:
        log.error(f"  Verification error: {e}")
        step_results["Verification"] = False

    # ──────────────────────────────────────────────
    # FINAL SUMMARY
    # ──────────────────────────────────────────────
    elapsed = time.time() - start_time
    minutes = int(elapsed // 60)
    seconds = int(elapsed % 60)

    print()
    print("=" * 55)
    print("  INSTALLATION SUMMARY")
    print("=" * 55)
    print(f"  OS: {system_info.os_name} {system_info.version_id} ({system_info.codename})")
    print(f"  Hardware: {system_info.pi_model}")
    print(f"  Time: {minutes}m {seconds}s")
    print()

    all_passed = True
    for step_name, ok in step_results.items():
        icon = "[PASS]" if ok else "[FAIL]"
        print(f"  {icon} {step_name}")
        if not ok:
            all_passed = False

    print()

    if all_passed:
        print("  STATUS: ALL STEPS COMPLETED SUCCESSFULLY!")
        print()
        print("  Next steps:")
        print("    1. Edit config_local.py with your API keys")
        print("    2. Reboot: sudo reboot")
        print(f"    3. Test: {venv_python or 'python3'} visionbridge.py")
    else:
        print("  STATUS: SOME STEPS FAILED (see log for details)")
        print(f"  Log: {log_file}")
        print()
        print("  You can re-run individual steps:")
        print("    python3 install.py --skip-system   # Skip apt packages")
        print("    python3 install.py --skip-python   # Skip venv setup")
        print("    python3 install.py --verify        # Check what's working")

    print()
    print("=" * 55)

    log.info(f"Installation completed in {minutes}m {seconds}s")
    log.info(f"Log saved to: {log_file}")

    return 0 if all_passed else 1


def _show_dry_run(system_info):
    """Show what would be installed without doing anything."""
    print("=" * 55)
    print("  DRY RUN — No changes will be made")
    print("=" * 55)
    print()
    print(f"  Detected: {system_info}")
    print()
    print("  System packages that would be installed:")
    for group_name, group_info in install_system.PACKAGE_GROUPS.items():
        packages = list(group_info["packages"])
        overrides = group_info.get("os_overrides", {})
        if system_info.codename in overrides:
            packages = overrides[system_info.codename]
        optional = "(optional)" if group_info.get("optional") else ""
        print(f"    {group_name}: {packages} {optional}")
    print()
    print("  Python packages: (from requirements.txt)")
    req_path = os.path.join(SCRIPT_DIR, "requirements.txt")
    if os.path.exists(req_path):
        with open(req_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    print(f"    - {line}")
    print()
    print("  Virtual environment: venv/ (with --system-site-packages)")
    print("  Service: visionbridge.service (using venv Python)")
    print()


if __name__ == "__main__":
    sys.exit(main())
