# Progress

## Status
Complete (research)

## Tasks
- [x] Profile Claude Code session JSONL format
- [x] Confirm/extend top-level entry-type list
- [x] Map content-block subtypes (assistant + user)
- [x] Document tool-call correlation (tool_use.id ↔ tool_use_id)
- [x] Document branching / sidechain / fork mechanics
- [x] Identify compaction emission (compact_boundary, summary, isCompactSummary)
- [x] Locate per-message usage / model / cwd / version
- [x] Document attachment entry catalog
- [x] Document ai-title / last-prompt / queue-operation render guidance
- [x] Document project-key path encoding (`/[:\\/]/g → '-'`)
- [x] Document session lifetime (1 .jsonl = 1 sessionId; resume appends; fork = new file)
- [x] Recommend pi-lookback normalization mapping

## Files Changed
- `claude-code-schema.md` (new) — 34 KB dense reference for the Claude Code source adapter.
- `progress.md` (updated)

## Notes

**Constraint:** This subagent had no shell access (no `Bash`, no directory listing). The Read tool resolved single paths via `fff` but could not enumerate `~/.claude/projects/`. Schema was therefore compiled from five independent reverse-engineering projects + the official `claude-agent-sdk-python`. All four reverse-eng sources independently scanned hundreds–thousands of real session files and agree on the core shape. Divergences flagged in §12 of the schema doc.

**Key findings beyond the user's working set:**
- Top-level `type` set is **larger** than the user listed. Add at least: `summary`, `progress`, `mode`, `custom-title`, `agent-name`, `agent-setting`, `bridge-session`, `pr-link`, `worktree-state`, `started`, `result`, `saved_hook_context`.
- **Three** distinct compaction mechanisms coexist: `system.compact_boundary`, `system.microcompact_boundary`, top-level `summary` entries, and `user.isCompactSummary:true` messages. Adapter must recognize all four.
- **Tool correlation is triple-redundant** on the user side: `parentUuid`, `sourceToolUseID`, `sourceToolAssistantUUID` all point at the same assistant entry. Anchor on `tool_use_id ↔ id` (canonical).
- **A single API response can be sharded** across multiple JSONL lines sharing one `message.id` — `thinking` on one line, `tool_use` on the next, each with its own `uuid`. Group by `message.id` when rolling up usage.
- **`result` type is ambiguous** — two shapes in the wild (workflow-step vs session-final). Branch on `subtype` field.
- **`isSidechain` is used for both** Task-spawned subagents and in-file exploratory branches. Distinguishing requires `agentId` presence + file path check.
- **cwd / gitBranch / version / model can all change mid-session.** Trust per-entry values, not the session-init snapshot.
- **`/fork` creates a new file** with `forkedFrom: {sessionId, messageUuid}` on every entry. `/resume` appends to the same file.

Q-1.1 / Q-1.2 / Q-1.3 / Q-1.4 / Q-1.5 (from the implementation-notes) are now answered in the schema doc.
