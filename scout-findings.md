# pi-lookback schema-leak map (for CC source adapter)

## 1. pi-specific `type` / `kind` references outside parser.js

| file:line | type / kind | usage |
|---|---|---|
| src/parser.js:36-37 | `type === 'session'` | line consumed as `sessionMeta`, NOT added to entries |
| src/parser.js:64,80,98,118,127,135,143,151,160,168 | dispatches all pi types into `kind: user/assistant/toolResult/bashExecution/compaction/branch_summary/model_change/thinking_level_change/custom/custom_message/label/unknown` |
| src/summary.js:46-64 | switch on `e.kind`: counts user, assistant, toolResult(isError), **bashExecution** (count + failedBash), **compaction**, **model_change**, **thinking_level_change**, **custom / custom_message** |
| src/signals.js:23-26 | per-entry: `toolResult.isError`, `bashExecution.exitCode`, `assistant.stopReason`, `toolResult.outputBytes`, `toolResult.truncated` |
| src/signals.js:42 | `bashExecution.exitCode !== 0` → `repeated_failed_command` (cmd-keyed) |
| src/signals.js:51 | `user.text` → CORRECTION_RE |
| src/signals.js:60 | `assistant.toolCalls` → long_no_tool_stretch |
| src/signals.js:71 | iterates `e.cost` (assistant only) → high_cost |
| src/signals.js:79-89 | `parentId` graph → branch_heavy; `kind === 'compaction'` → compaction_heavy |
| src/signals.js:94-101 | `bashExecution.command` regex + `toolResult.toolName` `^(write|edit)$` → verification_missing |
| src/api.js:166 | strips `raw`, truncates `text/output/thinking` (assumes those field names) |
| src/api.js:181 | search hay: `firstPrompt, cwd, projectPath, id, models` |
| src/api.js:205-218 | entry hay: `text, thinking, toolName, command, output, summary, toolCalls[*].{name,arguments}` |
| src/export-html.js:17-35 | renders branches: user / assistant / toolResult / bashExecution / compaction / model_change / thinking_level_change / custom / custom_message; else dumps JSON |
| public/app.js:175-185 (treeLabel) | branches on: user, assistant, toolResult, bashExecution, compaction, model_change, thinking_level_change, custom, custom_message |
| public/app.js:198-228 (entryHtml) | branches on: user, assistant, toolResult, bashExecution, compaction, **branch_summary**, model_change, thinking_level_change, custom, custom_message |
| public/app.js:166 | tree branch-count via `e.parentId` |
| public/app.js:259-273 (renderInspector) | hard-coded per-kind field layouts (assistant: provider/api/stopReason/responseId; bashExecution: cancelled/excludeFromContext; compaction: tokensBefore/firstKeptEntryId/fromHook) |
| public/app.js:155-156 | error filter: `toolResult.isError` OR `bashExecution.exitCode !== 0 && !== null` |
| test/parser.test.js | asserts kinds: user, assistant, toolResult, bashExecution, compaction, unknown |
| test/api.test.js:68-73 | asserts kinds `user/assistant/toolResult` and `unknown` |

Pi-only `kind`s never seen in CC corpus: **bashExecution, compaction, branch_summary, model_change, thinking_level_change, custom, custom_message, label**.

## 2. pi-specific field names

| field | who reads it | CC equivalent |
|---|---|---|
| `raw.id` → `entry.id` | parser.js:52; summary.js:35; signals.js:81; api.js (loadParsedById, getEntryRaw, search by id); app.js (selectEntry, data-id, treeLabel keying) | CC: `uuid` |
| `raw.parentId` → `entry.parentId` | parser.js:53; summary.js:39-41 (branchCount); signals.js:81-83 (branch_heavy); app.js:166 (tree); app.js:259 (inspector display) | CC: `parentUuid` |
| `obj.type === 'session'` header line | parser.js:36; consumed → `sessionMeta` | CC has **no header line**; every entry carries `sessionId`, `cwd`, `version`, `gitBranch` |
| `sessionMeta.id` | summary.js:95 (session id), api.js fallback | derive from filename or first entry's `sessionId` |
| `sessionMeta.timestamp` | summary.js:10 (startedAt) | use entries[0].timestamp |
| `sessionMeta.cwd` | summary.js:81,99; api.js:65 (errorSummary cwd); referenced in search hay | per-entry `cwd` |
| `sessionMeta.version` | unused (never read) | n/a |
| `m.role === 'bashExecution'` & `m.role === 'toolResult'` | parser.js:80,98 | pi-specific: pi nests bash + toolResult as message subroles; CC uses content-block `tool_use` / `tool_result` directly inside user/assistant messages |
| `m.usage.cost.total`, `m.usage.totalTokens` | parser.js:73-74 | CC usage shape differs (no `.cost.total`; tokens fields are input/output/cache_*) |
| `m.provider`, `m.api`, `m.stopReason`, `m.responseId` | parser.js:69-77; app.js inspector | CC has different names (`stop_reason`, `id` on inner message, no `provider`/`api`) |
| scanner.decodeProjectDir: `--Users-anishthite-...--` | scanner.js:36-44; summary.js:80-81 | CC encoding is `-Users-anishthite-...` (no surrounding `--`, similar but distinct) |

## 3. De-facto normalized entry interface (what consumers actually read)

Every entry MUST have: `id`, `parentId`, `timestamp`, `kind`, `raw`.

Per-kind required surface (union, drawn from summary+signals+api+app+export):

- **user**: `text` (string), `tokens` (number)
- **assistant**: `text`, `thinking`, `toolCalls[]={id,name,arguments}`, `model`, `provider`, `api`, `usage`, `cost`, `totalTokens`, `stopReason`, `responseId`
- **toolResult**: `toolName`, `toolCallId`, `isError`, `text`, `outputBytes`, `truncated`, `fullOutputPath`, `details`
- **bashExecution**: `command`, `output`, `outputBytes`, `exitCode`, `cancelled`, `truncated`, `fullOutputPath`, `excludeFromContext`
- **compaction**: `summary`, `firstKeptEntryId`, `tokensBefore`, `fromHook`, `details`
- **branch_summary**: `fromId`, `summary`, `details`
- **model_change**: `provider`, `modelId`
- **thinking_level_change**: `thinkingLevel`
- **custom / custom_message**: `customType`, `content`/`data`, `display`, `details`

Parsed-file envelope: `{ entries, parseErrors, sessionMeta, filePath }` — consumers (summary, api, signals) all destructure `sessionMeta` and `parseErrors`.

## 4. Hard-coded paths / config flow

| location | value |
|---|---|
| src/scanner.js:8 | `DEFAULT_ROOT = ~/.pi/agent/sessions` |
| src/scanner.js:10-12 | env `PI_SESSIONS_DIR` overrides default |
| src/api.js:14 | `SESSIONS_ROOT = defaultSessionsRoot()` module-level |
| src/api.js:16-22 | `setSessionsRoot(root)` clears caches |
| server.js:22 | `--sessions <dir>` CLI flag |
| server.js:153 | `if (opts.sessions) api.setSessionsRoot(opts.sessions)` |
| test/api.test.js:33; test/metrics.js | call `api.setSessionsRoot(...)` for fixtures / real root |
| scanner.js:18-32 | `listSessionFiles` recursively scans for `*.jsonl` — directory shape agnostic, fine for CC |
| scanner.js:36-44 | `decodeProjectDir`: pi's `--a-b--` ↔ `/a/b` convention. **Pi-specific.** |

There is currently ONE sessions root globally. No multi-source plumbing.

## 5. Fixtures

| fixture | covers |
|---|---|
| simple-linear.jsonl | model_change + user + assistant (no tools); baseline |
| tool-success.jsonl | assistant toolCall + toolResult (isError=false) |
| tool-error.jsonl | toolResult `isError=true`; ENOENT text (search target) |
| bash-failure.jsonl | 2× same failing bashExecution (exitCode≠0) → repeated_failed_command |
| branching.jsonl | one entry has 3 children via parentId → branchCount=1 |
| compaction.jsonl | 2× compaction events → compaction_heavy signal |
| huge-output.jsonl | toolResult outputBytes > 50KB + truncated=true |
| unknown-entry.jsonl | unknown `type` → forward-compat fallback |
| corrupt.jsonl | malformed JSON lines → parseErrors |

All start with a pi `{"type":"session",...,"cwd":"/tmp/fixt"}` header line.

## 6. Test gates that will need CC parallels

**parser.test.js** — needs CC counterparts for: parses w/o errors, tool call/result counts, branch detection via parentUuid, unknown type tolerance, corrupt-line tolerance. The bash-failure / compaction / model_change / huge-output / truncated cases have **no direct CC analogue** — CC tool-results carry the bash output, no compaction events, no model_change events.

**api.test.js** — gates:
- M-style assertions on summary field names (`failedToolCallCount`, `branchCount`, `compactionCount`, `bashCommandCount`, etc.) — these fields are **emitted regardless of source**; for CC they'll just be 0 unless we re-map.
- `kinds.has('user') && kinds.has('assistant') && kinds.has('toolResult')` — passes for CC if we map tool_use/tool_result to those kinds.
- `fixt-tool-error`, `fixt-huge-output`, `fixt-unknown` looked up by id — would need CC fixtures with synthesized ids.

**metrics.js** — gates depending on pi semantics:
- M2 (parse ≥98%) — source-agnostic.
- M3 / TC (every parsed entry rendered) — source-agnostic if adapter normalizes.
- M5 (failed signal) — CC has no `bashExecution`; failed_tool only.
- M8 (≥5 signal kinds) — at risk for CC-only corpus because failed_bash / compaction_heavy / verification_missing(bash regex) likely never fire.
- SF (failed-tool detection completeness) — depends on `toolResult.isError` flag mapping.

## 7. Signals: pi-specific vs source-agnostic

| signal | source | trigger |
|---|---|---|
| failed_tool | **agnostic** | `toolResult.isError` (adapter must set) |
| failed_bash | **pi-only** | `kind==='bashExecution' && exitCode!==0` |
| aborted_assistant | borderline | `assistant.stopReason in {error,aborted}` — CC has `stop_reason` but different values |
| huge_output | **agnostic** | `toolResult.outputBytes > 50KB` |
| truncated_output | **agnostic** | `toolResult.truncated` flag (CC has none; adapter would synthesize) |
| repeated_failed_command | **pi-only** | bashExecution.command + exitCode |
| user_correction | **agnostic** | regex on `user.text` |
| long_no_tool_stretch | **agnostic** | `assistant.toolCalls.length` |
| high_cost | **agnostic** but **breaks** | `e.cost` summed; CC has no `.usage.cost.total` → totalCost=0 → never fires for CC |
| branch_heavy | **agnostic** | parentId graph (adapter must map `parentUuid`) |
| compaction_heavy | **pi-only** | `kind==='compaction'` |
| verification_missing | **mostly pi** | requires bashExecution + toolName regex; CC has no bashExecution |

## 8. public/app.js renderer branches

`entryHtml` (lines 198-228) renders these `kind`s:
1. **user** → `text`
2. **assistant** → thinking, text, toolCalls[], model/totalTokens/cost/stopReason
3. **toolResult** → toolName, isError badge, outputBytes, text
4. **bashExecution** → command (terminal block), exitCode, cancelled, truncated, output
5. **compaction** → tokensBefore, firstKeptEntryId, summary
6. **branch_summary** → fromId, summary
7. **model_change** → provider/modelId
8. **thinking_level_change** → level
9. **custom / custom_message** → customType + content/data details
10. else → JSON dump

`treeLabel` (lines 175-185): same kinds minus branch_summary (falls through to default).

`renderInspector` (lines 259-273): hard-coded per-kind key/value sections — adding new source-specific kinds means extending this switch.

## Start here
**src/parser.js** — it is the *only* place where raw shape is read; every consumer downstream consumes the normalized `{id, parentId, kind, ...}` envelope. An adapter that produces the same envelope (plus `sessionMeta`) makes 80% of the pipeline source-agnostic. The remaining leaks are: `decodeProjectDir` (scanner.js:36), `bashExecution`/`compaction`-specific signals (signals.js:24-43, 79-101), and renderer branches in app.js + export-html.js that won't crash on missing kinds but won't be useful either.
