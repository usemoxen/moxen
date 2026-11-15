"""Sync public design assets at a reviewed, immutable revision (requires gh)."""
from pathlib import Path
import base64
import json
import subprocess

REV = "ff2e9a65a278df4198b573413007132d20858a75"
ROOT = Path(__file__).resolve().parent / "design-system"
FILES = ["tokens.json", "tokens.css", "components/bundle.css", "components/bundle.js",
         "components/Composer/README.md", "components/Steps/README.md",
         "components/ListRow/README.md", "docs/agent-desktop.md",
         "assets/logos/agent-mark-on-dark.svg", "mockups/agent-desktop/main.png",
         "mockups/agent-desktop/tool-calls.png", "mockups/agent-desktop/source/Main.dc.html",
         "mockups/agent-desktop/source/ToolCalls.dc.html", "mockups/agent-desktop/source/canvas.json",
         "mockups/agent-desktop/source/support.js",
         "mockups/agent-desktop/source/ds/moxen/tokens.json",
         "mockups/agent-desktop/source/ds/moxen/tokens.css",
         "mockups/agent-desktop/source/ds/moxen/components/bundle.css",
         "mockups/agent-desktop/source/ds/moxen/components/bundle.js"]
for name in FILES:
    entry = json.loads(subprocess.check_output(["gh", "api", f"repos/usemoxen/design-system/contents/{name}?ref={REV}"]))
    blob = json.loads(subprocess.check_output(["gh", "api", f"repos/usemoxen/design-system/git/blobs/{entry['sha']}"]))
    data = base64.b64decode(blob["content"])
    target = ROOT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
(ROOT / "REVISION").write_text(REV + "\n")
