# Expected output for the demo command

This is the ground truth for

    python3 flapsim.py --seed 7 --ticks 200 --flaps 0010

Your program must print EXACTLY this, character for character:

```
TRACE t=0000 y=0578 vy=+0018 score=00 alive=1
TRACE t=0010 y=0587 vy=-0027 score=00 alive=1
TRACE t=0020 y=0587 vy=+0009 score=00 alive=1
TRACE t=0030 y=0587 vy=-0027 score=00 alive=1
TRACE t=0040 y=0587 vy=+0009 score=00 alive=1
TRACE t=0050 y=0587 vy=-0027 score=02 alive=1
TRACE t=0060 y=0587 vy=+0009 score=02 alive=1
TRACE t=0070 y=0587 vy=-0027 score=02 alive=1
TRACE t=0080 y=0587 vy=+0009 score=02 alive=1
TRACE t=0090 y=0587 vy=-0027 score=04 alive=1
TRACE t=0100 y=0587 vy=+0009 score=04 alive=1
TRACE t=0110 y=0587 vy=-0027 score=04 alive=1
TRACE t=0120 y=0587 vy=+0009 score=04 alive=1
TRACE t=0130 y=0587 vy=-0027 score=04 alive=1
TRACE t=0140 y=0587 vy=+0009 score=06 alive=1
TRACE t=0150 y=0587 vy=-0027 score=06 alive=1
TRACE t=0160 y=0587 vy=+0009 score=06 alive=1
TRACE t=0170 y=0587 vy=-0027 score=06 alive=1
TRACE t=0180 y=0587 vy=+0009 score=08 alive=1
TRACE t=0190 y=0587 vy=-0027 score=08 alive=1
DIGEST seed=7 ticks=200 score=8 alive=1 y=0578 vy=-0009 ticks_run=200
```

Diff your output against this block before moving on. If it differs, the cause is
almost always one of: printing TRACE on the wrong ticks (see spec/06_cli.md — the
FIRST tick of each group, t = 0, 10, 20 ...), zero-padding `score` in DIGEST when it
must not be padded, or doing the per-tick steps in the wrong order (spec/02).
