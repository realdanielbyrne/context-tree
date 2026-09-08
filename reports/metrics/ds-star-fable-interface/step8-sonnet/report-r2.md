# context-tree eval — step8-sonnet-r2

- model: `claude-sonnet-5` (provider `anthropic`)
- runs: 6 across 1 benchmark(s)
- errors: 0

## Results

### deepswe-agents-last-exam

| arm | runs | ok | success | score | in tok | out tok | cache r | cache w | total tok | tool calls | turns | p50 ms | p95 ms | avg cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| native | 2 | 1 | 100.0% | 100.0% | 66 | 12776 | 799452 | 23277 | 835570 | 54 | 48 | 257388 | 364142 | $0.3460 |
| context-tree | 2 | 2 | 100.0% | 100.0% | 87761 | 8184 | 106234 | 16487 | 218666 | 18 | 17 | 184071 | 504796 | $0.6063 |
| prefix-retrieval | 2 | 1 | 50.0% | 50.0% | 100234 | 3980 | 51408 | 3672 | 159294 | 17 | 15 | 59568 | 521771 | $0.2597 |


**context-tree vs native (deltas):**

| metric | native | context-tree | delta | reads |
| --- | --- | --- | --- | --- |
| success rate | 100.0% | 100.0% | +0.0 pp | pp |
| avg total tokens | 835570 | 218666 | -73.8% | lower-is-better |
| avg output tokens | 12776 | 8184 | -35.9% | lower-is-better |
| avg cache-read tokens | 799452 | 106234 | -86.7% | lower-is-better |
| avg tool calls | 54 | 18 | -66.4% | lower-is-better |
| avg model turns | 48 | 17 | -64.2% | lower-is-better |
| p50 wall ms | 257388 | 184071 | -28.5% | lower-is-better |
| p95 wall ms | 364142 | 504796 | +38.6% | lower-is-better |
| avg cost usd | $0.3460 | $0.6063 | +75.2% | lower-is-better |
