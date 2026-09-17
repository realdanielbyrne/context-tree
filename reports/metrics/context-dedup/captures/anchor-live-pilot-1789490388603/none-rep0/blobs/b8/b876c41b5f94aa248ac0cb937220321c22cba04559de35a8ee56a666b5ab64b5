# Units and constants

All positions and velocities are **centi-units**: integers, 100 per display unit.
Never introduce a float. Use `//` for division.

    FIELD_H      1200     playfield height
    BIRD_X        300     the bird's fixed horizontal position
    BIRD_W         80     bird width
    BIRD_H         80     bird height

    G              18     gravity added to vy each tick
    FLAP_V        -27     vy is SET to this on a flap (not added)
    VY_MAX        260     terminal downward speed

    SCROLL         40     pixels every pipe moves left per tick
    PIPE_W        120     pipe width
    GAP_H        1000     vertical gap height
    SPAWN_X      2000     x at which a new pipe appears
    SPAWN_EVERY    45     spawn when t % SPAWN_EVERY == 0
    GLIDE_VY       40     |vy| at or below this counts as a clean glide

Initial state: `y = 560`, `vy = 0`, `score = 0`, `alive = True`, `pipes = []`.

Put these in units.py as module-level names and import them everywhere else. Do not
re-declare a constant in more than one file.
