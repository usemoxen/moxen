"""Capture actual macOS windows, with input scripted inside the app's demo mode."""
from pathlib import Path
import os
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
if sys.platform != "darwin":
    raise SystemExit("Native window capture requires macOS.")
subprocess.run(["swiftc", str(ROOT / "window-id.swift"), "-o", str(ROOT / "target/window-id")], check=True)
for stage in (sys.argv[1:] or ["main", "picker", "details", "focus"]):
    process = subprocess.Popen(["cargo", "run", "--", "--demo", stage],
                               cwd=ROOT, stdout=subprocess.PIPE, text=True, start_new_session=True)
    try:
        for line in process.stdout:
            print(line, end="", flush=True)
            if line.startswith(f"demo: ready {stage} pid="):
                pid = line.strip().split("pid=")[1]
                window = subprocess.check_output([str(ROOT / "target/window-id"), pid], text=True).strip()
                path = ROOT / "screenshots" / f"polish-{stage}.png"
                subprocess.run(["screencapture", "-l", window, "-o", str(path)], check=True)
                print(f"Captured window {window}: {path}", flush=True)
                break
        else:
            raise RuntimeError(f"Demo exited before {stage} was ready")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait()
