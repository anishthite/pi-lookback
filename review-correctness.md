# Adversarial correctness review — Claude Code source adapter

Scope: `src/sources/claude-code.js`, `pricing.js`, `signals.js`, `summary.js`, `sources/index.js`, and the cc fixtures. Verified by static read; tests intentionally not relied upon.

---

## Multi-shard assistant rollup (R4)

- **Correct — late-shard usage is honored.** `buildShardState` keys on `message.id`, recording `firstUsageByMsgId` lazily as it walks. If shard 1 lacks `usage` and shard 2 carries it, shard 2 wins `keepUsage=true`. `src/sources/claude-code.js:185-205`. The "first shard with usage" semantic, not "first shard unconditionally", is implemented.
- **Correct — non-adjacent shards.** Registry is map-keyed on `message.id`, not adjacency. Gap-tolerant.
- **Correct — `buildSessionSummary.totalTokens`.** Only sums `e.totalTokens`, which is null on non-usage shards (`src/sources/claude-code.js:330-336`). `signals.high_cost` uses `e.cost` which is gated by `usage` → null on non-usage shards. No double-count path observed.

Section clean.

---

## Tool-pair correlation

- **Note (minor) — `toolUseResult`-only result blocks are dropped.** CITE `src/sources/claude-code.js:354-369` (`normalizeUserEntry`). `extractToolResultBlocks` only walks `message.content[]` for `type==='tool_result'`. If a Task/subagent result ever ships with `raw.toolUseResult` populated but **no** `tool_result` block in `message.content[]`, the result is silently dropped (the line becomes a plain `user` text entry). In the live corpus the canonical Task result still carries both, so this is theoretical, but the plan §2.6 says "look in `message.content[]` AND in `toolUseResult`" — only the first is done. FIX: if `toolResultBlocks.length === 0 && raw.toolUseResult?.tool_use_id`, synthesize a single tr-shaped object from `toolUseResult` and feed it through `buildToolResultEntry`.
- **Major — `server_tool_use` / `web_search_tool_result` leak.** CITE `src/sources/claude-code.js:170-181` (`buildToolUseRegistry`) only registers `part.type === 'tool_use'`; `decomposeAssistantContent` at `:540-553` only emits `toolCalls` for `tool_use`. EVIDENCE: an assistant message containing `{type:'server_tool_use', id:'srvtool_…', name:'web_search', input:…}` followed by `{type:'web_search_tool_result', tool_use_id:'srvtool_…', content:[…]}` (schema §5 deviation 2) produces an assistant entry with empty `toolCalls`, no `toolResult` entry, and no `parseErrors`. Telemetry vanishes. FIX: accept `'server_tool_use'` in registry/decompose and `'web_search_tool_result'` (and `'mcp_tool_result'`) in `extractToolResultBlocks`.
- **Correct — orphan `tool_use`.** Registry retains, no result emitted; assistant entry still carries `toolCalls`. No crash.
- **Correct — orphan `tool_result`.** `paired=null` path at `:454-459` pushes a `parseError` and emits a `toolResult` with `toolName: null`. Verified the parseError IS written to `ctx.parseErrors` before the entry is built.
- **Note (minor) — registry crosses sidechain boundaries.** A `tool_use_id` from a sidechain branch can be matched by a main-thread `tool_result` (or vice versa) because `buildToolUseRegistry` is global. tool IDs are unique in practice, so harmless, but the synthesized result inherits sidechain from the *user* line's `isSidechain`, not from the pairing assistant. If the asymmetry ever occurs (sidechain tool_use, main-thread result), the result loses subagent provenance. FIX: store `isSidechain` on registry rows; copy onto synthesized entry when divergent.

---

## Bash exit-code heuristic (R3)

- **Major — regex misses the most common real failures.** CITE `src/sources/claude-code.js:33` `BASH_FAILURE_HINT_RE = /(^Error:|^Traceback|\bexit (?:status|code)\s+(?!0\b)\d+)/m`. Counterexamples that the heuristic must catch but doesn't:
  - `make: *** [target] Error 1` — leading `make:`, not `Error:`. Misses.
  - `bash: foo: command not found` — misses.
  - `Permission denied` — misses.
  - `npm ERR! code ELIFECYCLE` followed by `npm ERR! exit 1` — `exit 1` matches IF on its own token boundary; `exit 1` matches `\bexit (status|code)…` only when followed by `status` or `code`. So `exit 1` plain misses.
  - Python `SyntaxError: …` — only matches if `Error:` starts the line; `^SyntaxError: …` starts with `S`, so matches `^Error:`? No — `^Error:` requires the literal `E-r-r-o-r-:`. `SyntaxError:` does NOT start with `Error:`. Misses.
  EVIDENCE: the only failures the regex catches in practice are Python tracebacks and lines literally beginning with `Error:`. FIX: broaden to e.g. `/(^|\n)(?:Error[: ]|Traceback|.*\bcommand not found\b|.*\bpermission denied\b|.*\*\*\* .*\bError\b|exit (?:status|code)?\s*[1-9])/im`, and/or test stderr-only with a much looser rule.
- **Correct — interrupted beats isError.** `:498-500` checks `interrupted` first → `-1`, else `isError` → `1`. `cancelled: interrupted` is set unconditionally, so when both flags are true, `exitCode=-1, cancelled=true`. ✓
- **Correct — stdout and stderr both fed.** `output` concatenates both before the regex test at `:501`. ✓

---

## Compaction priority merging

- **Major — merged entry breaks the parent-child tree.** CITE `:285-292`, `:393-433`. When `system.compact_boundary` + `user.isCompactSummary` co-occur within ±2 lines, the user line is `consume`d (returns null from `normalizeEntry`). The merged compaction entry's `id`/`parentId` come from the **boundary's** `raw` (system msg), not the user's. Any subsequent entry with `parentUuid === <consumed user's uuid>` is now orphaned: its `parentId` points at no entry. `summary.branch_heavy` and tree renderers will produce phantom roots / mis-attributed branches. EVIDENCE: in a typical flow the boundary is parented to the user that triggered compact, and the *next* user message is parented to the `isCompactSummary` uuid — that next user becomes an orphan when the summary is consumed. FIX: either (a) emit two entries (boundary + consumed-user-as-passthrough) and only flag the boundary as `kind: 'compaction'`, or (b) keep an `aliasIdMap` and remap orphaned `parentId` references during normalize.
- **Note — ±2 is raw JSONL lines, not normalized entries.** Plan was ambiguous; the implementation uses `lineNo` (raw JSONL). Reasonable choice; document it. Multi-shard interleaving doesn't matter because shards aren't compaction.
- **Correct — top-level `summary` `parentId: null`.** `raw.parentUuid` absent → `parentId: null`. branch_heavy iterates `if (e.parentId)` only, so nulls don't pollute. ✓ But these summary entries still pollute `compactionCount`, and `compaction_heavy` threshold = 2; in CC sessions with multiple top-level summaries that aren't really compactions, signal may misfire. NOTE only.

---

## Sidechain flag propagation

- **Correct — synthesized toolResult/bashExecution inherits sidechain from the user line.** `base.sidechain = !!raw.isSidechain` at `:312`, propagated via `{ ...base, id, ... }` through `buildToolResultEntry`/`buildBashEntry`. ✓
- **Correct — survives multi-shard.** Each line carries its own `raw.isSidechain`; shard entries are independent.
- **Note (minor)** — see sidechain cross-pairing note in the tool-correlation section. Harmless given ID uniqueness.

---

## Session metadata last-wins

- **Correct — empty session.** `seed = rawObjects[0]?.obj || {}`; `cwd: lastCwd || seed.cwd || ''` → empty string. No crash. ✓
- **Correct — `lastModel` picks last model VALUE, not model from last assistant entry.** `:243` loops all assistants, assigns only when `obj.message?.model` truthy. A trailing shard without `message.model` doesn't clobber a prior one. ✓ Matches plan intent.
- **Correct — late `system.init`.** The init-scan loop breaks only when BOTH `init` and `firstUserOrAsst` are set (`:228`), so a `system.init` appearing after the first user/assistant is still found and `synthesized: false`. ✓

Section clean.

---

## Signals math under source-gating

- **Major (design) — `max_tokens` is not a failure.** CITE `src/signals.js:30-34`. Anthropic's `stop_reason: 'max_tokens'` is a normal "long output, hit the cap" terminator, often expected for thinking-heavy or large code-emit turns. Flagging it as `aborted_assistant` will produce false positives on legitimate long-form sessions and inflate the review score. Plan §3 added it, but it does not belong in the `{error, aborted, refusal}` cohort. FIX: drop `max_tokens` from the union.
- **Correct — `verification_missing` regex.** `/^(write|edit|multiedit)$/i` matches pi lowercase `write`/`edit` AND cc `Write`/`Edit`/`MultiEdit`. ✓
- **Note — `high_cost` silent on unknown models.** If pricing returns null for every model, `totalCost` stays 0 and signal never fires — exactly as plan §3.1 accepts. Acceptable per R1. The single `console.warn` per unknown model is the only observability; consider also incrementing a `pricing.unknownModelCount` accessible via summary.

---

## Pricing prefix matcher

- **Minor — `claude-opus-4-5` family hole.** CITE `src/sources/pricing.js:17-30`. PRICES has `claude-opus-4-5-20251101`, `claude-opus-4-7`, `claude-opus-4` but NO `claude-opus-4-5` row. `claude-opus-4-5-99999999` falls back to `claude-opus-4` (correct price by coincidence, since opus tiers share rates) but the plan §3.1 specifically cites `claude-opus-4-5` as the expected fallback target. Add it (and `claude-opus-4-5` mirror) for explicitness.
- **Minor — legacy `claude-3-5-sonnet-20241022` returns null.** `matchPrefix` loop walks: pop `20241022` → `claude-3-5-sonnet` not present; pop `sonnet` → `claude-3-5` absent; pop `5` → `claude-3` absent; stops at `parts.length === 2` (`claude-3`). Returns null → null cost → `high_cost` blind to Claude-3.x sessions. If any user has legacy CC sessions on disk this matters. FIX: add `claude-3-5-sonnet`, `claude-3-5-haiku`, `claude-3-opus` rows or document the cutoff.
- **Correct — null safety.** `costFor` early-returns null when `!model || !usage`; caller `normalizeAssistantEntry` only computes when `usage` truthy and tolerates `null` cost downstream. No dereference.

---

## Project-key decode (R6, §5)

- **Correct — always returns a string.** Edge cases:
  - `''` → `''`
  - `'-'` → `'/'`
  - `'--'` → `'/'`
  - non-string → `''`
  - normal `-Users-x-y` → `/Users/x/y`
  All return strings; no throw.
- **Correct — `summary.resolveProjectPath` lookup chain.** `:147-156` checks `sessionMeta?.cwd` first, then per-entry `e.raw?.cwd` (user/assistant only), then adapter decode. Per plan §5.2. ✓

Section clean.

---

## Summary of severity

| Sev | Finding |
|---|---|
| Major | `server_tool_use` / `web_search_tool_result` silently dropped (registry + decompose + extract) |
| Major | Bash failure regex misses the most common stderr shapes (make, command-not-found, permission-denied, plain `exit N`, `SyntaxError`) |
| Major | Compaction merge orphans children that parented to the consumed `isCompactSummary` user uuid |
| Major | `max_tokens` mis-classified as `aborted_assistant` (false positives on long-output turns) |
| Minor | Task-shape `toolUseResult`-only results dropped when no `tool_result` block present |
| Minor | Pricing table missing `claude-opus-4-5` row and all Claude-3.x rows |
| Minor | Top-level `summary` entries inflate `compactionCount` toward `compaction_heavy` threshold |
| Minor | Sidechain flag taken from user-line, not from the paired tool_use's source branch |

No blockers found. Multi-shard rollup, sidechain propagation, session-meta synthesis, and project-key decode are all clean. The merge-bug and bash-regex are the two with the highest user-visible impact; both have one-line fixes.

Bug count just exceeded coffee count — recommend equalizing before merge.
