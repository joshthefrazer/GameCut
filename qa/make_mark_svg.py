"""
The same mark, as vectors.

The app's top bar and the website need the logo as SVG rather than as a bitmap,
and hand-copying the coordinates into a second file is how a logo ends up
subtly different in two places. So this reads qa/mark.py — the one definition —
and writes the SVG from it.

Drawn at the full-detail size: the graded-down variants exist for the .ico,
where Windows picks a bitmap; anywhere an SVG is used, the browser scales it
and the detail is free.
"""
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mark import (                                              # noqa: E402
    BODY, BODY_R, BUMPER_L, BUMPER_R, BUMPER_RAD,
    GRIP_W, GRIP_H, GRIP_R, GRIP_L, GRIP_R_POS,
    STICK_L, STICK_R, DPAD, FACE, PLAYHEAD,
    TILE_TOP, TILE_BOT, CLIP_A, CLIP_B, PLAY, band_for, clips_for,
)

V = 32.0          # viewBox units


def n(x):
    """Trim a number to two decimals without trailing noise."""
    return f'{x * V:.2f}'.rstrip('0').rstrip('.')


def hexs(rgb):
    return '#%02x%02x%02x' % rgb


def rect(box, r, fill=None):
    x0, y0, x1, y1 = box
    f = f' fill="{fill}"' if fill else ''
    return (f'<rect x="{n(x0)}" y="{n(y0)}" width="{n(x1 - x0)}" '
            f'height="{n(y1 - y0)}" rx="{n(r)}"{f}/>')


def grip_svg(cx, cy, deg, fill=None):
    box = (cx - GRIP_W / 2, cy - GRIP_H / 2, cx + GRIP_W / 2, cy + GRIP_H / 2)
    return (f'<g transform="rotate({deg:g} {n(cx)} {n(cy)})">'
            f'{rect(box, GRIP_R, fill)}</g>')


def circle(c, fill=None):
    cx, cy, r = c
    f = f' fill="{fill}"' if fill else ''
    return f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}"{f}/>'


def build():
    band = band_for(256)

    # What the shell is made of.
    shell = (
        grip_svg(*GRIP_L)
        + grip_svg(*GRIP_R_POS)
        + rect(BUMPER_L, BUMPER_RAD)
        + rect(BUMPER_R, BUMPER_RAD)
        + rect(BODY, BODY_R)
    )

    # What is taken out of it: the timeline cut, the sticks, the d-pad and the
    # four face buttons. All black in the mask, so the tile shows through.
    dx, dy, arm, th = DPAD
    fx, fy, sp, fr = FACE
    holes = (
        f'<rect x="{n(band[0])}" y="{n(band[1])}" width="{n(band[2] - band[0])}" '
        f'height="{n(band[3] - band[1])}" fill="#000"/>'
        + circle(STICK_L, '#000') + circle(STICK_R, '#000')
        + f'<rect x="{n(dx - arm)}" y="{n(dy - th)}" width="{n(arm * 2)}" height="{n(th * 2)}" fill="#000"/>'
        + f'<rect x="{n(dx - th)}" y="{n(dy - arm)}" width="{n(th * 2)}" height="{n(arm * 2)}" fill="#000"/>'
        + ''.join(circle((fx + ox, fy + oy, fr), '#000')
                  for ox, oy in ((0, -sp), (0, sp), (-sp, 0), (sp, 0)))
    )

    inset = (band[3] - band[1]) * 0.16
    clips = ''.join(
        f'<rect x="{n(x0)}" y="{n(band[1] + inset)}" width="{n(x1 - x0)}" '
        f'height="{n(band[3] - band[1] - inset * 2)}" rx="{n((band[3] - band[1]) * 0.22)}" '
        f'fill="{hexs(CLIP_B if i == 1 else CLIP_A)}"/>'
        for i, (x0, x1) in enumerate(clips_for(256)))

    over = (band[3] - band[1]) * 0.34
    pw = 0.016
    playhead = (f'<rect x="{n(PLAYHEAD - pw / 2)}" y="{n(band[1] - over)}" '
                f'width="{n(pw)}" height="{n(band[3] - band[1] + over * 2)}" '
                f'rx="{n(pw / 2)}" fill="{hexs(PLAY)}"/>')

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        '<defs>'
        '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{hexs(TILE_TOP)}"/>'
        f'<stop offset="1" stop-color="{hexs(TILE_BOT)}"/>'
        '</linearGradient>'
        '<mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">'
        '<rect width="32" height="32" fill="#fff"/>'
        f'{holes}'
        '</mask>'
        '</defs>'
        '<rect width="32" height="32" rx="7" fill="url(#g)"/>'
        f'<g mask="url(#k)" fill="#fff">{shell}</g>'
        f'{clips}{playhead}'
        '</svg>'
    )


def write_svg(path):
    svg = build()
    with open(path, 'w', encoding='utf-8') as f:
        f.write(svg)
    return svg


def data_uri():
    """
    The SVG as a CSS/href-safe data: URL, single-quoted for embedding.

    `#` MUST be percent-encoded. Left raw it is a fragment delimiter, so a
    browser reads `url("data:image/svg+xml,<svg ... fill='#fff'`, throws the
    rest away, and renders nothing at all — silently, with no console error and
    no failed request. The logo simply does not appear, which is exactly what
    happened the first time this was written.
    """
    svg = build().replace('"', "'")
    # Percent-encode everything. Leaving `<`, `>` or `#` raw is a coin-toss that
    # depends on the parser: `#` starts a fragment and truncates the document,
    # and raw angle brackets are not legal in a URL at all. Both fail the same
    # silent way — no error, no request, just nothing drawn — so none of them
    # are left to chance. The extra kilobyte is not worth an invisible logo.
    return 'data:image/svg+xml,' + urllib.parse.quote(svg, safe='')


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'mark.svg')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    print('wrote', out, len(write_svg(out)), 'bytes')
