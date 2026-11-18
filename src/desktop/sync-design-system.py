"""Sync design assets at a reviewed, immutable revision (requires gh).

Public files go to design-system/ (tracked). Private docs and mockups go to
design-system/.private/ (git-ignored) and must never be committed.
"""
from pathlib import Path
import base64
import json
import subprocess

REV = "ff2e9a65a278df4198b573413007132d20858a75"
ROOT = Path(__file__).resolve().parent / "design-system"
# Public files: tracked in git under design-system/. Nothing else may be.
PUBLIC_FILES = ["tokens.json", "tokens.css", "components/bundle.css", "components/bundle.js",
                "assets/logos/agent-mark-on-dark.svg"]
# Private material (docs, component READMEs, mockups) stays in the private design-system
# repo. Agents that work on the desktop read it locally from design-system/.private/, which
# is git-ignored. Never move these into the tracked folder (MXN-355).
PRIVATE_FILES = ["components/Composer/README.md", "components/Steps/README.md",
                 "components/ListRow/README.md", "docs/agent-desktop.md",
                 "mockups/agent-desktop/main.png", "mockups/agent-desktop/tool-calls.png",
                 "mockups/agent-desktop/source/Main.dc.html",
                 "mockups/agent-desktop/source/ToolCalls.dc.html",
                 "mockups/agent-desktop/source/canvas.json",
                 "mockups/agent-desktop/source/support.js",
                 "mockups/agent-desktop/source/ds/moxen/tokens.json",
                 "mockups/agent-desktop/source/ds/moxen/tokens.css",
                 "mockups/agent-desktop/source/ds/moxen/components/bundle.css",
                 "mockups/agent-desktop/source/ds/moxen/components/bundle.js"]
PRIVATE = ROOT / ".private"
def fetch(repo, revision, name, target):
    entry = json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/contents/{name}?ref={revision}"]))
    blob = json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/git/blobs/{entry['sha']}"]))
    data = base64.b64decode(blob["content"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

for name in PUBLIC_FILES:
    fetch("usemoxen/design-system", REV, name, ROOT / name)
for name in PRIVATE_FILES:
    fetch("usemoxen/design-system", REV, name, PRIVATE / name)
(ROOT / "REVISION").write_text(REV + "\n")

# The design system has no font or icon assets at this revision.
LUCIDE = "55782beff3a0133df79c417eb68f96e8f19e2404"
ICONS = ["check", "circle", "circle-dot", "circle-gauge", "x", "chevron-right",
         "chevron-down", "chevron-left", "external-link", "square", "dollar-sign",
         "asterisk", "paperclip", "file", "pencil", "search", "square-pen",
         "panel-right", "settings", "arrow-up", "git-branch", "copy", "maximize"]
for name in ICONS:
    fetch("lucide-icons/lucide", LUCIDE, f"icons/{name}.svg", ROOT.parent / "icons" / f"{name}.svg")
fetch("lucide-icons/lucide", LUCIDE, "LICENSE", ROOT.parent / "icons/LICENSE")

# Explicit static instances let native font matching select real weights.
# Install fonttools in the Python environment used to run this script.
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
FONTS = "cc39c4c2c304bc368c9b7c311ea2bcc6013299fe"
for family, stem, weights in [
    ("atkinsonhyperlegiblenext", "AtkinsonHyperlegibleNext", [400, 500, 600, 700, 800]),
    ("atkinsonhyperlegiblemono", "AtkinsonHyperlegibleMono", [400, 500]),
]:
    variable = ROOT.parent / "fonts" / f"{stem}-Variable.ttf"
    fetch("google/fonts", FONTS, f"ofl/{family}/{stem}[wght].ttf", variable)
    for weight in weights:
        font = instantiateVariableFont(TTFont(variable), {"wght": weight}, inplace=False, updateFontNames=True)
        filename = f"{stem}.ttf" if weight == 400 else f"{stem}-{weight}.ttf"
        font.save(ROOT.parent / "fonts" / filename)
    variable.unlink()
