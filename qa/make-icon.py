"""
Generate the GameCut app icon as a multi-resolution .ico.

Drawn at 4x and downsampled so the rounded corners and the play glyph stay
clean at 16px, where Windows renders the taskbar and title-bar icon.
"""
from PIL import Image, ImageDraw
import os

SS = 4                     # supersample factor
SIZES = [256, 128, 64, 48, 32, 16]
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'build')
os.makedirs(OUT_DIR, exist_ok=True)

# Brand blues, matching --acc-lo → --acc-2 in tokens.css
TOP = (37, 99, 235)        # #2563eb
BOT = (14, 165, 233)       # #0ea5e9


def render(px):
    n = px * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))

    # Vertical gradient body.
    grad = Image.new('RGBA', (1, n))
    for y in range(n):
        t = y / max(1, n - 1)
        grad.putpixel((0, y), (
            round(TOP[0] + (BOT[0] - TOP[0]) * t),
            round(TOP[1] + (BOT[1] - TOP[1]) * t),
            round(TOP[2] + (BOT[2] - TOP[2]) * t),
            255,
        ))
    grad = grad.resize((n, n))

    # Rounded-square mask.
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # Play triangle, optically centered (nudged right of true center).
    cx, cy = n * 0.545, n * 0.5
    r = n * 0.235
    d.polygon(
        [(cx - r * 0.78, cy - r), (cx - r * 0.78, cy + r), (cx + r * 0.92, cy)],
        fill=(255, 255, 255, 255),
    )

    # No sheen overlay: at icon scale a highlight band reads as a second shape
    # stacked on the tile rather than as light on it. The gradient carries it.
    return img.resize((px, px), Image.LANCZOS)


frames = [render(s) for s in SIZES]
ico = os.path.join(OUT_DIR, 'icon.ico')
frames[0].save(ico, format='ICO', sizes=[(s, s) for s in SIZES])
frames[0].save(os.path.join(OUT_DIR, 'icon.png'), format='PNG')
print('wrote', ico, [f.size for f in frames])
