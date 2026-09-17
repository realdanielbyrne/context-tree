# World — the generator and pipe motion

## The LCG

    s = (1103515245 * s + 12345) % 2147483648

`s` starts at the `--seed` value. Advance it ONCE per spawn, before computing the
gap, and keep the advanced value as the new state.

## Spawning

On a spawn tick, advance the LCG, then:

    gap_top = 40 + (s >> 8) % 80

The pipe occupies the full column except the open gap:

    open gap = [gap_top, gap_top + GAP_H)     # half-open

A pipe is a dict: `{"x": SPAWN_X, "gap_top": gap_top, "passed": False}`.

## Motion and culling

Every tick, after physics: `x -= SCROLL` for every pipe.
After scoring: drop every pipe whose `x + PIPE_W <= 0`. A culled pipe can never be
scored again, so cull after scoring, never before.
