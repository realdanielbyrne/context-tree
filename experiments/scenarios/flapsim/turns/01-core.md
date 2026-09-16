Build `flapsim`, a headless deterministic side-scroller engine, from the specs in spec/.

Start with the core. Read spec/00_overview.md, spec/01_units.md, spec/02_physics.md,
spec/03_world.md and spec/04_collide.md, then implement these four modules:

    units.py     the constant table
    physics.py   step_bird(y, vy, flap) -> (y, vy, alive)
    world.py     lcg, spawn, scroll, cull
    collide.py   rect_overlap, pipe_hit

Keep each module under 55 lines and 1800 characters. Integers only.

Reply DONE when all four files exist.
