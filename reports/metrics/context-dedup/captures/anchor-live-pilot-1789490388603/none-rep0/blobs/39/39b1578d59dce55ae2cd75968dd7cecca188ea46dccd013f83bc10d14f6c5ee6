# flapsim — a headless deterministic side-scroller

A tiny flappy-bird-style engine with NO rendering. Everything is integer arithmetic
in centi-units, so a run is byte-for-byte reproducible on any machine.

Python 3 standard library only. No pip, no network, no pygame, no display.

## Build order

    spec/00_overview.md   module decomposition and the engineering rules — READ FIRST
    spec/01_units.md      centi-units and the constant table
    spec/02_physics.md    the per-tick order (NORMATIVE — most bugs live here)
    spec/03_world.md      the LCG and pipe spawning
    spec/04_collide.md    axis-aligned overlap, half-open intervals
    spec/05_score.md      passing a pipe, and the clean-glide bonus
    spec/06_cli.md        the command line and the exact output format
    spec/07_powerups.md   FUTURE WORK — read for context, do not implement yet
    spec/08_examples.md   six worked examples; these are the --selfcheck set

## Checking your work

    python3 flapsim.py --selfcheck

prints one line per worked example and nothing else. It has no timing and no paths,
so two runs with no code change between them produce identical output. Prefer it to
the test runner when you want to know whether something changed.
