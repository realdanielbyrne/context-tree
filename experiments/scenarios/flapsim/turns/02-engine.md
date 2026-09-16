Now the engine and the command line.

Read spec/05_score.md, spec/06_cli.md and spec/09_expected_output.md, then implement:

    engine.py    run(seed, ticks, flaps, powerups=False) -> state
    flapsim.py   sys.argv parsing and the output format, plus --selfcheck

spec/09_expected_output.md contains the exact stdout that

    python3 flapsim.py --seed 7 --ticks 200 --flaps 0010

must print. Diff your output against it character for character and fix any difference.
Then run `python3 flapsim.py --selfcheck` until every line reports OK.

Reply DONE when --selfcheck is all OK.
