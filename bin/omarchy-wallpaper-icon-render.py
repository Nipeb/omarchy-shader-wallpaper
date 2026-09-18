#!/usr/bin/env python3
"""Render the wallpaper-shader icon (mask + signed distance field) from a
source image or an Omarchy branding ASCII (braille) file.

Not meant to be called directly by hand -- omarchy-wallpaper-icon drives it.
Needs only numpy and Pillow (python-numpy, python-pillow).
"""

import sys
import argparse
import numpy as np
from PIL import Image

OUT_SIZE = 1024
PAD_FRAC = 0.06  # breathing room around the icon inside the square canvas
SDF_RANGE = 140.0  # px either side of the edge that maps to 0..1


def braille_to_bitmap(text: str) -> np.ndarray:
    lines = [ln for ln in text.splitlines() if ln.strip("\n") != "" or True]
    lines = text.splitlines() or [""]
    rows = len(lines)
    cols = max((len(ln) for ln in lines), default=1)
    bmp = np.zeros((rows * 4, cols * 2), dtype=np.uint8)
    # Unicode Braille bit -> (row, col) within a cell
    bit_pos = {0: (0, 0), 1: (1, 0), 2: (2, 0), 3: (0, 1),
               4: (1, 1), 5: (2, 1), 6: (3, 0), 7: (3, 1)}
    for r, line in enumerate(lines):
        for c, ch in enumerate(line):
            cp = ord(ch)
            if cp < 0x2800 or cp > 0x28FF:
                continue
            bits = cp - 0x2800
            for bit, (dr, dc) in bit_pos.items():
                if bits & (1 << bit):
                    bmp[r * 4 + dr, c * 2 + dc] = 255
    return bmp


def load_alpha_from_image(path: str) -> np.ndarray:
    im = Image.open(path).convert("RGBA")
    arr = np.array(im)
    alpha = arr[:, :, 3]
    if alpha.max() == alpha.min():
        # No real transparency (e.g. a flat JPEG) -- derive coverage from
        # luminance instead, on the assumption of dark ink on a light page.
        rgb = arr[:, :, :3].astype(np.float32)
        luma = rgb.mean(axis=2)
        lo, hi = np.percentile(luma, 1), np.percentile(luma, 99)
        norm = np.clip((luma - lo) / max(hi - lo, 1e-6), 0, 1)
        alpha = ((1.0 - norm) * 255).astype(np.uint8)
    return alpha


def fit_to_square(alpha: np.ndarray, out_size: int, pad_frac: float) -> np.ndarray:
    ys, xs = np.where(alpha > 12)
    if len(xs) == 0:
        return np.zeros((out_size, out_size), dtype=np.uint8)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = x1 - x0 + 1, y1 - y0 + 1
    side = max(w, h)
    pad = int(side * pad_frac)
    side += pad * 2
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0

    canvas = np.zeros((side, side), dtype=np.uint8)
    src_x0 = int(round(cx - side / 2.0))
    src_y0 = int(round(cy - side / 2.0))

    dst_x0 = max(0, -src_x0)
    dst_y0 = max(0, -src_y0)
    clip_x0 = max(0, src_x0)
    clip_y0 = max(0, src_y0)
    clip_x1 = min(alpha.shape[1], src_x0 + side)
    clip_y1 = min(alpha.shape[0], src_y0 + side)
    cw = clip_x1 - clip_x0
    ch = clip_y1 - clip_y0
    if cw > 0 and ch > 0:
        canvas[dst_y0:dst_y0 + ch, dst_x0:dst_x0 + cw] = alpha[clip_y0:clip_y1, clip_x0:clip_x1]

    img = Image.fromarray(canvas, mode="L").resize((out_size, out_size), Image.LANCZOS)
    return np.array(img)


def dist_to_zero(nonzero: np.ndarray, reach: int) -> np.ndarray:
    """Euclidean distance from each True pixel to the nearest False pixel.

    Exact for distances up to `reach`; anything farther comes back as a value
    of at least `reach`, which is all the caller needs because the field is
    clamped to that range anyway. This stands in for scipy's
    distance_transform_edt, which is a 100+ MB dependency for one function.
    """
    h, w = nonzero.shape
    big = float(reach + 1)
    # Pass 1: vertical distance to the nearest False pixel in the same column.
    down = np.full((h, w), big, dtype=np.float32)
    up = np.full((h, w), big, dtype=np.float32)
    down[0] = np.where(nonzero[0], big, 0.0)
    for y in range(1, h):
        down[y] = np.where(nonzero[y], np.minimum(down[y - 1] + 1.0, big), 0.0)
    up[-1] = np.where(nonzero[-1], big, 0.0)
    for y in range(h - 2, -1, -1):
        up[y] = np.where(nonzero[y], np.minimum(up[y + 1] + 1.0, big), 0.0)
    col = np.minimum(down, up)
    col2 = col * col
    # Pass 2: best (horizontal offset, vertical distance) pair within reach.
    best = col2.copy()
    padded = np.pad(col2, ((0, 0), (reach, reach)), constant_values=big * big)
    for dx in range(1, reach + 1):
        cost = dx * dx
        best = np.minimum(best, padded[:, reach + dx:reach + dx + w] + cost)
        best = np.minimum(best, padded[:, reach - dx:reach - dx + w] + cost)
    return np.sqrt(np.where(nonzero, best, 0.0))


def make_sdf(alpha: np.ndarray, sdf_range: float) -> np.ndarray:
    inside = alpha > 127
    reach = int(np.ceil(sdf_range))
    # dist_to_zero gives distance to the nearest False pixel, so run it on
    # each side of the boundary and subtract for a signed field.
    dist_out = dist_to_zero(~inside, reach)
    dist_in = dist_to_zero(inside, reach)
    signed = dist_in - dist_out
    norm = np.clip(signed / sdf_range * 0.5 + 0.5, 0, 1)
    return (norm * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--braille", action="store_true", help="input is an Omarchy ASCII branding file")
    ap.add_argument("--blank", action="store_true", help="render an empty icon (no input file)")
    ap.add_argument("input", nargs="?")
    ap.add_argument("mask_out")
    ap.add_argument("dist_out")
    args = ap.parse_args()

    if args.blank:
        alpha = np.zeros((OUT_SIZE, OUT_SIZE), dtype=np.uint8)
    elif args.input is None:
        ap.error("an input file is required unless --blank is given")
    elif args.braille:
        with open(args.input, "r", encoding="utf-8") as f:
            text = f.read()
        alpha = braille_to_bitmap(text)
    else:
        alpha = load_alpha_from_image(args.input)

    alpha = fit_to_square(alpha, OUT_SIZE, PAD_FRAC)
    sdf = make_sdf(alpha, SDF_RANGE)

    mask_rgba = np.zeros((OUT_SIZE, OUT_SIZE, 4), dtype=np.uint8)
    mask_rgba[:, :, 0] = 255
    mask_rgba[:, :, 1] = 255
    mask_rgba[:, :, 2] = 255
    mask_rgba[:, :, 3] = alpha
    Image.fromarray(mask_rgba, mode="RGBA").save(args.mask_out)
    Image.fromarray(sdf, mode="L").save(args.dist_out)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as e:  # not an image, unreadable, ...
        print(f"omarchy-wallpaper-icon-render: {e}", file=sys.stderr)
        sys.exit(1)
