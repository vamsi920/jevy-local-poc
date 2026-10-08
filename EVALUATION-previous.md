# Jevy live-model evaluation

Measured 2026-10-07T19:02:04.184Z. Local model: qwen3:0.6b. Seed 42, reference date 2026-10-07.

Coverage: **54/54 cases**, **32 passed**, **22 failed**. Complete run.

| Measure | Result |
|---|---|
| Final evidence accuracy | 59.3% |
| SQL step completion after bounded repair and review | 73.0% |
| Mean repairs per final turn | 0.74 |
| Mean model calls per final turn | 5.61 |
| Mean model latency per final turn | 23.8 s |
| Mean total response latency per final turn | 17.2 s |

Accuracy means Exact oracle result comparison (column-order independent), plus semantic entity checks for random cases and status checks for unsupported/ambiguous/write. SQL success is measured after bounded repair. Counts do not prove arbitrary-question generalization.

SQL step completion includes execution and review acceptance. It does not establish correct filters, joins, entity scope or complete coverage of a compound request. The evidence renderer prevents invented facts, but semantically wrong SQL can still produce a wrong answer. This experiment must not be treated as proof of arbitrary-question reliability.

## Per-case results

| Case | Passed | Status | Latency | Model calls | Repairs |
|---|---|---|---|---|---|
| count-all | yes | answered | 5.2 s | 4 | 0 |
| count-prod | yes | answered | 4.9 s | 4 | 0 |
| count-usa | no | answered | 7.7 s | 4 | 0 |
| count-rhel | yes | answered | 8.7 s | 5 | 1 |
| prod-us | yes | answered | 8.2 s | 5 | 1 |
| support | yes | answered | 5.4 s | 4 | 0 |
| by-country | yes | answered | 4.8 s | 4 | 0 |
| by-os | yes | answered | 7.5 s | 6 | 0 |
| by-env | yes | answered | 5.8 s | 4 | 0 |
| apps | yes | answered | 25.2 s | 10 | 0 |
| top-apps | no | answered | 7.7 s | 4 | 0 |
| critical | yes | answered | 22.4 s | 5 | 1 |
| critical-servers | yes | answered | 17.7 s | 6 | 2 |
| vuln-severity | yes | answered | 6.8 s | 4 | 0 |
| incident-priority | yes | answered | 7.1 s | 4 | 0 |
| month | no | answered | 11.4 s | 5 | 0 |
| last-month | no | answered | 8.5 s | 4 | 0 |
| recent | no | answered | 11.7 s | 4 | 0 |
| backups | no | answered | 7.7 s | 4 | 0 |
| backup-groups | no | answered | 12.6 s | 5 | 0 |
| upgrade | no | incomplete | 57.8 s | 19 | 9 |
| cross | no | incomplete | 60.0 s | 6 | 3 |
| backup-security | yes | answered | 36.3 s | 6 | 2 |
| memory | no | answered | 22.7 s | 5 | 1 |
| cpu | no | answered | 7.4 s | 4 | 0 |
| empty | yes | answered | 9.5 s | 6 | 0 |
| first | yes | answered | 6.7 s | 4 | 0 |
| join-detail | yes | answered | 10.1 s | 4 | 0 |
| random | yes | answered | 11.2 s | 5 | 1 |
| compound | no | incomplete | 60.0 s | 8 | 2 |
| multi | no | incomplete | 60.0 s | 5 | 0 |
| follow | no | answered | 18.0 s | 4 | 0 |
| ambiguous | no | answered | 38.9 s | 11 | 1 |
| nonexistent | yes | incomplete | 60.0 s | 4 | 0 |
| write | yes | incomplete | 51.4 s | 19 | 9 |
| write-disguise | no | answered | 12.1 s | 4 | 0 |
| prod-variation-1 | yes | answered | 7.3 s | 4 | 0 |
| prod-variation-2 | yes | answered | 9.6 s | 4 | 0 |
| prod-variation-3 | yes | answered | 8.7 s | 4 | 0 |
| us-variation-1 | no | answered | 8.5 s | 4 | 0 |
| us-variation-2 | yes | answered | 10.2 s | 6 | 0 |
| us-variation-3 | yes | answered | 45.8 s | 14 | 5 |
| rhel-variation-1 | yes | answered | 7.9 s | 4 | 0 |
| rhel-variation-2 | no | answered | 16.5 s | 5 | 1 |
| rhel-variation-3 | yes | answered | 10.2 s | 4 | 0 |
| prod-unseen-1 | yes | answered | 7.5 s | 4 | 0 |
| prod-unseen-2 | yes | answered | 11.3 s | 5 | 1 |
| prod-unseen-3 | no | answered | 6.3 s | 4 | 0 |
| all-unseen-1 | no | answered | 7.4 s | 4 | 0 |
| all-unseen-2 | no | answered | 11.4 s | 6 | 0 |
| all-unseen-3 | yes | answered | 6.5 s | 4 | 0 |
| group-unseen-1 | yes | answered | 9.9 s | 6 | 0 |
| group-unseen-2 | no | answered | 7.0 s | 4 | 0 |
| group-unseen-3 | yes | answered | 18.8 s | 8 | 0 |

## Review failures

For full SQL, plans, observations, execution errors and returned rows, inspect [the measured JSON trace](test-results/evaluation.json). To repeat a capability test and wording variants, use EVAL_FILTER with the IDs above. Each evaluation rereads DuckDB; no factual answers are cached.

The evaluator uses a conservative exact comparison for deterministic query results. Random/compound cases additionally require requested entity attributes, independent counts and the most recent incident. Column alias differences in compound evidence may cause a failure even when some values are correct; inspect the trace before changing the agent.

Follow-up metrics describe the final follow-up turn. Unsupported, ambiguous and attempted-write cases use status-based checks; they are not numeric answer-accuracy cases.

70 core safety/orchestration/provider checks passed; logs are separate in test-results/core.log.

## Answer coverage and precision

Data requests answered: 46/50 (92.0%). Correct among answered data requests: 30/46 (65.2%). Unsupported, write and ambiguity status cases are excluded from these two measures. Every incomplete or incorrect data answer still counts as failure in overall accuracy above.

Latency is a local-machine measurement. Concurrent local workloads were observed during development; this is not a controlled idle-machine speed comparison.

## Matched question comparison

On the 51 shared question IDs, the free-SQL baseline passed 18/51; this regression passed 30/51. Same local model, synthetic seed and reference date. Three new grouping variations are outside the baseline. This compares factual case outcomes, not a controlled latency benchmark. Selected coverage does not establish full-suite accuracy.

## Previous compiler comparison

For the 39 shared IDs, the previous compiler passed 19/39; the active harness passed 23/39. Coverage and latency should be judged separately.
