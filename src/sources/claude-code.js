// Claude Code source adapter.
//
// Implements the source-adapter contract (plan §1.2) for Claude Code JSONL
// sessions stored under ~/.claude/projects/<project-key>/*.jsonl.
//
// Slice coverage:
//  - B: user / assistant / unknown kinds.
//  - C: tool_use ↔ tool_result correlation by id; Bash mapping with
//       exit-code heuristics (Risk R3).
//  - D (current): sidechain agentId, multi-shard assistant usage rollup
//       (Risk R4), session_meta synthesis (plan §6), attachment_card,
//       error, snapshot, meta, compaction (three mechanisms per plan §4).
//
// References:
//   claude-code-schema.md — full Claude Code JSONL spec.
//   scout-findings.md     — leak map of the pi-shape downstream contract.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { costFor } = require('./pricing');

const ID = 'claude-code';
const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');

// Bash output threshold beyond which we mark a result truncated. CC's
// default Bash output cap; used only as a heuristic (no native flag).
const BASH_TRUNCATION_HINT = 30000;

// per review-security.md S-1 / S-2 / S-4: bounded-RAM parsing guards.
const MAX_FILE_BYTES = 256 * 1024 * 1024;   // 256 MB hard cap per .jsonl
const MAX_LINE_BYTES = 16 * 1024 * 1024;    // 16 MB hard cap per single line
const MAX_PARSE_ERRORS = 1000;              // suppress the rest with overflow marker

// Heuristic regex for inferring Bash failure when neither `isError` nor
// `interrupted` are set on toolUseResult. Plan §2.6 / Risk R3.
// Broadened per review-correctness.md §Bash: matches make/python/node/npm
// failure shapes that don't naturally hit the legacy `Error:` / `Traceback`
// or `exit status N` patterns.
const BASH_FAILURE_HINT_RE = /(?:^|\n)(?:Error[: ]|Traceback|[A-Z]\w*Error[: ]|.*?\bcommand not found\b|.*?\bpermission denied\b|.*?\*\*\*.*\bError\b|.*?\bexit(?:\s+(?:status|code))?\s+[1-9]\d*\b)/im;

// Top-level entry types that we render as `meta` (collapsed by default).
// Anything not in this set and not handled by a dedicated branch falls
// through to `unknown` (forward-compat).
const META_TYPES = new Set([
  'queue-operation',
  'permission-mode',
  'last-prompt',
  'ai-title',
  'worktree-state',
  'pr-link',
  // schema §3.10+: tolerate-but-render-collapsed.
  'mode',
  'custom-title',
  'agent-name',
  'agent-setting',
  'bridge-session',
  'started',
  'saved_hook_context',
  'progress',
]);

// ----- adapter contract -----

function defaultRoot() {
  return process.env.CLAUDE_SESSIONS_DIR || DEFAULT_ROOT;
}

function discover(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (path.basename(dir) === 'subagents') continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        if (e.name.startsWith('agent-')) continue;
        out.push({
          filePath: full,
          source: ID,
          projectKey: path.basename(path.dirname(full)),
          isSubagent: false,
        });
      }
    }
  }
  return out;
}

function decodeProjectDir(name) {
  if (typeof name !== 'string' || !name) return '';
  if (!name.startsWith('-')) return name;
  return '/' + name.slice(1).split('-').filter(Boolean).join('/');
}

function sniff(_filePath, firstLine) {
  if (!firstLine || typeof firstLine !== 'object') return false;
  if (firstLine.type === 'session') return false;
  if (!firstLine.sessionId) return false;
  if (!firstLine.type) return false;
  return true;
}

function parseFile(filePath) {
  // per review-security.md S-1: refuse anything beyond MAX_FILE_BYTES
  // before allocating any buffer. Returns an error envelope so the
  // library row still surfaces (with a clear reason) rather than
  // throwing into the server's 500 handler.
  let st;
  try { st = fs.statSync(filePath); }
  catch (err) {
    return {
      entries: [], parseErrors: [{ line: 0, reason: `stat failed: ${err.message}`, preview: '' }],
      sessionMeta: null, filePath, source: ID,
    };
  }
  if (st.size > MAX_FILE_BYTES) {
    return {
      entries: [],
      parseErrors: [{
        line: 0,
        reason: `file exceeds ${MAX_FILE_BYTES} byte size cap (${st.size} bytes)`,
        preview: '',
      }],
      sessionMeta: null, filePath, source: ID,
    };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  return parseSessionText(text, filePath);
}

// ----- internal: parse + normalize -----

function parseSessionText(text, filePath) {
  // per review-security.md S-2 / S-4: iterate lines via indexOf rather
  // than `text.split('\n')` to avoid materializing the full line-array
  // copy. Skip any line larger than MAX_LINE_BYTES with a parse-error.
  // parseErrors is capped at MAX_PARSE_ERRORS to bound memory on
  // pathological inputs (overflow gets a final marker entry).
  const parseErrors = [];
  let parseErrorsOverflow = 0;
  const addError = (line, reason, preview) => {
    if (parseErrors.length < MAX_PARSE_ERRORS) parseErrors.push({ line, reason, preview });
    else parseErrorsOverflow++;
  };
  const rawObjects = [];

  let start = 0;
  let lineNo = 0;
  const len = text.length;
  while (start <= len) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? len : nl;
    lineNo++;
    const lineLen = end - start;
    if (lineLen > MAX_LINE_BYTES) {
      addError(lineNo, `line exceeds ${MAX_LINE_BYTES} byte cap (${lineLen} bytes)`, '');
    } else if (lineLen > 0) {
      const ln = text.slice(start, end);
      if (ln.trim()) {
        try { rawObjects.push({ obj: JSON.parse(ln), lineNo }); }
        catch (err) { addError(lineNo, err.message, ln.slice(0, 120)); }
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  if (parseErrorsOverflow > 0) {
    parseErrors.push({
      line: -1,
      reason: `parseErrors overflow; ${parseErrorsOverflow} additional errors suppressed`,
      preview: '',
    });
  }

  // Pre-pass 1 (slice C): tool_use registry.
  const toolUseRegistry = buildToolUseRegistry(rawObjects);

  // Pre-pass 2 (slice D, Risk R4): multi-shard assistant tracking.
  // For each message.id, record the FIRST line that carried it AND the FIRST
  // line that carried usage. Only the latter gets to keep `usage`/`cost`
  // populated; others are zeroed out to prevent double-counting in summary.
  const shardState = buildShardState(rawObjects);

  // Pre-pass 3 (slice D, plan §4): compaction boundary index.
  // Records uuids and (lineNo, raw) of `system.compact_boundary` /
  // `system.microcompact_boundary`. Used during normalization to merge an
  // adjacent `user.isCompactSummary` into a single compaction entry.
  const compactionState = buildCompactionState(rawObjects);

  // Pre-pass 4 (slice D, plan §6): session metadata synthesis.
  const sessionMeta = extractSessionMeta(rawObjects, filePath);

  const entries = [];
  const ctx = { filePath, toolUseRegistry, shardState, compactionState, parseErrors };
  for (const { obj, lineNo } of rawObjects) {
    ctx.lineNo = lineNo;
    const normalized = normalizeEntry(obj, ctx);
    if (!normalized) continue;
    if (Array.isArray(normalized)) entries.push(...normalized);
    else entries.push(normalized);
  }

  return {
    entries,
    parseErrors,
    sessionMeta,
    filePath,
    source: ID,
  };
}

// ----- pre-passes -----

function buildToolUseRegistry(rawObjects) {
  // per review-correctness.md §Tool-pair: register `server_tool_use` (e.g.
  // web_search) alongside the standard `tool_use` so its paired result
  // entries are not silently dropped.
  const reg = new Map();
  for (const { obj } of rawObjects) {
    if (obj?.type !== 'assistant') continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if ((part?.type === 'tool_use' || part?.type === 'server_tool_use') && part.id) {
        reg.set(part.id, {
          name: part.name || null,
          input: part.input ?? null,
          uuid: obj.uuid || null,
          variant: part.type,
        });
      }
    }
  }
  return reg;
}

function buildShardState(rawObjects) {
  // Per Risk R4: 1616 of ~4900 assistant message.ids span >1 JSONL line in
  // the live corpus. We track:
  //   - shardOfByUuid: uuid → uuid-of-first-shard-with-same-msg.id (null on first shard)
  //   - keepUsageByUuid: uuid → boolean (true iff this is the FIRST shard
  //     carrying usage; only such shards keep their usage populated.)
  const firstShardByMsgId = new Map();
  const firstUsageByMsgId = new Map();
  const shardOfByUuid = new Map();
  const keepUsageByUuid = new Map();
  for (const { obj } of rawObjects) {
    if (obj?.type !== 'assistant') continue;
    const msgId = obj.message?.id;
    const uuid = obj.uuid;
    if (!uuid) continue;
    if (msgId) {
      if (firstShardByMsgId.has(msgId)) {
        shardOfByUuid.set(uuid, firstShardByMsgId.get(msgId));
      } else {
        firstShardByMsgId.set(msgId, uuid);
        shardOfByUuid.set(uuid, null);
      }
      if (obj.message?.usage) {
        if (firstUsageByMsgId.has(msgId)) {
          keepUsageByUuid.set(uuid, false);
        } else {
          firstUsageByMsgId.set(msgId, uuid);
          keepUsageByUuid.set(uuid, true);
        }
      }
    } else {
      shardOfByUuid.set(uuid, null);
      if (obj.message?.usage) keepUsageByUuid.set(uuid, true);
    }
  }
  return { shardOfByUuid, keepUsageByUuid };
}

function buildCompactionState(rawObjects) {
  // Plan §4: scan for system.compact_boundary and microcompact_boundary
  // first, then user.isCompactSummary, then top-level summary, with ±2-line
  // merging. We emit a compaction entry from EXACTLY ONE source line
  // (the boundary's, if present; else the user's; else the summary's), and
  // mark the others as "consumed" so they don't double-emit.
  const boundariesByLine = new Map();   // lineNo → { obj, type:'boundary' }
  const compactSummariesByLine = new Map(); // lineNo → { obj, type:'isCompactSummary' }
  const topLevelSummariesByLine = new Map();
  for (const { obj, lineNo } of rawObjects) {
    if (obj?.type === 'system' && (obj.subtype === 'compact_boundary' || obj.subtype === 'microcompact_boundary')) {
      boundariesByLine.set(lineNo, obj);
    } else if (obj?.type === 'user' && obj.isCompactSummary === true) {
      compactSummariesByLine.set(lineNo, obj);
    } else if (obj?.type === 'summary') {
      topLevelSummariesByLine.set(lineNo, obj);
    }
  }

  // For each line, decide:
  //   emit: which source-line is the compaction emitted from
  //   consume: lines that should be silenced
  const emit = new Map();      // lineNo → { mechanism, mergeFrom?:{ summary, ... } }
  const consume = new Set();   // lines to skip when iterating

  for (const [lineNo, boundary] of boundariesByLine.entries()) {
    let mergedSummaryObj = null;
    for (const [other, summObj] of compactSummariesByLine.entries()) {
      if (Math.abs(other - lineNo) <= 2 && !consume.has(other)) {
        mergedSummaryObj = summObj;
        consume.add(other);  // suppress its own normalize emission
        break;
      }
    }
    emit.set(lineNo, {
      mechanism: boundary.subtype === 'microcompact_boundary'
        ? 'system.microcompact_boundary'
        : 'system.compact_boundary',
      boundary,
      summaryObj: mergedSummaryObj,
    });
  }
  for (const [lineNo, summObj] of compactSummariesByLine.entries()) {
    if (consume.has(lineNo)) continue;     // already merged
    if (emit.has(lineNo)) continue;
    emit.set(lineNo, { mechanism: 'user.isCompactSummary', boundary: null, summaryObj: summObj });
  }
  for (const [lineNo, summObj] of topLevelSummariesByLine.entries()) {
    if (consume.has(lineNo)) continue;
    if (emit.has(lineNo)) continue;
    emit.set(lineNo, { mechanism: 'top-level-summary', boundary: null, summaryObj: summObj });
  }
  return { emit, consume };
}

function extractSessionMeta(rawObjects, filePath) {
  // Live-corpus profile: 100% of sessions in user's corpus have NO
  // system.init line. We still look for one (forward-compat), then
  // synthesize from the first user/assistant entry.
  let init = null;
  let firstUserOrAsst = null;
  for (const { obj } of rawObjects) {
    if (!init && obj?.type === 'system' && obj.subtype === 'init') init = obj;
    if (!firstUserOrAsst && (obj?.type === 'user' || obj?.type === 'assistant')) firstUserOrAsst = obj;
    if (init && firstUserOrAsst) break;
  }
  // Last-wins for mutable fields (plan §6).
  let lastCwd = null, lastGitBranch = null, lastVersion = null, lastModel = null;
  for (const { obj } of rawObjects) {
    if (typeof obj?.cwd === 'string' && obj.cwd) lastCwd = obj.cwd;
    if (typeof obj?.gitBranch === 'string') lastGitBranch = obj.gitBranch;
    if (typeof obj?.version === 'string' && obj.version) lastVersion = obj.version;
    if (obj?.type === 'assistant' && obj.message?.model) lastModel = obj.message.model;
  }
  const baseName = filePath ? path.basename(filePath, '.jsonl') : '';
  if (init) {
    return {
      id: init.session_id || init.sessionId || baseName,
      cwd: lastCwd || init.cwd || '',
      version: lastVersion || init.claude_code_version || '',
      gitBranch: lastGitBranch || '',
      model: lastModel || init.model || null,
      permissionMode: init.permissionMode || null,
      tools: Array.isArray(init.tools) ? init.tools : [],
      mcpServers: Array.isArray(init.mcp_servers) ? init.mcp_servers : [],
      agents: Array.isArray(init.agents) ? init.agents : [],
      timestamp: init.timestamp || rawObjects[0]?.obj?.timestamp || null,
      synthesized: false,
      source: ID,
    };
  }
  const seed = firstUserOrAsst || rawObjects[0]?.obj || {};
  return {
    id: seed.sessionId || baseName,
    cwd: lastCwd || seed.cwd || '',
    version: lastVersion || seed.version || '',
    gitBranch: lastGitBranch || seed.gitBranch || '',
    model: lastModel,
    permissionMode: null,
    tools: [],
    mcpServers: [],
    agents: [],
    timestamp: seed.timestamp || rawObjects[0]?.obj?.timestamp || null,
    // `synthesized: true` flags meta synthesized from the first user/asst
    // entry rather than a `system.init` line. Surfaced in session_meta
    // rendering as a small " · synthesized" suffix; no consumer beyond that.
    synthesized: true,
    source: ID,
  };
}

// ----- normalize -----

function normalizeEntry(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;

  // Compaction lines are emitted only from their owning `emit` line
  // and silenced everywhere else.
  if (ctx?.compactionState?.consume.has(ctx.lineNo)) return null;
  if (ctx?.compactionState?.emit.has(ctx.lineNo)) {
    return buildCompactionEntry(ctx.compactionState.emit.get(ctx.lineNo), raw, ctx);
  }

  const baseId = raw.uuid || (ctx ? `${path.basename(ctx.filePath)}:${ctx.lineNo}` : null);
  const base = {
    id: baseId,
    parentId: raw.parentUuid ?? null,
    timestamp: raw.timestamp || null,
    raw,
    source: ID,
    sidechain: !!raw.isSidechain,
    agentId: raw.agentId || null,    // surfaced in slice D; null on main thread
  };

  const t = raw.type;

  if (t === 'user') return normalizeUserEntry(raw, base, ctx);
  if (t === 'assistant') return normalizeAssistantEntry(raw, base, ctx);

  if (t === 'attachment') {
    return buildAttachmentEntry(raw, base);
  }
  if (t === 'file-history-snapshot') {
    return buildSnapshotEntry(raw, base);
  }
  if (t === 'system') {
    return buildSystemEntry(raw, base);
  }
  if (META_TYPES.has(t)) {
    return buildMetaEntry(raw, base, t);
  }

  return { ...base, kind: 'unknown', type: t || 'no-type' };
}

function normalizeUserEntry(raw, base, ctx) {
  const m = raw.message || {};
  let toolResultBlocks = extractToolResultBlocks(m.content);

  // per review-correctness.md C-5 / schema §3.2.1: Task/subagent wrappers
  // expose tool_use_id only on the top-level `toolUseResult`, never as a
  // tool_result block in `message.content[]`. Synthesize one when needed
  // so the pair completes and downstream signals fire.
  if (toolResultBlocks.length === 0 && raw.toolUseResult && raw.toolUseResult.tool_use_id) {
    const tur = raw.toolUseResult;
    let synthContent;
    if (typeof tur.content === 'string' || Array.isArray(tur.content)) synthContent = tur.content;
    else if (typeof tur.stdout === 'string' || typeof tur.stderr === 'string') {
      synthContent = [tur.stdout, tur.stderr].filter(Boolean).join('\n');
    } else synthContent = '';
    toolResultBlocks = [{
      type: 'tool_result',
      tool_use_id: tur.tool_use_id,
      content: synthContent,
      is_error: !!tur.isError,
    }];
  }

  if (toolResultBlocks.length > 0) {
    return toolResultBlocks.map((tr, idx) =>
      buildToolResultEntry(raw, tr, base, ctx, idx, toolResultBlocks.length)
    );
  }

  const text = extractMessageContentText(m.content);
  return {
    ...base,
    kind: 'user',
    text,
    tokens: text.length,
    promptType: detectPromptType(raw),
  };
}

function normalizeAssistantEntry(raw, base, ctx) {
  const m = raw.message || {};
  const { text, thinking, toolCalls } = decomposeAssistantContent(m.content);
  const model = m.model || null;
  const uuid = base.id;
  const keepUsage = ctx?.shardState?.keepUsageByUuid.get(uuid) ?? !!m.usage;
  const usage = keepUsage ? (m.usage || null) : null;
  const cost = usage ? costFor(model, usage) : null;
  const totalTokens = usage
    ? (usage.input_tokens || 0) + (usage.output_tokens || 0)
    : null;
  const shardOf = ctx?.shardState?.shardOfByUuid.get(uuid) ?? null;

  // Slice D: api_error assistant entries get their own kind so signals/UI
  // can distinguish them. schema §3.3.
  if (raw.isApiErrorMessage) {
    return {
      ...base,
      kind: 'error',
      errorMessage: text || '',
      cause: m.stop_reason || null,
      retryAttempt: typeof raw.retryAttempt === 'number' ? raw.retryAttempt : null,
      httpStatus: typeof raw.httpStatus === 'number' ? raw.httpStatus : null,
      severity: 'retryable',
    };
  }

  return {
    ...base,
    kind: 'assistant',
    text,
    thinking,
    toolCalls,
    model,
    provider: 'anthropic',
    api: null,
    usage,
    cost,
    totalTokens,
    stopReason: m.stop_reason || null,
    responseId: m.id || null,
    // forward-compat (review-simplicity.md P-3): messageId/shardOf are
    // surfaced for the planned shard-collapsing UI (see L-7 in notes).
    // Today no renderer or signal consumes them.
    messageId: m.id || null,
    shardOf,
  };
}

function buildAttachmentEntry(raw, base) {
  return {
    ...base,
    kind: 'attachment_card',
    subtype: raw.attachment?.type || 'unknown',
    payload: raw.attachment || null,
  };
}

function buildSnapshotEntry(raw, base) {
  const tracked = raw.snapshot?.trackedFileBackups || {};
  const trackedFiles = Object.entries(tracked).map(([file, info]) => ({
    path: file,
    backupFileName: info?.backupFileName || null,
    version: info?.version || null,
  }));
  // Only emit when the snapshot tracks at least one file; empty snapshots
  // (common at session start) are noise and fall through to nothing.
  if (trackedFiles.length === 0) {
    return { ...base, kind: 'meta', metaType: 'file-history-snapshot', payload: raw.snapshot || null };
  }
  return {
    ...base,
    kind: 'snapshot',
    messageId: raw.messageId || null,
    trackedFiles,
  };
}

function buildSystemEntry(raw, base) {
  if (raw.subtype === 'init') {
    // forward-compat (review-simplicity.md P-3 / review-tests.md F6): no
    // live CC corpus observed in mid-2026 emits `system.init`; this
    // branch is exercised only by T-5 below. Kept for forward-compat
    // with older session formats or possible future emit.
    return {
      ...base,
      kind: 'session_meta',
      cwd: raw.cwd || '',
      version: raw.claude_code_version || '',
      gitBranch: null,
      model: raw.model || null,
      permissionMode: raw.permissionMode || null,
      tools: Array.isArray(raw.tools) ? raw.tools : [],
      mcpServers: Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [],
      agents: Array.isArray(raw.agents) ? raw.agents : [],
      synthesized: false,
    };
  }
  if (raw.subtype === 'api_error') {
    return {
      ...base,
      kind: 'error',
      errorMessage: raw.message || raw.error || '',
      cause: raw.subtype,
      retryAttempt: typeof raw.retryAttempt === 'number' ? raw.retryAttempt : null,
      httpStatus: typeof raw.httpStatus === 'number' ? raw.httpStatus : null,
      severity: 'fatal',
    };
  }
  return { ...base, kind: 'meta', metaType: 'system', payload: raw };
}

function buildMetaEntry(raw, base, t) {
  return { ...base, kind: 'meta', metaType: t, payload: raw };
}

function buildCompactionEntry(decision, raw, ctx) {
  const { mechanism, boundary, summaryObj } = decision;
  // per review-correctness.md C-3: when a `system.compact_boundary` is
  // merged with an adjacent `user.isCompactSummary`, the consumed user's
  // uuid MUST survive as the merged entry's `id` so that any downstream
  // entry whose `parentUuid` references that uuid still resolves through
  // the tree. The boundary's metadata (preTokens/postTokens/trigger) is
  // folded in but is not the entry's identity.
  const idSource = summaryObj || raw;
  const baseId = idSource.uuid || raw.uuid || `${path.basename(ctx.filePath)}:${ctx.lineNo}`;
  const baseParent = (summaryObj?.parentUuid ?? raw.parentUuid) ?? null;
  const base = {
    id: baseId,
    parentId: baseParent,
    timestamp: (summaryObj?.timestamp) || raw.timestamp || null,
    raw,
    source: ID,
    sidechain: !!raw.isSidechain,
    agentId: raw.agentId || null,
  };
  // Extract narrative summary from whatever object carries it.
  let summary = '';
  if (summaryObj) {
    if (typeof summaryObj.summary === 'string') summary = summaryObj.summary;
    else summary = extractMessageContentText(summaryObj.message?.content);
  } else if (typeof raw.summary === 'string') {
    summary = raw.summary;
  }
  const tokensBefore = boundary?.compactMetadata?.preTokens
    ?? boundary?.preTokens
    ?? null;
  const tokensAfter = boundary?.compactMetadata?.postTokens
    ?? boundary?.postTokens
    ?? null;
  const trigger = boundary?.compactMetadata?.trigger || boundary?.trigger || null;
  const firstKeptEntryId = summaryObj?.leafUuid || raw.leafUuid || null;

  return {
    ...base,
    kind: 'compaction',
    summary,
    firstKeptEntryId,
    tokensBefore,
    tokensAfter,
    trigger,
    mechanism,
    fromHook: !!(raw.fromHook || summaryObj?.fromHook),
    details: null,
  };
}

// ----- tool_result extraction (slice C) -----

function extractToolResultBlocks(content) {
  // per review-correctness.md §Tool-pair: accept `web_search_tool_result`
  // and `mcp_tool_result` as result-shaped blocks (server-side tools).
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (part?.type === 'tool_result' ||
        part?.type === 'web_search_tool_result' ||
        part?.type === 'mcp_tool_result') {
      out.push(part);
    }
  }
  return out;
}

function buildToolResultEntry(raw, tr, base, ctx, idx, total) {
  const paired = ctx?.toolUseRegistry?.get(tr.tool_use_id) || null;
  const id = total > 1 ? `${base.id}:${tr.tool_use_id || idx}` : base.id;

  if (!paired && ctx?.parseErrors) {
    ctx.parseErrors.push({
      line: ctx.lineNo,
      reason: `tool_result references unknown tool_use_id ${tr.tool_use_id}`,
      preview: '',
    });
  }

  const toolName = paired?.name || null;
  const toolUseResult = raw.toolUseResult || null;

  if (toolName === 'Bash') {
    return buildBashEntry({ ...base, id }, tr, paired, toolUseResult);
  }

  const { text, outputBytes } = collectToolResultText(tr, toolUseResult);
  const isError = !!(tr.is_error || toolUseResult?.isError);
  return {
    ...base,
    id,
    kind: 'toolResult',
    toolCallId: tr.tool_use_id || null,
    toolName,
    isError,
    text,
    outputBytes,
    details: toolUseResult || null,
    fullOutputPath: null,
    truncated: false,
  };
}

function buildBashEntry(base, tr, paired, toolUseResult) {
  const input = paired?.input || {};
  const command = typeof input.command === 'string' ? input.command : '';

  let output = '';
  if (toolUseResult && (typeof toolUseResult.stdout === 'string' || typeof toolUseResult.stderr === 'string')) {
    const stdout = typeof toolUseResult.stdout === 'string' ? toolUseResult.stdout : '';
    const stderr = typeof toolUseResult.stderr === 'string' ? toolUseResult.stderr : '';
    output = stderr ? (stdout ? stdout + '\n' + stderr : stderr) : stdout;
  } else {
    output = collectToolResultText(tr, null).text;
  }

  const interrupted = !!toolUseResult?.interrupted;
  const isErrorFlag = !!(tr.is_error || toolUseResult?.isError);
  let exitCode = null;
  if (interrupted) exitCode = -1;
  else if (isErrorFlag) exitCode = 1;
  else if (BASH_FAILURE_HINT_RE.test(output)) exitCode = 1;

  return {
    ...base,
    kind: 'bashExecution',
    command,
    output,
    outputBytes: output.length,
    exitCode,
    cancelled: interrupted,
    truncated: output.length >= BASH_TRUNCATION_HINT,
    fullOutputPath: null,
    excludeFromContext: false,
  };
}

function collectToolResultText(tr, toolUseResult) {
  let text = '';
  let outputBytes = 0;
  if (typeof tr.content === 'string') {
    text = tr.content;
    outputBytes = text.length;
  } else if (Array.isArray(tr.content)) {
    for (const p of tr.content) {
      if (p?.type === 'text' && typeof p.text === 'string') {
        text += (text ? '\n' : '') + p.text;
        outputBytes += p.text.length;
      }
    }
  }
  if (!text && toolUseResult && typeof toolUseResult === 'object') {
    if (typeof toolUseResult.content === 'string') {
      text = toolUseResult.content;
      outputBytes = text.length;
    } else if (typeof toolUseResult.file === 'object' && typeof toolUseResult.file?.content === 'string') {
      text = toolUseResult.file.content;
      outputBytes = text.length;
    }
  }
  return { text, outputBytes };
}

// ----- text helpers -----

function extractMessageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  }
  return out.join('\n');
}

function decomposeAssistantContent(content) {
  let text = '';
  let thinking = '';
  const toolCalls = [];
  if (!Array.isArray(content)) return { text, thinking, toolCalls };
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      text += (text ? '\n' : '') + (part.text || '');
    } else if (part.type === 'thinking') {
      thinking += (thinking ? '\n' : '') + (part.thinking || '');
    } else if (part.type === 'tool_use' || part.type === 'server_tool_use') {
      // per review-correctness.md §Tool-pair: surface server_tool_use
      // alongside tool_use so the assistant entry's toolCalls reflects
      // both client- and server-side invocations.
      toolCalls.push({
        id: part.id || null,
        name: part.name || null,
        arguments: part.input ?? null,
      });
    }
  }
  return { text, thinking, toolCalls };
}

function detectPromptType(raw) {
  if (raw.isCompactSummary) return 'system_caveat';
  if (raw.toolUseResult) return 'hook_result';
  if (Array.isArray(raw.message?.content)) {
    for (const p of raw.message.content) {
      if (p?.type === 'tool_result') return 'hook_result';
    }
  }
  const text = typeof raw.message?.content === 'string' ? raw.message.content : '';
  if (/^<(command-name|command-message|local-command-stdout)>/.test(text)) {
    return 'command';
  }
  return 'user';
}

module.exports = {
  id: ID,
  defaultRoot,
  discover,
  parseFile,
  decodeProjectDir,
  sniff,
  // Internal helpers — exported for tests.
  parseSessionText,
  normalizeEntry,
};
