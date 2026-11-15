#!/usr/bin/env python3
"""Prepare the caption fonts for the fast (FFmpeg) renderer.

    python scripts/convert-fonts.py        (needs: pip install fonttools brotli)

The web app and the Remotion renderer load apps/web/public/fonts/*.woff2. libass (the subtitle renderer
inside FFmpeg) cannot read woff2, so this writes for every font:

  apps/worker/klipz_worker/fastrender/fonts/<name>.ttf   the same glyphs as TTF, with a fixed family name
                                                         ("KLIPZ <Family>") so libass matches it exactly
  apps/worker/klipz_worker/fastrender/fonts.json         metrics the worker needs to lay text out like the
                                                         browser: units per em, hhea and OS/2 win ascent /
                                                         descent, and the advance width of every character

The fallback font for Arabic script (presets.json "fallbackFont") is converted the same way; its
substitution and positioning tables are kept because the worker shapes that text with HarfBuzz.

Re-run it whenever a font file under apps/web/public/fonts changes, and commit the results.
"""
from __future__ import annotations

import json
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "apps" / "web" / "public" / "fonts"
DST = ROOT / "apps" / "worker" / "klipz_worker" / "fastrender"
PRESETS = json.loads((DST / "presets.json").read_text(encoding="utf-8"))


def main() -> None:
    (DST / "fonts").mkdir(parents=True, exist_ok=True)
    out: dict[str, dict] = {}
    entries = [(family, files[0]) for family, files in PRESETS["fontFiles"].items()]
    # the script fallback (Arabic script): same conversion; the worker shapes its text with HarfBuzz
    fallback = PRESETS["fallbackFont"]
    entries.append((fallback["family"], fallback))
    for family, entry in entries:
        woff2 = SRC / entry["file"]
        ttf = DST / "fonts" / entry["file"].replace(".woff2", ".ttf")
        ass_family = f"KLIPZ {family}"
        font = TTFont(str(woff2), recalcTimestamp=False)  # same input, same bytes: no churn in git
        font.flavor = None
        name = font["name"]
        for rec in list(name.names):
            if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22):
                name.removeNames(nameID=rec.nameID)
        for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
            name.setName(ass_family, 1, pid, eid, lid)
            name.setName("Regular", 2, pid, eid, lid)
            name.setName(f"{ass_family} {ttf.stem}", 3, pid, eid, lid)
            name.setName(ass_family, 4, pid, eid, lid)
            name.setName(ass_family.replace(" ", ""), 6, pid, eid, lid)
        font.save(str(ttf))

        font = TTFont(str(ttf))
        hmtx, cmap = font["hmtx"], font.getBestCmap()
        os2, hhea = font["OS/2"], font["hhea"]
        out[family] = {
            "file": ttf.name,
            "assFamily": ass_family,
            "weight": entry["weight"],
            "fallback": family == fallback["family"],
            "unitsPerEm": font["head"].unitsPerEm,
            "hheaAscent": hhea.ascent,
            "hheaDescent": hhea.descent,
            "winAscent": os2.usWinAscent,
            "winDescent": os2.usWinDescent,
            # codepoint -> advance in font units (no kerning, like CSS inline-blocks measured per word).
            # For the fallback font this only says which characters it has: widths come from shaping.
            "advances": {str(cp): hmtx[glyph][0] for cp, glyph in sorted(cmap.items())},
        }
        print(f"{ttf.name:26} {ass_family:22} {len(cmap)} characters")
    (DST / "fonts.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {DST / 'fonts.json'}")


if __name__ == "__main__":
    main()
