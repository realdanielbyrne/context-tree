# Worked examples — the --selfcheck set

These six cases are normative. `python3 flapsim.py --selfcheck` must print exactly
one line per case, in this order and this format:

```
EX1 seed=7 ticks=200 flaps=0010 expect score=08 alive=1 got score=08 alive=1 OK
EX2 seed=7 ticks=120 flaps=01 expect score=00 alive=0 got score=00 alive=0 OK
EX3 seed=3 ticks=200 flaps=0001 expect score=08 alive=1 got score=08 alive=1 OK
EX4 seed=11 ticks=60 flaps=1 expect score=00 alive=0 got score=00 alive=0 OK
EX5 seed=2 ticks=90 flaps=0 expect score=00 alive=0 got score=00 alive=0 OK
EX6 seed=5 ticks=200 flaps=0010 expect score=08 alive=1 got score=08 alive=1 OK
```

`got` is what your engine returned; `expect` is the value above. Print `OK` when they
match and `FAIL` when they do not. No timing, no paths, no other output — two runs with
no code change between them must produce byte-identical output.

Note the mix: some patterns keep the bird alive for the full run, others let it fall
into a pipe or the floor. If every one of your cases scores 0, your per-tick order is
wrong — most likely you are scoring before collision, or culling before scoring.
