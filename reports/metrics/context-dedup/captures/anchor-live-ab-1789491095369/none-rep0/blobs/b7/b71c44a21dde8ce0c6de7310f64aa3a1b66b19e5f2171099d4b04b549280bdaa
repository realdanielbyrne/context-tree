# Scoring

Scoring happens after collision, in step 5 of the tick order.

A pipe is **passed** on the first tick where its right edge is at or behind the
bird's left edge:

    x + PIPE_W <= BIRD_X

On that tick, and only that tick, set the pipe's `passed` flag and:

    score += 1

and additionally, **on the same tick**:

    if abs(vy) <= GLIDE_VY:
        score += 1          # the clean-glide bonus

So a pipe passed while nearly level is worth 2, and a pipe passed while climbing or
diving hard is worth 1.

Because scoring runs after collision, a tick that kills the bird scores nothing —
the bird is already dead and the run halts at step 7.

A pipe may only ever be scored once. Use the `passed` flag, not the position alone.
