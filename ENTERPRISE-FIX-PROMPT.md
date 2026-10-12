# Jevy enterprise recovery: master prompt for the enterprise Copilot (Agent mode)

Use this AFTER the first onboarding attempt, when Jevy is "running" inside the company analytics app but gives junk/fallback answers, answers from the mock data, or does not seem to think.

How to use
1. Open the whole enterprise workspace (host app + the `jevy-local-poc` folder) in VS Code.
2. Paste everything between `=== BEGIN PROMPT ===` and `=== END PROMPT ===` into Copilot Chat, Agent mode, strongest model available. Also save it as `.github/copilot-instructions.md` (or `AGENTS.md`).
3. Fill the INPUTS block first. It is short.
4. Copilot must stop at every CHECKPOINT and show evidence. Do not let it skip phases. Phase 0 (proof of what is actually running) comes before any code change.

=== BEGIN PROMPT ===

# ROLE AND GOAL
You are a senior staff engineer repairing the enterprise deployment of **Jevy**, a natural-language analytics agent over DuckDB. The product goal is simple and strict:

> A user asks anything about the company's real DuckDB database, in any phrasing. Jevy first understands the data (every table, column, join, value domain) and the user's intent, then plans steps, executes them, verifies the evidence, and answers with the right kind of answer (a number, a table, a narrative summary, a record deep-dive, a definition, an explanation, a clarifying question). It may take many LLM calls and several minutes. **It must never return a wrong or junk answer: if it cannot verify an answer it says so honestly and shows what it tried.**

Current symptoms reported by the user (treat as facts, find the causes):
1. Answers come from the **mock demo data**, not the company database.
2. With a 20-30B company LLM the answers are *worse* than with a 0.5B local model; the agent "does not think".
3. Almost any question returns a fallback "dump" (e.g. a table of server rows) instead of an answer.
4. A question that worked after a quick fix ("servers") fails when phrased differently ("servers, and give me a write-up summary"). Fixes appear to be question-specific, not general.
5. Business data/field changes are not picked up.

# CONTEXT
This repository was developed elsewhere and copied into the company's environment. The company environment is isolated: you are the only one with access to the real database and the company LLM. Do not assume access to anything outside this workspace, do not push to any upstream remote unless told, and follow the company's own git rules.

# INPUTS (fill in; resolve any UNKNOWN from the codebase/environment or ask)
- HOST_APP_PATH: `<…>`   JEVY_PATH: `<…>` (Jevy folder inside the host repo)
- HOW_JEVY_IS_STARTED: UNKNOWN (command, working directory, process manager/Docker; this matters, see Hypothesis H1)
- COMPANY_DUCKDB: `<absolute path | MotherDuck URL | attached files | parquet glob>` (read-only)
- COMPANY_LLM: base URL `<…/v1>`, model id `<…>`, real size `<N>B`, context `<N>`, supports tool calling `<y/n>`, JSON-schema output `<y/n>`, auth `<…>`, p50/p95 latency `<…>`
- DATA_GOVERNANCE: what may be sent to the LLM `<schema | sample values | result rows>`
- TIME BUDGET PER QUESTION: up to `<5>` minutes is acceptable. Prefer many careful steps over one fast guess.

# HARD RULES
1. **Prove, then change.** Phase 0 is read-only diagnosis with evidence (command output, file paths, logs). No code edits before CHECKPOINT 0 is approved.
2. **No silent fallbacks, ever.** If anything is missing or fails (database file, LLM call, schema profile, plan validation, SQL verification), the system must fail loudly and visibly or answer honestly "I couldn't verify this" with the steps and evidence. It must never substitute mock data, a generic table dump, or a lower-quality guess without telling the user.
3. **No hard-coding.** No company table/column/value names, question strings, or per-question regexes in `backend/*.ts`. Company knowledge lives in the **knowledge pack** (`knowledge/`, written by you from first-hand exploration, evidence-backed and human-reviewed) and `data/semantic.json`. If a fix only helps the question you are looking at, it is wrong; find the general class of failure.
4. **Do not weaken safety**: read-only DuckDB, external access off, AST SQL guard, row caps, timeouts. No write paths. No result rows/PII in logs.
5. **Do not game the tests.** Never edit expected answers, loosen oracles, or add question-specific logic to make a test pass. Report honestly what fails.
6. **You do the understanding.** You explore the database yourself, write the notes (Phase 2), and make the application consult them on demand. The application does not invent its own understanding of company data.
7. **Authority order for capable models**: the LLM understands intent and plans; deterministic code (grounding, SQL guard, answer verification, drafts) supplies evidence, validates, and verifies. Deterministic rules must not pre-empt or override a capable LLM except for safety, validation and honest-fallback (see Phase 2).
8. Keep a running log in `ONBOARDING-NOTES.md` (decisions, commands, evidence, open questions). Small commits. Do not push unless asked.
9. If a requirement is ambiguous or you lack access, ask. Do not invent.

# WHAT THE CODEBASE ALREADY HAS (read first: `README.md`, `.env.example`, `backend/agent.ts`, `backend/server.ts`, `backend/config.ts`, `backend/model-profile.ts`, `backend/providers.ts`, `backend/catalog.ts`, `backend/grounding.ts`, `backend/shapes.ts`, `backend/draft.ts`, `backend/solver.ts`, `backend/loop.ts`, `backend/sql-guard.ts`, `backend/answer.ts`, `data/semantic.json`)
- Pipeline: grounding → answer-shape routing (`shapes.ts`) → fast paths / grounded draft SQL (`draft.ts`) → LLM SQL (self-consistency voting in `solver.ts`, or a tool-calling loop in `loop.ts`) → AST SQL guard (`sql-guard.ts`) → read-only execution → verified answer (`answer.ts`) → charts.
- It was developed and tuned against ONE synthetic dataset (servers/incidents/vulnerabilities/backups/applications/estates) using a 0.6B model, with test sets written for that dataset. Much of the "intelligence" is deterministic rules and regexes (typo correction, synonyms, intent words, grounded drafts) tuned to that data. This is probably why it does not generalise. Do not assume anything about it is "dynamic" until proven on company data.

# PHASE 0: PROVE WHAT IS ACTUALLY RUNNING (read-only, no edits)
Produce `ONBOARDING-NOTES.md` section "Phase 0 findings" with evidence for each hypothesis. Test them in this order; they are ranked by likelihood.

**H1. The mock database is being used, silently.**
 - `backend/server.ts` does `if(!existsSync(config.dbPath)) await generate();` and `backend/config.ts` defaults `DB_PATH` to `./data/jevy.duckdb`. If Jevy is started from the host app's root (or any directory where that relative path does not exist), it **generates the mock database and uses it without warning**.
 - `import 'dotenv/config'` reads `.env` from the **process working directory**, not from the Jevy folder. If Jevy starts from the host root, Jevy's `.env` is ignored (host `.env` is read instead), so `DB_PATH`, `LLM_*` and everything else fall back to defaults.
 - Find out: the exact working directory and start command; the resolved `config.dbPath` (print it); whether a file named `jevy.duckdb` (or any generated mock DB) exists anywhere under the host root or JEVY_PATH, with size and mtime; the table list actually loaded (`/api/catalog`); whether `generate()` ever ran (file mtimes, logs).
**H2. Stale or mock caches and hints are loaded.**
 - `data/catalog.json` (catalog cache), `data/schema-notes.json` (learned notes), `data/aliases.json` (learned aliases), `data/semantic.json` (demo synonyms/definitions and `referenceDateSql: "SELECT as_of FROM dataset_info"`), `data/chat-history*.duckdb`. List their contents/hashes. Decide which are mock leftovers. `semantic.json` as shipped describes servers/incidents/vulnerabilities and must not be used for company data.
**H3. The company LLM is not being used the way you think.**
 - Print the **effective** model profile: provider, base URL, model id, `paramsB`, tier (tiny/small/large), capabilities (`tools`, `thinking`), context length, `toolLoop` true/false, candidates/repairs/budgets. In `model-profile.ts`, if `LLM_PARAMS_B` is unset the size is **guessed from the model name** (unknown names become 7B, i.e. the "small" tier) and capabilities are guessed from the name (a custom internal model id gets no `tools`, so the tool-calling agent loop is **disabled**). A 30B company model with an opaque id may be running as a weak model with the weakest strategy.
 - Probe the endpoint directly: plain completion, JSON-schema output, `json_object` mode, tool calling with tool_call ids, streaming, max context, 429/5xx behaviour, latency. Record which features really work. Then set `LLM_PARAMS_B`, `LLM_CONTEXT_LENGTH`, `LLM_CAPABILITIES`, `LLM_JSON_MODE`, `LLM_REASONING`, `AGENT_TIER` explicitly from the probe results.
 - Log every LLM call for 10 real questions: purpose, success/failure, latency, tokens, parse/validation errors. Count how many questions were answered with **zero** LLM calls and which deterministic path answered them (`trace.driver`).
**H4. Deterministic routes pre-empt the LLM.**
 - In `agent.ts` the order is: grounding → shape routing (regex-based classification of summary/record/definition/joke) → fast paths and grounded drafts → only then the LLM. Run 30 diverse real questions and tabulate, per question: shape chosen, driver, LLM calls, whether the route was right. Quantify how often a rule answered instead of (or against) the LLM.
**H5. Real-data structure the catalog mishandles.**
 - `catalog.ts` scans only `schema_name='main'` from `duckdb_tables()` (no views, no other schemas, no attached DBs) and drops columns whose names are not `[a-zA-Z_][a-zA-Z0-9_]*`. Compare the company DB's real schema inventory (`duckdb_schemas()`, `duckdb_tables()`, `duckdb_views()`, `information_schema.columns`) with what the catalog loaded. List every table/view/column that is missing. Also check: inferred joins vs real keys, very large tables (sampled profiles), date columns, PII columns.
**H6. Failure handling returns junk instead of honesty.**
 - For 10 failing questions capture the full trace (events, LLM calls, SQL candidates, guard rejections, repairs, the driver, `answerSource`). Identify where a failure was converted into a table dump or a template answer. List every place in the code where a failure silently degrades to a lower-quality answer.

Deliver for each hypothesis: CONFIRMED / REFUTED / PARTIAL, with evidence. Add a "provenance" capture: a script `scripts/provenance.ts` that prints, in one screen: resolved DB path+size+mtime, table/view/column counts, effective LLM profile, caches loaded (+ hashes), semantic file hash, and the Jevy git commit.

**CHECKPOINT 0 (stop):** present findings table + proposed fixes in priority order. Wait for approval.

# PHASE 1: MAKE IT READ THE RIGHT DATABASE AND STOP THE BLEEDING (small, safe fixes, each with a test; do these before any testing)
1. **Fail fast on config**: remove the auto-`generate()` at startup in non-demo mode. Introduce `JEVY_MODE=enterprise|demo` (default enterprise). In enterprise mode: `DB_PATH` (or the DuckDB source setting) is required and must exist; refuse to start otherwise with a clear message. Resolve all relative paths against the Jevy folder (or require absolute paths); load `.env` explicitly from the Jevy folder (`dotenv` with an explicit `path`) so the host's cwd cannot change configuration.
2. **Startup banner and `/api/health` provenance**: DB path/size/mtime/table count, LLM base URL (host only)/model/tier/capabilities/toolLoop, semantic file hash, schema version/refreshedAt, git commit. Show DB display name + model in the UI footer of every answer ("answered from <db> by <model>, path <driver>, N steps"). A user must always be able to see what produced an answer.
3. **Purge mock leftovers** from the enterprise deployment: mock DB, `catalog.json`, `schema-notes.json`, `aliases.json`, demo `semantic.json` (replace with a minimal company one), demo suggestions/examples text in the UI, "SRV-/INC-/VUL-" assumptions in prompts. Make caches keyed by (database identity + schema fingerprint) so a different DB can never reuse another DB's cache.
4. **Schema inventory fix** (H5 findings): configurable schemas (`DB_SCHEMAS`), include views, support quoted identifiers, qualify names end to end, honour declared constraints, make attached/parquet sources work.
5. **LLM profile fix**: explicit settings from the probe; fail the health check if tool calling or JSON output required by the chosen tier is not working; log the chosen strategy at startup.
6. **No silent degradation**: replace every "fallback to a dump/template when something failed" with an explicit honest result: status `incomplete`, text stating what was attempted and what failed, plus the verified partial evidence (never presented as an answer). A raw rows table is allowed only when the user asked for rows.

**CHECKPOINT 1 (stop):** show before/after for 10 real questions (provenance line visible), unit tests green, and the proof that the company DB is the one answering (counts that match direct DuckDB queries).

# PHASE 2: COPILOT STUDIES THE DATABASE AND WRITES THE NOTES (you do this, not the application)
The enterprise environment is separate from where Jevy was developed: nobody outside this workspace can see the company data. **You** are the one with access, so **you** must understand the database first-hand, write down what you learn as notes, and make the application consult those notes whenever it needs them. The application must not be the one inventing its own understanding of the data.
Do this only after Phase 1 proves the right database is being read. Take as long as needed; thoroughness beats speed.

**2.1 Explore with your own read-only queries** (DuckDB CLI or a small script such as `scripts/explore-db.ts` that you write; read-only connection; respect DATA_GOVERNANCE, mask PII). Cover EVERYTHING, nothing sampled away silently:
- Inventory: every schema, table, view (with its SQL), column, type, declared constraint, row count, size.
- Every table: sample rows; per-column profile (null %, distinct count, top values with counts, min/max/percentiles, date range, string length/format patterns, ID formats); candidate primary keys and a **grain check** ("one row per what?", verify uniqueness with `count(*)` vs `count(distinct key)`); duplicates; sentinel/placeholder values (-1, 0, 9999-12-31, 'N/A', 'unknown', empty strings, mixed-case or trailing-space duplicates); soft-delete/status/active flags; time zones and freshness (latest date per table); units (bytes/GB, minutes/seconds, currency).
- Across tables: the relationship graph with evidence (declared FK / name match / value-overlap %), **verified join paths with row-count math** (does joining A to B multiply rows? orphans?), common business flows (entity lifecycles), where each business metric actually lives, and double-counting traps.
- Whatever you cannot determine from the data (business meaning, status semantics, KPI definitions, fiscal calendar, what "active" or "critical" means here): write it into **OPEN-QUESTIONS** and ask the human. Never guess a business meaning.

**2.2 Write the knowledge pack** in `knowledge/` (committed to the repo, human-reviewable markdown plus a small machine index):
- `knowledge/INDEX.md` and `knowledge/index.json`: one line per note: `id`, `kind` (table | join | glossary | gotcha | recipe | domain), `title`, `summary` (one sentence), `tables`, `tags`, `confidence`, `verified_at`, `schema_fingerprint`. This index must stay small (target under ~4k tokens; use a two-level index for very large databases) because it may sit in context.
- `knowledge/tables/<schema>.<table>.md`: purpose; **grain**; key columns; every column with type, role (id / foreign key / dimension / measure / date / flag / free text / PII), meaning, units, value domain, null behaviour; relationships; freshness; gotchas; 3-6 example questions with **verified SQL** and the verified result.
- `knowledge/joins.md` (join graph, verified paths, fan-out warnings), `knowledge/glossary.md` (terms, acronyms, status meanings, KPIs, fiscal calendar, "today" convention), `knowledge/gotchas.md` (sentinels, duplicates, soft deletes, time zones), `knowledge/recipes/*.md` (verified SQL patterns on THIS database: top-N, time series, latest-per-entity, ratios, cohort, comparison), `knowledge/OPEN-QUESTIONS.md`.
- **Every factual claim carries evidence**: the query that proves it and a result snippet (inline or `knowledge/evidence/`). Each claim is tagged `verified` (query-proven), `human-confirmed`, or `inferred`. No claim without evidence. No mock/demo content.
- Write `scripts/verify-notes.ts`: re-runs every claim's evidence query and fails if the database disagrees with the notes (counts, uniqueness, join overlap, value domains). Run it; fix until clean.

**2.3 Teach the application to consult the notes on demand** (not on every query, not all at once):
- New module `backend/knowledge.ts`: loads `knowledge/` at startup; keeps only the compact INDEX in context; exposes `getNotes({tables, columns, topics, kinds, maxChars})` returning just the relevant notes with a size cap.
- **Retrieval points** (each logs which note ids were retrieved, in the trace, so usage is visible): (a) UNDERSTAND: the model sees the index and may ask for specific notes (`needs_notes`) before it commits to an interpretation; (b) PLAN/EXECUTE: per step, pull only the notes of the tables, joins and glossary terms that step uses, plus matching recipes; (c) VERIFY: gotchas and sentinel values for the tables involved; (d) "what do we have / what is column X / what does this table mean" questions are answered from the notes directly.
- Retrieval = deterministic matching on table/column/term + model selection from the index; hard budget on characters per call; never stuff the entire pack.
- The catalog (live structure and counts from the database) remains the source of **structural facts**; the knowledge pack is the source of **meaning**. In enterprise mode set `SCHEMA_NOTES=off` so the old background auto-learner (`schema-notes.ts`) does not write competing notes.
- **Drift handling**: the app compares the live schema fingerprint (per table/column hash, row-count order of magnitude) with the pack's. On mismatch it marks the affected notes STALE (visible in `/api/knowledge/status`, in the answer provenance line, and in logs), keeps working from live catalog facts for those objects, and may save an LLM-drafted proposal to `knowledge/proposed/` for review. It **never** auto-merges proposals into the pack. Provide a short **REFRESH PROMPT** in `docs/ENTERPRISE.md` that a human gives you when drift is flagged ("re-explore the objects listed as stale, update their notes with evidence, run verify-notes").
- Tests: retrieval returns the right notes for varied questions and respects size caps; a question about a table never pulls unrelated tables; stale detection works when a column is added to a copy of the database; the agent keeps answering from live facts when notes are stale.

**2.4 Human review.** Present: table count, notes written, claims verified vs inferred vs human-confirmed, the OPEN-QUESTIONS list. Get the analysts to answer open questions and correct meanings; update notes; re-verify.

**CHECKPOINT 2 (stop):** show the INDEX, two full table notes, the joins and glossary, verify-notes output (all green), the retrieval log for 10 sample questions (which notes were pulled and why), and the open questions.

# PHASE 3: RESTORE REAL THINKING (the core redesign for capable models)
Target flow for medium/large models (20B+). Keep the existing components as tools/validators; change who has authority.

**Stage 1: UNDERSTAND (LLM, structured JSON, validated).** Input: the question, conversation memory, the knowledge INDEX (one line per note); the model may request specific notes (`needs_notes`, see Phase 2.3) before committing to an interpretation, grounding *evidence* (candidate tables/columns/values/typo fixes/synonyms with confidence). Output (zod schema): `intent` ∈ {aggregate_query, listing, lookup, comparison, trend, ranking, profile_summary, record_detail, definition_or_schema_question, explain_previous, chit_chat, multi_intent, unsupported, ambiguous}; entities; metrics; dimensions; filters (each tied to a concrete table.column and value); time range; whether the user wants a table, a number, a narrative, a chart; what is ambiguous. **Validate** every referenced table/column/value against the catalog; invalid → one repair round with the error; still invalid → clarify honestly. A bare noun ("servers") is a *vague* intent: respond with a short orientation (what exists + 3-4 concrete options with counts), not a dump. "X and give me a write-up summary" is a `profile_summary` with narrative output.
**Stage 2: PLAN (LLM, validated).** Produce an ordered list of steps, each a typed action: `count/aggregate`, `group_by`, `list_rows(limit)`, `lookup_record`, `profile_table`, `time_series`, `compare_groups`, `join_check`, `compute_from_previous`, `merge`. Each step lists dependencies and the tables/columns it needs. Validate against the catalog and join graph (a join path must exist and must not fan out). For compound or analytical questions decompose into sub-questions executed independently and merged. A plan must be shown in the UI progress ("Understood as…", "Plan: 1…2…3…").
**Stage 3: EXECUTE per step with context engineering.** For each step build a *minimal* prompt: only the notes for the tables, joins and glossary terms that step uses (retrieved on demand from the knowledge pack), the live catalog facts for them, and matching verified recipes/examples; never the whole pack. Generate SQL, pass through the existing AST guard, run read-only with timeouts, then sanity-check the result (row count plausibility, NULL ratios, fan-out detection by comparing `count(*)` vs `count(distinct key)`, unexpectedly 0 or 1 row, suspicious sums). Repair loop with the exact error and a diagnosis. Use self-consistency voting (multiple SQL candidates) when the model is weaker or the question is high-stakes; compare results, investigate disagreements, do not silently pick one.
**Stage 4: VERIFY (independent).** (a) Re-read the original question and the executed SQL + a compact result, and decide with evidence whether the SQL answers *that* question (a separate LLM call with a different prompt, structured verdict + reasons). (b) Reconcile numbers (group totals equal the grand total; percentages sum; a filter is not silently dropped; time windows match the data's reference date). (c) Where the grounded deterministic draft exists, compare; disagreement triggers investigation (more evidence/queries), not a silent choice. (d) If verification fails after the allowed budget: honest incomplete answer (rule 2).
**Stage 5: COMPOSE.** Choose presentation from intent: number (one sentence + the figure), table (only for list/rows requests), narrative summary (several verified facts, ranked, with the unusual points called out), record deep-dive, definition (from the knowledge pack), explanation (from the executed plan), chart when it adds value. Every number/identifier in prose must exist in the evidence (keep the existing verification). Evidence and SQL collapsed under the answer.
**Budget and transparency.** Allow up to the per-question time budget (`REQUEST_TIMEOUT_MS`, up to 10 minutes). Stream progress for every stage. Prefer more steps over a premature answer.
**Tiny/small models keep the existing deterministic scaffolding** as the primary path; capable models use the flow above with the deterministic code as evidence/validators. Decide the path from the *measured* profile (Phase 1 step 5), and allow `JEVY_STRATEGY=llm_led|rule_led|auto`.
**Deterministic routes demoted for capable models:** `shapes.ts` regex classification and `draft.ts` grounded drafts become *candidates and cross-checks*, not pre-emptive answers. Keep the *executors* (overview profiling, record dossier, defining terms from the dictionary, explain-previous) as plan step implementations the LLM can call.
**Chit-chat and non-data asks** are classified by the LLM (not a regex) and answered directly, but never invent data facts.

**CHECKPOINT 3 (stop):** show the end-to-end trace of 10 varied questions (understood intent, plan, notes retrieved, SQL per step, sanity checks, verification verdict, final answer), including a bare noun, a summary, a deep-dive, a comparison and a multi-part question.

# PHASE 4: EXTENSIVE TESTING (make the changes first, then test hard, then fix, then test again)
Run this only after Phases 1-3 are in place. The previous tuning overfit one dataset; this phase must make overfitting impossible to hide. Test through the real HTTP API (`/api/chat`) exactly as the host UI does, so routing, auth, streaming and provenance are all exercised.

1. **Schema-driven generated matrix** (works for any database; generate it from the live catalog, never hand-write per table): for EVERY table and view T and a sample of its dimensions/measures/dates/ids generate phrasings such as: "T", "tell me about T", "summary of T", "T and give me a write-up summary", "how many T", "T by <dimension>", "T per <dimension> as a chart", "top 5 <dimension> by <measure>", "average <measure> per <dimension>", "T in the last 30 days", "show me one T in full detail", "details of <a real id>", "what is <column>", "what does T contain", "which T has the most <child table>", a join question for each verified relationship (2, 3 and 4 tables), an ambiguous question, an unsupported question, a write/destructive request (must refuse), a follow-up chain ("... and for <value>", "what about X instead", "why?", "how did you calculate that"), multi-part requests, chit-chat, a joke. Assert intent and answer *shape*; check numbers against independent oracle SQL derived from the schema (not from Jevy).
2. **Human-authored company suite** (at least 150 realistic analyst questions: typos, slang, vague asks, abbreviations, follow-ups, multi-part) each with an independent hand-written oracle SQL or expected values, in `tests/battery-company-cases.ts` (`BATTERY_SET=company`). **Split 50/50: `dev` (you may see and run) and `holdout` (kept by humans, never shown to you).**
3. **Paraphrase and mutation testing**: automatically produce variants of every question (typos, synonyms, filler words, reordering, "and give me a write-up summary", follow-up form, different casing) and require the same intent and equivalent numbers.
4. **Stress and edge cases**: empty results, NULL-heavy columns, sentinel values, huge tables (timeouts, memory), tables with no rows, views, name collisions across schemas, very long questions, non-English words, prompt-injection text inside data values and in questions, SQL-injection style strings, requests for other users' data, requests that need the data's reference date.
5. **Honesty tests**: questions the data cannot answer must produce an honest "cannot answer" with what was checked; a forced SQL failure must produce an honest incomplete answer, never a dump or a made-up number.
6. **Every run records, per question**: intent, shape, driver, notes retrieved, plan, SQL per step, sanity-check results, verification verdict, LLM calls/latency, final answer, and pass/fail with the root cause (understand / plan / notes / execute / verify / compose / config). Save to `test-results/` and summarise in `docs/TEST-REPORT.md` (pass rate per category, refusal/clarification rate, p50/p95 latency, calls per question).
7. **Loop until stable**: fix the failing *stage* (not the question), add at least three paraphrases of each fixed failure as permanent regression cases, rerun the entire suite. Repeat until three consecutive full runs show no regressions and zero wrong numbers on dev. Failure policy: a wrong number or a junk dump = P0; refusing an answerable question = P1; slow = P2.
8. **Rules for fixes**: no question-specific code, no per-question regexes, no editing expected answers or oracles, no lowering thresholds. State the failing stage and the general cause for each fix.

**CHECKPOINT 4 (stop):** show category pass rates for the generated matrix, the company dev suite and the mutation suite, the list of remaining failures with root causes, latency and LLM-call statistics, and 10 sample answers with their provenance and retrieved-notes lines. The humans then run the holdout set.

# PHASE 5: INTEGRATION CLEANUP AND HANDOVER
1. Make sure the host tab calls the Jevy API with the host's auth; conversation history per user; feature flag + rollback; old chatbot code paths removed behind the flag. Render by intent: prose/bullets for summaries, deep dives, definitions; tables only for rows; charts when asked/useful; collapsed "steps and SQL"; clear states for clarification, honest-incomplete and errors.
2. Observability: structured logs (question id, intent, plan, driver, per-stage latency, LLM calls/tokens, verification verdict, error class; no rows/PII), counters for refusals/clarifications/LLM errors, dashboard-ready metrics.
3. `docs/ENTERPRISE.md` (include the REFRESH PROMPT for stale notes): architecture, config reference, runbook (restart, refresh schema, rotate key, switch model, kill switch), how to extend the glossary and tests, known limits, troubleshooting table (symptom → check → fix) including "answers look like mock data" and "answers are junk".

# QUICK TRIAGE (do these first, in 15 minutes, before reading further)
1. Print the working directory and exact command Jevy was started with. Print `config.dbPath` and check it exists, with size/mtime. Search the whole workspace for `*.duckdb` files and report them.
2. Open `/api/catalog`: are the table names the company's tables? If you see servers/incidents/vulnerabilities/backups/applications/estates/evergreening, the mock DB is loaded (H1/H2).
3. Open `/api/health`: model, tier, tools? If the tier is not what the real model size implies, or tools are false, fix `LLM_PARAMS_B`/`LLM_CAPABILITIES` (H3).
4. For one failing question, capture the full trace and read `driver` and the LLM call list. If `driver` starts with `shape:`/`operator`, or there were 0 LLM calls, a rule answered (H4).
Report these four results first.

# HOW TO WORK
- Read before you write; search before you add; reuse existing helpers and the SQL guard; match code style.
- One concern per commit; run `npm test` and the relevant battery before each commit.
- When a question fails: reproduce with `scripts/ask.ts "<question>"` and the probes (`ground-probe.ts`, `draft-probe.ts`, `guard-probe.ts`), find the stage at fault, fix the stage, add a paraphrase set as regression.
- Report in plain English first, evidence second. Do not claim "done" without test counts and the provenance line.
- Do not stop at "it compiles".

# DEFINITION OF DONE
- Provenance proves every answer comes from the company DB and the company LLM; the mock data cannot be loaded in enterprise mode.
- A `knowledge/` pack written by you from first-hand exploration exists, every claim is evidence-backed and passes `verify-notes`, and the application retrieves only the notes it needs, when it needs them (visible in the trace).
- A capable model measurably outperforms the tiny model on the company suite; the agent plans, executes, verifies and composes; rules support it rather than pre-empt it.
- Bare nouns, "tell me about X", summaries, deep dives, definitions, follow-ups, mixed requests, comparisons, rankings, time windows and joins across all company tables produce the right kind of answer, with zero wrong numbers on dev and holdout; failures are honest.
- Schema drift is detected automatically: affected notes are flagged STALE visibly, answers continue from live facts, and the documented refresh prompt brings the notes back to green.
- Rollback flag tested; runbook delivered.

Order of work: QUICK TRIAGE, Phase 0 (diagnose), Phase 1 (right database, no silent fallbacks), Phase 2 (you study the database and write the notes), Phase 3 (real thinking using the notes), Phase 4 (extensive testing), Phase 5 (integration and handover). Make the required changes BEFORE the extensive testing. Do not edit any file except `ONBOARDING-NOTES.md` and `scripts/provenance.ts` until CHECKPOINT 0 is approved.

=== END PROMPT ===

## Pre-flight for the human
- [ ] Exact command and folder used to start Jevy in the enterprise setup
- [ ] Absolute path (or URL) of the company DuckDB, read-only copy is fine
- [ ] Real model size/id, whether it supports tool calling and JSON-schema output, and its auth method
- [ ] Two or three analysts to supply real questions and confirm business definitions
- [ ] Keep a holdout list of ~50 real questions that Copilot never sees
