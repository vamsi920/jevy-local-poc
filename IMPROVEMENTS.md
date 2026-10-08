# Jevy reasoning harness improvements

The active runtime uses adaptive effort: Qwen3:0.6b drafts simple SQL in fast mode and reasons for complex or stateful generation, repairs and independent review. Each call has a fixed budget. A second call checks meaning against the question and actual executed rows, rather than approving any query that returned a number. Private reasoning is discarded; the trace records only verdicts, operational events and timings.

Context preserves explicitly requested domains, excludes definitions triggered only by generic table words, and supplies category lists only when the intent identifies filters. Multi-table planning uses reasoning and asks for focused dependent operations. Context contains discovered DuckDB tables and fields, actual categorical values, verified joins, business aliases, the dataset reference date, previous selected IDs and declared dependency results. The original question stays authoritative when a planning restatement loses detail. Date guidance uses DuckDB syntax, avoiding incompatible MySQL date functions.

DuckDB's own AST maps grounded categorical aliases, rejects missing unambiguous requested filters, and restores missing grouping labels and blocks counts inflated by joining many child rows to one entity. These are general relational checks; the runtime has no evaluation questions, stored answers or canned SQL mappings. Exact query failures and semantic review issues can trigger at most three repairs per SQL step.

Duplicate objectives with identical dependencies are merged. A reviewed single-step answer avoids additional observation and synthesis model calls. Compound requests retain dependency execution and whole-request coverage checks. A 60-second request budget stops prolonged inference and repair loops. There is no factual result cache.

Run `npm test`, `npm run build`, and `npm run evaluate`. Read `EVALUATION.md` for measured accuracy and response times. A second call to the same tiny model is useful scrutiny, but it is not an independent accuracy oracle. The evaluator separately executes oracle SQL and checks compound attributes and conversation scope. Passing the benchmark does not prove arbitrary-question reliability.

The supplied corporate stack remains untouched. These changes belong to the local POC and can be adapted behind Jevy's approved provider and tool boundaries after separate integration work.

Calendar counts now use a typed compiler for day/week/month/quarter/year offsets. Table and date fields come from the catalog; every period uses a half-open interval against `dataset_info.as_of`, and zero periods remain visible. This is a reusable operator compiler, not stored question/answer pairs. Filtered queries, rolling windows and non-count measures stay on the SQL reasoning path. Ambiguous date fields require clarification.

Random record requests enforce database random ordering and explicit sample cardinality. Creative tasks separate record retrieval from decorative text. Record facts are inserted verbatim; creative inference gets at most ten seconds and cannot discard verified evidence on timeout. Identical failed repairs stop early; reviewer rejection without concrete issues cannot consume repeated SQL repair rounds. Numeric and temporal SQL generation now receive reasoning even with one table.

An AST guard also removes a date-only restriction when the original request contains no temporal scope, and rejects mixed unwanted date predicates for bounded repair. Conversation follow-ups may retain earlier temporal scope. This prevents a fabricated reference-date condition from silently turning an unfiltered inventory sample into zero rows.
