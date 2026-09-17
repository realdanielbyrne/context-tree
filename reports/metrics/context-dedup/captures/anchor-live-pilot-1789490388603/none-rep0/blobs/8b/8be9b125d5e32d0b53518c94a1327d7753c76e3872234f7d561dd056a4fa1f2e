# Physics and the per-tick order

This order is NORMATIVE. Doing these steps in a different order produces different
scores and is the most common bug in this project.

For each tick `t` from 0 while the bird is alive:

    1. SPAWN    if t % SPAWN_EVERY == 0: append a new pipe at x = SPAWN_X
    2. PHYSICS  if this tick flaps:  vy = FLAP_V
                else:                vy = min(vy + G, VY_MAX)
                y += vy
                if y < 0:            y = 0 and vy = 0        (ceiling is soft)
                if y + BIRD_H > FIELD_H:
                                     y = FIELD_H - BIRD_H and alive = False
    3. SCROLL   every pipe: x -= SCROLL
    4. COLLIDE  see spec/04_collide.md
    5. SCORE    see spec/05_score.md
    6. CULL     drop every pipe with x + PIPE_W <= 0
    7. HALT     if not alive, the run stops at this tick

Note carefully:

* `VY_MAX` clamps **gravity only**. A flap sets vy to FLAP_V and is never clamped.
* The ceiling zeroes vy; the floor does not — it kills.
* Scrolling happens BEFORE collision, so a pipe can move into the bird on the same
  tick it becomes overlapping.
* `ticks_run` counts the ticks actually executed, including the fatal one.
