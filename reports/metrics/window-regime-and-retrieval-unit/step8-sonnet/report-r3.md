# context-tree eval — step8-sonnet-r3

- model: `claude-sonnet-5` (provider `anthropic`)
- runs: 6 across 1 benchmark(s)
- errors: 0

## Results

### deepswe-agents-last-exam

| arm | runs | ok | success | score | in tok | out tok | cache r | cache w | total tok | tool calls | turns | p50 ms | p95 ms | avg cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| native | 2 | 2 | 100.0% | 100.0% | 30 | 6252 | 99094 | 7797 | 113173 | 27 | 23 | 79195 | 313014 | $0.1019 |
| context-tree | 2 | 1 | 100.0% | 100.0% | 106207 | 6404 | 109006 | 17282 | 238898 | 19 | 18 | 363330 | 418277 | $0.6377 |
| prefix-retrieval | 2 | 0 | 50.0% | 50.0% | 240888 | 5525 | 78948 | 3672 | 329033 | 24 | 23 | 25061 | 353894 | $0.5898 |


**context-tree vs native (deltas):**

| metric | native | context-tree | delta | reads |
| --- | --- | --- | --- | --- |
| success rate | 100.0% | 100.0% | +0.0 pp | pp |
| avg total tokens | 113173 | 238898 | +111.1% | lower-is-better |
| avg output tokens | 6252 | 6404 | +2.4% | lower-is-better |
| avg cache-read tokens | 99094 | 109006 | +10.0% | lower-is-better |
| avg tool calls | 27 | 19 | -28.3% | lower-is-better |
| avg model turns | 23 | 18 | -22.2% | lower-is-better |
| p50 wall ms | 79195 | 363330 | +358.8% | lower-is-better |
| p95 wall ms | 313014 | 418277 | +33.6% | lower-is-better |
| avg cost usd | $0.1019 | $0.6377 | +525.9% | lower-is-better |
