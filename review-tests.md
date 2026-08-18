# Test-Coverage Review — Claude Code source adapter

Adversarial pass against `src/sources/claude-code.js`, `src/sources/pricing.js`, and their tests. Findings ordered by severity; closing section ranks highest-value additions.

Legend: **SEV** = severity (BLOCKER / HIGH / MED / LOW), **CITE** = location, **EVIDENCE** = what's actually there, **FIX** = concrete test (or impl) to add.

---

## Fixture realism

### F1 — Usage records are missing cache tokens entirely
- **SEV:** HIGH
- **CITE:** every `cc-*.jsonl` assistant entry; `test/sources-claude-code.test.js:55–61`
- **EVIDENCE:** Every fixture's `usage` is `{input_tokens, output_tokens}` only. No `cache_creation_input_tokens` / `cache_read_input_tokens` anywhere. Yet the *typical* live CC assistant turn has both populated, and `pricing.js:71–73` multiplies all four. The cost arithmetic on those two columns is therefore exercised **zero** times. The unit test at L60 (`(10*15 + 3*75)/1e6`) wouldn't catch a regression that, say, double-counted `cache_read_input_tokens` or applied `cacheCreation` price to `cacheRead` tokens.
- **FIX:** Either (a) update `cc-simple-turn` to include `cache_creation_input_tokens: 200, cache_read_input_tokens: 5000` and tighten the cost assertion, or (b) add a `pricing: costFor with all four token kinds` unit test.

### F2 — `tool_use.input` shapes are not faithful to real CC tools
- **SEV:** MED
- **CITE:** `fixtures/claude-code/cc-multi-tool-use.jsonl` line 1 (`Read` with `{path:"a.txt"}` — real schema is `{file_path, offset?, limit?}`); `cc-tool-success.jsonl` line 2 likely same.
- **EVIDENCE:** The adapter only reads `input.command` for Bash, so this is currently invisible; but the moment anyone adds `Read`/`Edit` introspection (offset/limit summaries, sidechain detection from Task input), the fixtures will mislead the test by passing with a fake key. The plan's §7 promised "realistic `input` shapes."
- **FIX:** Change `Read` inputs to `{file_path:"a.txt"}`; change `Task` input in sidechain fixture to `{description, prompt, subagent_type}`.

### F3 — `parentUuid` chains always link to previous line
- **SEV:** MED
- **CITE:** all fixtures.
- **EVIDENCE:** Every `parentUuid` is the immediately preceding `uuid`. The adapter doesn't actually require this, but no fixture exercises an out-of-order or branched chain (e.g., two assistant entries whose `parentUuid` both point at the same user — the `/fork`-style branch that the schema doc highlights). No `forkedFrom` field anywhere.
- **FIX:** Add `cc-branched-parents.jsonl` with two assistant entries sharing one user parent; assert `branchCount > 0` in the summary if pi-lookback computes one.

### F4 — `cwd` never changes mid-session; no fixture omits `cwd`
- **SEV:** MED
- **CITE:** `extractSessionMeta` in `claude-code.js:243` walks last-wins for `cwd`, but no fixture changes it mid-stream; no fixture omits it. The schema doc explicitly calls this out as a live-corpus reality.
- **FIX:** Add a fixture where line 1 has `cwd:"/a"` and line 5 has `cwd:"/b"`; assert `sessionMeta.cwd === "/b"` (last-wins). Also: one user entry with no `cwd` to confirm it doesn't blank the meta.

### F5 — No `isMeta:true` user entry, no `interrupted_message_id`
- **SEV:** LOW
- **CITE:** schema doc §3; absent from fixtures.
- **EVIDENCE:** `detectPromptType` doesn't branch on `isMeta`; if a future signal cares, regression is invisible.
- **FIX:** Optional follow-up fixture.

### F6 — Coverage of 18+ schema entry types is shallow
- **SEV:** MED
- **CITE:** `META_TYPES` set in `claude-code.js:38–55` lists 14 strings; only `queue-operation` has a fixture. `compact_boundary`, `microcompact_boundary`, `top-level-summary` get inline-string tests but no on-disk fixture; `file-history-snapshot`, `system.api_error`, `assistant.isApiErrorMessage`, `summary` (forward-compat), `progress`, `result`, `bridge-session` are entirely untested.
- **FIX:** Add at least one fixture exercising `system.init` (the supposed-canonical, "0% of live corpus" forward-compat path) so `sessionMeta.synthesized === false` is reached. Today no test asserts the `init` branch of `extractSessionMeta`; the entire `if (init) { return …}` block at `claude-code.js:251–266` is dead under the test suite.

---

## Assertion strength — 5 graded tests

| # | Test (line) | Grade | Why |
|---|---|---|---|
| 1 | `cc-simple-turn: parses without errors` (L31) | **Strong** | `eq(p.entries.length, 2)` + named id/parent linkage + `eq(p.entries[1].text,'hi there')` — would catch most regressions. |
| 2 | `cc-sidechain: flags sidechain entries` (L168) | **Weak** | `sub.length >= 3` — would still pass if a regression turned a 5-entry sidechain into a 3-entry one. Use `eq(sub.length, N)`. |
| 3 | `cc-multi-tool-use: …two toolResults emitted` (L130) | **Strong** | Pairs ids, names sorted, length-equal. Good. |
| 4 | `cc-bash-success: …no exitCode` (L142) | **Mixed** | `eq(b.exitCode, null)` is sharp; but the regression-passes-for-wrong-reason hazard: if a refactor stops emitting `bashExecution` entirely, the `assert(p.entries.every(e=>e.kind!=='toolResult'))` still passes vacuously. The `eq(bashes.length, 1)` immediately above does catch it — so this one's fine. |
| 5 | `cc-attachment: emits attachment_card` (L189) | **Weak** | `att.length===1`, then `Array.isArray(att[0].payload.skills)` — a regression that left `payload` untouched but stripped `subtype` would still pass the array check. Tighter: `eq(att[0].payload.skills.length, 2)` and `eq(att[0].payload.skills[0].name, 'emil-design-eng')`. |

### A1 — "Passes for the wrong reason" hazards
- **SEV:** MED
- **CITE:** `test/sources-claude-code.test.js:121` (`assert(p.entries.every((e) => e.kind !== 'failed_tool'), …)`) — there is **no** `failed_tool` kind in the adapter at all (it's a *signal* kind, not an entry kind). The assertion is structurally true on every conceivable parse. The intended check is `sigs.every((s) => s.kind !== 'failed_tool')` (which the very next test does correctly at L122 — but on the *original* line the predicate is over `p.entries`, which never carries `kind === 'failed_tool'`).
- **FIX:** Re-check L121; if intended on signals, swap to `sigs`.

### A2 — `cc-multi-shard` only verifies usage *count*, not which shard kept it
- **SEV:** LOW
- **CITE:** `sources-claude-code.test.js:183` — `withUsage.length===1`, `withUsage[0].cost > 0`.
- **EVIDENCE:** Doesn't verify *which* shard. A regression that picked the wrong shard (e.g. last instead of first) would pass.
- **FIX:** `eq(withUsage[0].id, '<second-shard-uuid>')` — pin to the shard the schema mandates (the one carrying `usage` in the JSONL).

---

## Edge-case gaps (highest yield)

### E1 — Empty `.jsonl` file (0 bytes)
- **SEV:** HIGH
- **CITE:** untested.
- **EVIDENCE:** `parseSessionText('')` → `rawObjects=[]` → `extractSessionMeta` returns synthesized meta with `id = basename`, `timestamp = null`. Likely doesn't crash, but `summary.js` / signals haven't been verified against it. No fixture, no test.
- **FIX:** `t('empty file: no crash, sessionMeta synthesized, entries empty')`.

### E2 — Blank-lines-only file
- **SEV:** MED
- **CITE:** untested. `parseSessionText` skips `!ln.trim()`, so this collapses to the empty case — but only one test would prove it.

### E3 — BOM at file start
- **SEV:** MED
- **CITE:** `fs.readFileSync(filePath, 'utf8')` retains the BOM; `JSON.parse('\uFEFF{…}')` throws. This becomes a parseError on line 1 and the entire session loses its first entry silently.
- **FIX:** Strip leading BOM in `parseFile`, OR add a test that documents/accepts the current behavior.

### E4 — `message.content` as a STRING on user entry
- **SEV:** LOW (handled, but barely tested)
- **CITE:** `cc-simple-turn.jsonl` line 1 is exactly this case (`content:"hello"`). The test at L37 (`eq(p.entries[0].text,'hello')`) does exercise it. ✓ Covered. Brief.

### E5 — `tool_result.content` as a STRING (not array)
- **SEV:** HIGH
- **CITE:** `collectToolResultText` `claude-code.js:480–483` handles it, but **no test exercises the string branch.** The schema doc confirms this shape is common.
- **FIX:** Add a fixture or inline test where `tool_result.content = "raw text"` (not an array of blocks); assert `text === "raw text"`.

### E6 — Two `tool_use` blocks with the same `id`
- **SEV:** MED
- **CITE:** `buildToolUseRegistry` is `Map.set` — second silently overwrites first. No warning, no parseError.
- **FIX:** Add a defensive test asserting current behavior (last-wins) and/or have the adapter push a parseError-style note when a collision is detected.

### E7 — Assistant with no `message.content` array (just model + usage)
- **SEV:** MED
- **CITE:** `decomposeAssistantContent` returns empty when `content` isn't an array. Untested. A live corpus pattern (final-shard of a multi-shard message often looks like this).
- **FIX:** Inline test asserting `text === ''`, `toolCalls.length === 0`, cost still computed from usage.

### E8 — `system` entry with unknown `subtype`
- **SEV:** LOW
- **CITE:** `buildSystemEntry` falls through to `{kind:'meta', metaType:'system'}`. Untested.

### E9 — `attachment.type` undefined
- **SEV:** LOW
- **CITE:** handled (`|| 'unknown'`). Untested.

### E10 — Out-of-order lines
- **SEV:** MED
- **CITE:** Adapter does **not** sort by timestamp; iteration is file order. The compaction-merge `±2 lines` window is *line-distance*, not time-distance, so out-of-order won't break compaction merging — but the timeline rendered in the UI will be incorrect. No test.

---

## Pricing tests

### P1 — Prefix-match path: **covered, narrowly.**
- **CITE:** `sources-claude-code.test.js:68` (`claude-sonnet-4-5-99999999` → `claude-sonnet-4-5`). ✓
- **GAP:** No test for *two-step* prefix walk (e.g., a model that needs to fall back twice to find a match). `matchPrefix` pops in a loop; only the one-step path is exercised.

### P2 — All four token kinds — **not covered.** See F1.

### P3 — `cost: null` flowing through `signals.high_cost` — **not covered.**
- **SEV:** MED
- **CITE:** `detectSignals` not exercised here with an unknown-model assistant entry.
- **FIX:** Test that a `mystery-model` assistant entry produces `entry.cost===null` and `detectSignals` does not throw or emit a malformed signal.

### P4 — `costFor` with malformed usage
- **SEV:** LOW
- The `null usage` case is tested (L81), but not `usage = {}` (all-zeros), not `usage = "stringly"` (defensive type guard exists). One test would close the loop.

---

## API tests (the 6 new in `test/api.test.js`)

### API1 — Source filter `?source=claude-code`: **good.**
- **CITE:** L118 asserts `every(s => s.source === 'claude-code')`. This *does* confirm pi is excluded. ✓

### API2 — Cache invalidation across sources: **not tested.**
- **SEV:** MED
- **CITE:** `api.js` cache layer isn't touched; no test writes/touches a cc file and reloads.
- **FIX:** Write a temp cc fixture, call `/api/sessions`, mutate the temp file (touch mtime), call again, assert the row reflects the change. (Or assert mtime-based cache key changes.)

### API3 — Search across mixed sources: **partially tested.**
- **CITE:** L130 finds `ENOENT` (pi-only string) when both roots are mounted. ✓
- **GAP:** No test for a string present in *both* corpora returning rows from both sources. No test that `?source=claude-code` *also* filters search results (only the library filter is exercised).
- **FIX:** `/api/search?q=…&source=claude-code` should return only cc hits.

### API4 — `setSessionsRoot` back-compat: **shallow.**
- **CITE:** L141 — just asserts `sources.has('pi')`. Doesn't enforce that the count matches `fixtures/` non-cc files.

---

## Metrics tests (`test/metrics.js`)

### M1 — M8-cc threshold: **correctly applied.**
- **CITE:** L142 `const M8_THRESHOLD = CLI.source === 'claude-code' ? 3 : 5;` ✓

### M2 — `--source` permutations: **partial.**
- The runner accepts `pi | claude-code | both`, but `run-all.js` invocations aren't shown to actually exercise `--source claude-code` and `--source both`. If CI only runs the default, the cc and both paths are dead code at gate-time.
- **FIX:** Verify `package.json` scripts (or `test/run-all.js`) invoke `metrics.js` thrice — once per source mode.

### M3 — Mixed-mode superset check: **missing.**
- **SEV:** MED
- **CITE:** No test asserts that `signalKindsTotal(both) ⊇ signalKindsTotal(pi) ∪ signalKindsTotal(claude-code)`. A regression that silently dropped cc signals from the mixed view would pass M8 (because pi alone exceeds 5).
- **FIX:** Add a meta-gate or a small test that mounts both, captures the kind set, and verifies it's a superset.

---

## Snapshot / UI regression

### U1 — No snapshot tests for new kinds
- **SEV:** HIGH
- **CITE:** `public/app.js`, `public/styles.css`, `export-html.js` all add new branches (`session_meta`, `attachment_card`, `error`, `snapshot`, `compaction`, `bashExecution`) but there is **no** test that exercises rendering. A renderer that throws on `kind==='compaction'` would not be caught by any test in the suite — `metrics.js` TC gate checks parser→API entry counts, not HTML output.
- **FIX:** Add `test/export-html.test.js` that runs `exportHtml` over every cc fixture and asserts (a) no thrown errors, (b) every entry's kind appears in the HTML output (string include check), (c) snapshot of structural element counts.

---

## Top 5 highest-value test additions

1. **`test/export-html.test.js`** (U1) — Render every cc fixture through `export-html.js`; assert no throws and that each `kind` produces a non-empty DOM fragment. **One file, ~50 lines, closes the biggest blind spot.**
2. **Pricing: all four token kinds populated** (F1, P2) — Update `cc-simple-turn` fixture with cache tokens and tighten the cost assertion; add `costFor: cache_creation + cache_read priced separately` unit test. **Catches a whole class of pricing-math regressions silently passing today.**
3. **Edge-case suite: empty file / BOM / tool_result.content-as-string / duplicate tool_use id** (E1, E3, E5, E6) — Four short tests using `parseSessionText` inline. **Each represents a real live-corpus shape unhandled today.**
4. **Source-aware search + cache invalidation** (API2, API3) — `/api/search?source=claude-code` filter + mtime-touch reload. **API contract is currently under-specified.**
5. **`system.init` path execution** (F6) — Add a fixture with a real `system.init` first line; assert `sessionMeta.synthesized===false` and that `tools`/`mcpServers`/`agents` arrays populate. **Currently the entire init branch of `extractSessionMeta` is dead under tests.**

---

## Summary

The suite is **structurally sound** (sniff routing, multi-shard, sidechain, compaction merging are all tested with sharp assertions) but **narrow**:
- Realism gaps in fixtures (cache tokens, tool input shapes, mid-session cwd) hide a real ~30–40% of the pricing/meta surface area.
- Several "passes for the wrong reason" assertions (`>= N` instead of `=== N`; one `kind !== 'failed_tool'` predicate on the wrong array).
- The UI renderer is entirely untested — the highest-leverage single addition.
- Source-aware behavior in `api` and `metrics` is asserted on positive shape only; negative-space and superset invariants are missing.

No BLOCKER-grade defects. The implementation looks careful; the tests just under-prove it.
