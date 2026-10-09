# Jevy local POC

A standalone experiment in local, evidence-backed database agents. React/Vite → Node/TypeScript → Qwen through Ollama → read-only DuckDB. No company application integration, cloud inference, Docker, WrenAI, or preloaded factual answers.

## Start on a Mac

Requirements: Node.js 22+ and approximately 2 GB free disk space. The small model is [Qwen3 0.6B](https://ollama.com/library/qwen3:0.6b), the newer small Qwen family tag available in Ollama. Ollama reports its actual parameter metadata separately (the downloaded quantized model is about 523 MB).

```sh
# Install Ollama if command -v ollama returns nothing:
brew install ollama
# Or install the Mac app from https://ollama.com/download/mac

# In a separate terminal; bind to localhost and disable Ollama cloud:
OLLAMA_NO_CLOUD=1 ollama serve
# In your project terminal:
ollama pull qwen3:0.6b
cd /Users/vamsi/Desktop/jevy/jevy-local-poc
npm install
cp .env.example .env  # only on first setup; preserve your existing configuration
# optional, larger models for better answers (the UI lets you switch):
# ollama pull qwen3:4b
npm run dev
```

Open **http://127.0.0.1:5173**. Backend: **http://127.0.0.1:3001**. Ollama: **http://127.0.0.1:11434**.

`npm run dev` starts both app processes and generates the database if missing. It builds the catalog from DuckDB at every backend startup. It starts Ollama locally if its CLI is installed and no local Ollama server responds. It does not automatically download the model. Offline/model-missing states show exact setup commands in the UI. To run separately: `npm run server` and `npm run frontend`.

## Configuration

See `.env.example`. `DB_PATH` selects the database. `MAX_ROWS` caps displayed rows, `SQL_TIMEOUT_MS` interrupts long queries, and `LLM_TIMEOUT_MS` bounds each model call.

### Bring your own LLM

The harness works with any chat model, from 0.5B to frontier size.

- **Local (default):** `LLM_PROVIDER=ollama`, `OLLAMA_MODEL=...`. Size, context and capabilities are read from Ollama.
- **Enterprise / hosted:** `LLM_PROVIDER=openai`, `LLM_BASE_URL=https://<gateway>/v1`, `LLM_API_KEY`, `LLM_MODEL`. This works with any OpenAI-compatible API: OpenAI, Azure OpenAI, vLLM, TGI, LM Studio, LiteLLM, and API gateways in front of self-hosted GPUs. Extra headers go in `LLM_HEADERS` (JSON).
  - Structured output falls back automatically from `json_schema` to `json_object` to prompt-only JSON, per model.
  - Tool calling uses the OpenAI `tools` format.
  - Parallel calls are capped by `LLM_CONCURRENCY`.
- **Strategy follows model power.** Set `LLM_PARAMS_B`, `LLM_CONTEXT_LENGTH` and `LLM_CAPABILITIES` (`tools`, `thinking`) for remote models, because most APIs don't report them. If you don't, the size is guessed from the model name. `AGENT_TIER` forces a tier.
  - Small models get more scaffolding: grounded drafts, parallel candidates with voting, deterministic repair, and template answers.
  - Larger models get the tool-calling agent loop, review and larger context.
- **Data boundary.** Prompts contain schema notes, stored category values and query results (up to `MAX_ROWS`). Point `LLM_BASE_URL` only at an endpoint approved for that data.

To test the hosted path locally, `scripts/openai-gateway.ts` runs an OpenAI-compatible gateway in front of Ollama:

```sh
GATEWAY_KEY=test npx tsx scripts/openai-gateway.ts
LLM_PROVIDER=openai LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=test LLM_MODEL=qwen3:0.6b LLM_PARAMS_B=0.6 LLM_CAPABILITIES=tools npm run dev
```

### Enterprise scale: slow APIs and large tables

- **Remote endpoints:**
  - Calls that fail with 429/5xx or dropped connections retry with exponential backoff and honour `Retry-After` (`LLM_RETRIES`), always within that call's budget.
  - The per-question budget grows with the endpoint's measured call latency, up to `REQUEST_TIMEOUT_MS` (default 5 min, max 10 min).
  - `LLM_CONCURRENCY` caps parallel calls.
  - Progress streams to the UI throughout.
- **Large tables:** answers are always computed in SQL; the model never reads raw tables.
  - Results larger than `MAX_ROWS` report the exact total and a DuckDB-computed summary over all rows (ranges, sums, averages, top categories). Only that summary goes to the model.
  - Profiling uses exact distinct counts for keys and approximate ones elsewhere. Join checks are sampled. Tables above `PROFILE_SAMPLE_ABOVE_ROWS` are profiled from a sample, and the guard then treats their value lists as incomplete.
  - DuckDB memory, threads and spill-to-disk are configurable (`DB_MEMORY_LIMIT`, `DB_THREADS`).
- **Sub-agents:** compound questions run as parallel, individually verified sub-queries and are merged into one answer. These include enumerations ("counts of A, B and C"), comparisons ("production versus test") and planner-decomposed questions. Planner sub-questions are validated: they must ground in the schema, use only filters the user mentioned, and add no unrequested groupings.

Test data at scale: `SCALE=250 DB_PATH=./data/jevy-large.duckdb npm run db:generate` builds 14.5M rows in about 30 s. `scripts/openai-gateway.ts` can simulate a slow, flaky endpoint (`GATEWAY_DELAY_MS`, `GATEWAY_FAIL_RATE`).

### Schema understanding

On startup, once a day while the app runs (`SCHEMA_REFRESH_MS`, default 24 h), and within minutes of the database file changing (`SCHEMA_CHANGE_CHECK_MS`, a cheap file check), the catalog profiles every table: row grain, primary keys, verified joins with cardinality ("each server has about 6 vulnerabilities, 7 have none"), value lists, ranges and null rates. The configured model then writes notes in the background to `data/schema-notes.json`: table purpose, example questions and business synonyms.

- Every synonym is validated against real tables and stored values before use.
- Small models may only add abbreviations.
- `data/semantic.json` holds hand-written hints.

Neither file is required.

## Synthetic data

58,085 deterministic records: 4 estates, 80 applications, 4,000 servers, 24,000 vulnerabilities, 10,000 incidents, 16,000 backup runs, 4,000 upgrade records, and one dataset metadata row. Important tables have 21–29 useful columns.

```sh
npm run db:generate
```

Stop the app before regeneration. Generation replaces this POC's dataset. Seed 42 and reference date **2026-10-07** make independent tests repeatable. Change `SEED` and `DATA_AS_OF` before regenerating. Relative-date questions use the reference date rather than the host clock. The data is explicitly synthetic; it contains no real company records. IDs and timestamps provide stable tie-breaking. Random queries reset DuckDB's seed on each connection for reproducible samples.

Relationships:

- `servers.application_id` joins `applications.application_id`.
- `applications.estate_id` joins `estates.estate_id`.
- Vulnerabilities, incidents, backups, and evergreening each join servers by `server_id`.
- Vulnerabilities, incidents, and backups contain many rows per server. Queries must aggregate child tables independently or use distinct entity counts to avoid multiplying counts.
- Backups are run history. “Latest backup” requires selecting the latest run per server; “any failed backup” has different semantics.

## Agent flow (model-adaptive harness)

The same harness runs on any local Ollama model. At startup it reads the model's size, context length and capabilities from `/api/show` (`backend/model-profile.ts`) and picks a strategy tier:

| Tier | Models | Strategy |
|---|---|---|
| tiny (<2B) | qwen3:0.6b, qwen2.5:0.5b | Structured driver: 3 parallel SQL candidates, deterministic repair, execution-based voting, template answers for tables |
| small (2–14B) | qwen3:4b, qwen3:8b | Native tool-calling agent loop (describe tables, look up values, run parallel queries, check, answer); structured driver as fallback; one SQL review |
| large (≥14B) | 20–32B models | Same loop with more steps, reasoning on the first step, larger context and result windows |

`think` is only sent to models that support it. Context size is capped by machine memory. `AGENT_TIER` overrides detection.

1. **Deterministic routing, no model needed**: write/export requests are refused, greetings and schema questions ("what tables are there?") are answered from the live catalog, vague or absent-data questions get a clarification.
2. **Grounding** (`backend/grounding.ts`): typo correction against schema vocabulary ("servrs in producton" → servers / Production), synonyms and acronyms (Germany → `DE`, RHEL → `Red Hat Enterprise Linux`), identifier lookups in high-cardinality columns (`host-00042`), and table selection with bridge tables added along verified join paths. Hints live in `data/semantic.json`, not in code.
3. **Follow-ups**: the last three turns are kept as compact memory (standalone question, SQL, result summary, entity IDs). Follow-ups are rewritten into standalone questions, and "they/those" scope to the previously listed entity IDs.
4. **Verified operators** answer common shapes without model SQL: category breakdowns, latest related record, share/percentage of one condition, and calendar periods (with filters).
5. **Model-driven solving**: the tool loop (capable models) or parallel candidates with voting (tiny models). Independent sub-questions ("how many X, and how many Y?") run in parallel.
6. **SQL guard** (`backend/sql-guard.ts`, DuckDB AST): replaces the host clock with the dataset reference date, rebuilds wrong or missing joins from verified relationships, qualifies ambiguous columns, injects requested filters the model forgot, rejects hallucinated or misplaced filter values, negated requested values, double-counted joins, trivial distinct counts, date filters outside the stored range and queries that ignore a table the user asked about. Mechanical fixes happen without a model call. Everything else becomes a precise repair hint.
7. **Answer**: the model writes 1–3 sentences from the rows. Every number, date and identifier must appear in, or be derived from, the results; otherwise a deterministic summary is shown. The table and SQL are always shown.

A request budget (up to 180 s, adaptive per tier) bounds the work. If it runs out, the last verified result is returned with a note instead of an error.

Strategy also adapts to **measured speed**: each model's real tokens/second on this machine is tracked. When a capable model is too slow for a multi-step tool loop within the budget, Jevy switches to the compact structured strategy (one candidate, no review) instead of timing out. The tool loop may use at most ~60% of the remaining budget, so a structured fallback can still answer. A single model call that exceeds `LLM_TIMEOUT_MS` counts as an ordinary failure, not "Ollama offline".

## Chat app

- **Conversation history** in a left pane: start a new conversation, search, rename, delete, and reopen any past conversation. History is stored in its own writable DuckDB file (`data/chat-history.duckdb`, `CHAT_DB_PATH`), separate from the read-only analytics database. Each conversation also stores the agent's follow-up memory, so follow-ups keep working after a restart. The pane collapses to an icon rail (desktop) or becomes a drawer (phone).
- **Model switcher** in the header lists installed Ollama models with their tier (fast / balanced / most capable), strategy (self-consistency or agent loop), reasoning support and measured speed. Choosing a model loads it in the background (`POST /api/models/warm`) so the first question isn't slowed by loading.
- **Live thinking trace** (vertical, like Codex/Cursor): each phase (understand → find data → query → check → answer) is a step with a spinner while active and a check when done, its duration, and every real backend event under it — tables found, SQL being run (as code chips), repairs, review results, and each model call as it starts ("Model · drafting a query"). When the answer arrives the trace folds into "Thought for N s · steps · model calls" and can be reopened.
- **Answers** reveal word by word, followed by a chart card (when there is one) and result cards (metrics or tables) with Show SQL / Copy. Copy and Retry are on every answer. White theme, keyboard focus states, reduced-motion support, phone layout.

## Charts

Ask for a chart in any wording — "pie chart of servers by os", "plot incidents per month", "stacked bar chart of vulnerabilities by severity and status", "histogram of cpu cores", "servers by region as a donut chart" — or turn the previous answer into one ("make that a pie chart", "chart it", "now as a horizontal bar chart"). Breakdowns and trends also get a chart automatically; single numbers stay as figures.

How it works (`backend/chart.ts`, rendered with Recharts in `frontend/src/Chart.tsx`):
- Chart wording is removed before the data pipeline runs, so the question is answered exactly as it would be without the chart (same grounding, SQL guard and verification).
- The **chart contract** (`ChartSpec`, zod-validated): type (`kpi | bar | column | line | area | stacked | grouped | pie | donut | scatter`), title, x field and kind, series, y format, data, notes, and the evidence step it came from. Every plotted value is copied from executed query rows; the model never produces chart numbers.
- The form follows **what the question is trying to show** and the result's shape:
  - **Share or proportion** → donut (≤7 parts) or treemap. **Ranking** ("top", "most") → sorted horizontal bars with value labels. **Compare** → grouped bars.
  - **Trend** → area, or one line per category. **Share over time** → stacked area. **Cumulative** → running-total line. Only 2–3 periods → columns.
  - **Two dimensions** → stacked bars, 100% stacked for shares, or a heatmap when both sides have many values.
  - **Three or more comparable measures** → radar. **A single percentage** → gauge. **Many categories** → treemap.
  - A small breakdown of a whole → donut. Ordered categories (Critical → Low, P1 → P4) → columns.
  - Averages, maxima and scores never become a pie, treemap or stack, because they don't add up to a total.
- Every chart has a **View as** row listing the other forms that are valid for the same data (e.g. Donut · Columns · Bars · Treemap · Radial). Switching only reorders the data or folds small slices; it never computes new numbers.
- **Summaries become dashboards**: "give me a summary of servers" returns one chart per breakdown, using different forms (donut, columns, bars, treemap, radial) rather than one kind repeated.
- If you name a type, it is used when the data supports it; otherwise the chart says why it fell back (for example, a pie of averages becomes columns with a note).
- Accuracy safeguards: more than 30 categories are capped with a note; pies keep 7 slices and fold the rest into "Other"; ordered categories keep their natural order (Critical → Low, P1 → P4); an incomplete latest period (data ends mid-month) is called out; a chart is never shown for a question the data cannot answer.
- Each chart card has Chart / Table / SQL views, hover tooltips (stack totals included), and CSV download. Colours are a fixed categorical order validated for colour-vision deficiency on white.

API: `GET /api/models`, `POST /api/models/warm`, `GET /api/suggestions`, `GET|PATCH|DELETE /api/conversations[/:id]`, `POST /api/chat` (NDJSON: `start`, `progress` with `phase`, `result`).

## Tools and SQL safety

`inspect_schema`, `inspect_values`, `inspect_table`, and `run_sql` are implemented in `backend/executor.ts`. Tool names and input shapes are validated. Metadata table/column inputs must exist in the discovered catalog. Dependency references such as `IN ({{step_id.server_id}})` are resolved only for declared dependencies, with SQL-literal escaping.

DuckDB runs with `access_mode=READ_ONLY` and `enable_external_access=false`. Its real parser extracts statements; exactly one SELECT statement is accepted, including CTEs, joins, aggregates, subqueries, and windows. Prepared statement type is checked before execution. Multi-statements, writes, external file/URL readers, extension loading, and configuration changes are rejected. Each query uses a separate connection with a time limit, 512 MB database memory limit and two execution threads. Display rows are capped with a wrapper without changing aggregate semantics. These controls follow [DuckDB's security guidance](https://duckdb.org/docs/stable/operations_manual/securing_duckdb/overview).

The safety boundary is the database connection and parser, not a regex or model refusal. This is a local POC, not a production multi-tenant isolation design.

## Conversation state

Each session keeps its last three turns as compact memory: the original and standalone question, executed SQL, a short result summary, the result's entity key (for example `server_id`) with up to 200 IDs, and the literals used. Follow-ups such as "what about Germany?" replace the matching filter. Follow-ups such as "which applications do they belong to?" are scoped to the previous IDs. Memory resets when the schema changes. Learned aliases go to `data/aliases.json` only when the value exists in the data.

## Debugging

Enable Developer trace in the sidebar. Each answer then shows the model profile and chosen strategy, measured speed, grounding (typo corrections, value mappings, tables), the standalone follow-up question, every SQL candidate with errors and repairs, review verdicts, whether the prose passed verification, model calls with token counts and timings, and all progress events. Trace is inspectable even when a turn fails. It contains operational data, never model thinking.

## Tests and evaluation

```sh
npm test           # real DuckDB safety + orchestration tests; uses injected model only for control-flow tests
npm run build      # TypeScript checks and production frontend build
npm run evaluate   # 54 live Ollama questions; model must be installed and served
BATTERY_SET=100 npm run battery   # 104-question set across every table, joins, dates, follow-ups, guardrails
npx tsx tests/chart-battery.ts   # 88 chart requests checked against independent oracle SQL
npm run battery    # 58-case core battery (30 dev + 15 held-out): typos, synonyms, 2-4 table joins, follow-ups, dates, writes
./scripts/run-batteries.sh qwen3:0.6b@all qwen3:4b@dev   # one model at a time
npm run report     # create EVALUATION.md from measured results
```

For a subset:

```sh
EVAL_FILTER=count-prod,prod-variation-1,prod-variation-2,prod-variation-3 npm run evaluate
```

`tests/cases.ts` is used only by evaluation, never by the agent. Exact-answer cases execute independent oracle SQL. Random records are checked against fresh database rows; compound records also verify OS, application, finding count and latest incident. Follow-up tests share a session. Ambiguous, absent-data and attempted-write cases verify response status. Multi-query tests verify independently computed counts and separate evidence.

`test-results/evaluation.json` records SQL success after repairs, final evidence accuracy, average retries, model calls, model latency and total response latency, plus complete per-case traces. Partial runs include tested/total counts. Accuracy compares factual evidence rather than model prose. Numeric correctness alone cannot prove SQL answered the intended business question; manual review is still valuable.

For every capability fix, rerun the failed question and at least three unseen wording variations. Do not add question-specific dispatch, saved answers, or evaluation-oracle SQL to the agent. Tiny-model limitations belong in the report, not hidden behind special cases.

## Project map

- `backend/generate.ts`: deterministic enterprise dataset.
- `backend/catalog.ts`: live schema/value catalog, relationships, retrieval, aliases.
- `backend/agent.ts`: routing, follow-up rewriting, verified operators, driver selection, answer and memory.
- `backend/model-profile.ts`: model size/capability detection and the per-tier strategy.
- `backend/grounding.ts`: typo correction, synonyms, acronyms, identifier lookups, table selection.
- `backend/solver.ts`: structured driver with parallel SQL candidates, repair and voting.
- `backend/loop.ts`: native tool-calling agent loop for capable models.
- `backend/tools.ts`: shared tools (run_sql with guard and auto-repair, describe_table, find_values).
- `backend/answer.ts`: prose answers checked against results; deterministic templates.
- `backend/executor.ts`: dependency scheduler for verified multi-step operators.
- `backend/sql-guard.ts`: DuckDB AST checks, join synthesis, deterministic repairs.
- `data/semantic.json`: optional synonyms and business definitions (no code changes needed).
- `backend/query-plan.ts`: retained typed compiler experiments and regression checks; not the active query generator.
- `backend/db.ts`: actual read-only connection, statement parser, row/time limits.
- `backend/providers.ts`: LLM providers (Ollama, any OpenAI-compatible API) behind one interface.
- `backend/llm.ts`: structured JSON and tool-calling calls, JSON recovery, speed tracking, concurrency and budget.
- `backend/draft.ts`: grounded draft SQL built from the schema when a question is fully understood.
- `backend/schema-notes.ts`: background schema learning (summaries, validated synonyms).
- `backend/server.ts`: local API and progress stream.
- `backend/chat-store.ts`: conversation history in a separate writable DuckDB file.
- `frontend/src/`: chat app — history sidebar, model switcher, live thinking timeline, answers and result cards.
- `tests/`: independent evaluation questions and control-flow/safety checks.

## Boundaries

This experiment can establish that the architecture executes safely and show where a tiny model succeeds or fails. It does not prove arbitrary-question accuracy. Read the measured results before reproducing the design in a company application. Current retrieval uses a small semantic glossary and lexical scoring; the observation model is not an independent semantic correctness oracle. Truncated evidence, ambiguous business definitions, long compound requests and entity-scope errors can require clarification or a larger local model. No company integration was performed.

## Relationship to the supplied Jevy stack photo

The photo describes React 18/TypeScript/Vite, `@ai-sdk/react`, a local Node HTTP API on port 8766 with NDJSON, Vercel AI SDK `generateText`, Zod-validated typed planner/executor, approved Group AI using Qwen3-32B-AWQ, and read-only `@duckdb/node-api` estate snapshots. This POC preserves the TypeScript, streaming, typed-plan and DuckDB boundaries while using React 19, Express on port 3001, and direct local Ollama inference. It does not access the corporate gateway or credentials. The photo is reference information, not authorization to connect to company services.

The transferable changes are bounded reasoning, catalog grounding, dependency execution, AST checks and independent SQL review. These can sit behind the existing Jevy provider and tool interfaces. Corporate integration has not been performed.

## Measured outcome (2026-10-08, qwen3:0.6b on an 8 GB MacBook)

| Test set | Result | Mean latency |
|---|---|---|
| Chart battery (`tests/chart-battery.ts`, 88 requests, 15 different chart forms produced, incl. intent-driven variety and 4 summary dashboards): explicit types, typos, joins, time series and trends split by category, two-field breakdowns, histograms, chart-only follow-ups, auto charts, figures, unanswerable requests — every plotted value checked against independent SQL | **88/88** | 0.9 s |
| 150-question stress set (`BATTERY_SET=150`): slang and typos, estate → application → server → incident/vulnerability/backup/upgrade chains, incident ↔ vulnerability via servers, latest-per-entity, NULL and negation, numeric thresholds, dates, lookups, 2–3 turn follow-ups, multi-questions, guardrails | **148/148** | 3.4 s |
| 100-question set (`BATTERY_SET=100`) | **104/104** | 4.4 s |
| Core set (58 cases, incl. held-out and fresh) | **58/58** | 2.6 s |
| Enterprise path: OpenAI-compatible API via `scripts/openai-gateway.ts` (30 mixed questions, no reasoning mode) | **30/30** | 0.9 s |
| Grounded-draft precision, run through the full SQL guard (deterministic, no model) | **219/219** correct when it fires | — |
| Unit tests (`npm test`) | **127/127** | — |

How it got there:
- The 100-question set went 78 → 103 → 104/104.
- The 150-question set went 121 → 138 → 147 → 148/148.
- Every fix was a general mechanism (grounding, draft patterns, guard checks). Nothing was added per question.

Limits:
- Questions the deterministic layer cannot fully ground still depend on the model and the guard.
- Bigger local models (4B and up) were not evaluated on this 8 GB Mac.
- Always review the SQL behind answers used for important decisions.

Raw results: `test-results/v7/` (latest), `test-results/v3/` (large database and slow/flaky gateway runs).
