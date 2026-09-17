# Power-ups — FUTURE WORK, do not implement until asked

This describes the shield power-up. It is specified now so the design accounts for
it, but it must NOT be implemented in the initial build.

The whole feature is gated behind the `--powerups` flag. **With the flag absent the
program must behave exactly as it does today, byte for byte.** That is the hard
requirement; everything else here is secondary.

## Behaviour

`engine.run(..., powerups=True)` starts the bird with `shields = 1` and adds
`shields` to the returned state.

* When a collision would set `alive = False` and `shields > 0`, instead spend one
  shield: `shields -= 1`, the bird stays alive, and the pipe that was hit is marked
  `passed = True` immediately so it can never be scored later.
* A spent shield does NOT prevent the floor kill in step 2. Shields only absorb pipe
  collisions.
* Every 5th pipe passed (the 5th, 10th, 15th …, counted by pipes passed and not by
  score) grants `shields += 1`, capped at 3.

## Output

With `--powerups`, the DIGEST line gains one field at the end:

    DIGEST seed=7 ticks=200 score=5 alive=1 y=0872 vy=+0152 ticks_run=200 shields=1

The TRACE lines are unchanged. Without `--powerups` the DIGEST line is unchanged.
