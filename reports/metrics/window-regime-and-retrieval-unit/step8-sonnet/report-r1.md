# context-tree eval — step8-sonnet-r1

- model: `claude-sonnet-5` (provider `anthropic`)
- runs: 6 across 1 benchmark(s)
- errors: 0

## Results

### deepswe-agents-last-exam

| arm | runs | ok | success | score | in tok | out tok | cache r | cache w | total tok | tool calls | turns | p50 ms | p95 ms | avg cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| native | 2 | 2 | 100.0% | 100.0% | 32 | 7210 | 91811 | 8168 | 107220 | 29 | 24 | 196166 | 202297 | $0.1109 |
| context-tree | 2 | 2 | 100.0% | 100.0% | 53367 | 5256 | 76261 | 15314 | 150197 | 15 | 13 | 93041 | 439650 | $0.4812 |
| prefix-retrieval | 2 | 1 | 50.0% | 50.0% | 70000 | 3649 | 44064 | 3672 | 121385 | 14 | 13 | 58147 | 148708 | $0.1945 |


**context-tree vs native (deltas):**

| metric | native | context-tree | delta | reads |
| --- | --- | --- | --- | --- |
| success rate | 100.0% | 100.0% | +0.0 pp | pp |
| avg total tokens | 107220 | 150197 | +40.1% | lower-is-better |
| avg output tokens | 7210 | 5256 | -27.1% | lower-is-better |
| avg cache-read tokens | 91811 | 76261 | -16.9% | lower-is-better |
| avg tool calls | 29 | 15 | -48.3% | lower-is-better |
| avg model turns | 24 | 13 | -46.8% | lower-is-better |
| p50 wall ms | 196166 | 93041 | -52.6% | lower-is-better |
| p95 wall ms | 202297 | 439650 | +117.3% | lower-is-better |
| avg cost usd | $0.1109 | $0.4812 | +333.7% | lower-is-better |
