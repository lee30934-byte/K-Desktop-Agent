"""Regression check: the antenna ball on every pose/tone/tier must be round, not cut flat.

2026-11-11: frames 3-8 (incl. the working pose) had the ball cut flat because the source
sheet's ball crosses into the cell above and that strip was discarded as bleed.
A round ball has a soft glow above its opaque top; a flat cut has none (glow and opaque
ball start on the same row). Measured on the old assets: gap 0-1 px for frames 3-8 at every
tier; after the fix 2-19 px. Frames 0-2 were always fine (gap 2-11 px).

Usage: py -3 scripts/check-companion-antenna.py [asset_dir]   (exit 1 on failure)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "src" / "assets" / "companion"
def glow_gap(cell_alpha: np.ndarray) -> int:
    """Rows of faint glow above the first opaque row of the figure (its antenna ball)."""
    any_top = int(np.nonzero((cell_alpha > 8).any(axis=1))[0][0])
    opaque_top = int(np.nonzero((cell_alpha > 128).any(axis=1))[0][0])
    return opaque_top - any_top


def min_gap(cell: int) -> int:
    return max(2, round(cell * 0.008))   # 500px cell -> 4, 340 -> 3, 230/160 -> 2


def main() -> int:
    failures = []
    checked = 0
    for path in sorted(ASSETS.glob("head-*.webp")):
        im = np.array(Image.open(path).convert("RGBA"))
        cell = im.shape[0] // 3
        for f in range(9):
            a = im[(f // 3) * cell:(f // 3 + 1) * cell, (f % 3) * cell:(f % 3 + 1) * cell, 3]
            gap = glow_gap(a)
            checked += 1
            if gap < min_gap(cell):
                failures.append(f"{path.name} frame {f}: antenna glow gap {gap}px < {min_gap(cell)}px (ball cut flat)")
    print(f"checked {checked} head cells")
    for line in failures:
        print("FAIL", line)
    if not checked:
        print("FAIL no head sheets found")
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
