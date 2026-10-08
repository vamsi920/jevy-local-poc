# Jevy live-model evaluation

Measured 2026-10-07T20:09:33.875Z. Local model: qwen3:0.6b. Seed 42, reference date 2026-10-07.

Coverage: **30/54 cases**, **26 passed**, **4 failed**. Partial run; do not interpret as full-suite accuracy.

| Measure | Result |
|---|---|
| Final evidence accuracy | 86.7% |
| SQL step completion after bounded repair and review | 72.5% |
| Mean repairs per final turn | 0.77 |
| Mean model calls per final turn | 5.40 |
| Mean model latency per final turn | 14.1 s |
| Mean total response latency per final turn | 13.7 s |

Accuracy means Exact oracle result comparison (column-order independent), plus semantic entity checks for random cases and status checks for unsupported/ambiguous/write. SQL success is measured after bounded repair. Counts do not prove arbitrary-question generalization.

SQL step completion includes execution and review acceptance. It does not establish correct filters, joins, entity scope or complete coverage of a compound request. The evidence renderer prevents invented facts, but semantically wrong SQL can still produce a wrong answer. This experiment must not be treated as proof of arbitrary-question reliability.

## Per-case results

| Case | Passed | Status | Latency | Model calls | Repairs |
|---|---|---|---|---|---|
| count-all | yes | answered | 5.2 s | 4 | 0 |
| count-prod | yes | answered | 4.7 s | 4 | 0 |
| count-usa | yes | answered | 7.3 s | 4 | 0 |
| count-rhel | yes | answered | 7.8 s | 5 | 1 |
| prod-us | yes | answered | 7.8 s | 5 | 1 |
| support | yes | answered | 4.6 s | 4 | 0 |
| by-country | yes | answered | 4.6 s | 4 | 0 |
| by-os | yes | answered | 7.0 s | 6 | 0 |
| by-env | yes | answered | 6.8 s | 4 | 0 |
| apps | yes | answered | 24.5 s | 10 | 0 |
| top-apps | yes | answered | 7.6 s | 4 | 0 |
| critical | yes | answered | 18.2 s | 5 | 1 |
| critical-servers | yes | answered | 15.0 s | 6 | 2 |
| vuln-severity | yes | answered | 5.3 s | 4 | 0 |
| incident-priority | yes | answered | 5.3 s | 4 | 0 |
| month | yes | answered | 1.1 s | 1 | 0 |
| last-month | yes | answered | 1.0 s | 1 | 0 |
| recent | no | answered | 46.0 s | 10 | 3 |
| backups | yes | answered | 9.5 s | 4 | 0 |
| backup-groups | no | answered | 16.3 s | 5 | 0 |
| upgrade | no | incomplete | 37.9 s | 16 | 6 |
| cross | no | incomplete | 60.0 s | 6 | 3 |
| backup-security | yes | answered | 33.1 s | 6 | 2 |
| memory | yes | answered | 9.1 s | 4 | 0 |
| cpu | yes | answered | 10.6 s | 4 | 0 |
| empty | yes | answered | 7.1 s | 6 | 0 |
| first | yes | answered | 6.0 s | 4 | 0 |
| join-detail | yes | answered | 8.3 s | 4 | 0 |
| random | yes | answered | 10.1 s | 5 | 1 |
| write | yes | incomplete | 23.5 s | 13 | 3 |

## Review failures

For full SQL, plans, observations, execution errors and returned rows, inspect [the measured JSON trace](test-results/current-regression.json). To repeat a capability test and wording variants, use EVAL_FILTER with the IDs above. Each evaluation rereads DuckDB; no factual answers are cached.

The evaluator uses a conservative exact comparison for deterministic query results. Random/compound cases additionally require requested entity attributes, independent counts and the most recent incident. Column alias differences in compound evidence may cause a failure even when some values are correct; inspect the trace before changing the agent.

Follow-up metrics describe the final follow-up turn. Unsupported, ambiguous and attempted-write cases use status-based checks; they are not numeric answer-accuracy cases.

79 core safety/orchestration/provider checks passed; logs are separate in test-results/core-current.log.

## Answer coverage and precision

Data requests answered: 27/29 (93.1%). Correct among answered data requests: 25/27 (92.6%). Unsupported, write and ambiguity status cases are excluded from these two measures. Every incomplete or incorrect data answer still counts as failure in overall accuracy above.

Latency is a local-machine measurement. Concurrent local workloads were observed during development; this is not a controlled idle-machine speed comparison.

## Matched question comparison

On the 30 shared question IDs, the free-SQL baseline passed 9/30; this regression passed 26/30. Same local model, synthetic seed and reference date. This compares factual case outcomes, not a controlled latency benchmark. Selected coverage does not establish full-suite accuracy.

## Previous compiler comparison

For the 26 shared IDs, the previous compiler passed 12/26; the active harness passed 23/26. Coverage and latency should be judged separately.

Final UI regression added a guard against unrequested temporal predicates after the 30-case measurement above. The final build passes 79 tests; the 30-case model run was not repeated after that guard. Browser scenario outcomes are recorded separately in test-results/ui-scenarios.log.
