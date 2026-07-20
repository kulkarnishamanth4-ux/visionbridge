"""
create_service.py — Create a systemd service for auto-start.
Uses the virtual environment Python binary so the correct packages are loaded.
"""
import os
import subprocess
import logging

log = logging.getLogger("install.service")

SERVICE_NAME = "visionbridge"
SERVICE_FILE = f"/etc/systemd/system/{SERVICE_NAME}.service"

SERVICE_TEMPLATE = """[Unit]
Description=VisionBridge AI Assistant
After=network.target sound.target

[Service]
Type=simple
User={user}
WorkingDirectory={working_dir}
ExecStart={python_path} {script_path}
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
"""


def install(project_dir, venv_python=None):
    """
    Create and enable the VisionBridge systemd service.
    Uses venv Python if available, otherwise falls back to system Python.
    Returns True on success.
    """
    script_path = os.path.join(project_dir, "visionbridge.py")

    # Determine which Python to use
    if venv_python and os.path.exists(venv_python):
        python_path = venv_python
        log.info(f"Service will use venv Python: {python_path}")
    else:
        python_path = "/usr/bin/python3"
        log.warning(f"venv Python not found — using system Python: {python_path}")

    # Get current user
    user = os.environ.get("USER", os.environ.get("LOGNAME", "pi"))

    # Generate service content
    service_content = SERVICE_TEMPLATE.format(
        user=user,
        working_dir=project_dir,
        python_path=python_path,
        script_path=script_path,
    )

    # Write service file
    log.info(f"Creating systemd service: {SERVICE_FILE}")
    try:
        # Write to temp file first, then move with sudo
        tmp_path = f"/tmp/{SERVICE_NAME}.service"
        with open(tmp_path, "w") as f:
            f.write(service_content)

        result = subprocess.run(
            ["sudo", "cp", tmp_path, SERVICE_FILE],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        if result.returncode != 0:
            log.error("Failed to copy service file")
            return False

        os.remove(tmp_path)
    except Exception as e:
        log.error(f"Failed to create service file: {e}")
        return False

    # Reload systemd and enable service
    log.info("Reloading systemd and enabling service...")
    cmds = [
        ["sudo", "systemctl", "daemon-reload"],
        ["sudo", "systemctl", "enable", f"{SERVICE_NAME}.service"],
    ]
    for cmd in cmds:
        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
            )
            if result.returncode != 0:
                stderr = result.stderr.decode("utf-8", errors="replace")
                log.warning(f"  Command warning: {' '.join(cmd)} — {stderr[:200]}")
        except Exception as e:
            log.warning(f"  Command failed: {' '.join(cmd)} — {e}")

    log.info(f"  Service '{SERVICE_NAME}' enabled for auto-start")
    log.info(f"  Start manually:  sudo systemctl start {SERVICE_NAME}")
    log.info(f"  View logs:       journalctl -u {SERVICE_NAME} -f")

    return True
