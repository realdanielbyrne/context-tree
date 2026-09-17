# Command line and output format

    python3 flapsim.py --seed S --ticks N --flaps BITS [--powerups]
    python3 flapsim.py --selfcheck

`--flaps` is a bit string; the bird flaps on tick `t` iff `BITS[t % len(BITS)] == '1'`.
It defaults to `"0"`. Parse `sys.argv` by hand — do not use argparse.

## Normal output

One TRACE line every `max(1, N // 20)` ticks, then exactly one DIGEST line. Widths are
literal: `t` and `y` are 4 digits zero-padded, `vy` is signed with 4 digits after the
sign, `score` is 2 digits.

```
TRACE t=0000 y=0533 vy=-0027 score=00 alive=1
TRACE t=0010 y=0578 vy=-0009 score=00 alive=1
DIGEST seed=7 ticks=200 score=8 alive=1 y=0578 vy=-0009 ticks_run=200
```

A TRACE line is printed after step 6 of the tick, so it reflects the post-cull state.
If the bird dies, the run stops and DIGEST still prints.

## Self check

`--selfcheck` runs the six cases in spec/08_examples.md and prints one line each, then
exits. It takes no other flags and prints nothing else.
