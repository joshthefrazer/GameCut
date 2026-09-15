"""
Render the GameCut mark to everything that needs it.

Outputs, all into build/:
  icon.ico              six bitmaps, 16 → 256, each drawn at its own size
  icon.png              256px, for anywhere that wants a PNG
  icon-sheet.png        a contact sheet, so it can be judged small
  installer-side.bmp    the 164x314 panel NSIS puts down the side
  mark.svg              the same drawing as vectors, for the app and the site

The geometry itself lives in qa/mark.py so the SVG and the bitmaps cannot
drift apart. See that file for why the mark is what it is.
"""
from PIL import Image, ImageDraw
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mark import (                                              # noqa: E402
    BODY, BODY_R, BUMPER_L, BUMPER_R, BUMPER_RAD,
    GRIP_W, GRIP_H, GRIP_R, GRIP_L, GRIP_R_POS,
    BAND, STICK_L, STICK_R, DPAD, FACE, CLIPS, PLAYHEAD,
    TILE_TOP, TILE_BOT, SHELL, CLIP_A, CLIP_B, PLAY, parts_for, band_for, clips_for,
)

SS = 4                     # supersample factor
SIZES = [256, 128, 64, 48, 32, 16]
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build')
os.makedirs(OUT_DIR, exist_ok=True)


def rounded(draw, box, r, fill, n):
    draw.rounded_rectangle(
        [box[0] * n, box[1] * n, box[2] * n, box[3] * n],
        radius=max(1, r * n), fill=fill)


def grip(n, cx, cy, deg):
    """One grip, as its own layer so it can be leaned outward."""
    w, h = GRIP_W * n, GRIP_H * n
    pad = int(max(w, h))
    lay = Image.new('L', (pad * 2, pad * 2), 0)
    d = ImageDraw.Draw(lay)
    d.rounded_rectangle(
        [pad - w / 2, pad - h / 2, pad + w / 2, pad + h / 2],
        radius=GRIP_R * n, fill=255)
    lay = lay.rotate(-deg, resample=Image.BICUBIC, center=(pad, pad))
    return lay, (int(cx * n) - pad, int(cy * n) - pad)


def render(px):
    p = parts_for(px)
    n = px * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))

    # ── Tile ──────────────────────────────────────────────────────
    grad = Image.new('RGBA', (1, n))
    for y in range(n):
        t = y / max(1, n - 1)
        grad.putpixel((0, y), (
            round(TILE_TOP[0] + (TILE_BOT[0] - TILE_TOP[0]) * t),
            round(TILE_TOP[1] + (TILE_BOT[1] - TILE_TOP[1]) * t),
            round(TILE_TOP[2] + (TILE_BOT[2] - TILE_TOP[2]) * t),
            255,
        ))
    grad = grad.resize((n, n))
    tile = Image.new('L', (n, n), 0)
    ImageDraw.Draw(tile).rounded_rectangle(
        [0, 0, n - 1, n - 1], radius=int(n * p['radius']), fill=255)
    img.paste(grad, (0, 0), tile)

    # ── The controller, as one silhouette ─────────────────────────
    shell = Image.new('L', (n, n), 0)
    sd = ImageDraw.Draw(shell)
    for cx, cy, deg in (GRIP_L, GRIP_R_POS):
        lay, at = grip(n, cx, cy, deg)
        shell.paste(255, at, lay)
    if p['shoulder']:
        rounded(sd, BUMPER_L, BUMPER_RAD, 255, n)
        rounded(sd, BUMPER_R, BUMPER_RAD, 255, n)
    rounded(sd, BODY, BODY_R, 255, n)

    # ── The cut ───────────────────────────────────────────────────
    # Taken out of the silhouette, so what shows through is the tile — a real
    # slice, not a grey stripe painted on top of a controller.
    band = band_for(px)
    sd.rectangle([band[0] * n, band[1] * n, band[2] * n, band[3] * n], fill=0)

    # ── Buttons, as holes in the shell ────────────────────────────
    # Holes rather than grey shapes: a hole is the tile colour, which is
    # already on screen, so it stays legible one step further down in size.
    if p['sticks']:
        for cx, cy, r in (STICK_L, STICK_R):
            sd.ellipse([(cx - r) * n, (cy - r) * n, (cx + r) * n, (cy + r) * n], fill=0)
    if p['dpad']:
        cx, cy, arm, th = DPAD
        sd.rectangle([(cx - arm) * n, (cy - th) * n, (cx + arm) * n, (cy + th) * n], fill=0)
        sd.rectangle([(cx - th) * n, (cy - arm) * n, (cx + th) * n, (cy + arm) * n], fill=0)
    if p['face']:
        cx, cy, sp, r = FACE
        for dx, dy in ((0, -sp), (0, sp), (-sp, 0), (sp, 0)):
            sd.ellipse([(cx + dx - r) * n, (cy + dy - r) * n,
                        (cx + dx + r) * n, (cy + dy + r) * n], fill=0)

    white = Image.new('RGBA', (n, n), (*SHELL, 255))
    img.paste(white, (0, 0), shell)

    # ── The timeline in the cut ───────────────────────────────────
    inset = (band[3] - band[1]) * 0.16
    cd = ImageDraw.Draw(img)
    for i, (x0, x1) in enumerate(clips_for(px)):
        cd.rounded_rectangle(
            [x0 * n, (band[1] + inset) * n, x1 * n, (band[3] - inset) * n],
            radius=max(1, (band[3] - band[1]) * 0.22 * n),
            fill=(*(CLIP_B if i == 1 else CLIP_A), 255))

    if p['playhead']:
        # Standing a little proud of the strip at large sizes, the way a
        # playhead does on the real timeline.
        over = (band[3] - band[1]) * p['playhead_over']
        w = max(1, p['playhead_w'] * n)
        cd.rounded_rectangle(
            [PLAYHEAD * n - w / 2, (band[1] - over) * n,
             PLAYHEAD * n + w / 2, (band[3] + over) * n],
            radius=w / 2, fill=(*PLAY, 255))

    return img.resize((px, px), Image.LANCZOS)


frames = [render(s) for s in SIZES]
ico = os.path.join(OUT_DIR, 'icon.ico')
frames[0].save(ico, format='ICO', sizes=[(s, s) for s in SIZES])
frames[0].save(os.path.join(OUT_DIR, 'icon.png'), format='PNG')

# A contact sheet, so the thing can be judged at the sizes it is actually seen
# at rather than only at 256.
sheet = Image.new('RGBA', (sum(SIZES) + 20 * len(SIZES), 300), (11, 26, 46, 255))
x = 10
for f, s in zip(frames, SIZES):
    sheet.alpha_composite(f, (x, 150 - s // 2))
    x += s + 20
sheet.save(os.path.join(OUT_DIR, 'icon-sheet.png'))

# ── The installer's side panel ────────────────────────────────────
# NSIS wants exactly 164x314, and it wants a BMP. It is the first thing anyone
# sees of GameCut, before a single frame of the app, so it carries the mark and
# the name of whoever made it rather than being left as the default grey.
SIDE_W, SIDE_H = 164, 314
side = Image.new('RGB', (SIDE_W * SS, SIDE_H * SS), (11, 18, 32))
sw, sh = side.size
sd = ImageDraw.Draw(side)
for y in range(sh):
    t = y / (sh - 1)
    sd.line([(0, y), (sw, y)], fill=(
        round(9 + (19 - 9) * t), round(16 + (58 - 16) * t), round(30 + (110 - 30) * t)))
glow = Image.new('RGBA', (sw, sh), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in range(26, 0, -1):
    a = int(4 + 30 * (1 - i / 26))
    r = int(sw * 0.30 * i / 26) + int(sw * 0.16)
    gd.ellipse([sw // 2 - r, int(sh * 0.30) - r, sw // 2 + r, int(sh * 0.30) + r],
               fill=(56, 132, 246, a))
side = Image.alpha_composite(side.convert('RGBA'), glow).convert('RGB')

mark_img = render(128).resize((int(sw * 0.34), int(sw * 0.34)), Image.LANCZOS)
side.paste(mark_img, (sw // 2 - mark_img.width // 2, int(sh * 0.30) - mark_img.height // 2), mark_img)
side = side.resize((SIDE_W, SIDE_H), Image.LANCZOS)

sd = ImageDraw.Draw(side)


def centred(text, y, fill, size):
    """Centre a line without depending on a font file being present."""
    try:
        from PIL import ImageFont
        f = ImageFont.truetype('DejaVuSans-Bold.ttf' if size > 12 else 'DejaVuSans.ttf', size)
    except Exception:
        f = None
    w = sd.textlength(text, font=f)
    sd.text(((SIDE_W - w) / 2, y), text, fill=fill, font=f)


centred('GameCut', 186, (255, 255, 255), 20)
centred('Frazer’s Softwares', 214, (150, 190, 245), 11)
side.save(os.path.join(OUT_DIR, 'installer-side.bmp'), format='BMP')

# ── The same drawing, as vectors ──────────────────────────────────
from make_mark_svg import write_svg                              # noqa: E402
svg_out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'mark.svg')
write_svg(svg_out)

print('wrote', ico, [f.size for f in frames], '+ installer-side.bmp + assets/mark.svg')
