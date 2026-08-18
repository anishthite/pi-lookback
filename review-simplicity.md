# Simplicity Review — Claude Code source adapter

Adversarial pass. Format: SEVERITY / CITE / EVIDENCE / FIX.
Bias toward "minor"/"nit". 5 findings worth doing, a few non-findings flagged at the bottom.

---

## 1. minor — `parser.js` back-compat shims are unused

**CITE:** `src/parser.js:43-52`, `src/sources/pi.js:307-310`

**EVIDENCE:** `parser.js` re-exports `normalizeEntry` and `parseSessionText` "so callers that imported these from parser.js keep working." Grep across `src/` and `test/` shows the only consumer of `parser.js` is `parseSessionFile` (4 import sites: `src/api.js:17`, `test/parser.test.js:7`, `test/metrics.js:20`, `test/sources-claude-code.test.js:8`). The tests that touch `parseSessionText`/`normalizeEntry` reach into `src/sources/claude-code.js` and `src/sources/pi.js` directly — never through the parser shim. So lines 44-50 are speculative back-compat for a caller that doesn't exist.

**FIX:** Delete the two shim functions and their export entries. `parser.js` shrinks to ~25 LOC (a thin dispatch shim, as the plan originally targeted). The plan literally said "30 LOC."

---

## 2. minor — dead/unread fields on the normalized envelope

**CITE:** `src/sources/claude-code.js:404-405` (`messageId`, `shardOf` on assistant); `src/sources/pi.js:140-141` (same pi-side, set to null); `src/sources/claude-code.js:241-256` (`sessionMeta.synthesized`).

**EVIDENCE:** Grep for downstream readers:

- `shardOf` — set on every assistant entry, **read by zero consumers** (`src/summary.js`, `src/signals.js`, `src/api.js`, `public/app.js`, `src/export-html.js` — no matches). Plan §2.4 admits the UI use is "out of scope … deferred to L-followup."
- `messageId` on assistant — set to `m.id`, which is also stored verbatim in `responseId` on the same entry. Inspector at `public/app.js:441` reads `responseId`, never `messageId`. The only place `messageId` is read is on the **snapshot** kind (`public/app.js:387`, `src/export-html.js:55`, inspector `:454`) — that's a different field on a different kind.
- `sessionMeta.synthesized` — set to `true` for 100% of the user's live corpus (no `system.init` ever appears, per progress.md + corpus probe). **Not branched on anywhere** in summary, api, signals, or renderer.

**FIX:** Either (a) drop `shardOf` and `messageId` from the assistant envelope until the deferred shard-collapsing UI ships, or (b) leave one comment at the field site stating they're forward-compat scaffolding. Same for `sessionMeta.synthesized` — a single `// reserved for future "synthesized" banner` comment, or drop it. Current state: looks like working contract, is actually fossilized intent.

---

## 3. minor — `session_meta` kind is dead in practice

**CITE:** `src/sources/claude-code.js:418-433` (emits `session_meta` only when `subtype === 'init'`); `public/app.js:268, 374-376, 446-451`; `src/export-html.js` (parallel branches).

**EVIDENCE:** `system.init` does not appear in the live corpus (progress.md §Notes, and a corpus probe of ~50 sample files found 0 occurrences). The adapter therefore never emits a `session_meta` entry today. Renderer, inspector, treeLabel, export-html, and CSS all carry branches for it.

This isn't strictly *wrong* — forward-compat for when CC starts logging init lines — but it's worth a one-line acknowledgement so the next maintainer doesn't waste 20 minutes debugging "why doesn't my CC session show its session_meta?"

**FIX:** Either (a) add a `// NOTE: cc 1.x rarely emits system.init; this branch is forward-compat only.` at `buildSystemEntry` plus the renderer branch, or (b) skip emitting the kind entirely and surface init data only through `sessionMeta` on the parsed envelope (which every consumer already reads). Option (b) collapses 4 dead UI branches.

---

## 4. nit — `pricing.matchPrefix` is YAGNI for the current corpus

**CITE:** `src/sources/pricing.js:42-54`

**EVIDENCE:** The PRICES table already lists every model family member (opus-4, opus-4-5, opus-4-5-20251101, opus-4-7, sonnet-4, sonnet-4-5, sonnet-4-5-20250929, haiku-4, haiku-4-5). The live corpus contains 4 distinct model strings (per scout) and all four are explicit keys. The prefix walker exists for a hypothetical future model id like `claude-opus-4-5-20260801` — fine, but it adds 13 LOC, an extra test (`cost computation` covers only the exact-key path per the plan), and the dual `PRICES[model] || matchPrefix(model)` site.

**FIX:** Don't remove it — the cost of keeping it is low and Risk R1 in the plan flagged staleness explicitly. But move the **warning side effect** out: the `console.warn` + `WARNED` Set make this module no-longer-pure data (the `_resetWarnings` test helper is a small smell). A one-line `if (!process.env.PI_LOOKBACK_SILENT) console.warn(...)` is fine, but the `_resetWarnings` export deserves to die with a `--quiet` flag instead. Nit, leave for follow-up.

---

## 5. nit — `index.js` defensive scaffolding from a prior slice

**CITE:** `src/sources/index.js:10-17`

**EVIDENCE:**
```js
let claudeCode = null;
try { claudeCode = require('./claude-code'); } catch { /* not yet implemented */ }
const REGISTRY = { [pi.id]: pi };
if (claudeCode && claudeCode.id) REGISTRY[claudeCode.id] = claudeCode;
```
This is slice-A scaffolding for a moment in time when claude-code.js didn't exist. Post slice F, it always exists; the try/catch is a silent failure mode that would mask a real syntax error in `claude-code.js`. Also `listSources` is exported and **never imported** by anyone.

**FIX:**
```js
const pi = require('./pi');
const claudeCode = require('./claude-code');
const REGISTRY = { [pi.id]: pi, [claudeCode.id]: claudeCode };
```
Drop `listSources` from the export list. Two fewer lines, one fewer silent-swallow.

---

## Non-findings (looked, didn't bite)

- **Registry vs switch.** Only 2 sources today, but `getSource`/`sniffSource`/`defaultRoots` are each called from 2-3 places and the contract is clean. Inlining would scatter the source-id list. Keep.
- **Renderer `kind` switches in 3 places** (`treeLabel`, `entryHtml`, `renderInspector`). After +5 kinds they total ~80 LOC of repetitive if-chains. A kind-table refactor would save maybe 30 LOC at the cost of indirection. Not worth it for 5 kinds and 1 renderer.
- **`error` vs `meta`.** `error` has a real `<span class="errorBadge">` head treatment and severity field; folding it would lose UI distinction. Keep.
- **`attachment_card` vs `meta`.** Both are "collapsed by default" but attachments have a known subtype space the renderer can specialise (deferred per plan). Keep the kind separation.
- **Defensive optional-chaining.** I went looking for `if (raw && raw.message && raw.message.content && …)` chains in the new adapter — they're consistently `?.` throughout. The few belt-and-suspenders chains (`boundary?.compactMetadata?.preTokens ?? boundary?.preTokens`) are defensible: schema §6 documents both shapes across CC versions.
- **`try/catch` swallows.** `discover` swallows `readdirSync` errors silently (`catch { continue; }`) — correct for "directory we can't read, skip it." `sniff`'s catch (`catch { /* keep going */ }`) — correct, an adapter sniff shouldn't crash routing. `readFirstJsonLine` swallows — fine for an 8KB best-effort probe.
- **`listSessionFiles`/`defaultSessionsRoot` back-compat.** `test/metrics.js:20` uses the single-source path. Keep.
- **`pricing.js` location under `sources/`.** Imported by `claude-code.js` only; `signals.js` does NOT import it (signals reads `e.cost` populated by the adapter, per plan §3). Coupling is clean.
- **27 tests in one file.** Mirror of `test/parser.test.js` style. No `t()` helper extracted because the assertions vary widely per fixture. Repetition is shallow. Keep.

---

## Judgment

**Roughly as simple as it needs to be, with ~50 LOC of trim available.** The architectural shape (registry + per-source adapter, dispatch shim, pricing as data) is the right size for two sources and a likely third. The smells are all of the "left-over scaffolding from intermediate slices" variety: dead back-compat shims in `parser.js`, dead `try/catch require` in `index.js`, three normalized-envelope fields no consumer reads, and one kind (`session_meta`) that doesn't fire in 100% of the live corpus. None of them are blockers; together they're a 30-minute polish pass that would let the next reader trust that every field they see has a reader.

The defensive coding is well-calibrated (optional chaining everywhere, no swallowed errors that matter, no anxiety guards on impossible nulls). The pre-pass / two-pass structure of `parseSessionText` is the right shape for the multi-shard and compaction-merge constraints — that's earned complexity, not premature.

Ship it after the 30-minute trim. Or ship it now and let the dead fields haunt the next code-archaeologist; they'll figure it out.

Done. If this review breaks anyone's feelings, I was never here.
