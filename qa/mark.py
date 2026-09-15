"""
The GameCut mark: a controller with a timeline cut through it.

── The idea ──────────────────────────────────────────────────────
A game controller, sliced across the middle by a strip of timeline —
clips, gaps and a playhead — running straight through the body and out
the other side. The two things GameCut is about, in one shape, without
either of them being a decoration stuck onto the other.

── Why the geometry lives in one place ───────────────────────────
The same drawing has to be a Windows .ico (six separate bitmaps), the
website favicon, and the mark in the app's own top bar. Drawing it three
times by hand is how a logo ends up subtly different in three places, so
every coordinate is defined once here, in units of the tile (0..1), and
both the PNG renderer and the SVG writer read from it.

── Why each size is drawn separately ─────────────────────────────
Detail that reads at 256px is mud at 16. So the parts list is graded:
at 256 there are sticks, a d-pad, four face buttons and four clips in
the timeline; by 32 the buttons are gone and the strip has two clips;
at 16 there is a controller and one bright playhead, because that is all
16 pixels can hold. Each is rendered at its own size rather than resized
down from the big one.
"""

# ── Geometry, in fractions of the tile ────────────────────────────
BODY = (0.185, 0.272, 0.815, 0.637)      # x0, y0, x1, y1
BODY_R = 0.135

# Bumpers: two stubs poking above the shoulders. Small, but they are most of
# what tells a controller from a rounded blob at a glance.
# Sat out at the corners rather than inboard: a pair of stubs near the middle
# of the top edge does not read as shoulder buttons, it reads as ears.
BUMPER_L = (0.196, 0.228, 0.372, 0.320)
BUMPER_R = (0.628, 0.228, 0.804, 0.320)
BUMPER_RAD = 0.046

# Grips: a rounded bar each side, leaned outward so the silhouette widens at
# the bottom the way a controller does in the hand. Narrower and longer than
# the body is wide, because that gap between the two grips is the other half
# of what makes the shape readable when it is twelve pixels across.
GRIP_W, GRIP_H, GRIP_R = 0.180, 0.340, 0.088
GRIP_L = (0.250, 0.662, -22.0)           # cx, cy, degrees
GRIP_R_POS = (0.750, 0.662, 22.0)

# The cut. Wider than the controller on purpose: the timeline does not
# start and stop at the edges of the body, it passes through it.
BAND = (0.070, 0.440, 0.930, 0.517)

# Sticks, d-pad and buttons, arranged the way a modern controller arranges
# them — and, usefully, in a diagonal that the cut passes cleanly between.
STICK_L = (0.318, 0.365, 0.052)          # cx, cy, r
STICK_R = (0.605, 0.577, 0.052)
DPAD = (0.395, 0.577, 0.049, 0.020)      # cx, cy, arm, half-thickness
FACE = (0.682, 0.365, 0.045, 0.021)      # cx, cy, spread, r

# Clips in the strip: (x0, x1) pairs across the band, and where the
# playhead sits. Chosen to look like a real timeline — uneven lengths,
# one gap — rather than an even row of dashes.
CLIPS = [(0.080, 0.290), (0.308, 0.468), (0.520, 0.706), (0.722, 0.920)]
PLAYHEAD = 0.560

# ── Colours ───────────────────────────────────────────────────────
TILE_TOP = (37, 99, 235)       # #2563eb
TILE_BOT = (14, 165, 233)      # #0ea5e9
SHELL = (255, 255, 255)
# Clips read as clips, not as a colour chart: mostly one pale blue, with a
# single teal one standing in for an audio track — which is what a real
# timeline looks like from a distance.
CLIP_A = (176, 232, 255)       # pale sky
CLIP_B = (45, 212, 191)        # #2dd4bf — the app's own audio teal
PLAY = (251, 191, 36)          # #fbbf24 — the timeline's own playhead amber


def parts_for(px):
    """
    What to draw at this size.

    Everything is a judgement about legibility, not about taste: a d-pad is
    four pixels of grey mush at 32, and a strip with four clips in it at 16 is
    a dotted line.
    """
    return {
        'sticks': px >= 48,
        'dpad': px >= 64,
        'face': px >= 48,
        'shoulder': px >= 32,
        'clips': 4 if px >= 96 else 3 if px >= 48 else 2 if px >= 24 else 0,
        'playhead': True,
        # The strip has to get proportionally thicker as the icon shrinks or it
        # closes up in the downsample and the controller looks merely dented.
        'band_grow': 1.0 if px >= 96 else 1.25 if px >= 48 else 1.6 if px >= 24 else 2.0,
        'radius': 0.22 if px >= 64 else 0.19 if px >= 32 else 0.16,
        'playhead_over': 0.34 if px >= 64 else 0.0,
        'playhead_w': 0.016 if px >= 64 else 0.026,
    }


def band_for(px):
    """The cut, at this size. Thicker in proportion the smaller it gets."""
    g = parts_for(px)['band_grow']
    h = (BAND[3] - BAND[1]) * g
    cy = (BAND[1] + BAND[3]) / 2
    return (BAND[0], cy - h / 2, BAND[2], cy + h / 2)


def clips_for(px):
    """
    The clips in the strip, at this size.

    With fewer of them the ones that remain are respaced across the whole
    strip — dropping the last two would leave the right-hand half of the
    timeline empty, which reads as a mistake rather than as a smaller icon.
    """
    n = parts_for(px)['clips']
    if n >= 4:
        return CLIPS
    if n == 3:
        return [(0.095, 0.330), (0.355, 0.585), (0.615, 0.905)]
    if n == 2:
        return [(0.095, 0.470), (0.520, 0.905)]
    return []
