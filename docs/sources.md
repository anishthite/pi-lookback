# Source adapters

pi-lookback ingests session JSONL through a pluggable **source adapter** layer (`src/sources/`). Two adapters ship in-tree today:

| id            | default root                              | env override          |
|---------------|-------------------------------------------|-----------------------|
| `pi`          | `~/.pi/agent/sessions/`                   | `PI_SESSIONS_DIR`     |
| `claude-code` | `~/.claude/projects/`                     | `CLAUDE_SESSIONS_DIR` |

## CLI

```sh
node server.js                          # both sources, autodiscovered
node server.js --source pi              # pi only
node server.js --source claude-code     # cc only
node server.js --source both            # explicit both (same as default)
node server.js --pi-sessions <dir>      # override pi root
node server.js --claude-sessions <dir>  # override cc root
node server.js --sessions <dir>         # legacy single-root mode (auto-sniffs)
```

The library view mixes both sources by default; use the **Source** filter in the toolbar (or `?source=pi`/`?source=claude-code` in the URL) to narrow.

## API

| field           | type                | notes |
|-----------------|---------------------|-------|
| `source`        | `'pi'\|'claude-code'` | tagged on every summary, search result, and entry |
| `sidechain`     | `boolean`           | true on cc subagent entries; pi always false |
| `agentId`       | `string\|null`      | cc-only; UI shows it as a badge |
| `attachmentCount`, `metaCount`, `sidechainCount`, `errorEventCount`, `snapshotCount` | `number` | cc-source rollups; always 0 on pi sessions |

The summary cache (`SUMMARY_CACHE` in `src/api.js`) is keyed by absolute file path, so the two sources never collide even when their roots overlap.

## Adapter contract

Every `src/sources/<id>.js` exports:

```js
module.exports = {
  id,                 // string source identifier
  defaultRoot,        // () => absolute path string
  discover,           // (root) => Iterable<{filePath, source, projectKey?, isSubagent?}>
  parseFile,          // (filePath) => ParsedSession
  decodeProjectDir,   // (dirname) => string  (best-effort cwd recovery)
  sniff,              // (filePath, firstLine?) => boolean
};
```

`ParsedSession` is `{ entries, parseErrors, sessionMeta, filePath, source }`. Each entry has at minimum `{ id, parentId, timestamp, kind, raw, source, sidechain }`; per-kind fields are documented in `src/sources/<id>.js` and consumed downstream (`summary.js`, `signals.js`, `public/app.js`, `src/export-html.js`).

The registry `src/sources/index.js` provides `getSource(id)`, `listSources()`, `defaultRoots()`, and `sniffSource(filePath)` for first-line content sniffing.

## Cost computation (cc only)

pi sessions carry `message.usage.cost.total` directly. Claude Code sessions only carry token counts; `src/sources/pricing.js` holds a per-model USD-per-million table and exposes `costFor(model, usage)`. Unknown models log once and yield `cost: null` — the `high_cost` signal then skips them rather than miscounting.

To add or update model pricing, edit the `PRICES` map in `src/sources/pricing.js`. Prefix matching is built-in: `claude-opus-4-5-99999999` falls back to `claude-opus-4-5` automatically.

## Known Bash-tool limitation

Claude Code's Bash tool does not emit a native exit code. The adapter infers failure via three signals in priority order:

1. `toolUseResult.interrupted === true` → `exitCode = -1`, `cancelled = true`
2. `toolUseResult.isError === true` (or `tool_result.is_error`) → `exitCode = 1`
3. Output text matches `/^Error:|^Traceback|exit (status|code) N/m` → `exitCode = 1`
4. Otherwise → `exitCode = null` (treated as success by `failed_bash`)

Real failures with none of these signals (rare — a script that exits 1 silently) will not trigger `failed_bash`. Fixture `cc-bash-error.jsonl` locks the heuristic in.

## Adding a third source

1. Drop `src/sources/<new-id>.js` implementing the contract above.
2. Require it from `src/sources/index.js`.
3. Add an env-var lookup to `defaultSessionsRoots` in `src/scanner.js`.
4. Add a CLI flag pair to `server.js` (`--<new-id>-sessions`) and the help text.
5. (Optional) Add summary-side rollups + UI badge.
6. Author fixtures under `fixtures/<new-id>/` and a `test/sources-<new-id>.test.js`.

The rest of the pipeline (summary, signals, library, search, export, metrics) is source-agnostic and will pick up the new adapter automatically.
