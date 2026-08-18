# Pi sessions look-back — findings & ranked optimizations

**Method.** Walked all 385 jsonl sessions under `~/.pi/agent/sessions` (245 MB). Per-session stats extracted with `analyze.js` (cost, tool calls, error rates, dup-arg replays, failed retries, parallel/serial batching, orchestration adoption, model usage). Cross-cutting evidence captured in `evidence_pack.md`. A six-specialist workflow (`pi_sessions_optimization`) analyzed the pack from cost / orchestration / batching / tool-error / long-session / standing-orders angles; a synthesizer merged duplicates and ranked.

**Corpus headline.** 385 sessions · 1.22 B tokens · **$1,951.00** · 14,851 tool calls · 581 errors · 681 failed-retry loops · 537 dup-arg replays · `workflow` tool used **0** times · subagent used in **18%** of sessions · async in **11%** · parallel/serial tool-call ratio **0.127**.

**Dominant theme.** pi's standing orders work as documentation but lose to tempo at decision time. Fixes that move rules from prose to *runtime gates* dominate the top tier.

---

## Top recommendations (ranked, confidence-scored)

Ranking = impact × confidence / effort, with cross-specialist duplicates merged.

| # | Recommendation | Audience | Conf | Impact | Effort |
|---|---|---|---|---|---|
| 1 | Failed-retry loop breaker with hypothesis-change gate | harness-author | **0.90** | high | low |
| 2 | Duplicate-argument replay detector + cached inline + escalation | harness-author | **0.88** | high | low |
| 3 | PreToolUse orchestration gate on session-first multi-file mutations | harness-author | **0.82** | high | medium |
| 4 | Real-tool few-shot examples + batched-tool description leadership | harness-author | **0.80** | high | low |
| 5 | Verify prompt-caching is enabled on the stable system-prompt prefix | harness-author | **0.75** | high | low |
| 6 | Block interactive-TTY commands at the Bash tool boundary | harness-author | **0.78** | high | low |
| 7 | Fuzzy-fallback Edit.oldText anchoring + stale-cache invalidation | harness-author | **0.82** | high | medium |
| 8 | Per-session cost + orchestration telemetry ledger (JSONL) | harness-author | **0.90** | high | medium |
| 9 | Hard tool-call ceiling with forced-summarization at p99 (~260 calls) | harness-author | **0.78** | high | medium |
| 10 | Flip `subagent` dispatch default to `async: true`; require explicit sync opt-in | harness-author | **0.72** | medium | low |

### 1 · Failed-retry loop breaker (conf 0.90)
**Evidence.** 681 failed-retry loops corpus-wide (~1.77 / session). Largest single waste category. Top offender: `test pi chrome` session (37 retries, $106, 317 tool calls).
**Action.** Per-(tool, target) failure counter. On 3rd *deterministic* failure (ENOENT, EPERM, syntax, "not unique") inject a forced-reasoning turn: "You have failed 3× on `<target>`. State a new hypothesis or escalate." Transient errors (timeout, 5xx, EAGAIN) keep free backoff retries.
**Outcome.** Eliminate the bulk of those 681 loops; conservatively trim 10-20% off tail-session tool-call counts and proportionally cut the p95+ $/session.

### 2 · Duplicate-arg replay detector (conf 0.88)
**Evidence.** 537 exact-replay calls (tool + args byte-identical). Concentrated in long sessions — 89/317 in `test pi chrome`, 77/414 in the implementation-notes loop. Zero new information for non-zero cost.
**Action.** Session-scoped LRU keyed by (tool, normalized_args) for *idempotent* tools (Read, Grep, find_files, ctx_search, ctx_execute_file). 2nd identical call returns cached result with `[cached]` marker; 3rd forces a planning turn; 4th escalates to summarize-and-handoff. Bash / network fetches stay non-cacheable.
**Outcome.** Directly trims input-token spend on the long-session tail; visibly shortens sessions that loop on the same Read/Grep.

### 3 · PreToolUse orchestration gate (conf 0.82)
**Evidence.** `workflow` calls = **0/385**. `subagent` calls in **18%** of sessions (target floor in AGENTS.md: >30%). Cross-corpus subagent / (write+edit+bash) = **0.035** — 10× under the explicit floor. Mechanism is documented in AGENTS.md HARD RULE point 4: prose loses to conversational tempo.
**Action.** Extension hook `orchestration-gate` (same shape as context-mode's PreToolUse routing). When the *first* Write/Edit/Bash-mutate of a session touches >1 directory or creates >1 new file AND prior subagent dispatches = 0, block. Return structured remediation naming `/parallel-research`, `/parallel-context-build`, or scout-async. Explicit `--ack-skip-orchestration <reason>` bypass, logged for self-grading.
**Outcome.** Moves subagent adoption from 18% toward the >30% target; cuts parent-context bloat (and downstream $) on the heaviest-cost session class (multi-file scaffolds done inline).

### 4 · Real-tool batching examples + tool-description leadership (conf 0.80)
**Evidence.** Parallel/serial ratio **0.127** despite explicit directive. Current system-prompt example uses a fictional `example_complex_tool` — models pattern-match to examples, not abstractions.
**Action.** (a) Replace the fake-tool example with 2-3 real-tool examples: parallel `Read × 3`, `Grep + find_files + Read` for exploration, multi-command `ctx_batch_execute`. Annotate each "independent → one block." (b) Edit descriptions of `ctx_batch_execute`, `fff_multi_grep`, `web_search` to lead with the batch use-case and add "Prefer this over single-call X when you have ≥2 independent items." (c) Add to `ctx_execute` description: "For ≥2 independent commands, use `ctx_batch_execute` instead."
**Outcome.** Lift parallel/serial ratio from 0.127 toward 0.25+; cut wall-clock latency on read-heavy turns.

### 5 · Verify prompt caching is on the stable prefix (conf 0.75)
**Evidence.** This session's system prompt alone (skills + AGENTS.md + tool descriptions) is ~30 KB and is identical turn-over-turn within a session. 385 sessions × multi-turn × 30 KB ≈ a meaningful share of $1,951 if NOT cached.
**Action.** Audit pi's Anthropic client wrapper for `cache_control: {type:'ephemeral'}` on the stable system-prompt block and the skills/AGENTS.md region. Add a regression test asserting prefix-hash stability across turns. If absent, enable.
**Outcome.** If currently off: ~90% cut on cached-prefix input cost — plausibly 20-40% of total $1,951. If on: confirms and closes the question.

### 6 · Block interactive-TTY Bash commands (conf 0.78)
**Evidence.** "sudo: a terminal is required to read the password" loop pattern across bash's 271 errors (5.6% rate). Loop shape (repeat-until-timeout) is a harness affordance bug — the failure looks like "no output" rather than "needs TTY", so the model retries.
**Action.** Pre-flight Bash commands against a deny/needs-TTY list (sudo without `-n`, ssh interactive, vim, less without piping). Return a structured error naming the cause ("requires TTY; rerun with `sudo -n` or pipe input") instead of letting the process hang.
**Outcome.** Removes a contributor to both the 681 failed-retries and long-session tail durations.

### 7 · Fuzzy-fallback Edit oldText anchoring (conf 0.82)
**Evidence.** Edit's 6.3% error rate is dominated by "oldText not unique / not found" — usually whitespace / CRLF drift, or anchoring against a stale Read cache after another tool mutated the file. The Read-retry-after-Edit pattern is the signature of anchor staleness, not the model picking bad anchors.
**Action.** Two-tier match: exact first, then whitespace-normalized (CRLF/LF, trailing whitespace, tab/space drift). Accept only if exactly one normalized candidate; otherwise return the candidate list for disambiguation. Hook write tools to bump a per-path version counter that invalidates Read caches.
**Outcome.** Cuts Edit-retry-after-Read churn — contributor to both failed-retries (681) and dup-arg Reads (subset of 537).

### 8 · Per-session telemetry ledger (conf 0.90)
**Evidence.** This very analysis ran on aggregate-only data; per-session cost histogram, model/tier distribution, task-class breakdown, per-error-cluster counts, and per-session orchestration ratios are *not* in the corpus. Every recommendation below 0.85 confidence carries residual uncertainty for this reason.
**Action.** Cost-and-orchestration hook appending JSONL to `~/.pi/telemetry/{cost,orchestration}.jsonl`: `{session_id, task_class, tool, model, input_tokens, output_tokens, cached_tokens, cost_usd, ts}` plus per-session rollup `{write_n, edit_n, bash_mutate_n, subagent_n, async_n, workflow_n, ratio}`. Ship `pi cost` and `pi sessions analyze --orchestration` CLIs. Local-only, opt-in for any upload.
**Outcome.** Converts ≥10 second-tier items from "directional 0.55-0.75" to measured numbers within a week of new data. Indirect impact but the highest-leverage *enabler*.

### 9 · Hard tool-call ceiling at p99 (conf 0.78)
**Evidence.** p99 = 258 tool calls; max = **414**. The ~60% gap above p99 is the long tail consistent with runaway loops, not legitimately large jobs. Reinforced by the failed-retry + dup-arg counts concentrating in those same sessions.
**Action.** Circuit-breaker at ~260 calls: inject a synthetic system turn forcing summarize-to-disk → declare remaining work as todos → hand off to a fresh-context continuation that inherits the digest. Non-destructive. Exempt sessions whose recent N calls show diverse tool/arg signatures.
**Outcome.** Bounds worst-case session $. Capping the max-414 sessions at ~260 with handoff trims ~150 calls × avg-cost from the worst sessions — disproportionate $ impact on the long-tail.

### 10 · Flip `subagent` async to default true (conf 0.72)
**Evidence.** Of subagent-using sessions, only 11/18 ≈ 61% used async. ~40% of delegations block the parent despite AGENTS.md saying "Foreground is the explicit opt-out, not the default." `workflow` already defaults `background: true` — precedent exists.
**Action.** Flip schema default of `async` in the subagent tool definition. Update the system-prompt guideline that currently says `async (default: false)`. One release of dual-default migration behind a config flag.
**Outcome.** Moves toward AGENTS.md's prescribed posture; reduces parent-session context bloat on the 40% currently blocking. Compounds with #3.

---

## Second tier (conf 0.55-0.78, ship after #8 makes them measurable)

- **Default new workflow agents to medium tier; require opt-in for big.** (conf 0.55) — Plausible mechanism, no tier-distribution evidence yet.
- **Hard per-session $ budget with graceful tier degradation.** (conf 0.60) — Long-tail cost shape is inferred; #8 will calibrate thresholds.
- **Mandatory `ctx_execute` / `ctx_batch_execute` for tool outputs >20 lines.** (conf 0.70) — Promote context-mode routing from advisory to default-on for new installs.
- **Per-session subagent : Write ratio in TUI status line.** (conf 0.70) — In-loop visibility nudge; precedent in todo lists working.
- **Promote named recipes (`/parallel-review`, `/review-loop`, etc.) to first-class slash commands / saved workflows.** (conf 0.78) — Workflow=0% says the `workflow` tool's authoring surface is too expensive on demand.
- **Fix the context-mode active-banner to mention subagent precedence.** (conf 0.74) — One-line change at injection time; per-turn banner beats per-session doc.
- **Auto-upgrade detection + structured "outdated" result for ctx_\*.** (conf 0.74) — Outdated-version warning appears in every ctx_* error.
- **MCP timeout retry-with-backoff at the harness layer.** (conf 0.70) — Transparent retry + circuit breaker instead of bubbling opaque timeouts.
- **`ask_user_question` field-level error locality** instead of whole-questionnaire reject. (conf 0.76) — 22.4% error rate is largely schema-validation churn.
- **Sliding-window context compactor triggered by call density**, not just tokens. (conf 0.70)
- **Turn-scoped snapshot for goal + standing-orders state** (fixes GOAL-STALE in-turn bouncing). (conf 0.78)
- **Per-turn batching detector** with system-reminder feedback. (conf 0.62)
- **Auto-fanout escalation at p95 tool-call mark.** (conf 0.60)
- **Chrome-extension liveness probe with degrade to fetch_content + direct API.** (conf 0.62) — chrome_tab 53% err, chrome_evaluate 27% err.
- **Explicit `/tempo-mode` opt-in** with end-of-session "what should have been orchestrated" report. (conf 0.55)
- **Planning-prompt convention:** emit "Parallel set: {tools}" before each tool block. (conf 0.58)

---

## What I (the user / pi-using human) should do differently

These are usage-side, not harness-side.

1. **Use `workflow` / `subagent`-async on multi-file work.** The corpus literally shows zero workflow calls and 11% async — *I* am the user across most of these sessions. The AGENTS.md HARD RULE was added because of exactly this pattern; treat it as a contract until #3 lands as a runtime gate.
2. **Stop saying "go ahead" / "just ship it" to skip orchestration.** Standing orders explicitly call out conversational tempo as the bypass that's not supposed to work. Whether or not the harness gates it tomorrow, give the agent an actual mandate to delegate.
3. **Run `/ctx-upgrade` and `/ctx-doctor` periodically.** Outdated context-mode is a contributor to disk-I/O and MCP-timeout errors. The warning was visible in essentially every ctx_* error in the corpus.
4. **Stop debugging chrome-extension flakiness inside a coding session.** The $106 `test pi chrome` session is the single most expensive session in the corpus, with the highest dup-arg count, highest failed-retry count, and the loop never converged. The right move when the extension is broken is to file a fix, not iterate against it inside an agent loop.
5. **For long investigative sessions, dispatch a planner subagent at ~p90 (90 tool calls)** rather than waiting for the harness to enforce it. The implementation-notes 414-call session is the only one in the corpus that hit `length` stopReason; a midway re-plan would have averted it.

---

## Meta-notes / what would tighten this further

- The aggregate JSON has the per-session rows but I deliberately *did not* sample raw user prompts or tool arguments beyond the first 200 chars (privacy posture). A per-task-class breakdown (feature / refactor / debug / conversation) would let us size #3, #4, #9 precisely. Easiest path: cluster the `firstUserPrompt` field in `sessions_summary.json` by topic.
- We do not yet know whether prompt caching is on (#5 collapses to a no-op if it is).
- 90 turns ended with `stopReason="error"` and 30 with `aborted`; those are worth a separate pass to see if they cluster on specific tools/models.
- The corpus is 94% `claude-opus-4-7`. Per-task tiering (Haiku for grep/read fan-out, Sonnet for synthesis, Opus only for judgment) is plausibly the largest single $ cut available *after* prompt caching is verified, but lacks evidence here.

## Artifacts produced

- `analyze.js` — JSONL walker, per-session metric extractor.
- `sessions_summary.json` (~825 KB) — per-session rows with tool counts, errors, costs, friction signals.
- `aggregate.json` — cross-corpus rollups, top-N session lists.
- `evidence_pack.md` — distilled signal pack fed to the workflow.
- `FINDINGS.md` — this file.

Workflow run: `pi_sessions_optimization`, 7 agents, 392,566 tokens / $2.89 — 6 specialists in parallel + 1 synthesizer.
