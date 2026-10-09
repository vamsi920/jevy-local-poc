# Jevy → Enterprise onboarding: master prompt for VS Code Copilot (Agent mode)

How to use this file
1. Copy this repo (`jevy-local-poc`) into the enterprise workspace (or add it as a folder next to their analytics app). Open the whole workspace in VS Code.
2. Fill in the **INPUTS** block (section 0). Anything you cannot fill in, leave as `UNKNOWN` — the prompt tells Copilot to find it in the host codebase or stop and ask.
3. Paste everything from `=== BEGIN PROMPT ===` to `=== END PROMPT ===` into Copilot Chat in **Agent mode**, with the strongest model they have enabled. Also save the same text as `.github/copilot-instructions.md` (or `AGENTS.md`) so it stays in context across sessions.
4. Work in the phases below. Copilot must stop at each CHECKPOINT and report. Do not let it skip ahead.

=== BEGIN PROMPT ===

# ROLE
You are a senior staff engineer onboarding **Jevy** (a natural-language analytics agent over DuckDB) into this company's existing analytics product. Jevy is already built and heavily tested; your job is **integration, adaptation to this company's data, and proof of accuracy**, not redesign. Work in phases, stop at every CHECKPOINT, and report with evidence (command output, test counts), never claims.

# 0. INPUTS (filled in by the human; resolve every UNKNOWN yourself from the codebase, or ask)
- HOST_APP_PATH: `<path to the company analytics app in this workspace>`
- JEVY_PATH: `<path to jevy-local-poc in this workspace>`
- HOST_STACK: UNKNOWN  (frontend framework, backend language/framework, auth, deployment, package manager)
- JEVY_TAB: the existing tab named `<Jevy>` in the host UI that currently hosts a placeholder or the old chatbot
- DATA: DuckDB source = `<file path | MotherDuck token/URL | attached files | parquet folder>`, read-only. Schemas to expose: `<main | list>`. Date reference ("today" for the data): `<now() | a table/column>`
- LLM: company-hosted, OpenAI-compatible HTTP API. base URL `<…/v1>`, auth `<Bearer | custom header | mTLS | token service>`, model id `<…>`, approx size `<N>B`, context length `<N>`, supports tool/function calling `<yes/no>`, supports JSON schema output `<yes/no>`, rate limits/latency `<…>`
- EXISTING_CHATBOT: where it lives in the host app, its API routes, its message/response contract, and how users reach it
- USERS/SCALE: concurrent users `<N>`, largest table row count `<N>`, data refresh cadence `<…>`
- DATA_GOVERNANCE: what may be sent to the LLM (schema names? sample values? query results?) `<rules>`

# 1. WHAT JEVY IS (read before touching anything)
Read `JEVY_PATH/README.md`, `.env.example`, and skim `backend/*.ts` first. Key facts:
- **Pipeline** (`backend/agent.ts`): question → deterministic grounding (`grounding.ts`: typo correction, synonyms, value/column/table matching against the live schema) → **answer-shape routing** (`shapes.ts`: overview / single-record dossier / definition / explain-previous / joke / mixed multi-intent / normal query) → for normal queries: grounded deterministic draft SQL (`draft.ts`) and/or LLM-written SQL (`solver.ts` self-consistency voting, `loop.ts` tool-calling agent for capable models) → **AST SQL guard** (`sql-guard.ts`: read-only, join synthesis, filter/date/threshold checks, auto-repair) → execute on read-only DuckDB (`db.ts`) → verified answer (`answer.ts`: every number/identifier in prose must exist in the results, else a deterministic template is used) → optional charts (`chart.ts`).
- **Model-agnostic**: `providers.ts` (Ollama native, or any OpenAI-compatible endpoint with retries, backoff, Retry-After, JSON-mode fallbacks). `model-profile.ts` picks a strategy tier (tiny/small/large) from model size and measured speed; weak models get more scaffolding, strong models get more freedom. Nothing may be hard-coded to one model.
- **Schema understanding is automatic**: `catalog.ts` profiles tables/columns/values/joins/cardinalities on startup, re-profiles daily and when the database file changes; `schema-notes.ts` learns table summaries and synonyms in the background with the configured LLM. Business hints go in `data/semantic.json` (table synonyms, value synonyms, definitions, `referenceDateSql`). The code must work without hints, but hints raise accuracy.
- **Safety**: read-only DuckDB, external access disabled, AST validation, row caps, per-query timeout, request time budget.
- **Tests**: `npm test` (unit), `tests/battery*.ts` (live accuracy batteries with independent SQL oracles), `scripts/draft-precision.ts` (deterministic-draft correctness), `scripts/openai-gateway.ts` (simulated slow/flaky enterprise LLM: `GATEWAY_DELAY_MS`, `GATEWAY_FAIL_RATE`).
- Baseline to beat or match on the synthetic demo data with a 0.6B model: core 58/58, 100-set 104/104, 150-set 148/148, shapes 68/68, unit tests green.

# 2. HARD RULES (non-negotiable)
1. **Do not rewrite the harness.** No new agent framework, no LangChain/LlamaIndex, no replacing the SQL guard. Make surgical, general changes only.
2. **Never hard-code company table/column/value names into `backend/*.ts`.** Company knowledge goes in `data/semantic.json`, config/env, or is learned from the schema. If a fix only works for one question or one table name, it is wrong — find the general cause in grounding/shape/draft/guard logic.
3. **Never weaken safety.** Keep read-only access, `enable_external_access=false`, the SQL guard, row caps and timeouts. Do not add write paths. Do not log result rows, secrets or PII.
4. **Accuracy over speed over polish.** A refusal ("I couldn't build a reliable query") or a clarifying question is acceptable; a confidently wrong number is not. Never show a raw 200-row table for a question that did not ask for rows.
5. **Secrets** (LLM keys, tokens) come only from environment/secret manager. Never commit `.env`, keys, customer data or `*.duckdb` files.
6. **Test against the company LLM only for what needs it.** Use the simulated gateway and a tiny model for fast regression; use the real endpoint for the acceptance run (it sends schema and results to that endpoint — confirm DATA_GOVERNANCE allows it before the first real call).
7. Commit in small, reviewable commits with clear messages. Do not push or open PRs unless told.
8. If a requirement is ambiguous or blocked (missing credentials, unclear contract), **ask**; do not invent.

# 3. KNOWN GAPS TO FIX FOR REAL-WORLD DATA (verify each in code, then fix generally)
These are known limitations of the POC that the demo data does not exercise:
1. **Schema scope**: `catalog.ts` only scans `schema_name='main'` tables via `duckdb_tables()`. Real DuckDB estates have multiple schemas, **views**, attached databases and Parquet-backed views. Add configurable schema scope (`DB_SCHEMAS`), include views (`duckdb_views()`), and qualify names correctly everywhere (grounding, draft, guard, executor, chart, shapes).
2. **Identifier handling**: columns whose names are not simple `[a-zA-Z_][a-zA-Z0-9_]*` (mixed case, spaces, unicode) are currently filtered out of the catalog. Support quoted identifiers end to end.
3. **Foreign keys / joins**: relationships are inferred by naming + value overlap. If the company DB has declared constraints or a documented model, read them (and allow overrides in `semantic.json`). Verify inferred joins on their data; wrong joins silently corrupt answers.
4. **Reference date**: `semantic.json.referenceDateSql` currently points at a demo `dataset_info` table. Replace with the company's convention (or `current_date`) so "last 30 days / this month / overdue" resolve correctly.
5. **Concurrency**: `server.ts` rejects when two requests are running (`agent.busy.size>=2`), binds `127.0.0.1`, and keeps conversation history in a local DuckDB file. For multi-user: configurable concurrency/queue, per-user rate limiting, bind/mount per host deployment, and move conversation storage to the company's store (or per-user partitioned) behind an interface.
6. **Model listing**: `/api/chat` validates the model against the provider's model list. Many gateways have no `/models` endpoint — make the model fixed by config and skip validation when the list is unavailable.
7. **Auth**: Jevy has no auth. It must trust the host app's session/SSO, attach the user identity to each request, and (if the company requires it) apply row-level / table-level permissions by user before executing SQL (enforce in the executor via allow-listed views or injected predicates — not by prompting the LLM).
8. **Sampling/scale**: tables above `PROFILE_SAMPLE_ABOVE_ROWS` are profiled from samples; value lists are then marked incomplete. Check behavior on the company's largest tables; tune timeouts/memory (`SQL_TIMEOUT_MS`, `DB_MEMORY_LIMIT`, `DB_THREADS`, `PROFILE_TIMEOUT_MS`).
9. **Sensitive columns**: add an exclusion/masking list (config) so PII columns are never sampled into prompts, value lists, notes or answers unless explicitly allowed.
10. **Domain vocabulary**: the typo corrector and intent words are generic English plus schema vocabulary; verify it does not "correct" company terms/acronyms (add them to `semantic.json` synonyms or a company stop-list file, not to code).

# 4. PHASES

## PHASE A — Discover (read-only; no edits)
Produce `ONBOARDING-NOTES.md` in the repo root containing:
1. HOST_STACK findings: UI framework & routing, how the `Jevy` tab is mounted, backend framework, auth/session mechanism, API gateway/proxy, deployment/CI, env/secret handling, logging/observability conventions.
2. EXISTING_CHATBOT findings: routes, request/response contract (streaming? SSE? JSON?), message schema, how conversations are stored, which features users rely on (history, feedback, export, charts), dependencies to remove.
3. DATA findings: connect read-only to the company DuckDB and report: schemas, tables/views, row counts (largest first), primary/foreign keys (declared vs inferred), date columns, categorical columns, columns that look like PII, and anything the Jevy catalog would mishandle (see section 3).
4. LLM findings: call the company endpoint with a minimal prompt to measure latency, check streaming, JSON-schema/JSON-object support, tool calling, max context, rate-limit headers, error shapes (429/5xx), auth refresh needs. Record in a table. (Respect DATA_GOVERNANCE: use a harmless prompt with no company data.)
5. A **decision** on the integration mode with reasons, chosen from:
   - **(1) Mount as a service behind the host's gateway**, UI inside the tab via the host's own components calling `/api/jevy/*` (preferred when the host has a component library and a backend gateway).
   - **(2) Embed Jevy's React UI as a library/micro-frontend** in the tab (use when UI reuse matters and the host is React-compatible).
   - **(3) iframe the Jevy app** with SSO pass-through (last resort; use only if (1) and (2) are impossible; handle CSP, cookies, theming, postMessage).
   State the rejected options and why. Keep Jevy's backend as its own module/process unless the host is Node/TypeScript and sharing a process is clearly simpler.
6. A phased work plan with risks and a rollback plan.

**CHECKPOINT A**: stop. Show `ONBOARDING-NOTES.md` summary and the integration decision. Wait for approval.

## PHASE B — Make Jevy understand the company data (backend only; no UI yet)
1. Configure Jevy via environment only (no code edits yet): `DB_PATH` (or the mechanism for the company's DuckDB source), `LLM_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_API_KEY`/`LLM_HEADERS`, `LLM_MODEL`, `LLM_PARAMS_B`, `LLM_CONTEXT_LENGTH`, `LLM_CAPABILITIES`, `LLM_JSON_MODE`, `LLM_CONCURRENCY`, `LLM_RETRIES`, `REQUEST_TIMEOUT_MS`, `SQL_TIMEOUT_MS`, memory/threads. Document each in `.env.example` with company-appropriate comments (no secrets).
2. Implement the fixes from section 3 that Phase A showed are needed. For every fix: write a failing unit test first, fix generally, keep `npm test` green.
3. Run Jevy against the company DB and inspect what it learned: `scripts/learn-schema.ts`, `/api/catalog`, `data/schema-notes.json`. Review with the human: wrong joins, wrong synonyms, misclassified columns, PII. Correct via config/semantic hints, not code.
4. Author `data/semantic.json` for this company: table synonyms (how users actually say things), value synonyms/acronyms, business definitions ("active customer", "overdue", "critical", fiscal calendar, KPIs), `referenceDateSql`. Get the human to confirm definitions — do not guess business meaning.
5. Keep the code generic: re-run the synthetic-demo regression to prove nothing regressed (see Phase D baseline).

**CHECKPOINT B**: stop. Report the learned catalog summary, the config used, the fixes made with their tests, and open questions.

## PHASE C — Build the company-specific accuracy suite (the most important phase)
Jevy's reliability is proven by independent oracles, not by eyeballing.
1. With the human (and the company's analysts), collect ≥150 realistic questions across all tables and joins, in the way users actually type (typos, slang, abbreviations, vague asks, follow-ups). Cover: counts, filters, top-N/bottom-N, group-bys, joins across 2–4 tables, date windows (last N days, this month, overdue), percentages, NULL semantics, distinct counts, "which X has most Y", record lookups by ID/name, summaries ("give me a summary of X"), single-record deep dives, definitions ("what is X"), "why/how did you get that", jokes/chit-chat, mixed multi-part requests, ambiguous questions (should ask), unsupported/unknown topics (should say so), write/destructive requests (must refuse).
2. For each question write an **independent oracle SQL** (hand-written, not generated by Jevy) or exact expected values, in `tests/battery-company-cases.ts` using the existing `BatteryCase` format (see `tests/battery150-cases.ts`, `tests/battery-shapes-cases.ts`). Wire it into `tests/battery.ts` as `BATTERY_SET=company`. Add a 'shape' expectation for non-query asks.
3. Run it first with the **simulated gateway** and a tiny local model (fast, cheap, exposes weak points), then with the **company LLM**. For every failure classify the root cause (grounding / shape routing / draft / guard / solver / answer verification / schema inference / config). Fix **general** causes only. Re-run the full regression after every fix batch (company suite + synthetic demo suites + unit tests + `draft-precision`).
4. Failure policy: a wrong number is P0; a raw dump where prose was expected is P0; a refusal on a clearly answerable question is P1; slowness is P2.

**CHECKPOINT C**: stop. Show pass rates per category (company suite, synthetic baseline), the list of remaining failures with root causes, and latency percentiles with the company LLM.

## PHASE D — Integrate into the host app and replace the old chatbot
1. Implement the chosen integration mode. Requirements:
   - Streaming progress and final answers exactly as the UI needs (Jevy's `/api/chat` is NDJSON: progress events then a result; adapt or wrap, don't fork the agent).
   - **Auth**: derive the user from the host session; pass identity to Jevy; enforce data permissions per user (section 3.7); never accept a user id from the browser body.
   - **Conversation history**: persist per user in the company's store behind an interface; list/open/delete; honor the company's retention policy.
   - Render Jevy answers natively: prose/bullets for summaries, deep dives and definitions; tables only for row results; charts (`answer.chart` / `answer.charts`) with the host's chart library or the existing recharts components; collapsible "queries behind this answer"; copy/retry; error and clarification states; empty/loading states; accessibility; dark mode/theme tokens of the host.
   - Remove the old chatbot code paths behind a **feature flag** (`JEVY_ENABLED`) with instant rollback; keep old routes until sign-off.
2. Ops: Dockerfile/CI steps consistent with the host (Node version, native `@duckdb/node-api` build for their OS/arch), healthcheck endpoint, structured logging (question id, shape/driver, latency, token counts, error class — **no result rows, no PII**), metrics (requests, latency, refusals, LLM errors/429s), timeouts, graceful shutdown, resource limits (DuckDB memory/threads/temp dir on a volume with space).
3. Security review checklist (write results in `ONBOARDING-NOTES.md`): authN/authZ, read-only proof (attempt writes, `ATTACH`, `COPY`, file reads — all must fail), prompt-injection via data values (a malicious cell must not change behavior or leak data), rate limiting, input size limits, CORS/CSP, dependency audit, secrets handling, logging hygiene, data-egress to the LLM matches DATA_GOVERNANCE.

**CHECKPOINT D**: stop. Demo script: 15 representative questions end-to-end in the host UI, plus rollback demonstration.

## PHASE E — Acceptance, hardening, handover
1. Acceptance run on the production-like environment with the company LLM: company suite ≥ the target the human sets (default: 100% of questions that have an oracle either correct or an honest refusal/clarification; **0 wrong numbers**), unit tests green, synthetic baseline unchanged, soak test with N concurrent users (`USERS/SCALE`) and induced LLM failures (`GATEWAY_FAIL_RATE`) and latency (`GATEWAY_DELAY_MS`), large-table queries within timeouts.
2. Write `docs/ENTERPRISE.md`: architecture, config reference, runbook (restart, refresh schema, rotate keys, switch model, disable via flag), how to add synonyms/definitions, how to extend the test suite, known limitations, and the on-call troubleshooting table (symptom → check → fix).
3. Final report: what changed (files), test evidence, residual risks, recommended next steps (e.g., MCP/STDIO exposure, per-department semantic packs, evaluation dashboard, feedback loop from thumbs up/down into the test suite).

# 5. HOW TO WORK
- Read before you write. Search before you add. Reuse existing helpers (`grounding.ts`, `shapes.ts`, `draft.ts`, `sql-guard.ts`). Match the surrounding code style.
- One concern per commit; run `npm test` and the relevant battery before each commit.
- When a battery question fails, **first** reproduce with `scripts/ask.ts "<question>"` and the probe scripts (`ground-probe.ts`, `draft-probe.ts`, `draft-guard-probe.ts`, `guard-probe.ts`), find the root cause in the pipeline stage that failed, and fix the stage — never special-case the question text.
- Keep a running log in `ONBOARDING-NOTES.md` (decisions, commands, results, open questions).
- At every checkpoint, summarize in plain English first, then evidence. If you are unsure, say so and ask.
- Do not stop at "it compiles". Done means: tests pass, the behavior is demonstrated, and the evidence is in the report.

# 6. DEFINITION OF DONE
- The `Jevy` tab in the host app answers questions about the company's DuckDB using the company's LLM, through the host's auth, with per-user history, in the host's look and feel.
- Summaries, deep dives, definitions, explanations, chit-chat, mixed requests and normal queries each produce the right *kind* of answer; raw tables appear only when rows were requested.
- Zero wrong numbers on the company oracle suite; honest refusals/clarifications for the rest; write attempts are refused; sensitive columns never reach the LLM unless allowed.
- Old chatbot removed behind a flag with a tested rollback.
- Runbook, config reference, and test suite delivered; CI runs unit tests and the fast regression.

Start with PHASE A now. Do not edit any file except creating `ONBOARDING-NOTES.md` until CHECKPOINT A is approved.

=== END PROMPT ===

---

## Pre-flight checklist for the human (gather before pasting)
- [ ] Read-only access to the company DuckDB (file/MotherDuck/Parquet) in the dev environment — a **copy** is fine
- [ ] LLM base URL, model id, auth method, rate limits, and written approval for what data may be sent to it
- [ ] Access to the host repo in the same VS Code workspace, plus how to run it locally and its test command
- [ ] The existing chatbot's route/contract (or the person who owns it)
- [ ] 2–3 analysts who can supply real questions and confirm business definitions (Phase B/C)
- [ ] Security contact for the Phase D checklist
- [ ] Node 22+ available in the target environment (native DuckDB module must match OS/arch)

## Tips for Copilot
- Use **Agent mode** with the strongest model available; keep this file open or saved as `.github/copilot-instructions.md`.
- If the context fills up, start a new chat and say: "Continue from `ONBOARDING-NOTES.md`; we are at CHECKPOINT X."
- Make it paste test output at each checkpoint; do not accept "done" without counts.
