# pi-lookback

A local GUI for reviewing past **pi** agent sessions as rich execution traces.
Read-only, single-binary (`node server.js`), no npm install needed.

> "How quickly can I find a past session and understand the exact agent behavior I care about?"

## What it shows

For every JSONL session under `~/.pi/agent/sessions/`:

- **Library view** — all sessions with first prompt, project path, models, token/cost, branch count, compaction count, error count, review-worthy score. Sortable by recency/cost/duration/errors/score. Filterable by project, model, has-errors, has-branches, has-compactions.
- **Session view** — three-pane: timeline tree (left), conversation trace (center), inspector (right). Renders `user`, `assistant`, `toolResult`, `bashExecution`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change`, `custom`, `custom_message` natively; unknown types are rendered as raw JSON.
- **Improvement signals** — failed tools, failed bash, repeated failed commands, user-correction phrases, long no-tool stretches, high cost, branch-heavy, compaction-heavy, huge / truncated outputs, aborted assistant, verification-missing.
- **Search** — across user prompts, assistant text, tool names, tool arguments, bash commands, output previews, models, project paths.
- **Export** — single self-contained HTML for any session.

## Example: finding a failed file read

Imagine a short session where the user asks the agent to read a file that does
not exist. The session trace in pi-lookback looks like this:

```text
10:00:01  User       read file
10:00:02  Assistant  read({ path: "/missing" })
10:00:03  Tool       ENOENT: no such file   ← error
```

Its library row and session inspector make the important context visible at a
glance:

| Field | Value |
| --- | --- |
| Project | `/tmp/fixt` |
| Duration | 3 seconds |
| Events | 3 |
| Tool calls | 1 |
| Tool failures | 1 |
| Review score | 4 |
| Improvement signal | `Tool read returned error` |

From there you can inspect the exact tool arguments and error output, search
for related sessions or commands, jump between errors and signals, and export
the session as a standalone HTML report. The app never modifies the original
session files.

## Quick start

```bash
cd pi-lookback
node server.js                       # default http://127.0.0.1:7878
node server.js --port 9000           # change port
node server.js --sessions /path/x    # point at a different sessions dir
```

Open the URL printed in the terminal. No build step. Node ≥ 18.

## Tests

```bash
node test/parser.test.js   # parser + summary + signals against the fixture corpus
node test/api.test.js      # HTTP API smoke against the fixture corpus
node test/metrics.js       # MVP acceptance-gate verification against ~/.pi/agent/sessions
```

`metrics.js` runs all quantitative gates from `docs/interface-plan.md`
(parse rate, render coverage, search latency, large-session-open p95, signal
diversity, read-only safety) and emits `metrics-report.json`.

Latest measured run against 352 real sessions:

| Gate | Target | Measured |
| --- | --- | --- |
| Real sessions loaded | ≥100 | **352 / 352 on disk** |
| Parse success | ≥98% | **100.000% lines** |
| Events rendered = parsed | 100% | **4844 / 4844** |
| Large session open p95 | <2 s | **37 ms** (max 844 entries) |
| Search latency p95 | <300 ms | **18 ms** |
| Signal types surfaced | ≥5 | **8 kinds** |
| Read-only safety | 0 mtime changes | **0 / 50** |
| Library row stats | ≥8 fields | **9 / 9** |
| Failed tools surfaced | 100% | **225 / 225** |

## Architecture

```
server.js               # Node http server (no deps)
src/scanner.js          # recursive *.jsonl discovery
src/parser.js           # tolerant JSONL → normalized entry objects
src/summary.js          # session-level aggregate metrics
src/signals.js          # 10 improvement-signal heuristics
src/api.js              # cached library + detail + search + stats
src/export-html.js      # standalone HTML session export
public/index.html       # single-page app
public/app.js           # vanilla JS, three views (library/session/search)
public/styles.css
fixtures/               # 9 fixture session files exercising every code path
test/parser.test.js     # parser/summary/signals tests
test/api.test.js        # API smoke tests
test/metrics.js         # acceptance-gate verifier (emits metrics-report.json)
```

## Read-only guarantee

The server only reads under the configured sessions root (default `~/.pi/agent/sessions`).
Verified by `test/metrics.js` gate M9 — 50 file mtimes captured before browsing,
0 changes after a representative session.

## Limitations / known scope (MVP)

- No annotations / bookmarks / saved searches (Phase 4 from `docs/interface-plan.md`).
- No "compare two sessions" UI yet.
- Replay-mode controls are not present; you can navigate signals/errors with the
  `◀ signal / signal ▶` and `◀ error / error ▶` buttons in the session topbar.
- Branch visualization is the parentId tree with branch-parent markers, not a
  full dagre/elk graph.
- Token/cost are taken from per-assistant-message `usage` blocks recorded by pi;
  files without `usage` show 0.
