# Collision

Axis-aligned, **half-open** intervals throughout. Touching edges do NOT collide.

The bird occupies `[BIRD_X, BIRD_X + BIRD_W)` horizontally and
`[y, y + BIRD_H)` vertically.

A pipe at `x` occupies `[x, x + PIPE_W)` horizontally.

    def rect_overlap(a0, a1, b0, b1):
        return a0 < b1 and b0 < a1

The bird hits a pipe when it overlaps horizontally AND is outside the open gap:

    horizontal = rect_overlap(BIRD_X, BIRD_X + BIRD_W, x, x + PIPE_W)
    outside    = y < gap_top or y + BIRD_H > gap_top + GAP_H
    hit        = horizontal and outside

A hit sets `alive = False`. Collision is evaluated against every pipe each tick;
one hit is enough.

Watch the boundary cases: a bird whose bottom is exactly `gap_top + GAP_H` is
INSIDE the gap and survives; a pipe whose right edge is exactly `BIRD_X` does not
overlap.
