# Command line and output format

    python3 flapsim.py --seed S --ticks N --flaps BITS [--powerups]
    python3 flapsim.py --selfcheck

`--flaps` is a bit string; the bird flaps on tick `t` iff `BITS[t % len(BITS)] == '1'`.
It defaults to `"0"`. Parse `sys.argv` by hand — do not use argparse.

## WHICH ticks print a TRACE line

Let `EVERY = max(1, N // 20)`. Print a TRACE line on every tick `t` where

    t % EVERY == 0

evaluated at the END of the tick, after step 6 (cull). For `--ticks 200`, `EVERY` is
10, so lines appear at t = 0, 10, 20, ... — the FIRST tick of each group, never the
last. DIGEST always prints, even when the bird dies.

## Exact field formats — these are literal

    TRACE t={t:04d} y={y:04d} vy={vy:+05d} score={score:02d} alive={alive:d}
    DIGEST seed={seed:d} ticks={ticks:d} score={score:d} alive={alive:d} y={y:04d} vy={vy:+05d} ticks_run={n:d}

`score` IS zero-padded to 2 digits in TRACE and is NOT padded in DIGEST.
`vy` is a sign then 4 digits: `+0018`, `-0027`. `alive` is 1 or 0.
With `--powerups`, DIGEST gains ` shields={s:d}` at the very end; TRACE is unchanged.

spec/09_expected_output.md holds the complete expected stdout for the demo command —
diff against it.

## Self check

`--selfcheck` runs the six cases in spec/08_examples.md and prints one line each, then
exits. It takes no other flags and prints nothing else.
