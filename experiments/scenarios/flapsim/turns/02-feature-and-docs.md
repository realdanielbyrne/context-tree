Thanks — that works. Two more things before we ship.

1. FEATURE. Implement the shield power-up. It is already specified in
   spec/07_powerups.md, which you read at the start of this session and which has not
   changed since. Re-read it now and implement it exactly as written.

   Hard requirement: with `--powerups` ABSENT the program must behave EXACTLY as it
   did before. Prove it — re-run

       python3 flapsim.py --seed 7 --ticks 200 --flaps 0010

   and check its output against replay.txt, which you produced earlier. If a single
   line differs, you have broken something. Extend test_flapsim.py to cover the shield.

2. DOCS. Write GETTING_STARTED.md for a new contributor. It must contain:
   - the exact command to run the demo, and the exact output that command produces;
   - one section per module, naming the module file and quoting at least one exact
     `def` line from it — signatures must match the files character for character;
   - a "Shield power-up" section explaining the new flag.

Then reply DONE.
