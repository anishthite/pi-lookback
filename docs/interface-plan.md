# pi-lookback Interface Plan and Success Metrics

## Purpose

Build a local GUI for reviewing past pi sessions as rich traces: what the user said, what the agent did, which tools ran, where branches/compactions happened, and where the agent behavior can be improved.

The north-star question is:

> How quickly can I find a past session and understand the exact agent behavior I care about?

## Product principles

| Principle | Meaning |
|---|---|
| Trace-first | Treat sessions as structured execution traces, not only chat transcripts. |
| Local-first | Read pi session JSONL files from disk without modifying them. |
| Dense but navigable | Show maximum useful metadata with collapsible detail and fast filtering. |
| Branch-aware | Preserve pi's session tree instead of flattening history. |
| Improvement-oriented | Surface failed tools, repeated mistakes, corrections, high cost, and confusing paths. |

## Source data

Pi sessions are JSONL files under:

```txt
~/.pi/agent/sessions/--<project-path>--/<timestamp>_<uuid>.jsonl
```

Relevant entry/message types to render:

| Type | UI treatment |
|---|---|
| `session` | Session metadata: id, cwd, timestamp, parent session. |
| `message.role=user` | User prompt block. |
| `message.role=assistant` | Assistant response block with model, usage, stop reason, tool calls. |
| `message.role=toolResult` | Tool result block linked to the originating tool call. |
| `message.role=bashExecution` | Command execution block with output, exit code, truncation. |
| `message.role=custom` | Extension/custom event block. |
| `compaction` | Timeline marker with summary and tokens before compaction. |
| `branch_summary` | Branch marker with abandoned-path summary. |
| `custom` / `custom_message` | Extension state/message event. |
| `label` | Bookmark/label marker. |
| `model_change` | Model switch marker. |
| `thinking_level_change` | Thinking-level switch marker. |

## Recommended MVP architecture

Start with a local web app.

```txt
Node/TypeScript backend
  scans ~/.pi/agent/sessions
  parses JSONL
  builds trees and summaries
  serves API

React/Vite frontend
  renders session library
  renders trace viewer
  renders inspector
  handles search/filtering
```

Future packaging options:

- Tauri desktop app
- Electron app
- pi extension
- static exported HTML viewer

## Main screens

### 1. Session Library

A searchable overview of every discovered session.

Each row/card should show:

| Field | Purpose |
|---|---|
| Session name | User-defined name when present; fallback to first prompt. |
| Project path | Group sessions by repo/cwd. |
| Date/time | Find sessions temporally. |
| First user prompt | Fast recognition. |
| Duration | Estimate session size and effort. |
| Turn count | Conversation length. |
| Tool call count | Agent activity density. |
| Error count | Review priority. |
| Branch count | Exploration/branching complexity. |
| Compaction count | Long-context indicator. |
| Models used | Compare behavior by model. |
| Total tokens/cost | Cost review. |
| Review-worthy score | Rank sessions worth inspecting. |

Filters:

- Project
- Date range
- Model/provider
- Tool used
- Has errors
- Has branches
- Has compactions
- High cost
- Long duration
- User correction detected

Search should cover:

- User prompts
- Assistant text
- Tool names
- Tool arguments
- Bash commands
- Tool output previews
- Project paths
- Session names

### 2. Trace View

The primary session inspection page.

```txt
┌─────────────────────────────────────────────────────────────┐
│ Top bar: session name, project, date, model, cost, export   │
├───────────────┬───────────────────────────┬─────────────────┤
│ Timeline/Tree │ Conversation Trace        │ Inspector       │
│               │                           │                 │
└───────────────┴───────────────────────────┴─────────────────┘
```

#### Left panel: Timeline / tree

Render the `id` / `parentId` structure as a navigable branch tree.

Badges:

| Badge | Color intent |
|---|---|
| User | Blue |
| Assistant | Purple |
| Tool call | Amber |
| Tool result | Gray |
| Error | Red |
| Branch | Green |
| Compaction | Cyan |
| Model change | Pink |
| Custom event | Indigo |

Clicking an item scrolls to the corresponding trace block and opens it in the inspector.

#### Center panel: Conversation trace

Render each event as a collapsible block.

User block:

- Full prompt
- Timestamp
- Entry id
- Parent id
- Copy prompt button
- Find similar prompts action

Assistant block:

- Assistant text
- Thinking block toggle when present
- Model/provider/api
- Usage and cost
- Stop reason
- Tool calls emitted by the message

Tool call block:

- Tool name
- Argument preview
- Status
- Linked result
- Expandable raw JSON

Tool result block:

- Success/error state
- Output preview
- Truncation marker
- Full output path when present
- Search within output

Bash execution block:

- Command
- Exit code
- Cancelled/truncated flags
- Output preview
- Full output path when present

Compaction/branch/model/custom blocks:

- Render as timeline markers with expandable metadata.

#### Right panel: Inspector

The inspector shows raw and derived metadata for the selected event.

| Event | Inspector fields |
|---|---|
| User prompt | Raw content, timestamp, id, parent id, prompt length, branch path, next assistant response. |
| Assistant message | Provider, model, API, stop reason, usage, cost breakdown, tool call ids, text length. |
| Tool result | Tool name, call id, error flag, output size, truncation, details, linked assistant entry. |
| Bash execution | Command, exit code, cancelled, truncated, output size, full output path. |
| Compaction | Summary, tokens before, first kept entry, details. |
| Branch summary | From id, summary, branch relationship, details. |

### 3. Session Analysis Panel

A sticky or tabbed summary for the selected session.

Metrics:

- Total entries
- Conversation turns
- User messages
- Assistant messages
- Tool calls
- Failed tool results
- Bash commands
- Failed bash commands
- Branch count
- Compaction count
- Model switches
- Thinking-level switches
- Total tokens
- Total cost
- Duration
- Longest delay between entries
- Top tools used
- Most expensive assistant message

### 4. Improvement Signals

Flag sessions and trace points that are useful for improving agent behavior.

| Signal | Detection heuristic |
|---|---|
| Failed tool call | `toolResult.isError=true` or bash `exitCode` non-zero. |
| Repeated failed command | Same normalized command fails 2+ times in one session. |
| User correction | User message contains phrases like `no`, `not that`, `wrong`, `you forgot`, `actually`, `fix`, `I said`. |
| Long no-tool stretch | Assistant messages exceed threshold before first useful tool call in implementation-shaped session. |
| High-cost session | Total cost exceeds configurable threshold. |
| Branch-heavy session | Branch count exceeds configurable threshold. |
| Compaction-heavy session | Compaction count exceeds configurable threshold. |
| Tool-output overload | Tool output size exceeds threshold or marked truncated. |
| Aborted/error assistant stop | Assistant `stopReason` is `error` or `aborted`. |
| Verification missing | Implementation-shaped session ends without test/lint/build/tool validation. |

### 5. Replay Mode

A step-through mode that replays the session as a trace:

```txt
User asked → Assistant responded → Tool called → Tool returned → Assistant continued
```

Controls:

- Step forward/back
- Jump to next error
- Jump to next branch
- Jump to next user correction
- Toggle raw metadata

### 6. Export and annotation

MVP export:

- Export visible session to standalone HTML.
- Copy user prompt, tool command, tool args, assistant answer.

Later:

- Redacted export
- Session annotations
- Bookmarks
- Tags
- Saved searches
- Compare two sessions
- AI-generated session review

## Data model sketch

```ts
type SessionSummary = {
  id: string;
  filePath: string;
  cwd: string;
  name?: string;
  startedAt: string;
  endedAt?: string;
  firstPrompt?: string;
  entryCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  failedToolCallCount: number;
  bashCommandCount: number;
  failedBashCommandCount: number;
  branchCount: number;
  compactionCount: number;
  modelSwitchCount: number;
  totalTokens: number;
  totalCost: number;
  reviewScore: number;
};

type TraceEntry = {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  timestamp: string;
  title: string;
  preview: string;
  raw: unknown;
  children: string[];
  derived: {
    hasError: boolean;
    tokenCount?: number;
    cost?: number;
    outputBytes?: number;
    toolName?: string;
    model?: string;
  };
};
```

## Build phases

### Phase 1 — Minimal viewer

Goal: inspect real sessions without opening JSONL manually.

Deliverables:

- Session scanner
- Session list
- JSONL parser
- Trace tree
- Conversation view
- Inspector panel
- Basic error handling

### Phase 2 — Useful observability

Goal: understand a session quickly.

Deliverables:

- Token/cost stats
- Tool call summaries
- Error highlighting
- Branch visualization
- Compaction markers
- Search/filtering
- HTML/JSON export

### Phase 3 — Improvement insights

Goal: identify ways to improve prompts, tools, and agent behavior.

Deliverables:

- Heuristic warning badges
- Review-worthy score
- User correction detection
- Failed command clustering
- Repeated tool call detection
- Missing verification detection
- Session outcome summary

### Phase 4 — Power features

Goal: make lookback a durable workflow tool.

Deliverables:

- Notes/annotations
- Bookmarks
- Tags
- Compare sessions
- Replay mode
- Prompt pattern library
- Saved searches
- Redacted share/export
- Optional AI-generated session review

## Quantifiable success metrics

### MVP acceptance gate

The MVP is successful when all of these are true:

| # | Requirement | Target | Measurement method |
|---:|---|---:|---|
| 1 | Real sessions loaded | ≥ 100 sessions or all available if fewer | Run scanner against `~/.pi/agent/sessions`. |
| 2 | Valid JSONL parse success | ≥ 98% | Count valid session files parsed without crash. |
| 3 | User/assistant/tool events rendered | 100% of parsed events | Compare rendered event counts to parser counts. |
| 4 | Known session find time | < 10 seconds | Manual timed test using project/date/search. |
| 5 | Failed tool call find time | < 10 seconds | Manual timed test inside a known failing session. |
| 6 | Large session open time | < 2 seconds | Measure p95 open latency for top 10 largest sessions. |
| 7 | Search latency | < 300 ms p95 | Browser/client timing over indexed sessions. |
| 8 | Improvement signals surfaced | ≥ 5 signal types | Verify badges for errors, repeats, corrections, cost, compaction/branches. |
| 9 | Read-only safety | 0 writes to session files | File mtime check before/after browsing. |
| 10 | JSONL alternative value | User prefers GUI over raw JSONL | Manual acceptance after reviewing 5 real sessions. |

### Session coverage metrics

| Metric | Target | Measurement method |
|---|---:|---|
| Session discovery coverage | 100% of valid JSONL files | Compare `find ~/.pi/agent/sessions -name '*.jsonl'` count to indexed count. |
| Parse success | ≥ 98% | Parse all files; report failures separately. |
| Corrupt session handling | 100% shown with useful error | Inject malformed JSONL fixture. |
| Metadata extraction | ≥ 95% | Count sessions with cwd, id, timestamp, name/first prompt. |

### Trace completeness metrics

| Metric | Target | Measurement method |
|---|---:|---|
| User messages displayed | 100% | Count parser user messages vs rendered blocks. |
| Assistant messages displayed | 100% | Count parser assistant messages vs rendered blocks. |
| Tool calls displayed | 100% | Count assistant `toolCall` blocks vs rendered blocks. |
| Tool results displayed | 100% | Count `toolResult` messages vs rendered blocks. |
| Bash executions displayed | 100% | Count `bashExecution` messages vs rendered blocks. |
| Compactions displayed | 100% | Count `compaction` entries vs rendered markers. |
| Branches represented | 100% | Count entries with multiple children vs tree branch nodes. |
| Model/thinking changes displayed | ≥ 95% | Count change entries vs rendered markers. |

### Time-to-answer metrics

| Review question | Target | Measurement method |
|---|---:|---|
| Find a session by project/date/search | < 10 sec | Timed manual test. |
| Find the first user prompt | < 3 sec | Timed manual test after opening session. |
| Find all failed tool calls | < 10 sec | Timed manual test using error navigation/filter. |
| Find tools/files touched | < 15 sec | Timed manual test; files depend on detectable tool args/output. |
| Find user correction points | < 30 sec | Timed manual test using correction heuristic badges. |
| Understand rough session outcome | < 60 sec | Timed manual test using summary panel and final trace blocks. |

### UI performance metrics

| Metric | Target | Measurement method |
|---|---:|---|
| App startup | < 2 sec | Cold start to first meaningful render. |
| Session library render | < 2 sec for 1,000 sessions | Seed/mock 1,000 summaries. |
| Normal session open | < 500 ms p95 | Measure sessions below median entry count. |
| Huge session open | < 2 sec p95 | Measure top 10 largest sessions. |
| Search latency | < 300 ms p95 | Measure query-to-results update. |
| Expand/collapse latency | < 100 ms | Measure interaction response. |
| Scroll smoothness | 50-60 FPS perceived | Manual and browser performance check. |

### Information density metrics

| Metric | Target | Measurement method |
|---|---:|---|
| Library stats visible before opening | ≥ 8 stats | Count fields in session row/card. |
| Inspector metadata fields for rich events | ≥ 10 fields | Count fields for assistant/tool/bash events. |
| Collapsed tool summary fields | ≥ 4 fields | Tool name, status, arg preview, result status. |
| Cost/token visibility | Session + assistant message level | UI inspection. |
| Error indicators in timeline | 100% of failed entries | Compare failed entry count to visible badges. |

### Search usefulness metrics

| Metric | Target | Measurement method |
|---|---:|---|
| Search user prompts | Supported | Query fixture text. |
| Search assistant text | Supported | Query fixture text. |
| Search tool names | Supported | Query tool names like `bash`, `grep`, `subagent`. |
| Search bash commands | Supported | Query known command string. |
| Search output previews | Supported | Query fixture output text. |
| Faceted search | Project, model, date, error | UI/API tests. |
| Relevant session in top 5 | ≥ 80% | Manual 20-query test set. |

### Improvement insight metrics

| Metric | Target | Measurement method |
|---|---:|---|
| Failed tool detection | 100% | Compare against `isError` and non-zero bash exit codes. |
| Repeated failed command detection | ≥ 90% | Fixture sessions with repeated normalized commands. |
| User correction recall | ≥ 70% | Manual labeled set of correction-like user messages. |
| High-cost flagging | Configurable threshold works | Unit test threshold boundary. |
| Branch/compaction flagging | 100% | Compare counts to session entries. |
| Review-worthy ranking quality | Top 10 includes ≥ 5 genuinely interesting sessions | Manual review against local session corpus. |

### Reliability metrics

| Metric | Target | Measurement method |
|---|---:|---|
| Browsing crash rate | 0 known crashes | Manual pass across representative sessions. |
| Unknown entry handling | 100% graceful | Fixture with unknown entry type. |
| Huge output freeze prevention | 100% collapsed/lazy-loaded | Fixture with large tool output. |
| Missing field tolerance | 100% graceful | Fixture with optional fields omitted. |
| Session file mutation | 0 writes | File mtime/hash before and after browsing. |

### Export metrics

| Metric | Target | Measurement method |
|---|---:|---|
| Export session to HTML | Supported | Manual export smoke test. |
| Export visible trace fidelity | ≥ 95% of visible blocks | Compare exported block count to UI block count. |
| Copy actions | Prompt, command, args, answer | Manual UI smoke test. |
| Redaction support | Later phase | Track as Phase 4 requirement. |

## Measurement fixtures

Create a small fixture corpus for automated testing:

| Fixture | Contents |
|---|---|
| `simple-linear.jsonl` | User, assistant, no tools. |
| `tool-success.jsonl` | Assistant tool call and successful tool result. |
| `tool-error.jsonl` | Failed tool result. |
| `bash-failure.jsonl` | Non-zero bash execution. |
| `branching.jsonl` | Multiple children from one parent. |
| `compaction.jsonl` | Compaction entry with first kept id. |
| `unknown-entry.jsonl` | Unknown entry type rendered gracefully. |
| `huge-output.jsonl` | Large output that must be collapsed/lazy-loaded. |
| `corrupt.jsonl` | Malformed line reported without crashing. |

## Definition of done for the first implementation

- Load real sessions from `~/.pi/agent/sessions` without mutating them.
- Render library, trace tree, conversation blocks, and inspector.
- Preserve branch and compaction visibility.
- Surface errors and at least five improvement signals.
- Meet the MVP acceptance gate above.
- Provide fixture tests for parser completeness and graceful failure.
