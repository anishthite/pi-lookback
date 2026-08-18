# Claude Code Session JSONL — Schema Reference for pi-lookback Adapter

> Spec for the Claude Code source adapter. Authoritative refs: empirically-derived schemas in `glebmish/claude-code-replay/docs/log-format.md` (verified 2026-05-27), `jamie-bitflight/claude_skills/.../session-log-schema.md` (verified 2026-03-24, 500-file scan), `neilberkman/ccrider/research/schema.md`, the official TypeScript types in `pedropaulovc/claude-code-types`, and `anthropics/claude-agent-sdk-python:_internal/session_summary.py`. No Anthropic-published spec exists; field set has drifted across CC versions (1.0.33 → 2.0.29+). Treat unknown fields as forward-compatible.

> **Note:** This subagent did not have shell access to enumerate `~/.claude/projects/` directly. The schema below is compiled from four independent reverse-engineering projects that each scanned hundreds to thousands of real session files, plus the official `claude-agent-sdk-python` source. Where the four sources agree it is treated as fact; where they diverge it is flagged.

---

## 1. On-disk layout

```
~/.claude/
├── projects/
│   └── <project-key>/
│       ├── <session-uuid>.jsonl              ← main session
│       ├── agent-<short-id>.jsonl            ← top-level subagent (no parent session ctx)
│       └── <session-uuid>/
│           └── subagents/
│               └── agent-<short-id>.jsonl    ← nested subagent
├── history.jsonl                              ← global command history (NOT session data)
├── file-history/<opaque-hash>/<backupFileName> ← raw file bytes for undo, no envelope
├── tasks/<list-id>/<task-id>.json
├── plans/<plan-name>.md
└── teams/<team-name>/config.json
```

XDG alt: `~/.config/claude/projects/` (ccusage). Glob: `~/.claude/projects/**/*.jsonl`.

### 1.1 Project key encoding (D-1 — recover original cwd)

Single rule, applied in JS as `path.replace(/[:\\/]/g, '-')`:

| Platform | cwd                          | project-key                   |
|---|---|---|
| macOS    | `/Users/anishthite/workspace/bondu` | `-Users-anishthite-workspace-bondu` |
| Linux    | `/home/x/repos/myproject`    | `-home-x-repos-myproject`     |
| Windows  | `C:\home\project`            | `C--home-project`             |

- POSIX paths get a **leading dash** (because they start with `/`).
- All `/`, `\`, and `:` are replaced with `-`.
- The transform is **lossy** for ambiguous originals (`foo-bar` vs `foo/bar` both encode the same way). Recovery: split on `-`, reinsert `/` between segments; for POSIX prepend `/`. Fall back to `cwd` field on any entry in the file for ground truth.

### 1.2 Session-file convention (lm-assist `SessionReader.listSessions`)

```js
if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;
```

`*.jsonl` directly in `<project-key>/` is a main session.
`agent-*.jsonl` is a subagent. Skip when listing, surface separately if needed.

---

## 2. Top-level entry-type catalog

Union from `pedropaulovc/claude-code-types:TranscriptEntry` (most complete spec). The user's working set was a subset.

| `type`                  | Required? | UI? | Description |
|---|---|---|---|
| `user`                  | core | render | Human prompt or tool result delivered to model. |
| `assistant`             | core | render | Model response (text / thinking / tool_use). |
| `system`                | core | partial | Internal events keyed by `subtype` (see §3.3). |
| `attachment`            | common | partial | Context injection (hooks, skills, diagnostics, etc.). 27+ subtypes. |
| `summary`               | common | timeline marker | Top-level compaction summary: `{type, summary, leafUuid}`. Conversation-replacing. |
| `file-history-snapshot` | common | optional marker | Undo checkpoint at turn boundary. |
| `progress`              | common | fold | Streaming subagent/Task updates. **CAN BE MULTI-MB.** |
| `permission-mode`       | sparse | metadata | Permission mode change: `{permissionMode, sessionId}`. |
| `mode`                  | sparse | metadata | Interaction mode change (observed: `"normal"`). |
| `ai-title`              | sparse | session card | AI-generated session title. |
| `custom-title`          | sparse | session card | User-assigned title. |
| `agent-name`            | sparse | metadata | Agent name binding for the session. |
| `agent-setting`         | sparse | metadata | Active agent definition (e.g. `"claude"`). |
| `last-prompt`           | sparse | skip | Bookkeeping for resume: `{lastPrompt, leafUuid, sessionId}`. |
| `queue-operation`       | sparse | fold | User-queued messages while turn is in flight. |
| `bridge-session`        | sparse | metadata | Remote-control bridge link. |
| `pr-link`               | sparse | session card | PR created/linked. |
| `worktree-state`        | sparse | metadata | Git worktree binding. |
| `started`               | sparse | skip | Workflow-step journal start, paired with `result` by `key`. |
| `result`                | rare/ambiguous | skip or session card | **Two distinct shapes in the wild — see §3.10.** |
| `saved_hook_context`    | sparse | skip | Persisted hook output (note: underscored, unlike all sibling kebab-case types). |

**Confirming the user's list:** the user-listed types (user, assistant, system, attachment, permission-mode, file-history-snapshot, ai-title, last-prompt, queue-operation) are real but **non-exhaustive**. Add at least: `summary`, `progress`, `mode`, `custom-title`, `agent-name`, `agent-setting`, `bridge-session`, `pr-link`, `worktree-state`, `started`, `result`, `saved_hook_context`. Adapter MUST tolerate unknown `type` values gracefully (pass through to `kind: "unknown"`).

---

## 3. Per-type field map

### 3.1 `EntryBase` (shared by user / assistant / attachment; partial on system / progress / saved_hook_context)

| Field          | Type                  | Req | Notes |
|---|---|---|---|
| `type`         | enum (above)          | ✓ | Discriminator. |
| `uuid`         | string (uuidv4)       | ✓ | This entry's id. Optional on `system`/`progress`. |
| `parentUuid`   | string \| null        | ✓ | Parent in conversation tree. `null` only at root. |
| `sessionId`    | string                | ✓ | Matches filename basename for main sessions. |
| `timestamp`    | ISO-8601 string       | ✓ | Lexicographically sortable. Optional on a few side types. |
| `cwd`          | absolute path         | ✓ | **May change mid-session** (user cd'd). Trust the per-entry value. |
| `version`      | string e.g. `"2.0.29"` | ✓ | Claude Code CLI version. **May change mid-session** if CC was upgraded between resumes. |
| `gitBranch`    | string                | ✓ | Empty string if not in a git repo. Can change mid-session. |
| `userType`     | `"external"`          | ✓ | Currently a constant. |
| `isSidechain`  | boolean               | ✓ | True on subagent/branch entries. See §4. |
| `agentId`      | string                | opt | Set on subagent-produced entries (e.g. `"a4044e6"`). |
| `agentName`    | string                | opt | Subagent name (e.g. `"implementer"`). |
| `slug`         | string                | opt | Project slug from cwd. |
| `sessionKind`  | `"bg"` \| other       | opt | `"bg"` = background/detached session. |
| `teamName`     | string                | opt | Multi-agent team binding. |
| `entrypoint`   | string                | opt | e.g. `"cli"`. Usually only on first entry of a session. |
| `forkedFrom`   | `{sessionId, messageUuid}` | opt | Set when this session was forked from another. |

### 3.2 `user` entry — adds:

| Field          | Type    | Req | Notes |
|---|---|---|---|
| `message`      | `{role:"user", content: string \| UserContentBlock[]}` | ✓ | `content` may be bare string OR array. Adapter must handle both. |
| `promptId`     | string  | opt | Groups all entries spawned by one user prompt turn. Useful for "show me everything triggered by prompt X". |
| `isCompactSummary` | boolean | opt | **TRUE = this user message is a compaction summary** replacing earlier history. Render as compaction marker, not as a user prompt. |
| `isMeta`       | boolean | opt | System-injected user message (e.g. local-command-caveat). |
| `isVisibleInTranscriptOnly` | boolean | opt | UI-only; not sent to API. |
| `interruptedMessageId` | string (`msg_…`) | opt | Anthropic message id this user message interrupted. |
| `imagePasteIds`| string[] | opt | Image attachments pasted by user. |
| `toolUseResult`| any     | opt | Present when this user msg delivers a tool result. Often duplicated in `message.content[]` as a `tool_result` block. Shape varies by tool — see §3.2.1. |
| `sourceToolUseID` | string | opt | The `tool_use.id` this user msg is the result for. |
| `sourceToolAssistantUUID` | string | opt | The assistant entry's `uuid` whose `tool_use` triggered this. Redundant with `parentUuid` in well-formed chains but defensively present. |
| `thinkingMetadata` | `{level, disabled, triggers[]}` | opt | Per-turn thinking-budget config. |
| `permissionMode` | enum | opt | Snapshot of permission mode at this point. |
| `planContent`  | string  | opt | Set on `ExitPlanMode` turn. |
| `todos`        | `Todo[]` | opt | TodoWrite snapshot. |
| `origin`       | `{kind:string}` | opt | e.g. task notification injection. |

**User-message classification heuristic** (from LM-Assist `session-cache.ts:33`):

| Text prefix                          | `promptType`     | Real prompt? |
|---|---|---|
| (none) or any other prefix           | `user`           | yes |
| `<command-name>` / `<command-message>` | `command`      | yes (slash command) |
| `<local-command-stdout>`             | `command_output` | no |
| `<local-command-caveat>` or `isMeta` | `system_caveat`  | no |
| `<user-prompt-submit-hook>`          | `hook_result`    | no |

#### 3.2.1 `toolUseResult` shape per tool

| Tool             | Shape |
|---|---|
| `Bash`           | `{stdout, stderr, interrupted, isImage}` |
| `WebFetch`       | `{bytes, code, codeText, result, durationMs, url}` |
| `TodoWrite`      | `{oldTodos: Todo[], newTodos: Todo[]}` |
| `Read`           | string (cat-n formatted, may end in `[Lines M-N omitted]`) — see §6 |
| `Task`           | wrapped: `{tool_use_id, content}` (different from flat content) |
| anything else    | string OR object; treat as opaque |

### 3.3 `assistant` entry — adds:

| Field          | Type    | Req | Notes |
|---|---|---|---|
| `message`      | `AssistantMessage` (below) | ✓ | |
| `requestId`    | string `"req_…"` | opt | Anthropic API request id. |
| `isApiErrorMessage` | boolean | opt | True when API failed; `message.content[0]` is a synthetic text block. |
| `apiError` / `apiErrorStatus` / `errorDetails` / `error` | various | opt | Failure metadata. `apiErrorStatus` is HTTP status. |
| `attributionAgent` | string | opt | e.g. `"general-purpose"`. |
| `attributionMcpServer` / `attributionMcpTool` / `attributionPlugin` / `attributionSkill` | string | opt | Origin of this response. |

#### `AssistantMessage` (the `message` value):

| Field          | Type    | Req | Notes |
|---|---|---|---|
| `id`           | string `"msg_…"` | opt | Anthropic message id. **Multiple JSONL lines can share one `id`** when content blocks were split into separate entries. |
| `type`         | `"message"` | opt | |
| `role`         | `"assistant"` | ✓ | |
| `model`        | string  | opt | e.g. `"claude-sonnet-4-5-20250929"`, `"claude-opus-4-5-20251101"`, `"<synthetic>"`. **Per-message**; can change mid-session. |
| `content`      | `AssistantContentBlock[]` | ✓ | See §3.5. |
| `stop_reason`  | enum    | nullable | `end_turn` \| `max_tokens` \| `stop_sequence` \| `tool_use` \| `pause_turn` \| `refusal`. Null during stream. |
| `stop_sequence`| string \| null | opt | |
| `stop_details` | unknown | opt | Beta. |
| `usage`        | `Usage` | opt | See §3.6. |
| `container`    | unknown | opt | Code-execution beta. |
| `context_management` | unknown | opt | Context-editing beta. |
| `diagnostics`  | object  | opt | Prompt-cache diagnostics. |

### 3.4 `system` entry — `Partial<EntryBase>` plus:

| Field      | Type | Req | Notes |
|---|---|---|---|
| `subtype`  | `SystemSubtype` | ✓ | See enum. |
| `content`  | string | opt | XML-formatted for `local_command`. |
| `level`    | `"info"\|"warning"\|"error"` | opt | |
| `isMeta`   | boolean | opt | |
| `logicalParentUuid` | string | opt | Parent override for in-graph tools. |
| `toolUseID` | string | opt | |

**`SystemSubtype` enum (exhaustive in known sources):**

| Subtype              | Extra fields | Render-worthy |
|---|---|---|
| `init`               | `cwd`, `session_id`, `tools[]`, `mcp_servers[]`, `model`, `permissionMode`, `slash_commands[]`, `claude_code_version`, `output_style`, `agents[]`, `plugins[]` | yes — session card |
| `compact_boundary`   | `compactMetadata` (§3.7) | **yes — compaction marker** |
| `microcompact_boundary` | `microcompactMetadata` (§3.7) | yes — micro-compaction marker |
| `turn_duration`      | `durationMs`, `messageCount`, `pendingBackgroundAgentCount`, `pendingWorkflowCount` | optional — turn metric |
| `stop_hook_summary`  | `hookCount`, `hookErrors[]`, `hookInfos[]`, `hasOutput`, `stopReason`, `preventedContinuation` | fold |
| `api_error`          | `error`, `cause`, `retryAttempt`, `retryInMs`, `maxRetries` | **yes — error** |
| `bridge_status`      | `url` | metadata |
| `away_summary`       | `content` (recap text) | optional — visible "where was I" recap |
| `scheduled_task_fire`| - | metadata |
| `local_command`      | `content` (XML) | optional |
| `informational`      | `content` | optional |

Note: `local_command` may also appear as top-level `type:"system"` from older versions (per ccrider schema). Treat consistently.

### 3.5 Content blocks inside `message.content[]`

**Assistant content blocks** (`AssistantContentBlock`):

| `type`              | Fields | Notes |
|---|---|---|
| `text`              | `{text: string}` | Plain prose. |
| `thinking`          | `{thinking: string, signature: string}` | Extended thinking. **`signature` is cryptographic — do not mutate.** |
| `redacted_thinking` | `{data: string}` | Redacted thinking block (encrypted-on-server). |
| `tool_use`          | `{id, name, input, caller?}` | `id` = `"toolu_…"`. `name` is built-in or `mcp__<server>__<tool>`. `caller` only on progress entries. |
| `server_tool_use`   | `{id, name, input}` | Anthropic server tools (e.g. web search). |
| `web_search_tool_result` | `{tool_use_id, content: WebSearchResultItem[] \| WebSearchResultError}` | Paired with `server_tool_use`. |

**User content blocks** (`UserContentBlock`):

| `type`         | Fields | Notes |
|---|---|---|
| `text`         | `{text}` | |
| `image`        | `{source: Base64ImageSource \| UrlImageSource}` | |
| `document`     | `{source: Base64DocumentSource \| UrlDocumentSource \| PlainTextSource, title?, context?, citations?}` | PDFs, etc. |
| `tool_result`  | `{tool_use_id, is_error?, content: string \| ToolResultContentBlock[]}` | Inner content blocks: `text`, `image`, `document`, `tool_reference`. `is_error` defaults false. |

**`tool_reference`** sub-block appears in tool_result content alongside text; replayers drop it (glebmish/`collect.flattenText`).

### 3.6 `Usage` shape (assistant `message.usage`)

| Field | Notes |
|---|---|
| `input_tokens` | Required. **Includes only the new input not served from cache.** |
| `output_tokens` | Required. |
| `cache_creation_input_tokens` | Tokens written to cache this turn. 0 if caching disabled. |
| `cache_read_input_tokens` | Tokens read from cache. 0 if caching disabled. |
| `cache_creation` | `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` — TTL breakdown. |
| `service_tier` | `"standard" \| "priority" \| "batch"`. |
| `server_tool_use` | `ServerToolUsage` (web-search counters). Present only when server tools used. **Caveat:** `cache_read_input_tokens` can be inflated when server tools loop internally. |
| `inference_geo` | e.g. `"us-west-2"`. |
| `speed` | e.g. `"standard"`. |
| `iterations` | Server-tool loop details. |

**Total billable input** = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Cost is **per assistant turn**, not per tool call. No per-tool-call usage exists in the log.

### 3.7 Compaction metadata

`CompactMetadata` (on `system.compact_boundary`):

| Field | Notes |
|---|---|
| `trigger` | `"auto" \| "manual"` |
| `preTokens` | Required. Token count just before compaction. |
| `postTokens` | After. |
| `durationMs` | |
| `preCompactDiscoveredTools` | `string[]` — tool names known at compact time. |
| `preservedMessages` | `{anchorUuid, uuids[]}` — kept message UUIDs. |
| `preservedSegment` | `{anchorUuid, headUuid, tailUuid}` — kept range. |

`MicrocompactMetadata` (on `system.microcompact_boundary`):

| Field | Notes |
|---|---|
| `trigger` | `"auto" \| "manual"` |
| `preTokens` | |
| `tokensSaved` | |
| `compactedToolIds` | `string[]` — `tool_use.id`s whose payloads were dropped. |

### 3.8 `attachment` entry — adds:

| Field | Type | Notes |
|---|---|---|
| `attachment` | `Attachment` (union, 27+ subtypes) | Switch on `attachment.type`. |

**Attachment subtypes** (`Attachment["type"]`, partial enumeration — pedropaulovc lists 27):

`hook_success`, `hook_additional_context`, `hook_blocking_error`, `task_reminder`, `deferred_tools_delta`, `mcp_instructions_delta`, `queued_command`, `skill_listing`, `invoked_skills`, `dynamic_skill`, `agent_mention`, `workflow_keyword_request`, `plan_file_reference`, `diagnostics`, `edited_text_file`, `command_permissions`, `nested_memory`, `plan_mode`, `plan_mode_exit`, `plan_mode_reentry`, `ultrathink_effort`, `goal_status`, `file`, `directory`, `date_change`, `companion_intro`, `compact_file_reference`.

**Render hint:** Most attachments are harness context injection between user turn and first assistant response (`deferred_tools_delta` / `mcp_instructions_delta` / `skill_listing`). Default UX: collapsed "system context" card per turn. Surface separately: `file` / `directory` / `edited_text_file` / `diagnostics` / `plan_mode*` / `goal_status` / `nested_memory` — these are user-visible work artifacts.

### 3.9 `file-history-snapshot` entry

```jsonc
{
  "type": "file-history-snapshot",
  "messageId": "<uuid of associated message>",
  "isSnapshotUpdate": false,
  "snapshot": {
    "messageId": "<uuid>",
    "timestamp": "2026-04-15T03:54:37.000Z",
    "trackedFileBackups": {
      "<project-relative path>": {
        "backupFileName": "<opaque hash>",
        "version": 1,
        "backupTime": "2026-04-15T03:54:37.000Z"
      }
    }
  }
}
```

Empty `trackedFileBackups: {}` is common at turn boundaries with no file mutations. Snapshot bytes live under `~/.claude/file-history/<varying depth>/<backupFileName>`.

### 3.10 Minor / ambiguous types

| Type | Schema |
|---|---|
| `summary`           | `{type, summary, leafUuid}` — **standalone top-level compaction summary**; replaces upstream history. Often the FIRST line of a file (per ccrider observation). |
| `last-prompt`       | `{type, sessionId, lastPrompt, leafUuid?}` |
| `ai-title`          | `{type, sessionId, aiTitle}` |
| `custom-title`      | `{type, sessionId, customTitle}` |
| `agent-name`        | `{type, sessionId, agentName}` |
| `agent-setting`     | `{type, sessionId, agentSetting}` |
| `permission-mode`   | `{type, sessionId, permissionMode}` where enum = `"default" \| "plan" \| "auto" \| "acceptEdits" \| "dontAsk" \| "bypassPermissions"` |
| `mode`              | `{type, sessionId, mode}` (observed `"normal"`) |
| `queue-operation`   | `{type, sessionId, timestamp, operation: "enqueue"\|"dequeue"\|"remove"\|"popAll", content?}` |
| `bridge-session`    | `{type, sessionId, bridgeSessionId, lastSequenceNum}` |
| `pr-link`           | `{type, sessionId, timestamp, prNumber, prRepository, prUrl}` |
| `worktree-state`    | `{type, sessionId, worktreeSession: WorktreeSession}` |
| `started`           | `{type, agentId, key}` — paired with `result` via `key` (workflow journaling). |
| `result`            | **AMBIGUOUS**. Two shapes in the wild: (a) workflow `{type, agentId, key, result}` per pedropaulovc; (b) **session-final** `{type, subtype: "success"\|"error"\|"cancelled"\|"timeout", session_id, is_error, duration_ms, duration_api_ms, num_turns, total_cost_usd, usage, result?, errors?}` per anthropic-sdk-python + lm-assist (read by `listSessionsWithDetails`). Adapter must branch on `subtype` presence. |
| `saved_hook_context`| `{type, hookName?, hookEvent?, content: string[], toolUseID?, …Partial<EntryBase>}` (note: snake-case type, anomalous) |

---

## 4. Branching, sidechains, forks (D-2 — pi mapping)

Three orthogonal mechanisms:

| Mechanism | Field(s) | Meaning |
|---|---|---|
| **Tree** | `parentUuid` on every entry → `uuid` of parent | The transcript is a DAG, not a list. Multiple children of one parent = branch. |
| **Sidechain** | `isSidechain: true` | Subagent / Task-tool branch / exploratory sub-conversation. Off main thread but in the same file. Subagent JSONLs also live in `subagents/`. |
| **Fork** | `forkedFrom: {sessionId, messageUuid}` | This session was created by `/fork` from another session+point. **Lives in a different .jsonl file.** |

**Retries / rollbacks / "rewind":** Claude Code does not delete on rewind. A new entry is appended with `parentUuid` pointing to an upstream node — same parent the original entry pointed to (or a different ancestor). The old branch remains in the file forever; the *active* leaf is tracked by `last-prompt.leafUuid` and `summary.leafUuid`. Reconstruction: walk `uuid → parentUuid` from the latest `leafUuid` backward to find the canonical thread; treat any unreferenced nodes as abandoned branches.

**`promptId`** groups all entries (assistant turn, attachments, tool calls, results) spawned by one human prompt — useful for "turn" rendering and for the review-worthy heuristics (cost-per-prompt, errors-per-prompt).

**Subagents:**
- In-file: `isSidechain: true` plus `agentId` / `agentName`.
- Separate file: `agent-<id>.jsonl` next to the main session, or `<sessionId>/subagents/agent-<id>.jsonl`.
- The parent session contains a `tool_use` for `Task` and a `tool_result` whose `toolUseResult` wrapper carries the spawn's id (lm-assist's `SubagentInvocation` linkage).
- `progress` entries (multi-MB possible) stream subagent state into the parent's file via `parentToolUseID`.

---

## 5. Tool-call correlation (confirmed + deviations)

Primary: `tool_use.id === tool_result.tool_use_id`. The pairing is **strictly by id**, not message-adjacency — though in practice the `tool_result` is in the immediately-following `user` message.

Secondary (redundant linkage on `user` entries):
- `parentUuid` → assistant entry's `uuid`
- `sourceToolUseID` → matching `tool_use.id`
- `sourceToolAssistantUUID` → matching assistant `uuid`

**Deviations:**
1. **Task / subagent results** wrap content as `{toolUseResult: {tool_use_id, content}}` on the user entry rather than putting a flat `tool_result` block in `message.content[]`. Adapter must look in both places.
2. **`server_tool_use`** (web search) is paired with `web_search_tool_result` inside the SAME assistant message's content array — no user-side tool_result.
3. **`microcompact_boundary`** lists `compactedToolIds` whose `tool_result` content has been zeroed out but the id pair still exists.
4. **Multi-tool-use assistants:** one assistant entry can carry N `tool_use` blocks; each gets its own `tool_result` (potentially split across multiple subsequent user entries). Each pair is independent.
5. **Split content blocks:** a single API response (one `msg_…` id) is frequently sharded across multiple consecutive assistant JSONL lines — thinking on one line, tool_use on the next — each with its own `uuid`/`parentUuid`. They share `message.id`. Group by id when rolling up usage (usage is only on one of the shards, typically the last).

---

## 6. Compaction — confirmed mechanisms

Claude Code emits compaction **explicitly**, in two ways that the adapter must both recognize:

1. **`system` entry with `subtype: "compact_boundary"`** (or `"microcompact_boundary"`) carrying `compactMetadata` / `microcompactMetadata`. This is the canonical marker. See §3.7.
2. **Top-level `type: "summary"` entry** `{type, summary, leafUuid}` — replaces upstream conversation. Common at the start of a resumed/compacted session file.
3. **`user` entry with `isCompactSummary: true`** — the *content* of the compaction summary, injected as a user-role message that the API consumes. Render as a compaction card, not a real prompt.

**The pi `compaction` block maps to:** any of (1), (2), or (3). Prefer (1) when present (richest metadata).

**No "context-window reset" event** beyond these.

---

## 7. cwd / gitBranch / version / model — locations & mutability

| Field | Where | Mutable mid-session? |
|---|---|---|
| `cwd` | every `user`/`assistant`/`attachment`; `Partial` on `system`/`progress` | **YES** — when user `cd`s, subsequent entries log new cwd. Trust per-entry. |
| `gitBranch` | same | **YES** — branch switches reflected per-entry. |
| `version` | same | **YES** — if CC was upgraded between resumes, later entries carry new version. |
| `model` | `assistant.message.model` only | **YES** — per assistant message. Common when user toggles models (`/model` slash command) or different subagents use different models. Plot model-switch points by diffing this across consecutive assistants. |
| `permissionMode` | `system.init.permissionMode`, `permission-mode` entries, optional snapshot on `user` entries | YES — change-tracked. |

Session-level "first-line snapshot" is the `system.init` entry (always first), but it goes stale fast — never rely on it for current state.

---

## 8. Attachments — file-attachment vs context-injection

The `attachment` entry type is **misleadingly broad**. Of the 27 attachment subtypes, only a few are user-facing file/dir attachments:

- `file`, `directory`, `edited_text_file` — user-attached or hook-attached files.
- `nested_memory` — included CLAUDE.md / MEMORY.md content.
- `diagnostics` — LSP-style diagnostic items with `DiagnosticPosition`, `DiagnosticFile`, `DiagnosticItem`.

The rest are harness bookkeeping (`deferred_tools_delta`, `mcp_instructions_delta`, `skill_listing`, `invoked_skills`, `task_reminder`, `hook_*`, `plan_mode*`, `goal_status`, `ultrathink_effort`, `date_change`, `companion_intro`, `command_permissions`, …). Default render: a single collapsed "context block" between user prompt and first assistant response; expand subtypes that the user actually attached (file, directory, edited_text_file, diagnostics).

---

## 9. Render-vs-skip recommendation for pi-lookback UI

| Bucket | Types |
|---|---|
| **Always render** | `user` (when `promptType ∈ {undefined, user, command}`), `assistant`, `system.api_error`, `system.compact_boundary`, `system.microcompact_boundary`, `summary`, `attachment[file\|directory\|edited_text_file\|diagnostics\|nested_memory]`, `file-history-snapshot` (as timeline marker when `trackedFileBackups` is non-empty), `pr-link`, `result` (subtype-shape variant only) |
| **Render as collapsed metadata** | `system.init`, `system.turn_duration`, `system.stop_hook_summary`, `system.bridge_status`, `system.away_summary`, `attachment[*]` (others), `permission-mode`, `mode`, `agent-name`, `agent-setting`, `ai-title`, `custom-title`, `worktree-state`, `bridge-session`, `progress` |
| **Skip by default** | `last-prompt`, `queue-operation` (unless user wants queue debugging), `started`, `saved_hook_context`, `file-history-snapshot` with empty `trackedFileBackups` |
| **Render conditionally** | `user` with `isCompactSummary:true` → render as compaction card not as prompt; `user` with non-user `promptType` → fold under preceding turn |

---

## 10. Session lifetime, resume, fork

- **1 `.jsonl` = 1 `sessionId`.** `/resume` appends to the **same** file. `parentUuid` chain continues.
- **`/fork` creates a new `.jsonl`** with the same project-key dir, new `sessionId`. Every entry in the forked file carries `forkedFrom: {sessionId: <orig>, messageUuid: <branch point>}`.
- **`/clear`** ends the current session (no further appends) and starts a new one in a new file. Conversation is saved and resumable.
- Subagent JSONLs (`agent-*.jsonl`) are separate-file extensions of the parent session; parent's `Task` `tool_use` ↔ subagent's `sessionId` via `agentId`.
- A "session" for UX purposes may therefore span multiple files (`<sessionId>.jsonl` + `<sessionId>/subagents/agent-*.jsonl`); list them as one logical session. Cross-file traversal of forked sessions is a separate "ancestor" relation.

**Session-status derivation** (lm-assist convention, not in the JSONL):

| Status | Heuristic |
|---|---|
| `running` | File mtime < 60s ago |
| `completed` | Has `result` with `subtype:"success"` / `is_error:false` |
| `error` | Has `result` with errors |
| `interrupted` | Last entry is user-interrupt and no terminating `result` |
| `idle` | 1–10 min since mtime, no result |
| `stale` | >10 min since mtime, no result |

---

## 11. Adapter implementation checklist (D-2 contract)

Recommended normalization to existing pi-lookback `kind` set:

| Claude Code shape | pi `kind` | Notes |
|---|---|---|
| `assistant` with only `text` blocks | `assistant` | text = concatenated text blocks |
| `assistant` with `thinking` block | `assistant` (+ thinking) | preserve thinking on the same record |
| `assistant` with `tool_use` blocks | `assistant` + emit `toolCalls[]` | one entry per `tool_use.id` |
| `user` with `tool_result` block(s) or `toolUseResult` | `toolResult` | toolCallId = `tool_use_id`; isError = `is_error`; output = flattened text |
| `user` with plain text and `promptType ∈ {user, command}` | `user` | |
| `user` with `isCompactSummary:true` | `compaction` | summary text from content |
| `user` with other `promptType` | `meta` or skip per UX | |
| `system.compact_boundary` / `microcompact_boundary` | `compaction` | preTokens / postTokens / trigger from metadata |
| `summary` (top-level) | `compaction` | summary string; leafUuid as next-kept-entry pointer |
| `system.api_error` | `error` | rendered inline |
| `system.init` | `session_meta` | once-per-session card |
| `file-history-snapshot` (non-empty) | `snapshot` | optional |
| anything `isSidechain:true` | preserve flag → `sidechain:true` | renderer adds subagent badge |
| Bash `tool_use` + `tool_result.toolUseResult` | `bashExecution` | command from `input.command`; output/exit from toolUseResult |
| any unknown `type` | `unknown` | pass raw payload through; never throw |

Field plumbing:

- `id` ← `uuid`
- `parentId` ← `parentUuid`
- `ts` ← `timestamp` (ISO sort key; do not parse if not needed)
- `cwd` ← per-entry `cwd`
- `model` ← `message.model` (assistant only)
- `usage` ← `message.usage` (assistant only)
- `tokens` ← derive: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`
- `cost` ← compute from `model` × `usage` via a pricing table; **no built-in cost field**

Hard rules:
- Tolerate missing fields. Every optional field above can be absent.
- Tolerate unknown `type` and unknown `subtype`. Never throw on a line.
- Sort by `(timestamp, file-basename, line-index)` — matches glebmish's global sort and disambiguates identical timestamps.
- Skip but log malformed JSON lines.
- For Read tool results: strip `cat -n` prefix, trailing-newline, `[Lines M-N omitted]` truncation marker, and `<system-reminder>…</system-reminder>` envelope before showing raw content.
- Treat `content` as string-or-array in every place it appears (`message.content`, `tool_result.content`, etc.).
- Multi-shard assistant messages (same `message.id` across N JSONL lines): roll up for usage display; render each shard's content independently.

---

## 12. Open / unverified

- **Empirical `type` cardinality on this machine** — could not enumerate `~/.claude/projects/` from this subagent (no shell). The TranscriptEntry union above is the superset across published references; not every install will see all 18 types in the wild.
- **`result` top-level entry shape disambiguation** — two distinct shapes coexist (workflow-step vs session-final). On a fixture corpus, branch on presence of `subtype` field.
- **Attachment subtype field shapes** — only the union of names is enumerated here. Each subtype's payload (e.g. `EditedTextFileAttachment.diff`, `DiagnosticsAttachment.files`) is documented in pedropaulovc's per-interface docs and should be looked up when an attachment-card UI is built.
- **Sidechain-versus-subagent distinction** — `isSidechain:true` is used both for Task-spawned subagents (file-separated) and for in-file exploratory branches. Distinguishing them requires checking `agentId` presence and the file path.

---

## Source provenance

| Source | What it verifies |
|---|---|
| `pedropaulovc/claude-code-types` (GitHub) | Comprehensive TS type catalog incl. all entry subtypes, attachment union, content blocks, Usage, CompactMetadata, ForkedFromRef. |
| `glebmish/claude-code-replay/docs/log-format.md` (verified 2026-05-27) | Consumed-field contract; subagent dir layout; tool-pair semantics; Read normalization. |
| `jamie-bitflight/claude_skills/.../session-log-schema.md` (verified 2026-03-24, 500-file scan) | Project-path encoding rule (`/[:\\/]/g → '-'`); `result` subtype enum; PromptType heuristic; team-spawn `toolUseResult` wrapper. |
| `neilberkman/ccrider/research/schema.md` | `summary`-first-line observation; `thinkingMetadata` / `toolUseResult` shapes; session-continuation `/resume` semantics. |
| `huytieu.com/blog/anatomy-of-a-claude-code-conversation-transcript/` | Sharded-content-block convention; attachment-chain ordering; deferred-tool-loading via `ToolSearch`; usage cache economics. |
| `anthropics/claude-agent-sdk-python:_internal/session_summary.py` | Official last-wins field map for session-summary sidecar (cwd, model, version, slug); validates "trust last value per session" rule. |
