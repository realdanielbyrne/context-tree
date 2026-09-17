# Overview — decomposition and engineering rules

Implement exactly six modules, flat in the workspace root, imported by plain name:

    units.py     the constant table, nothing else            ~25 lines
    physics.py   step_bird(y, vy, flap) -> (y, vy, alive)     ~25 lines
    world.py     lcg(s), spawn(t, s), scroll(pipes), cull(pipes)  ~35 lines
    collide.py   rect_overlap(...), pipe_hit(y, pipe)         ~25 lines
    engine.py    run(seed, ticks, flaps, powerups=False) -> state   ~50 lines
    flapsim.py   argv parsing and output formatting           ~45 lines

## Rules

1. **No module may exceed 55 lines or 1800 characters.** If one grows past that,
   split it. This is graded.
2. **Integers only.** No float literals anywhere. All quantities are centi-units
   (see spec/01_units.md). Division is `//`.
3. No `argparse` — parse `sys.argv` by hand and keep flapsim.py small.
4. Every module is importable on its own and has no side effects at import time.
5. `engine.run` returns a dict with keys: `y`, `vy`, `score`, `alive`, `ticks_run`,
   and (only when powerups are enabled) `shields`.
