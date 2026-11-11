"""Build the layered companion atlas from the approved 3x3 ceramic source sheet.

Why: the source sheet places the antenna on the cell edge (its glow is cut and a
rotating head pushes the ball outside the cell), lets neighbouring cells bleed in,
and only supports a straight neck cut that breaks arms crossing the neck.

Output (all 3x3 grids, one cell per pose, transparent padding on every side):
  src/assets/companion/body-<tone>.webp   body + arms, plus a narrow neck under-fill
  src/assets/companion/head-<tone>.webp   head with eyes/mouth removed and in-painted
  src/assets/companion/front-<tone>.webp  hands/props that sit in front of the head
  src/assets/companion/eyes.webp          eyes only (blink + gaze layer)
  src/assets/companion/mouth.webp         speaking mouth only (lip-sync layer)
  src/components/companionRig.ts          per-pose pivots and feature centres (% of cell)

Usage: py -3 scripts/build-companion-atlas.py [--debug <dir>]
Deterministic: same source -> same files.
"""
from __future__ import annotations

import argparse
import colorsys
import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "design" / "companion" / "k-assistant-ceramic-v2.png"
OUT = ROOT / "src" / "assets" / "companion"
RIG = ROOT / "src" / "components" / "companionRig.ts"
CELL = 500          # output cell (source cell is 418)
TOP_PAD = 44        # room for antenna glow + head rotation
ANTENNA_OVERFLOW = 24  # source rows above a cell that may hold this figure's antenna ball + glow (ball measured max 9)
BASELINE = CELL - 24
TONES = {
    # mint is the approved original art; the others recolour only the ceramic shell.
    "mint": None,
    "pearl": {"hue": 42 / 360, "sat": 0.07, "light": 1.05},
    "rose": {"hue": 328 / 360, "sat": 0.34, "light": 0.99},
}

# Per pose, in % of the source cell: head ellipse (cx, cy, rx, ry), neck line y,
# antenna box (x0, y0, x1, y1) and polygons that stay in front of the head.
POSES = {
    0: dict(head=(53, 36, 35, 24), neck=59, antenna=(48, 0, 70, 16), front=[]),
    1: dict(head=(49, 38, 34, 24), tilt=6, neck=61, antenna=(50, 0, 72, 17),
            front=[[(74, 45), (88, 45), (88, 72), (63, 72), (63, 62), (73, 57)]]),
    2: dict(head=(46, 36, 33, 24), tilt=13, neck=62, antenna=(48, 0, 68, 15),
            front=[[(24, 50), (45, 50), (47, 66), (23, 68)]]),
    3: dict(head=(52, 35, 34, 24), neck=59, antenna=(52, 0, 70, 14), front=[],
            body=[[(74, 52), (97, 52), (97, 70), (71, 70)]]),
    4: dict(head=(46, 33, 34, 24), neck=57, antenna=(44, 0, 62, 13),
            front=[[(73, 40), (89, 40), (89, 60), (70, 67), (63, 62), (71, 51)]]),
    5: dict(head=(45, 34, 34, 24), neck=57, antenna=(42, 0, 62, 13),
            front=[[(42, 52), (60, 52), (60, 68), (42, 68)]]),
    6: dict(head=(51, 35, 34, 24), neck=59, antenna=(46, 0, 66, 14), front=[]),
    7: dict(head=(47, 34, 34, 24), neck=58, antenna=(46, 0, 64, 13),
            front=[[(38, 52), (80, 52), (80, 75), (38, 75)]]),
    8: dict(head=(45, 35, 35, 25), neck=61, antenna=(42, 0, 62, 13), front=[]),
}
SPEAKING_FRAME = 3
CLOSED_EYES = {5, 6}  # arcs: no blink


def polygon_mask(poly, w, h):
    """Even-odd point-in-polygon on pixel centres. poly in pixels."""
    ys, xs = np.mgrid[0:h, 0:w]
    xs = xs + 0.5
    ys = ys + 0.5
    inside = np.zeros((h, w), bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cond = (y1 > ys) != (y2 > ys)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (x2 - x1) * (ys - y1) / (y2 - y1) + x1
        inside ^= cond & (xs < xint)
    return inside


def components(mask):
    """4-connected labelling without scipy. Returns (labels, sizes)."""
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    sizes = [0]
    cur = 0
    for y0, x0 in zip(*np.nonzero(mask)):
        if labels[y0, x0]:
            continue
        cur += 1
        labels[y0, x0] = cur
        q = deque([(y0, x0)])
        n = 0
        while q:
            y, x = q.popleft()
            n += 1
            for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not labels[yy, xx]:
                    labels[yy, xx] = cur
                    q.append((yy, xx))
        sizes.append(n)
    return labels, np.array(sizes)


def dilate(mask, r):
    out = mask.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy > r * r:
                continue
            out |= np.roll(np.roll(mask, dy, 0), dx, 1)
    return out


def inpaint(rgba, hole, region, iterations=80):
    """Diffuse colour from known pixels of `region` into `hole` (premultiplied)."""
    img = rgba.astype(np.float32)
    known = region & ~hole
    acc = img * known[..., None]
    weight = known.astype(np.float32)
    k = [(0, 1), (0, -1), (1, 0), (-1, 0)]
    for _ in range(iterations):
        s = np.zeros_like(acc)
        c = np.zeros_like(weight)
        for dy, dx in k:
            s += np.roll(np.roll(acc, dy, 0), dx, 1)
            c += np.roll(np.roll(weight, dy, 0), dx, 1)
        fill = hole & (weight == 0) & (c > 0)
        acc[fill] = s[fill] / c[fill][:, None]
        weight[fill] = 1
    out = img.copy()
    done = hole & (weight > 0)
    out[done] = acc[done]
    out[done, 3] = np.maximum(out[done, 3], 255)
    return out.clip(0, 255).astype(np.uint8)


def clean_cell(cell):
    """Drop faint fringe and anything not connected to the main figure."""
    cell[-6:] = 0  # the next row's antenna bleeds into the bottom edge; feet end near 95%
    a = cell[..., 3]
    solid = a > 40
    labels, sizes = components(solid)
    keep = np.zeros_like(solid)
    main = int(np.argmax(sizes[1:]) + 1)
    keep |= labels == main
    h, w = solid.shape
    ys, xs = np.nonzero(keep)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    for lab in range(1, len(sizes)):
        if lab == main or sizes[lab] < 30:
            continue
        ly, lx = np.nonzero(labels == lab)
        # Separate antenna balls / tablet glints of THIS figure sit inside its box;
        # neighbouring-cell bleed touches the cell border.
        if ly.min() > 2 and ly.max() < h - 3 and lx.min() > 2 and lx.max() < w - 3 \
                and x0 - 10 <= lx.mean() <= x1 + 10 and y0 - 30 <= ly.mean() <= y1:
            keep |= labels == lab
    # Keep a soft 1px edge + the green antenna/tablet glow (faint but intentional).
    edge = dilate(keep, 2) & (a > 0)
    r, g, b = (cell[..., i].astype(int) for i in range(3))
    glow = dilate(keep, 14) & (a > 0) & (g > r + 25) & (g > b - 10)
    glow[int(y0 + 0.8 * (y1 - y0)):] = False  # only antenna/tablet glow; never bleed below the feet
    out = cell.copy()
    out[..., 3] = np.where(keep | edge | glow, a, 0)
    out[..., :3] = np.where(out[..., 3:4] > 0, out[..., :3], 0)
    return out


def recolour(cell, shell, tone):
    if tone is None:
        return cell
    rgb = cell[..., :3].astype(np.float32) / 255
    out = cell.copy()
    ys, xs = np.nonzero(shell)
    base_s = []
    for y, x in zip(ys, xs):
        h, l, s = colorsys.rgb_to_hls(*rgb[y, x])
        base_s.append(s)
    mean_s = max(float(np.mean(base_s)) if base_s else 1, 1e-3)
    for (y, x), s in zip(zip(ys, xs), base_s):
        _, l, _ = colorsys.rgb_to_hls(*rgb[y, x])
        ns = min(1.0, tone["sat"] * (s / mean_s))
        nl = min(1.0, l * tone["light"])
        r, g, b = colorsys.hls_to_rgb(tone["hue"], nl, ns)
        out[y, x, :3] = (round(r * 255), round(g * 255), round(b * 255))
    return out


def build(debug: Path | None):
    src = np.array(Image.open(SOURCE).convert("RGBA"))
    S = src.shape[0] // 3
    sheets = {name: np.zeros((CELL * 3, CELL * 3, 4), np.uint8)
              for name in ["eyes", "mouth"] + [f"{l}-{t}" for l in ("body", "head", "front") for t in TONES]}
    rig = {}
    for f, pose in POSES.items():
        cell = clean_cell(src[(f // 3) * S:(f // 3 + 1) * S, (f % 3) * S:(f % 3 + 1) * S].copy())
        a = cell[..., 3] > 0
        pct = S / 100
        ys, xs = np.mgrid[0:S, 0:S]
        cx, cy, rx, ry = (v * pct for v in pose["head"])
        tilt = np.deg2rad(pose.get("tilt", 0))   # head tilt, clockwise positive
        ex = (xs - cx) * np.cos(tilt) + (ys - cy) * np.sin(tilt)
        ey = -(xs - cx) * np.sin(tilt) + (ys - cy) * np.cos(tilt)
        ellipse = (ex / rx) ** 2 + (ey / ry) ** 2 <= 1
        # The helmet's lower corners bulge past the ellipse; a wider ellipse catches
        # them (arms above the neck are excluded through `front`/`body` polygons).
        wide = (ex / (rx * 1.13)) ** 2 + (ey / (ry * 1.1)) ** 2 <= 1
        keep_body = np.zeros_like(wide)
        for poly in pose.get("body", []):
            keep_body |= polygon_mask([(x * pct, y * pct) for x, y in poly], S, S)
        neck = pose["neck"] * pct
        ax0, ay0, ax1, ay1 = pose["antenna"]
        ax0, ay0, ax1, ay1 = (ax0 - 4) * pct, ay0 * pct, (ax1 + 3) * pct, ay1 * pct
        antenna = (xs >= ax0) & (xs <= ax1) & (ys >= ay0) & (ys <= ay1)
        front = np.zeros_like(a)
        for poly in pose["front"]:
            front |= polygon_mask([(x * pct, y * pct) for x, y in poly], S, S)
        head_region = (((wide & ~keep_body) & (ys < neck)) | antenna)
        head = a & head_region & ~front
        front_px = a & front & head_region
        # The helmet's dark bottom rim/shadow dips just below the neck line. It must
        # turn with the head; the body keeps an in-painted shoulder under it.
        rlum = 0.299 * cell[..., 0].astype(int) + 0.587 * cell[..., 1].astype(int) + 0.114 * cell[..., 2].astype(int)
        rim_zone = (ex / (rx * 1.25)) ** 2 + (ey / (ry * 1.15)) ** 2 <= 1
        rim = a & rim_zone & ~keep_body & ~front & (ys >= neck) & (ys < neck + 4 * pct) & (rlum < 95)
        head |= rim
        # Ear-pod tips of a tilted head hang below the neck line outside the torso.
        yt = min(S - 1, int(neck + 6 * pct))
        row = a[yt]
        c0 = int(cx)
        if row[c0]:
            tl = c0
            while tl > 0 and row[tl - 1]: tl -= 1
            tr = c0
            while tr < S - 1 and row[tr + 1]: tr += 1
            hang = a & rim_zone & ~keep_body & ~front & (ys >= neck) & (ys < neck + 5 * pct) & ((xs < tl) | (xs > tr))
            head |= hang
            rim |= hang
        body = a & ~(head & ~rim)
        # Narrow neck under-fill so a turning head never opens a gap at the collar.
        neck_band = (np.abs(xs - cx) < 12 * pct) & (ys >= neck - 5 * pct) & (ys < neck) & ~front

        r, g, b = (cell[..., i].astype(int) for i in range(3))
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        visor = a & ellipse & (np.maximum(np.maximum(r, g), b) < 75)
        hull = np.zeros_like(visor)
        for y in range(S):
            row = np.nonzero(visor[y])[0]
            if len(row) > 20:
                hull[y, row.min():row.max() + 1] = True
        # Row hull ∩ column hull, eroded: the visor interior without its glossy rim.
        col = np.zeros_like(visor)
        for x in range(S):
            c = np.nonzero(visor[:, x])[0]
            if len(c) > 20:
                col[c.min():c.max() + 1, x] = True
        inner = ~dilate(~(hull & col), 5)
        green = (g > r + 45) & (g > b + 22) & (lum > 90)
        orange = (r > 190) & (g > b + 25) & (r - b > 70)
        seed = inner & (green | orange)
        labels, sizes = components(seed)
        order = [lab for lab in np.argsort(-sizes) if lab and sizes[lab] >= 25]
        cores = order[:2]
        core = np.isin(labels, cores)
        cy_, _ = np.nonzero(core)
        top_y, bot_y = cy_.min(), cy_.max()
        eyes = core.copy()
        mouth = np.zeros_like(a)
        for lab in order[2:]:
            ly, _ = np.nonzero(labels == lab)
            if ly.mean() > bot_y - (bot_y - top_y) * 0.15:
                mouth |= labels == lab
            elif ly.min() >= top_y:   # highlights inside the eye band (not eyebrows)
                eyes |= labels == lab
        # pink tongue/inside of the open mouth
        if f == SPEAKING_FRAME:
            mbox = dilate(mouth, 12) & inner
            mouth |= mbox & (r > 110) & (r > b + 10) & ~((r > g + 25) & (lum < 150) & ~dilate(mouth, 6))
        eyes = dilate(eyes, 7) & hull & col
        mouth = dilate(mouth, 5) & hull & col
        feature_hole = eyes | (mouth if f == SPEAKING_FRAME else np.zeros_like(mouth))

        layers = {}
        head_img = cell.copy()
        head_img[~head] = 0
        head_img = inpaint(head_img, feature_hole & head, visor & ~feature_hole | feature_hole, 60)
        # fill what the front hand hides so slivers never open while the head turns
        # Only the part of the hand that overlaps the helmet silhouette (row ∩ column hull).
        rh = np.zeros_like(head); ch = np.zeros_like(head)
        for y in range(S):
            row = np.nonzero(head[y])[0]
            if len(row) > 1: rh[y, row.min():row.max() + 1] = True
        for x in range(S):
            c = np.nonzero(head[:, x])[0]
            if len(c) > 1: ch[c.min():c.max() + 1, x] = True
        hidden = front_px & ((rh & ch) | (ellipse & (ys < neck))) & ~antenna  # holes look worse than a filled back
        head_img = inpaint(head_img, hidden & ~head, head | hidden, 120)
        head_img[~(head | hidden)] = 0
        layers["head"] = head_img
        body_img = cell.copy(); body_img[~body] = 0
        if rim.any():
            body_img = inpaint(body_img, rim, body, 40)
        # Recessed neck joint under the head: shoulder colour, darkened, never a
        # copy of the helmet underside (that copy shows as a loose strip on turns).
        band = neck_band & a
        if band.any():
            filled = inpaint(body_img, band, body & ~band & ~rim, 80)
            ok = band & (filled[..., 3] > 0)
            lum_j = (0.299 * filled[..., 0] + 0.587 * filled[..., 1] + 0.114 * filled[..., 2]) * 0.55
            joint = np.stack([lum_j, lum_j * 0.93, lum_j * 0.86, np.full_like(lum_j, 255)], -1)
            body_img[ok] = joint[ok].clip(0, 255).astype(np.uint8)
            body_img[band & ~ok] = 0
        layers["body"] = body_img
        front_img = cell.copy(); front_img[~front_px] = 0; layers["front"] = front_img
        eyes_img = cell.copy(); eyes_img[~eyes] = 0
        mouth_img = cell.copy(); mouth_img[~(mouth if f == SPEAKING_FRAME else np.zeros_like(mouth))] = 0

        # Shell = ceramic, not lights, visor, blush or the hologram tablet.
        shell = a & ~(hull & col) & ~((g > r + 12) & (g >= b - 20))

        # Placement: feet on a common baseline, legs centred.
        oy, ox = np.nonzero(a)
        bottom = oy.max()
        legs = a & (ys > bottom - 0.12 * S)
        lx = np.nonzero(legs)[1]
        leg_cx = (lx.min() + lx.max()) / 2
        dy = int(round(BASELINE - bottom))
        dx = int(round(CELL / 2 - leg_cx))
        top = oy.min() + dy
        assert top >= TOP_PAD - 40, f"frame {f} too tall"
        if top < TOP_PAD:
            raise SystemExit(f"frame {f}: top {top} < pad {TOP_PAD}")
        assert ox.min() + dx > 8 and ox.max() + dx < CELL - 8, f"frame {f} horizontal overflow"

        # 2026-11-11: in the 2nd/3rd source rows the antenna ball crosses the top cell
        # edge (up to 9 source px for the working pose) into the bottom of the cell above,
        # which clean_cell() of that cell discards as bleed -> the ball was cut flat.
        # Recover that strip, limited to this figure's antenna columns, and put it on the
        # head layer just above the cell. The figure above ends near 95% of its cell, so
        # the strip never contains its feet.
        ball_strip = None
        if f // 3 > 0:
            hy, hx = np.nonzero(head_img[..., 3] > 0)
            top_cols = hx[hy <= hy.min() + 3]
            sx0, sx1 = max(0, int(top_cols.min()) - 8), min(S, int(top_cols.max()) + 9)
            y_hi = (f // 3) * S
            strip = src[y_hi - ANTENNA_OVERFLOW:y_hi, (f % 3) * S:(f % 3 + 1) * S].copy()
            cand = np.zeros(strip.shape[:2], bool)
            sr, sg = strip[..., 0].astype(int), strip[..., 1].astype(int)
            # green ball/glow only: the ceramic feet of the figure above are neutral (r≈g)
            green_px = (strip[..., 3] > 0) & (sg > sr + 12)
            cand[:, sx0:sx1] = green_px[:, sx0:sx1]
            # only what continues across the boundary into this cell's ball (feet of the
            # figure above never touch the boundary row)
            labels, _ = components(cand)
            touching = set(np.unique(labels[-1][cand[-1]])) - {0}
            keep = np.isin(labels, list(touching)) if touching else np.zeros_like(cand)
            strip[~keep] = 0
            if keep.any():
                ball_strip = strip
                top = min(top, int(np.nonzero(keep)[0].min()) - ANTENNA_OVERFLOW + dy)

        def place(name, img):
            gy, gx = (f // 3) * CELL, (f % 3) * CELL
            canvas = np.zeros((CELL, CELL, 4), np.uint8)
            canvas[dy:dy + S, dx:dx + S] = img
            if ball_strip is not None and name.startswith("head-"):
                canvas[dy - ANTENNA_OVERFLOW:dy, dx:dx + S] = ball_strip
            sheets[name][gy:gy + CELL, gx:gx + CELL] = canvas

        for tone_name, tone in TONES.items():
            for lname in ("body", "head", "front"):
                img = layers[lname]
                tint_mask = shell & (img[..., 3] > 0)
                if lname == "head":
                    tint_mask = (shell | (hidden & ~(hull & col))) & (img[..., 3] > 0) & ~(hull & col)
                place(f"{lname}-{tone_name}", recolour(img, tint_mask, tone))
        place("eyes", eyes_img)
        place("mouth", mouth_img)

        def to_pct(px, py):
            return round((px + dx) / CELL * 100, 2), round((py + dy) / CELL * 100, 2)

        ey, ex = np.nonzero(eyes)
        my, mx = np.nonzero(mouth) if f == SPEAKING_FRAME else (np.array([0]), np.array([0]))
        ant = antenna & a & (g > r + 25)
        ty, tx = np.nonzero(ant)
        rig[f] = {
            "pivot": to_pct(cx, neck),
            "bodyPivot": to_pct(leg_cx, bottom),
            "eyes": to_pct(ex.mean(), ey.mean()),
            "mouth": to_pct(mx.mean(), my.mean()) if f == SPEAKING_FRAME else None,
            "antenna": to_pct(tx.mean(), ty.mean()) if len(tx) else to_pct((ax0 + ax1) / 2, ay1 / 2),
            "blink": f not in CLOSED_EYES,
            "front": bool(front_px.any()),
            "top": round(top / CELL * 100, 2),
        }
        if debug:
            dbg = cell.copy().astype(np.float32)
            dbg[head] = dbg[head] * 0.6 + np.array([255, 60, 60, 255]) * 0.4
            dbg[front_px] = dbg[front_px] * 0.5 + np.array([60, 120, 255, 255]) * 0.5
            dbg[eyes] = [255, 255, 0, 255]
            dbg[mouth] = [255, 0, 255, 255]
            dbg[neck_band & a] = dbg[neck_band & a] * 0.5 + np.array([0, 255, 0, 255]) * 0.5
            bg = Image.new("RGBA", (S, S), (40, 44, 52, 255))
            bg.alpha_composite(Image.fromarray(dbg.clip(0, 255).astype(np.uint8)))
            bg.save(debug / f"seg-{f}.png")

    OUT.mkdir(parents=True, exist_ok=True)
    for name, arr in sheets.items():
        Image.fromarray(arr).save(OUT / f"{name}.webp", "WEBP", quality=88, alpha_quality=92, method=6)
    meta = {
        "cell": CELL,
        # Figure height in the old sheet was 392/418 of the cell. Scale the new,
        # padded cell so the figure keeps exactly its previous on-screen size.
        "scale": round(CELL / 418, 5),
        "frames": rig,
    }
    RIG.write_text(
        "// Generated by scripts/build-companion-atlas.py — do not edit by hand.\n"
        "export interface CompanionRigFrame { pivot: [number, number]; bodyPivot: [number, number]; eyes: [number, number];\n"
        "  mouth: [number, number] | null; antenna: [number, number]; blink: boolean; front: boolean; top: number }\n"
        f"export const COMPANION_RIG: {{ cell: number; scale: number; frames: Record<number, CompanionRigFrame> }} = {json.dumps(meta, indent=1)};\n",
        encoding="utf-8", newline="\n")
    sizes = {p.name: p.stat().st_size for p in sorted(OUT.glob("*.webp"))}
    print(json.dumps({"sizes": sizes, "total": sum(sizes.values()), "rig": rig}, ensure_ascii=False))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug", type=Path)
    args = ap.parse_args()
    if args.debug:
        args.debug.mkdir(parents=True, exist_ok=True)
    build(args.debug)
