# Implementation Plan — Claude Code source adapter for pi-lookback

> Meta-prompt for the implementation worker. Every decision is explicit; do not guess.
> Cite scout-findings.md and claude-code-schema.md inline when adding code that references them.

## Goal

Extend pi-lookback to ingest Claude Code session JSONL (`~/.claude/projects/<project-key>/*.jsonl`) through a pluggable source-adapter layer, with a unified library view (pi + Claude Code mixed, sortable by recency, filterable by source). All existing pi acceptance gates (M1–M9, TC, LP, ID, SF) must continue to pass when run against pi sessions alone.

---

## 1 · Architectural shape

### 1.1 File tree (add / modify / unchanged)

| Path | Action | Purpose |
|---|---|---|
| `src/sources/index.js`            | **new** | Registry. Exports `getSource(id)`, `listSources()`, `sniffSource(filePath, firstLine?)`. |
| `src/sources/pi.js`               | **new** | Pi adapter. Re-exports the existing `parser.js` logic verbatim (lifted unchanged), plus `discover(root)` walking `~/.pi/agent/sessions/`. |
| `src/sources/claude-code.js`      | **new** | Claude Code adapter. New parser; `discover(root)` walks `~/.claude/projects/`. |
| `src/sources/pricing.js`          | **new** | Per-model price table. Pure data module + `costFor(model, usage)` helper. |
| `src/parser.js`                   | **modify** | Becomes a thin dispatch shim. `parseSessionFile(filePath, { source? })` picks adapter via explicit hint or `sniffSource(filePath)`. Existing `normalizeEntry` moves to `src/sources/pi.js`. |
| `src/scanner.js`                  | **modify** | Adds `listSessionFilesMulti({ pi?, claudeCode? })` returning `{ filePath, source }` rows. `defaultSessionsRoots()` (plural) returns `{ pi, claudeCode }`. Existing `listSessionFiles` / `defaultSessionsRoot` kept for backwards-compat with `test/metrics.js`. |
| `src/summary.js`                  | **modify** | Adds `source` to the summary object. `decodeProjectDir` lookup is delegated to the adapter (each source has its own decoder). |
| `src/signals.js`                  | **modify** | Source-gate `failed_bash`, `repeated_failed_command`, `compaction_heavy`, `verification_missing` (see §3). Add adapter-populated `entry.cost` path. |
| `src/api.js`                      | **modify** | `setSessionsRoot` → `setSessionsRoots({pi, claudeCode})`. `listAllSummaries` walks both roots and tags each summary with `source`. Library query gains `?source=pi|claude-code`. Search hay includes `source`. |
| `src/export-html.js`              | **modify** | New `kind`s added: `session_meta`, `attachment_card`, `error`, `snapshot`. Sidechain badge on `<div class="entry">`. |
| `server.js`                       | **modify** | `--source pi|claude-code|both` flag. `--sessions <dir>` becomes source-aware (sniff content). New env `CLAUDE_SESSIONS_DIR`. |
| `public/app.js`                   | **modify** | Library: source filter chip, source badge on row. Trace: render new kinds; sidechain badge; subagent indent. Inspector: per-kind layout for new kinds. |
| `public/styles.css`               | **modify** | Add classes: `.kind-session_meta`, `.kind-attachment_card`, `.kind-error`, `.kind-snapshot`, `.sidechain-flag`, `.source-pi`, `.source-claude-code`. |
| `public/index.html`               | **modify** | Add `<select id="fSource">` filter, source-filter chip label. |
| `test/sources-claude-code.test.js`| **new** | Adapter-level tests against `fixtures/claude-code/`. |
| `test/parser.test.js`             | **modify** | Re-run existing assertions through the new dispatch shim (no behavior change for pi). |
| `test/api.test.js`                | **modify** | Add mixed-source library test, source-filter test, source field present on all rows. |
| `test/metrics.js`                 | **modify** | Source-gate M8 and SF (run against pi-only by default; add M8-cc variant). |
| `fixtures/claude-code/*.jsonl`    | **new** | 9 hand-authored CC fixtures (see §7). |
| `docs/sources.md`                 | **new** | One-page operator doc: source-adapter contract, how to add a third source. |
| `package.json` (scripts)          | **modify** | Add `test:cc` script for `node test/sources-claude-code.test.js`. |

**Unchanged**: `public/index.html` head/title, `src/export-html.js` CSS (only kind branches change), `docs/interface-plan.md`.

### 1.2 Adapter interface (every `src/sources/<id>.js` exports this)

```js
// src/sources/<id>.js
//
// Source adapter contract.
//
// id           — string, source identifier ('pi' | 'claude-code' | ...).
// defaultRoot  — () => string, absolute path of the source's default on-disk root.
//                Reads its source-specific env var (e.g. PI_SESSIONS_DIR, CLAUDE_SESSIONS_DIR).
// discover     — (root) => Iterable<{ filePath: string, source: string, projectKey?: string,
//                                     isSubagent?: boolean }>.
//                Walks the root and yields one row per .jsonl file to consider.
// parseFile    — (filePath) => ParsedSession.  // see §2
// decodeProjectDir — (dirname) => string. Best-effort recovery of cwd from project-key.
// sniff        — (filePath, firstLine?) => boolean. True iff this adapter recognises the file.
//                Used by sniffSource() when --source is not explicit.
//
// ParsedSession shape (returned by parseFile):
//   { entries:    NormalizedEntry[],
//     parseErrors:[{ line, reason, preview }],
//     sessionMeta: SessionMeta,   // see §6
//     filePath:    string,
//     source:      string }       // adapter sets this to its own id

module.exports = { id, defaultRoot, discover, parseFile, decodeProjectDir, sniff };
```

### 1.3 Registry (`src/sources/index.js`)

```js
const pi          = require('./pi');
const claudeCode  = require('./claude-code');

const REGISTRY = { [pi.id]: pi, [claudeCode.id]: claudeCode };

function getSource(id)        { return REGISTRY[id] || null; }
function listSources()        { return Object.keys(REGISTRY); }
function defaultRoots()       { return { pi: pi.defaultRoot(), 'claude-code': claudeCode.defaultRoot() }; }

// File-shape autodetection. Reads only the first non-blank JSON line.
function sniffSource(filePath) {
  const firstLine = readFirstJsonLine(filePath);   // helper, ≤8KB read
  if (!firstLine) return null;
  for (const a of Object.values(REGISTRY)) {
    if (a.sniff(filePath, firstLine)) return a.id;
  }
  return null;   // unknown — caller decides
}

module.exports = { getSource, listSources, defaultRoots, sniffSource, REGISTRY };
```

Sniff rules (concrete, ordered):

| Adapter | Sniff predicate |
|---|---|
| pi          | `firstLine.type === 'session'` |
| claude-code | `firstLine.sessionId && firstLine.type && (firstLine.uuid \|\| firstLine.sessionId === path.basename(filePath, '.jsonl'))` |

If neither matches: parser fails open to `pi` only when `--source pi` is explicit, otherwise marks the file unparseable with `parseErrors: [{ line: 0, reason: 'source not recognized', preview: '…' }]` and zero entries (so M9 read-only invariant is preserved).

### 1.4 `src/parser.js` becomes a dispatch shim

Before (current): owns all pi-shape normalization (229 LOC).

After:

```js
'use strict';
const fs = require('fs');
const { getSource, sniffSource } = require('./sources');

function parseSessionFile(filePath, { source } = {}) {
  const id = source || sniffSource(filePath);
  const adapter = getSource(id);
  if (!adapter) {
    return { entries: [], parseErrors: [{ line: 0, reason: `unknown source for ${filePath}` }],
             sessionMeta: null, filePath, source: null };
  }
  return adapter.parseFile(filePath);
}

// Back-compat: re-export the old pi normalizer for tests that import it directly.
function normalizeEntry(raw) { return require('./sources/pi').normalizeEntry(raw); }

module.exports = { parseSessionFile, normalizeEntry };
```

The current `parseSessionText` is **deleted** from `parser.js` and lifted into `src/sources/pi.js` as the pi adapter's internal helper. No external caller uses it (verify via grep).

### 1.5 `src/scanner.js` multi-source walk

```js
function listSessionFilesMulti(roots) {
  // roots: { pi?: string|null, 'claude-code'?: string|null }
  // returns: Array<{ filePath, source, projectKey?, isSubagent? }>
  const out = [];
  for (const [sourceId, root] of Object.entries(roots)) {
    if (!root) continue;
    const adapter = getSource(sourceId);
    if (!adapter) continue;
    for (const row of adapter.discover(root)) out.push({ ...row, source: sourceId });
  }
  return out;
}

function defaultSessionsRoots() {
  const { pi, 'claude-code': cc } = require('./sources').defaultRoots();
  return {
    pi: process.env.PI_SESSIONS_DIR || pi,
    'claude-code': process.env.CLAUDE_SESSIONS_DIR || cc,
  };
}
```

The existing single-root `listSessionFiles(root)` and `defaultSessionsRoot()` remain — `test/metrics.js` and any external callers depend on them. They alias to pi-source only.

### 1.6 `src/api.js` library response gains `source`

- `setSessionsRoot(root)` → keep as **back-compat**: alias for `setSessionsRoots({ pi: root, 'claude-code': null })`. Tests in `test/api.test.js` and `test/metrics.js` keep using it; behaviour unchanged.
- Add `setSessionsRoots({ pi, 'claude-code' })` — primary entry point.
- `listAllSummaries()` walks both roots via `listSessionFilesMulti`. Each summary row gets `source: 'pi'|'claude-code'`.
- Library filter: new query arg `source` filters to one source. Default = no filter (mixed).
- Search hay (`entrySearchHay` at api.js:205): unchanged shape — adapter normalizes to the same field names. Search across sessions also matches `summary.source` so users can type "claude-code" to filter.
- Cache keys: `SUMMARY_CACHE` and `PARSED_CACHE` are keyed by `filePath` already — no collision risk between sources because filepaths are absolute. No change needed.

### 1.7 CLI surface (`server.js`)

New flags and env:

| Flag / env | Effect |
|---|---|
| `--source pi`             | Disable claude-code root. |
| `--source claude-code`    | Disable pi root. |
| `--source both` *(default)* | Both roots (if present). |
| `--sessions <dir>`        | Treat `<dir>` as a single root; sniff its source from the first file found, or honor `--source` hint. |
| `--pi-sessions <dir>`     | Override pi root only. |
| `--claude-sessions <dir>` | Override claude-code root only. |
| `PI_SESSIONS_DIR`         | Existing pi root env. |
| `CLAUDE_SESSIONS_DIR`     | **new** — Claude Code root env. |

`parseArgs` resolution order: explicit `--pi-sessions` / `--claude-sessions` > `--sessions` (sniffed) > `--source` (modulates default roots) > env vars > built-in defaults. The bound roots are passed to `api.setSessionsRoots(...)`.

Startup log adds one line per active source:
```
pi-lookback listening on http://127.0.0.1:7878
Sources active:
  pi          → /Users/anishthite/.pi/agent/sessions     (87 files)
  claude-code → /Users/anishthite/.claude/projects        (505 files)
```

---

## 2 · Normalized entry envelope (the contract)

### 2.1 Common fields (every entry, regardless of source)

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✓ | pi: `raw.id`. cc: `raw.uuid`. Always non-empty (synthesize from `${filename}:${lineIndex}` if absent). |
| `parentId` | string \| null | ✓ | pi: `raw.parentId`. cc: `raw.parentUuid`. |
| `timestamp` | ISO-8601 string \| null | ✓ | Lexicographically sortable. |
| `kind` | enum (see §2.2) | ✓ | The rendered category. Never throws on unknown raw types. |
| `raw` | object | ✓ | Original JSONL object (stripped by api.js before sending to client). |
| `source` | `'pi' \| 'claude-code'` | ✓ | Set by adapter. |
| `sidechain` | boolean | optional | True on cc subagent/sidechain entries (default false). pi adapter always sets false. |

### 2.2 Final `kind` enum

| Kind | Source(s) | Source raw shape |
|---|---|---|
| `user`                  | both | pi: message/user. cc: type=user with non-system promptType. |
| `assistant`             | both | pi: message/assistant. cc: type=assistant. |
| `toolResult`            | both | pi: message/toolResult. cc: type=user with tool_result block or toolUseResult wrapper. |
| `bashExecution`         | both | pi: message/bashExecution. cc: synthesized when an `assistant.tool_use.name === 'Bash'` is followed by its matching `tool_result` — see §2.4. |
| `compaction`            | both | pi: type=compaction. cc: see §4. |
| `model_change`          | pi | (pi-only event type; cc never emits this kind, but renderer keeps support for backward replay). |
| `branch_summary`        | pi | pi-only. |
| `thinking_level_change` | pi | pi-only. |
| `custom`                | pi | pi-only. |
| `custom_message`        | pi | pi-only. |
| `label`                 | pi | pi-only. |
| **NEW** `session_meta`  | cc | cc `system.init` (when present) OR synthesized §6. |
| **NEW** `attachment_card` | cc | cc `attachment` of any subtype; collapsed by default in UI. |
| **NEW** `error`         | cc | cc `system.api_error`; `assistant.isApiErrorMessage:true`. |
| **NEW** `snapshot`      | cc | cc `file-history-snapshot` with non-empty `trackedFileBackups`. |
| **NEW** `meta`          | cc | cc `queue-operation`, `permission-mode`, `last-prompt`, `ai-title`, `worktree-state`, `pr-link`, etc. Collapsed by default. |
| `unknown`               | both | Forward-compat fallback. |

### 2.3 Per-kind field surface (additions to common fields above)

These are the field names downstream code reads. Adapters MUST populate them (or set to null/empty). Scout-findings.md §3 enumerated the existing pi surface; the CC adapter must produce the same shape for the same `kind`.

- **user**: `text` (string), `tokens` (int — input token estimate; cc: pull from preceding assistant's `usage.input_tokens` if available, else `text.length`), **NEW** `promptType` (cc: `'user' | 'command' | 'hook_result' | 'command_output' | 'system_caveat'`; pi: always `'user'`).
- **assistant**: `text`, `thinking`, `toolCalls[]={id,name,arguments}`, `model`, `provider`, `api`, `usage`, **`cost`** (number — both adapters populate this; cc computes from pricing.js), `totalTokens`, `stopReason`, `responseId`, **NEW** `messageId` (the inner `msg_…`; for multi-shard rollup; pi: null), **NEW** `shardOf` (when multiple jsonl lines share `message.id`, set to the FIRST shard's `id`; null otherwise).
- **toolResult**: `toolName`, `toolCallId`, `isError`, `text`, `outputBytes`, `truncated`, `fullOutputPath`, `details`.
- **bashExecution**: `command`, `output`, `outputBytes`, `exitCode`, `cancelled`, `truncated`, `fullOutputPath`, `excludeFromContext`.
- **compaction**: `summary`, `firstKeptEntryId`, `tokensBefore`, **NEW** `tokensAfter`, **NEW** `trigger` (`'auto'|'manual'|null`), **NEW** `mechanism` (`'system.compact_boundary'|'system.microcompact_boundary'|'top-level-summary'|'user.isCompactSummary'`), `fromHook`, `details`.
- **session_meta**: `cwd`, `version`, `gitBranch`, `model`, `permissionMode`, `tools[]`, `mcpServers[]`, `agents[]`, `synthesized` (true when no `system.init` was present and meta was inferred per §6).
- **attachment_card**: `subtype` (the `attachment.type` value), `payload` (the raw `attachment` object — adapter does not pre-render; renderer chooses what to show).
- **error**: `errorMessage`, `cause`, `retryAttempt`, `httpStatus`, `severity` (`'fatal'|'retryable'`).
- **snapshot**: `messageId`, `trackedFiles` (array of `{ path, backupFileName, version }`).
- **meta**: `metaType` (e.g. `'queue-operation'`, `'permission-mode'`), `payload` (raw object). Hidden by default in UI.
- **model_change** / **branch_summary** / **thinking_level_change** / **custom** / **custom_message** / **label**: unchanged from pi.

### 2.4 Multi-shard assistant messages (CC §5.5)

Live-corpus stat: ~33% of assistant `message.id` values appear on more than one JSONL line. Adapter behavior:

1. Each JSONL line produces **one** normalized entry (preserves the tree shape and per-shard `uuid`).
2. Each entry whose `message.id` was seen on a prior line in the same file gets `shardOf` set to the first-seen shard's `id`. First shard has `shardOf: null`.
3. Usage and cost: ONLY the shard that carries `message.usage` populates `usage`/`cost`/`totalTokens`. Other shards leave those fields null.
4. Summary rollup: `buildSessionSummary` sums tokens/cost from non-null `usage`/`cost` — guaranteed to count each `msg_…` once.
5. UI hint: trace renderer collapses subsequent shards under the first (`shardOf != null` → indented; sticky header references parent). Out of scope for this MVP — render all shards as standalone entries; deferred to L-followup.

### 2.5 Sidechain entries

Set `sidechain: true` on any cc entry where `raw.isSidechain === true`. Do NOT branch on a new `kind`. Renderer (public/app.js) detects the flag and adds a `<span class="sidechain-flag">subagent</span>` badge plus `agentId`/`agentName` (when present) on the entry head.

### 2.6 Tool-call ↔ tool-result correlation

CC rule (schema §5): `tool_use.id === tool_result.tool_use_id`, strict id pairing, NOT positional.

Adapter algorithm in cc parseFile (single pass after raw line parsing):

```text
toolUseRegistry := {}                       // tool_use.id → { name, input, uuid }
for each raw line in file order:
    if assistant && content has tool_use blocks:
        for each tool_use block tu:
            toolUseRegistry[tu.id] = { name: tu.name, input: tu.input, uuid: line.uuid }
            emit assistant entry (toolCalls includes this tu)
    if user with tool_result block(s) or toolUseResult wrapper:
        for each tool_result tr (look in message.content[] AND in toolUseResult):
            paired := toolUseRegistry[tr.tool_use_id]
            // emit one toolResult entry per tool_result (separate id derived from uuid + ':' + tr.tool_use_id)
            kind := (paired && paired.name === 'Bash') ? 'bashExecution' : 'toolResult'
            emit normalized entry
```

**Bash extraction** when `kind === 'bashExecution'`:
- `command`     ← `toolUseRegistry[tr.tool_use_id].input.command`
- `output`      ← `tr.content[].text` joined, OR `toolUseResult.stdout + '\n' + toolUseResult.stderr`
- `exitCode`    ← null UNLESS `toolUseResult.interrupted === true` → `-1`, OR `toolUseResult.isError === true` → `1`, OR text contains `(eval):N: <error>` parse; otherwise null (cc Bash tool does not surface exit codes natively — see Risk R3).
- `cancelled`   ← `toolUseResult.interrupted === true`.
- `excludeFromContext` ← false (pi-specific concept).
- `truncated`   ← `text.length >= 30000` (cc default Bash output cap — heuristic).

If `paired` is null (tool_use never seen — rare, indicates malformed log or replay across files), still emit a `toolResult` with `toolName: null` and an entry in `parseErrors`.

### 2.7 `parseErrors` envelope

Same shape as pi: `[{ line, reason, preview }]`. CC adapter records:
- Malformed JSON lines (same as pi).
- Tool-result with unknown `tool_use_id` (rare but possible).
- Entries whose `type` is unrecognized AND lack the discriminator fields needed for forward-compat fallback (`uuid`+`sessionId` missing).

---

## 3 · Signals source-gating

Existing signals classification (with cite to signals.js):

| Signal | signals.js line | Disposition | Implementation |
|---|---|---|---|
| `failed_tool`              | 23 | **source-agnostic** | Already triggered by `toolResult.isError` — cc adapter populates that. ✓ |
| `failed_bash`              | 25 | **source-agnostic via adapter** | Trigger when `kind === 'bashExecution' && exitCode !== 0 && exitCode !== null`. For cc this fires only when adapter inferred an error from `interrupted`/`isError` (R3); otherwise zero false negatives, zero false positives. |
| `aborted_assistant`        | 27 | **source-agnostic with mapping** | pi values: `'error'|'aborted'`. cc values (per schema §3.3): `'end_turn'|'max_tokens'|'stop_sequence'|'tool_use'|'pause_turn'|'refusal'`. **Add**: cc adapter maps `'refusal'` → keep as `'refusal'`; signal fires on `{'error','aborted','refusal','max_tokens'}`. Update CORRECTION_RE block to: `stopReason in {'error','aborted','refusal','max_tokens'}`. |
| `huge_output`              | 29 | **source-agnostic** | Triggered by `toolResult.outputBytes > 50KB`. ✓ |
| `truncated_output`         | 31 | **source-agnostic** | cc adapter synthesizes `truncated` via `text.length >= 30000` heuristic (only for Bash; other tools never set it). Acceptable for MVP. |
| `repeated_failed_command`  | 42 | **source-agnostic via adapter** | Operates on `bashExecution.command` + `exitCode`. For cc, fires only when adapter inferred bash errors (R3). |
| `user_correction`          | 51 | **source-agnostic** | Operates on `user.text`. cc adapter filters out non-`user` promptTypes (so command-output text does not trigger false positives). |
| `long_no_tool_stretch`     | 56 | **source-agnostic** | Operates on `assistant.toolCalls.length`. ✓ |
| `high_cost`                | 71 | **source-agnostic — REPLUMBED** | Currently sums `e.cost` (assistant only). cc adapter populates `entry.cost` via pricing table (§3.1). pi adapter continues to populate from `m.usage.cost.total`. **No change to signals.js code** beyond a comment noting the cross-source contract. |
| `branch_heavy`             | 79 | **source-agnostic** | Operates on `parentId` graph. ✓ |
| `compaction_heavy`         | 89 | **source-agnostic with caveat** | Operates on `kind === 'compaction'` count. Forward-compat for cc (no events observed in live corpus). pi sessions continue to trigger. |
| `verification_missing`     | 94 | **partially source-gated** | Currently looks for `bashExecution.command` regex + `toolName` `/^(write|edit)$/i`. cc has bash via §2.6 and Write/Edit are real cc tool names (`Write`, `Edit`). The regex needs `/^(write|edit|multiedit)$/i` (case-insensitive). For cc, also accept `bash`-substituted `tool_use.input.command`. Mark as source-agnostic after this regex tweak. |

### 3.1 Cost computation (`src/sources/pricing.js`)

```js
// Per-million-token USD prices. Source: anthropic.com/pricing as of 2026-06-04.
// Fields: { input, output, cacheCreation, cacheRead }
const PRICES = {
  'claude-opus-4-5-20251101':   { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-opus-4-7':            { input: 15,  output: 75,  cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-5-20250929': { input: 3,   output: 15,  cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-haiku-4-5':           { input: 1,   output: 5,   cacheCreation: 1.25,  cacheRead: 0.1 },
  '<synthetic>':                { input: 0,   output: 0,   cacheCreation: 0,     cacheRead: 0 },
};
function costFor(model, usage) {
  if (!model || !usage) return null;
  const p = PRICES[model] || PRICES[matchPrefix(model)] || null;
  if (!p) return null;
  return (usage.input_tokens || 0) * p.input / 1e6
       + (usage.output_tokens || 0) * p.output / 1e6
       + (usage.cache_creation_input_tokens || 0) * p.cacheCreation / 1e6
       + (usage.cache_read_input_tokens || 0) * p.cacheRead / 1e6;
}
function matchPrefix(model) {
  // 'claude-opus-4-5-20251101' → match 'claude-opus-4-5'
  const parts = model.split('-');
  while (parts.length > 2) {
    parts.pop();
    if (PRICES[parts.join('-')]) return parts.join('-');
  }
  return null;
}
module.exports = { PRICES, costFor };
```

Unknown model → `cost: null`. Signal won't double-count nulls. Maintenance is L-followup (Risk R1).

### 3.2 M8 (≥5 signal kinds) acceptance

- **pi-only run** (current `node test/metrics.js`): unchanged. Required gate.
- **cc-only run**: relaxed to ≥3 signal kinds (`failed_tool`, `huge_output`, `user_correction`, `long_no_tool_stretch`, `high_cost`, `branch_heavy` are the realistic firers given live-corpus profile). Documented as M8-cc in test/metrics.js.
- **Mixed run** (default): use the pi-only threshold (≥5). Mixed signals only ever grow the kind set.

---

## 4 · Compaction handling

Three mechanisms per CC schema §6, in **priority order** when more than one exists in the same vicinity (`vicinity` = ±2 lines):

| Priority | Mechanism | Emit `compaction` entry with… |
|---|---|---|
| 1 | `system.compact_boundary` / `microcompact_boundary` | `trigger` ← `compactMetadata.trigger`; `tokensBefore` ← `preTokens`; `tokensAfter` ← `postTokens`; `summary` ← `''` (boundary has no narrative); `mechanism` ← `'system.compact_boundary'` (or microcompact). |
| 2 | `user.isCompactSummary === true` | `summary` ← extracted text from `message.content`; `tokensBefore` ← null; `mechanism` ← `'user.isCompactSummary'`; emit at the user entry's `uuid` (do NOT also emit a `user` kind for the same uuid — compaction supersedes). |
| 3 | top-level `type === 'summary'` | `summary` ← `raw.summary`; `firstKeptEntryId` ← `raw.leafUuid`; `mechanism` ← `'top-level-summary'`. |

If (1) and (2) co-occur (boundary marker followed within ±2 lines by `isCompactSummary` user message): emit ONE compaction entry combining fields — `summary` from (2), `tokensBefore`/`tokensAfter`/`trigger` from (1). De-dup by `uuid` of the boundary entry.

Order-of-operations:
1. CC adapter first pass: scan for `system.compact_boundary` and `system.microcompact_boundary`, record `uuid → metadata`.
2. Second pass: for each line, emit normalized entry. For `user.isCompactSummary`, check if a recorded boundary exists within ±2 lines; if so, merge; else emit standalone compaction.
3. For top-level `summary` entries: emit compaction with no merging.

Skip-conditions (do NOT emit compaction): top-level `last-prompt`, `ai-title` — these are bookkeeping, not compaction.

---

## 5 · Project-key decoding

### 5.1 Rule

```js
// src/sources/claude-code.js
function decodeProjectDir(name) {
  // CC encodes paths as: path.replace(/[:\\/]/g, '-')
  // Best-effort reverse for POSIX:
  if (typeof name !== 'string' || !name.startsWith('-')) return name || '';
  return '/' + name.slice(1).split('-').filter(Boolean).join('/');
}
```

Note the leading-dash convention: `/Users/x/y` → `-Users-x-y` (no surrounding `--` like pi). Differs from pi by exactly one character — keep them separate.

### 5.2 Ground-truth fallback

The encoding is **lossy** for paths containing literal dashes (`/foo-bar/baz` and `/foo/bar/baz` both encode to `-foo-bar-baz`). Recovery: **prefer per-entry `cwd`** from any entry in the file. `decodeProjectDir(projectKey)` is only used as the display fallback when no entry has carried a `cwd` (impossible in practice — every cc user/assistant entry has cwd — but defensive).

Implementation in `src/summary.js`:

```js
// scanner.decodeProjectDir is removed and split per source.
// Lookup order in buildSessionSummary:
//   1. sessionMeta?.cwd  (extracted in §6)
//   2. raw entry cwd from first user/assistant entry
//   3. adapter.decodeProjectDir(projectDir)   ← last resort
```

The pi adapter keeps its existing `decodeProjectDir` (with `--…--` convention) verbatim. The cc adapter has its own.

---

## 6 · Session metadata extraction (CC)

CC has no header line and `system.init` is absent in 100% of the user's live corpus. Algorithm for `sessionMeta`:

### 6.1 Algorithm

```js
function extractSessionMeta(rawLines) {
  // rawLines = parsed JSON objects, in file order
  let init = null;          // type=system && subtype=init
  let firstUserOrAsst = null;
  for (const r of rawLines) {
    if (!init && r?.type === 'system' && r?.subtype === 'init') init = r;
    if (!firstUserOrAsst && (r?.type === 'user' || r?.type === 'assistant')) firstUserOrAsst = r;
    if (init || (firstUserOrAsst && init === null && rawLines.length > 5)) break;
  }
  // Last-wins for mutable fields:
  let lastCwd = null, lastGitBranch = null, lastVersion = null;
  for (const r of rawLines) {
    if (r?.cwd) lastCwd = r.cwd;
    if (typeof r?.gitBranch === 'string') lastGitBranch = r.gitBranch;
    if (r?.version) lastVersion = r.version;
  }
  // Model: last assistant model wins.
  let lastModel = null;
  for (const r of rawLines) if (r?.type === 'assistant' && r?.message?.model) lastModel = r.message.model;

  if (init) {
    return {
      id: init.session_id || init.sessionId || basename(filePath, '.jsonl'),
      cwd: lastCwd || init.cwd,
      version: lastVersion || init.claude_code_version,
      gitBranch: lastGitBranch,
      model: lastModel || init.model,
      permissionMode: init.permissionMode || null,
      tools: init.tools || [],
      mcpServers: init.mcp_servers || [],
      agents: init.agents || [],
      timestamp: init.timestamp || rawLines[0]?.timestamp,
      synthesized: false,
      source: 'claude-code',
    };
  }
  // Synthesize from first user/assistant entry.
  const seed = firstUserOrAsst || rawLines[0] || {};
  return {
    id: seed.sessionId || basename(filePath, '.jsonl'),
    cwd: lastCwd || seed.cwd || '',
    version: lastVersion || seed.version || '',
    gitBranch: lastGitBranch || seed.gitBranch || '',
    model: lastModel || null,
    permissionMode: null,
    tools: [],
    mcpServers: [],
    agents: [],
    timestamp: seed.timestamp || null,
    synthesized: true,
    source: 'claude-code',
  };
}
```

### 6.2 Decisions

| Question | Answer |
|---|---|
| `sessionMeta.cwd` — first, last, or last-wins? | **last-wins**. Schema §7 confirms cwd is mutable mid-session. The user's current directory at the END of the session is the most useful for the library "project" column. |
| `sessionMeta.gitBranch` — same? | **last-wins**, same reasoning. |
| `sessionMeta.version` — same? | **last-wins**. If CC was upgraded mid-session, show the newer version. |
| `sessionMeta.model` — same? | **last-wins-assistant**. If the user toggled models, the last model used is the most relevant signal. |
| `sessionMeta.id` | `sessionId` from any entry (they're all the same per file) OR filename basename. |
| `sessionMeta.timestamp` | First entry's timestamp (consistent with pi semantics for `startedAt`). |
| Emit `session_meta` entry? | Yes when `system.init` is present (rare); skip when synthesized (avoids cluttering 100% of cc sessions with a junk "synthesized" card). |

---

## 7 · Fixture plan

All fixtures under `fixtures/claude-code/`. Each is **one** valid `.jsonl` file. Realistic uuids and timestamps; copy the structure from real corpus entries but invent the content so we don't ship any user prompts.

| Fixture | Lines | Covers | Adapter assertions |
|---|---|---|---|
| `cc-simple-turn.jsonl` | 4 | One user prompt, one assistant text reply, end_turn | `entries.length === 2`; kinds `['user','assistant']`; `assistant.stopReason === 'end_turn'`; `sessionMeta.synthesized === true`; `source === 'claude-code'`. |
| `cc-tool-success.jsonl` | 5 | assistant `tool_use` (Read) + user `tool_result` | `toolCallCount === 1`; one `toolResult` with `isError:false`; `toolName === 'Read'`. |
| `cc-multi-tool-use.jsonl` | 6 | Single assistant carrying 2 `tool_use` blocks (Read + Grep), followed by 2 separate user entries each delivering one tool_result | `toolCallCount === 2`; two `toolResult` entries with matching `toolCallId`s; both `isError:false`. |
| `cc-sidechain.jsonl` | 8 | One main user→assistant, then Task `tool_use`, then sidechain (`isSidechain:true`) user→assistant→tool_use chain returning a `tool_result` | `entries.filter(e => e.sidechain === true).length === 3`; subagent `agentId` present on sidechain entries; main thread `sidechain:false`. |
| `cc-bash-success.jsonl` | 4 | assistant Bash `tool_use` + user `tool_result` (no interrupt, no isError) | One `bashExecution` entry; `command === 'ls -la'`; `exitCode === null` (cc Bash has no native exit); `cancelled === false`. |
| `cc-bash-error.jsonl` | 4 | Bash with `toolUseResult.isError:true` | One `bashExecution` entry; `exitCode === 1`; `output` contains stderr; signal `failed_bash` fires. |
| `cc-multi-shard-assistant.jsonl` | 5 | Two assistant JSONL lines sharing `message.id`; first carries thinking only (no usage), second carries text + tool_use + usage | `entries.filter(e=>e.kind==='assistant').length === 2`; `entries[1].shardOf === entries[0].id`; usage only on second; `buildSessionSummary.totalTokens` counts once. |
| `cc-attachment.jsonl` | 4 | User prompt with preceding `attachment` of type `skill_listing`, then assistant | `attachment_card` kind present with `subtype === 'skill_listing'`; renderer should default collapse. |
| `cc-queue-operation.jsonl` | 3 | `queue-operation` (enqueue) first line, then user, then assistant | One `meta` entry with `metaType === 'queue-operation'`; user/assistant render normally; `sessionMeta.synthesized === true`. |
| `cc-malformed-line.jsonl` | 5 | 4 valid lines + 1 line with `}{` mid-JSON | `parseErrors.length === 1`; valid entries still parsed; `entries.length === 4`. |

Files are tiny (<2KB each, except sidechain ~4KB and multi-shard ~3KB). Total disk ≈ 20KB. Created once, committed.

---

## 8 · Test plan

### 8.1 `test/sources-claude-code.test.js` (new)

Mirrors `test/parser.test.js` structure (assertion-based, no framework). One `t()` block per fixture above. Specific assertions:

```js
t('cc-simple-turn: parses without errors', () => {
  const p = parseSessionFile(fix('cc-simple-turn.jsonl'));
  eq(p.parseErrors.length, 0);
  eq(p.source, 'claude-code');
  eq(p.entries.length, 2);
  eq(p.entries[0].kind, 'user');
  eq(p.entries[1].kind, 'assistant');
  eq(p.entries[1].stopReason, 'end_turn');
});

t('cc-multi-tool-use: pairs tool_use to tool_result by id', () => {
  const p = parseSessionFile(fix('cc-multi-tool-use.jsonl'));
  const results = p.entries.filter(e => e.kind === 'toolResult');
  eq(results.length, 2);
  const useIds = p.entries.find(e => e.kind === 'assistant').toolCalls.map(t => t.id);
  for (const r of results) assert(useIds.includes(r.toolCallId), `unpaired ${r.toolCallId}`);
});

t('cc-sidechain: flags sidechain entries', () => {
  const p = parseSessionFile(fix('cc-sidechain.jsonl'));
  const sub = p.entries.filter(e => e.sidechain);
  assert(sub.length >= 3);
  assert(sub.every(e => e.raw.agentId));
});

t('cc-multi-shard: groups by message.id for usage', () => {
  const p = parseSessionFile(fix('cc-multi-shard-assistant.jsonl'));
  const asst = p.entries.filter(e => e.kind === 'assistant');
  eq(asst.length, 2);
  eq(asst[1].shardOf, asst[0].id);
  const s = buildSessionSummary(p);
  eq(s.assistantMessageCount, 2);   // counts shards as separate timeline entries
  assert(s.totalTokens > 0);
  // Verify usage is on exactly one shard:
  eq(asst.filter(e => e.usage).length, 1);
});

t('cc-bash-error: surfaces failed_bash signal', () => {
  const p = parseSessionFile(fix('cc-bash-error.jsonl'));
  const sigs = detectSignals(p);
  assert(sigs.some(s => s.kind === 'failed_bash'));
});

t('cc-malformed-line: tolerant', () => {
  const p = parseSessionFile(fix('cc-malformed-line.jsonl'));
  assert(p.parseErrors.length === 1);
  assert(p.entries.length >= 4);
});

t('cc-attachment: emits attachment_card', () => {
  const p = parseSessionFile(fix('cc-attachment.jsonl'));
  assert(p.entries.some(e => e.kind === 'attachment_card' && e.subtype === 'skill_listing'));
});

t('cost computation: pricing table applies to known model', () => {
  const { costFor } = require('../src/sources/pricing');
  const c = costFor('claude-opus-4-5-20251101', { input_tokens: 1e6, output_tokens: 1e6 });
  eq(c, 90);  // 15 + 75
});

t('decodeProjectDir cc differs from pi', () => {
  const cc = require('../src/sources/claude-code');
  const pi = require('../src/sources/pi');
  eq(cc.decodeProjectDir('-Users-a-b'), '/Users/a/b');
  eq(pi.decodeProjectDir('--Users-a-b--'), '/Users/a/b');
});
```

### 8.2 `test/parser.test.js` (modify)

No assertion changes. Add ONE check at top: `parseSessionFile` of every existing pi fixture returns `source === 'pi'`. Goal: catch a regression where the dispatch shim silently routes pi files to the cc adapter.

### 8.3 `test/api.test.js` (modify)

Existing 9 tests stay green (pi-only fixtures). Add 4 new tests:

```js
await t('mixed library lists both sources', async () => {
  api.setSessionsRoots({ pi: PI_FIX, 'claude-code': CC_FIX });
  const j = await getJson(base + '/api/sessions');
  const sources = new Set(j.sessions.map(s => s.source));
  assert(sources.has('pi') && sources.has('claude-code'));
});

await t('source filter narrows the library', async () => {
  api.setSessionsRoots({ pi: PI_FIX, 'claude-code': CC_FIX });
  const j = await getJson(base + '/api/sessions?source=claude-code');
  assert(j.sessions.every(s => s.source === 'claude-code'));
  assert(j.sessions.length >= 9);   // 9 cc fixtures
});

await t('every summary has a source field', async () => {
  const j = await getJson(base + '/api/sessions');
  for (const s of j.sessions) assert(s.source === 'pi' || s.source === 'claude-code');
});

await t('search across mixed sources', async () => {
  const j = await getJson(base + '/api/search?q=ENOENT');
  // ENOENT exists in pi tool-error fixture only
  assert(j.results.some(r => r.sessionId === 'fixt-tool-error'));
});
```

### 8.4 `test/metrics.js` (modify)

Source-conditional gates:

| Gate | Behaviour |
|---|---|
| M1, M2, M3, M4, M6, M7, M9, TC, LP, ID, SF | source-agnostic; run uniformly on the active root(s). |
| M5 | source-agnostic — but if cc-only and signals don't include `failed_bash`/`failed_tool`, the gate fails. Acceptable: gate fails legitimately when nothing in the corpus has errors. |
| M8 | split into `M8` (pi root only, ≥5) and **new** `M8-cc` (cc root only, ≥3). `node test/metrics.js` runs `M8` by default. `node test/metrics.js --source claude-code` runs `M8-cc` instead. |

CLI for metrics:
```sh
node test/metrics.js                    # pi root only (back-compat)
node test/metrics.js --source pi        # explicit pi
node test/metrics.js --source claude-code
node test/metrics.js --source both
```

Acceptance after changes: `node test/metrics.js` (no flag) MUST produce identical output to pre-change run (modulo the new `source` field appearing in summary rows for ID gate — verify the field count threshold isn't affected; ID counts a fixed list of 9 fields, so it's unchanged).

### 8.5 Validation commands the worker runs after each slice

```sh
node test/parser.test.js                 # pi parser
node test/sources-claude-code.test.js    # cc parser
node test/api.test.js                    # api smoke (mixed)
node test/metrics.js                     # pi gates
node test/metrics.js --source claude-code  # cc gates
node test/metrics.js --source both         # mixed gates (no regression)
```

---

## 9 · Risk register

| ID | Risk | Likelihood × Impact | Mitigation |
|---|---|---|---|
| R1 | **Cost-table staleness** — Anthropic adds new models or changes prices; `costFor` returns null → `high_cost` signal stops firing for cc, summaries show $0. | High × Medium | (a) Make `PRICES` a JSON file that loads at startup, easy to update without code changes. (b) Add prefix-match (`claude-opus-4-5*` matches anything starting with that). (c) Log unknown models once per process. (d) L-followup: monthly cost-table refresh script. |
| R2 | **agentId without agentName** — UI shows opaque hex IDs (e.g. `a4044e6`) for subagents; user has no name to click on. | Certain × Low | MVP shows `agentId` only with a "subagent" badge. L-followup: lookup table populated from any prior `agent-setting` or `agent-name` entries seen in the same project dir. |
| R3 | **Bash exit-code absence** — CC Bash tool doesn't emit `exit_code`. Adapter heuristics (`interrupted`, `isError`, text scrape) can miss real failures, undercounting `failed_bash`/`repeated_failed_command`. | Medium × Medium | Document the heuristic openly in `docs/sources.md`. Add `output`/`text` regex fallback: `/^Error:|^Traceback|\bexit (status|code) (?!0)[0-9]+/m` → `exitCode: 1`. Add fixture `cc-bash-error.jsonl` to lock this in. L-followup: PR upstream to log exit codes. |
| R4 | **Multi-shard usage double-counting** — if `shardOf` logic breaks, the same `msg_…` could be counted N times in `totalTokens`/`totalCost`. | Medium × High | Adapter pre-pass builds a `Set<message.id>` of seen ids before normalize, and only the FIRST shard carrying `usage` keeps it (others get `usage: null`). Unit-tested by `cc-multi-shard-assistant.jsonl` fixture; assertion: `entries.filter(e => e.usage).length === 1`. |
| R5 | **`result` entry ambiguity** — schema §3.10 documents two shapes (workflow-step vs session-final). Adapter could mis-render. | Low × Low | MVP: emit `meta` kind for both shapes. Forward-compat. If session-final shape is detected (`subtype` ∈ `{success,error,cancelled,timeout}`), additionally enrich `sessionMeta` (status, durationMs, totalCost). L-followup. |
| R6 | **Project-key collisions** — paths with literal dashes (`/foo-bar/baz`) encode identically to `/foo/bar/baz`. | Low × Low | Adapter always prefers per-entry `cwd` over `decodeProjectDir`. The decode is display-only fallback. Documented in §5.2. |
| R7 | **CC version drift between sessions in one root** — a single root contains files written by CC 1.x and 2.x with different field names. | Medium × Low | All field reads are optional-chained; unknown shapes fall through to `unknown` kind. Adapter never throws. Sniff is structural (parse-shape), not version-based. |
| R8 | **Performance: 505 cc files × N entries** on first library load could push past M6 (2s p95 on top-10 opens). | Medium × Medium | Same caching strategy as pi (`SUMMARY_CACHE` keyed by mtime). First cold load is unavoidable; subsequent runs use cache. Measure during validation. If p95 > 2s, slice 5 adds a `--max-files` server flag for testing-only. |
| R9 | **CC entry without `cwd`/`sessionId`** breaks scanner row generation. | Low × Medium | Adapter `discover()` falls back to filename basename for `sessionId`. `cwd` defaults to `''` and is allowed empty in summaries (already true for pi error rows). |
| R10 | **Sidechain double-emission** — same subagent appears once in `agent-*.jsonl` and again inline as `isSidechain:true`. Could be counted twice in stats. | Low × Medium | Discover skips `agent-*.jsonl` files by default (matches lm-assist convention scout cites). Document the flag `--include-subagent-files` for an explicit follow-up. |

---

## 10 · Execution slicing (worker meta-prompt)

Six slices, each independently testable. After each slice, ALL of the following must pass before moving on:
- `node test/parser.test.js` (pi)
- `node test/api.test.js` (mixed, after slice 3)
- `node test/metrics.js` (pi, after every slice)

### Slice A — Split parser, no behavior change

**Goal:** Lift pi-specific normalization into `src/sources/pi.js` behind the adapter contract. Pure refactor; nothing about pi behavior changes.

**Files touched:**
- **new** `src/sources/index.js` (registry, `getSource`, `sniffSource`).
- **new** `src/sources/pi.js` (move existing `normalizeEntry`/`parseSessionText` from `parser.js`; add `id='pi'`, `defaultRoot()`, `discover(root)`, `decodeProjectDir`, `sniff`).
- **modify** `src/parser.js` (becomes dispatch shim, 30 LOC).
- **modify** `src/scanner.js` (keep `listSessionFiles`/`defaultSessionsRoot` unchanged; `decodeProjectDir` move-shim that calls `pi.decodeProjectDir` for backwards compat).

**Success criterion:** All existing tests pass with zero modifications. `git diff test/` is empty.

**Validation:** `node test/parser.test.js && node test/api.test.js && node test/metrics.js`.

---

### Slice B — CC adapter skeleton + simple-turn fixture

**Goal:** Get the most basic cc fixture parsing through the new dispatch path.

**Files touched:**
- **new** `src/sources/claude-code.js` (id='claude-code', `defaultRoot()` reads `CLAUDE_SESSIONS_DIR` ?? `~/.claude/projects`, `discover(root)` walks the dir, `decodeProjectDir`, `sniff`, `parseFile` covering only `user` + `assistant` + `unknown` kinds — NO tool correlation yet).
- **new** `src/sources/pricing.js` (price table + `costFor`).
- **modify** `src/sources/index.js` (register cc).
- **new** `fixtures/claude-code/cc-simple-turn.jsonl`.
- **new** `test/sources-claude-code.test.js` (one test: simple-turn).

**Success criterion:** `node test/sources-claude-code.test.js` passes the simple-turn case. Existing pi gates still green.

**Validation:** All three test files green.

---

### Slice C — CC tool correlation + Bash mapping

**Goal:** Pair `tool_use` ↔ `tool_result` by id; emit `toolResult` and `bashExecution` kinds.

**Files touched:**
- **modify** `src/sources/claude-code.js` (add tool-use registry pass; emit `toolResult`/`bashExecution`; handle `toolUseResult` wrapper).
- **new** `fixtures/claude-code/cc-tool-success.jsonl`.
- **new** `fixtures/claude-code/cc-multi-tool-use.jsonl`.
- **new** `fixtures/claude-code/cc-bash-success.jsonl`.
- **new** `fixtures/claude-code/cc-bash-error.jsonl`.
- **modify** `test/sources-claude-code.test.js` (add 4 tests).

**Success criterion:** Tool-correlation tests pass. Bash-error fixture triggers `failed_bash` signal.

**Validation:** `node test/sources-claude-code.test.js` + pi gates.

---

### Slice D — CC remaining kinds + sidechain + multi-shard + compaction

**Goal:** Cover `attachment_card`, `meta`, `session_meta`, `error`, `snapshot`, sidechain flag, multi-shard rollup, compaction (all 3 mechanisms).

**Files touched:**
- **modify** `src/sources/claude-code.js` (multi-shard pre-pass; sidechain flag; attachment/meta/error/snapshot/session_meta emission; compaction merging).
- **new** `fixtures/claude-code/cc-sidechain.jsonl`.
- **new** `fixtures/claude-code/cc-multi-shard-assistant.jsonl`.
- **new** `fixtures/claude-code/cc-attachment.jsonl`.
- **new** `fixtures/claude-code/cc-queue-operation.jsonl`.
- **new** `fixtures/claude-code/cc-malformed-line.jsonl`.
- **modify** `test/sources-claude-code.test.js` (add 5 tests).

**Success criterion:** All 10 cc fixture tests pass. Multi-shard usage rollup counts once.

**Validation:** `node test/sources-claude-code.test.js` + pi gates (R4 check).

---

### Slice E — API + scanner multi-source plumbing

**Goal:** Wire cc into the API and library. Add `source` field to summaries, support source-filter query, mixed-source search.

**Files touched:**
- **modify** `src/scanner.js` (`listSessionFilesMulti`, `defaultSessionsRoots`).
- **modify** `src/api.js` (`setSessionsRoots`, `listAllSummaries` mixed walk, `?source=` filter, source in summary).
- **modify** `src/summary.js` (`source` field on summary; `decodeProjectDir` lookup chain per §5.2; new fields: `attachmentCount`, `metaCount`, `sidechainCount`).
- **modify** `src/signals.js` (regex tweak in `verification_missing`; comment-document the cost contract).
- **modify** `test/api.test.js` (add 4 new tests per §8.3).

**Success criterion:** Mixed library lists both sources; source filter narrows; every summary has `source`; existing api tests pass.

**Validation:** All test files green; `node test/metrics.js` unchanged.

---

### Slice F — Server CLI + UI surface

**Goal:** Surface multi-source to the operator (CLI + UI).

**Files touched:**
- **modify** `server.js` (new flags: `--source`, `--pi-sessions`, `--claude-sessions`; env `CLAUDE_SESSIONS_DIR`; startup log per source).
- **modify** `public/index.html` (add `<select id="fSource">` with options `all`/`pi`/`claude-code`).
- **modify** `public/app.js` (source filter chip in library URL params; `source` badge on rows; sidechain badge on trace entries; new kinds in `treeLabel`/`entryHtml`/`renderInspector` for `session_meta`, `attachment_card`, `error`, `snapshot`, `meta`).
- **modify** `public/styles.css` (new kind/source/sidechain classes).
- **modify** `src/export-html.js` (parallel additions for the new kinds).
- **modify** `test/metrics.js` (split M8; add `--source` flag).
- **new** `docs/sources.md` (operator doc, ≤80 lines).
- **modify** `package.json` (add `test:cc` script; update `test:metrics:cc` script).

**Success criterion:** `node server.js` autodiscovers both sources, logs both. Library shows source column. Source filter works in UI. `node test/metrics.js --source claude-code` passes new M8-cc gate.

**Validation:** All previous test commands green + the 3 new metrics invocations. Manual smoke: open server, verify library mixes both, source filter works, trace shows sidechain badges, export renders cc sessions.

---

## Files to Modify (summary)

| File | Slices touched | Net LOC delta (estimate) |
|---|---|---|
| `src/parser.js`              | A | -200 (lifted out) |
| `src/scanner.js`             | A, E | +50 |
| `src/summary.js`             | E | +30 |
| `src/signals.js`             | E | +10 (regex + comments) |
| `src/api.js`                 | E | +40 |
| `src/export-html.js`         | F | +60 |
| `server.js`                  | F | +50 |
| `public/app.js`              | F | +120 |
| `public/index.html`          | F | +5 |
| `public/styles.css`          | F | +40 |
| `test/parser.test.js`        | A | +5 |
| `test/api.test.js`           | E | +50 |
| `test/metrics.js`            | F | +30 |
| `package.json`               | F | +3 |

## New Files

| File | Slice | Purpose |
|---|---|---|
| `src/sources/index.js`            | A | Registry + sniff + multi-root helper. |
| `src/sources/pi.js`               | A | Pi adapter (lifted from parser.js). |
| `src/sources/claude-code.js`      | B–D | Claude Code adapter. |
| `src/sources/pricing.js`          | B | Per-model price table + `costFor`. |
| `test/sources-claude-code.test.js`| B–D | CC adapter tests. |
| `fixtures/claude-code/*.jsonl`    | B–D | 9 fixtures, ~20KB total. |
| `docs/sources.md`                 | F | Operator doc. |

---

## Dependencies (slice order)

```
A (split parser) ──► B (cc skeleton) ──► C (tool/bash) ──► D (rest of cc) ──► E (api/scanner) ──► F (server/UI)
```

Each slice depends only on its predecessor. Any slice can be reviewed and merged independently if needed (each leaves the codebase green).

---

## Out of Scope (explicitly deferred)

| Item | Rationale |
|---|---|
| **Subagent visualization beyond a flag** | MVP shows a `subagent` badge + `agentId` on flagged entries. Dedicated sidechain timeline pane → L-followup. |
| **Attachment-card UI beyond collapsed default** | MVP collapses all `attachment_card` entries; subtype-specific renderers (diagnostics list, file diff, plan card) → L-followup. |
| **Cross-source "compare two sessions" view** | Single-source diff already absent; cross-source diff is a separate feature → L-followup. |
| **Cost-table maintenance UX** | MVP ships static JSON. UI-driven editor + monthly refresh script → L-followup. |
| **`/fork` cross-file ancestry traversal** | MVP treats every `.jsonl` as a standalone session. Walking `forkedFrom` chain to build a session tree → L-followup. |
| **`agent-*.jsonl` subagent file listing** | MVP skips them in discover. Surfacing them as their own library rows → L-followup. |
| **Live tail / mtime watcher** | Existing mtime-based cache invalidation is the only refresh mechanism. SSE live updates → L-followup. |
| **Microcompact UI distinct from compact** | Both render as `compaction` kind. Visual distinction → L-followup. |

---

## Open Questions (none blocking — all resolved)

The implementation-notes file (`implementation-notes/2026-06-04-claude-code-source-adapter.html`) had 5 open questions Q-1.1 through Q-1.5. The plan resolves them as follows:

| Q | Resolution |
|---|---|
| Q-1.1 (compaction equivalent) | §4: three mechanisms, priority-ordered, merging in ±2 lines. |
| Q-1.2 (queue-operation / ai-title / etc render?) | §2.2: emit as `meta` kind, collapsed by default. |
| Q-1.3 (one .jsonl = one session?) | §5–§6: yes, per CC schema §10. `/fork` produces a new file (out of scope for MVP). |
| Q-1.4 (token usage path) | §3.1: `message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}` → pricing table → `entry.cost`. |
| Q-1.5 (pi-specific signals) | §3 table: all signals classified. `compaction_heavy` and `failed_bash`/`repeated_failed_command` are forward-compat for cc but won't fire often per live-corpus profile. M8 split per §3.2. |

---

## Worker conduct (rules)

1. After each slice, run the validation commands listed in that slice. Do not start the next slice until they all pass.
2. Append an entry to `implementation-notes/2026-06-04-claude-code-source-adapter.html` per slice (D-* for any architecture decision made during execution, X-* for any deviation from this plan, T-* for tradeoffs). Use stable IDs.
3. Read-only invariant (M9) is sacrosanct. The cc adapter MUST never call `fs.writeFile` / `fs.appendFile` / `fs.utimes` etc. on any path under `~/.claude/projects/` or `~/.pi/agent/sessions/`. (M9 verifies this empirically.)
4. No new runtime dependencies. Node ≥18. `package.json` `dependencies` stays empty.
5. When citing line numbers, use scout-findings.md and claude-code-schema.md (e.g. `// scout-findings.md §3; schema §3.5`).
6. If a real-corpus surprise contradicts this plan (e.g. an attachment subtype we didn't enumerate), STOP and surface via `contact_supervisor` rather than guessing.
