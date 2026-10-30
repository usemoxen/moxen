"""Paints the JSON cell grids written by src/tui/render-check/shots.tsx as PNGs.

usage: python3 -I scripts/render-shots.py <dir>  (run by src/tui/render-check/shots.tsx)
Every <dir>/<theme>/<screen>.json becomes <screen>.png beside it.
"""
import glob
import json
import os
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont, features

# Ligatures (`=>`, `!=`, `->`, `...`) need Raqm, which Pillow's macOS wheels load from the
# system. Homebrew keeps its libraries out of dyld's default search path, so when Raqm is
# missing and Homebrew's fribidi is there, run again with that path. Without Raqm the shots
# still draw, glyph by glyph and without ligatures.
BREW_LIB = "/opt/homebrew/lib"
if not features.check("raqm") and sys.platform == "darwin" and os.path.isdir(BREW_LIB) and os.environ.get("MOXEN_SHOTS_REEXEC") != "1":
    env = dict(os.environ, MOXEN_SHOTS_REEXEC="1", DYLD_FALLBACK_LIBRARY_PATH=BREW_LIB)
    os.execve(sys.executable, [sys.executable, "-I", *sys.argv], env)
LIGATURES = features.check("raqm")

SUPERSAMPLE = 2  # drawn at 4x and halved, so the thin FreeType strokes antialias like CoreText's
SCALE = 2 * SUPERSAMPLE
SIZE = 15 * SCALE
CELL_W, CELL_H = 9 * SCALE, 20 * SCALE
STROKE = 1  # CoreText (Ghostty on macOS) renders heavier than FreeType; one supersampled pixel closes most of the gap
# JetBrains Mono's ascent and descent, in em; the baseline sits where the line box centres them in the cell.
ASCENT, DESCENT = 1.02, 0.30
BASELINE = round((CELL_H - (ASCENT + DESCENT) * SIZE) / 2 + ASCENT * SIZE)
HOME = pathlib.Path.home()

# Ghostty's default face is JetBrains Mono; MOXEN_SHOTS_FONT_DIR points at a folder holding
# JetBrainsMono-{Regular,Bold,Italic,BoldItalic}.ttf. Without it the painter looks in the usual
# places (a JetBrains JDK ships the family), then falls back to Menlo / DejaVu / Consolas.
FONT_DIRS = [
    os.environ.get("MOXEN_SHOTS_FONT_DIR", ""),
    str(HOME / "Library/Fonts"),
    "/Library/Fonts",
    "/usr/share/fonts/truetype/jetbrains-mono",
    *glob.glob(str(HOME / ".jdks/**/lib/fonts"), recursive=True),
]
FALLBACK_FILES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "C:/Windows/Fonts/consola.ttf",
]
SYMBOL_FILES = [
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]


def load_face(style):
    for folder in FONT_DIRS:
        if folder and (pathlib.Path(folder) / f"JetBrainsMono-{style}.ttf").exists():
            return ImageFont.truetype(str(pathlib.Path(folder) / f"JetBrainsMono-{style}.ttf"), SIZE)
    for path in FALLBACK_FILES:
        try:
            return ImageFont.truetype(path, SIZE, index={"Regular": 0, "Bold": 1, "Italic": 2, "BoldItalic": 3}[style])
        except OSError:
            continue
    return ImageFont.load_default()


def load_symbols():
    faces = []
    for path in SYMBOL_FILES:
        try:
            faces.append(ImageFont.truetype(path, SIZE))
        except OSError:
            continue
    return faces


def mix(a, b, t):
    pa = [int(a[i : i + 2], 16) for i in (1, 3, 5)]
    pb = [int(b[i : i + 2], 16) for i in (1, 3, 5)]
    return tuple(round(x + (y - x) * t) for x, y in zip(pa, pb))


def has_glyph(font, char):
    """False for a face's "missing glyph" box, which draws something but is not the character."""
    mask = font.getmask(char)
    if mask.getbbox() is None:
        return False
    return bytes(mask) != bytes(font.getmask("\uffff")) or mask.size != font.getmask("\uffff").size


def paint(source: pathlib.Path) -> None:
    data = json.loads(source.read_text())
    faces = {(b, i): load_face({(False, False): "Regular", (True, False): "Bold", (False, True): "Italic", (True, True): "BoldItalic"}[(b, i)]) for b in (False, True) for i in (False, True)}
    symbols = load_symbols()
    image = Image.new("RGB", (data["cols"] * CELL_W, len(data["lines"]) * CELL_H))
    draw = ImageDraw.Draw(image)
    for y, line in enumerate(data["lines"]):
        for span in line:
            x0, y0 = span["x"] * CELL_W, y * CELL_H
            draw.rectangle([x0, y0, x0 + span["width"] * CELL_W - 1, y0 + CELL_H - 1], fill=span["bg"])
            fg = mix(span["bg"], span["fg"], 0.5) if span["dim"] else span["fg"]
            font = faces[(span["bold"], span["italic"])]
            if LIGATURES:
                font = ImageFont.truetype(font.path, SIZE, layout_engine=ImageFont.Layout.RAQM)
            # Runs of glyphs the main face has are shaped together, so JetBrains Mono's ligatures
            # form; anything else (blocks, symbols from other faces) is placed cell by cell.
            run, run_start = "", 0
            def flush_run(end):
                nonlocal run
                if run:
                    kwargs = {"features": ["calt", "liga"]} if LIGATURES else {}
                    draw.text((x0 + run_start * CELL_W, y0 + BASELINE), run, font=font, fill=fg, anchor="ls", stroke_width=STROKE, stroke_fill=fg, **kwargs)
                run = ""
            for offset, char in enumerate(span["text"]):
                cx = x0 + offset * CELL_W
                if char == "\u2588":
                    flush_run(offset)
                    draw.rectangle([cx, y0, cx + CELL_W - 1, y0 + CELL_H - 1], fill=fg)
                elif char == " " or has_glyph(font, char):
                    if not run:
                        run_start = offset
                    run += char
                else:
                    flush_run(offset)
                    fallback = next((f for f in symbols if has_glyph(f, char)), font)
                    draw.text((cx, y0 + BASELINE), char, font=fallback, fill=fg, anchor="ls", stroke_width=STROKE, stroke_fill=fg)
            flush_run(len(span["text"]))
            if span["underline"]:
                draw.line([x0, y0 + CELL_H - SCALE, x0 + len(span["text"]) * CELL_W, y0 + CELL_H - SCALE], fill=fg)
    image.resize((image.width // SUPERSAMPLE, image.height // SUPERSAMPLE), Image.LANCZOS).save(source.with_suffix(".png"))


def sheet(root: pathlib.Path, name: str, themes: list) -> pathlib.Path:
    """One image comparing every theme's `name`.png, three to a row, each at half size."""
    tiles = []
    for theme in themes:
        image = Image.open(root / theme / name)
        tiles.append((theme, image.resize((image.width // 2, image.height // 2), Image.LANCZOS)))
    cols = 3
    gap, label_h = 24, 40
    cell_w = max(tile.width for _, tile in tiles)
    cell_h = max(tile.height for _, tile in tiles) + label_h
    rows = (len(tiles) + cols - 1) // cols
    out = Image.new("RGB", (cols * cell_w + (cols + 1) * gap, rows * cell_h + (rows + 1) * gap), "#303030")
    draw = ImageDraw.Draw(out)
    font = load_face("Bold")
    font = font.font_variant(size=26)
    for index, (theme, tile) in enumerate(tiles):
        x = gap + (index % cols) * (cell_w + gap)
        y = gap + (index // cols) * (cell_h + gap)
        draw.text((x, y + 4), theme, font=font, fill="#f0f0f0")
        out.paste(tile, (x, y + label_h))
    target = root / "sheets" / name
    target.parent.mkdir(exist_ok=True)
    out.save(target)
    return target


if __name__ == "__main__":
    from multiprocessing import Pool

    root = pathlib.Path(sys.argv[1])
    sources = sorted(root.glob("*/*.json"))
    with Pool() as pool:
        pool.map(paint, sources)
    print(f"painted {len(sources)} images under {root}")
    if "--sheets" in sys.argv:
        themes = sorted({p.parent.name for p in sources}, key=lambda t: (t != "moxen", t))
        names = sorted({p.with_suffix(".png").name for p in sources})
        for name in names:
            sheet(root, name, [t for t in themes if (root / t / name).exists()])
        print(f"built {len(names)} sheets under {root / 'sheets'}")
