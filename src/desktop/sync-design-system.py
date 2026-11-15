"""Sync public design assets at a reviewed, immutable revision (requires gh)."""
from pathlib import Path
import subprocess

REV = "ff2e9a65a278df4198b573413007132d20858a75"
ROOT = Path(__file__).resolve().parent / "design-system"
FILES = ["tokens.json", "tokens.css", "components/bundle.css", "components/bundle.js",
         "components/Composer/README.md", "components/Steps/README.md",
         "components/ListRow/README.md", "docs/agent-desktop.md",
         "assets/logos/agent-mark-on-dark.svg"]
for name in FILES:
    data = subprocess.check_output(["gh", "api", f"repos/usemoxen/design-system/contents/{name}?ref={REV}",
                                    "-H", "Accept: application/vnd.github.raw+json"])
    target = ROOT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
(ROOT / "REVISION").write_text(REV + "\n")
