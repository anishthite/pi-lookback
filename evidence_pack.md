# Pi sessions — evidence pack

Corpus: 385 sessions under `~/.pi/agent/sessions`, raw 245 MB jsonl.
Total spend: **1.22 B tokens · $1,951.00** · 14,851 tool calls · 581 tool errors.

## Headline ratios (across all sessions)

| Metric | Value | Note |
|---|---|---|
| avg cost / session | **$5.07** | p50 $1.64 · p75 $5.44 · p90 $13.43 · p95 $19.71 · p99 $47.88 · max **$106.19** |
| avg tokens / session | 3,160,798 | |
| avg tool calls / session | 39 | p50 20 · p90 90 · p99 258 · max 414 |
| **parallel-batch / serial-tool turns** | **0.127** | 87% of tool turns fire ONE tool — system prompt explicitly says batch independents |
| **workflow tool calls (total, 385 sessions)** | **0** | tool exists, used zero times across entire corpus |
| **subagent calls** | 367 (2.5% of tool calls) | only **18%** of sessions used it at all |
| async subagent / subagent | 13% | AGENTS.md says "default posture: async parallel" — opposite |
| tool error rate | 3.91% | |
| dup-arg tool calls (exact replay) | 537 (3.6%) | wasted spend, concentrated in long sessions |
| failed retries (err then same tool ≤3 calls) | 681 | retries/err = 1.17 |
| sessions on `claude-opus-4-7` | 361 / 385 (94%) | virtually no model tiering |
| ask_user_question error rate | 22.4% | (47/210) |
| chrome_evaluate / chrome_tab error rate | 27% / 53% | |

## Tool usage (top 12 by call count)

```
4818 bash         5.6% err
2816 read         0.5% err
1525 edit         6.3% err
1462 todo         1.2% err
1236 write        0.2% err
 799 ctx_execute  6.3% err
 367 subagent     0.5% err
 344 grep         0.9% err
 230 ls           0.4% err
 210 ctx_batch_execute  6.7% err
 210 ask_user_question  22.4% err
 126 ctx_execute_file   4.0% err
```

## Stop reasons (assistant turns)
- `toolUse` 12,126
- `stop`    1,384
- `error`   90  ← model itself errored mid-turn 90 times
- `aborted` 30
- `length`  1

## Top cost-burn sessions

| $ | tokens | tool calls | first user prompt (truncated) |
|---|---|---|---|
| 106.19 | 35.6M | 317 | test pi chrome, does it work? |
| 85.25  | 15.7M | 122 | i want to do the same for claude code. should we extend it for this … |
| 77.11  | 55.0M | 414 | look at the implementaiton notes, use any subagents you ened to, and continue to … |
| 47.88  | 35.6M | 216 | ok, so make a plan for a nice sticky note style board … |
| 45.14  | 36.7M | 136 | help me understand how our subscription works … |

## Top "duplicate-args" sessions (exact tool+args repeated)

```
89 dup / 317 tc — test pi chrome, does it work?
77 dup / 414 tc — look at implementation notes, use subagents …
36 dup / 188 tc — look at implementation notes …
25 dup / 219 tc — worktree checkout origin/anish/retention-policy …
21 dup / 149 tc — zuma game for mothers day …
```

## Top failed-retry sessions

```
37 retries / 38 errs / 317 tc — test pi chrome
30 retries / 30 errs / 414 tc — look at implementation notes
22 retries / 14 errs / 219 tc — worktree checkout (tool kept loop-failing)
17 retries /  6 errs / 115 tc — git stage/unstaged tests
16 retries /  8 errs / 138 tc — make mobile app like desktop
```

## Recurring error patterns (sampled from raw error text)

**bash** (271 errs, 5.6%): dominant pattern is permission/auth:
- `sudo: a terminal is required to read the password` — repeated dozens of times. We do not have a passwordless sudo path; bash invocations that need root just loop and fail.
- `security: SecKeychainSearchCopyNext: The specified item could not be found` — keychain probes failing.
- Directory listing fallbacks when a path doesn't exist (cheap, but adds noise).

**edit** (96 errs, 6.3%): predominantly "oldText not unique" / "oldText not found" — model picked a non-unique anchor.

**ctx_execute / ctx_batch_execute** (50 + 14 errs):
- `Runtime error: disk I/O error` — context-mode SQLite I/O failing repeatedly.
- `MCP request timeout after 120000ms: tools/call` and `MCP server has exited` — MCP layer crashed.
- `⚠️ context-mode v1.0.136 outdated → v1.0.151 available. Upgrade: /ctx-upgrade` appears in basically every ctx_* error — we ignored 15 minor-version upgrades.

**ctx_fetch_and_index** (8 errs, 17.8%): HTTP 404 / fetch failures on docs URLs the model guessed.

**ask_user_question** (47 errs, 22.4%): structural validation failures (label > 60 chars, duplicate `Other` row, etc.) — the schema is strict and the model doesn't always respect it.

**chrome_tab / chrome_evaluate** (10/19, 32/119): extension is genuinely flaky.

## Orchestration adoption

- 70 / 385 sessions (18%) called `subagent` even once.
- 41 / 385 sessions (11%) called subagent with `async: true`.
- 0 / 385 sessions called the `workflow` tool.

This is despite explicit standing instructions in `~/.pi/agent/AGENTS.md`:
> Default posture: async parallel. … For any task that meets the HARD RULE definition of a multi-file change, subagent delegation sits above context-mode's hierarchy.
> Self-grading: ratio of `subagent` calls to direct `Write`/`Edit`/`Bash`-mutate calls should be >0.30. If <0.10, you defaulted to plowing through — flag it.

Actual cross-corpus ratio: subagent / (bash + edit + write + read) = 367 / 10,395 = **0.035** — almost 10× under the floor.

## Parallel-batching gap

11,500 tool-using assistant turns:
- 1,364 multi-tool turns (12%) — agent batched calls.
- 10,769 single-tool turns (88%) — most independent calls were issued one at a time.

The system prompt explicitly says: "If you intend to call multiple tools and there are no dependencies between the calls, make all of the independent calls in the same `<function_calls>` block."

## Goal-loop friction (this corpus)
- 26 explicit goal-checkpoint events captured.
- Real "GOAL STALE" preambles appear in active sessions but the custom_message channel they ride on isn't surfaced in metrics — same-turn double-checkpoint pattern means the model bounces "yielding" / "resuming" within a single user turn.

## Notable single-session pathologies
- `test pi chrome` session: 317 tool calls, $106, 89 exact-duplicate calls, 37 failed retries — the model loop-tried chrome extension calls that the extension itself was returning errors for.
- 414-tool-call session: hit context length once (the single `length` stopReason in the whole corpus is in this neighborhood) and never used a sub-agent to split work.
