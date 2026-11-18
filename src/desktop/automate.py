"""Run an automation script against the desktop app without taking focus.

    python3 automate.py script.txt [app args, e.g. --mock]

Builds with the `render-harness` feature, runs the app with
MOXEN_DESKTOP_AUTOMATION=script.txt (see src/automation.rs for the script
format) and, on macOS, samples the frontmost application throughout and fails
if it is ever the app itself: the window must never come to the front.
"""
from pathlib import Path
import os
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent


def frontmost_pid():
    """The pid of the frontmost application, or None where `lsappinfo` is missing."""
    try:
        asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
        info = subprocess.run(["lsappinfo", "info", "-only", "pid", asn], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return None
    digits = "".join(c for c in info.split("=")[-1] if c.isdigit())
    return int(digits) if digits else None


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    script = Path(sys.argv[1]).resolve()
    subprocess.run(["cargo", "build", "--features", "render-harness"], cwd=ROOT, check=True)
    env = {**os.environ, "MOXEN_DESKTOP_AUTOMATION": str(script)}
    app = subprocess.Popen([str(ROOT / "target/debug/moxen-desktop"), *sys.argv[2:]], cwd=ROOT, env=env)
    # Someone using the computer changes the frontmost app all the time; only
    # the automated process being frontmost is a failure.
    stole = False
    while app.poll() is None:
        stole = stole or frontmost_pid() == app.pid
        time.sleep(0.1)
    if stole:
        raise SystemExit("the app came to the front during the run")
    sys.exit(app.returncode)


main()
