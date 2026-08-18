// Derive a SessionSummary (used by the library view) and supporting helpers.
// Pure transformation of parsed entries -> compact aggregate metadata.
//
// Slice E (plan §1.6, §2.3): added `source` field and per-source decoder
// fallback chain; new aggregate counts for cc-specific kinds.

'use strict';

const path = require('path');
const { getSource } = require('./sources');

function buildSessionSummary({ entries, sessionMeta, filePath, parseErrors, source }) {
  // Slice E: `source` lives on the parsed envelope; fall back to sessionMeta
  // or 'pi' for back-compat with callers that don't pass it.
  const resolvedSource = source || sessionMeta?.source || 'pi';

  const startedAt = sessionMeta?.timestamp || entries[0]?.timestamp || null;
  const endedAt = entries.length ? entries[entries.length - 1].timestamp : null;

  // Find first user prompt for a quick label. Skip cc tool-result-bearing
  // user entries (slice C maps those to toolResult/bashExecution so this
  // is already correct, but be defensive).
  const firstUser = entries.find((e) => e.kind === 'user');
  const firstPrompt = firstUser?.text?.slice(0, 240) || null;

  // Counts
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let failedToolCallCount = 0;
  let bashCommandCount = 0;
  let failedBashCommandCount = 0;
  let compactionCount = 0;
  let modelSwitchCount = 0;
  let thinkingLevelSwitchCount = 0;
  let customCount = 0;
  let totalTokens = 0;
  let totalCost = 0;
  let maxAssistantCost = 0;
  // Slice E: cc-only roll-ups.
  let attachmentCount = 0;
  let metaCount = 0;
  let sidechainCount = 0;
  let errorEventCount = 0;
  let snapshotCount = 0;

  const childrenById = new Map();
  const seenIds = new Set();
  const models = new Set();

  for (const e of entries) {
    if (e.id) seenIds.add(e.id);
    if (e.parentId) {
      if (!childrenById.has(e.parentId)) childrenById.set(e.parentId, []);
      childrenById.get(e.parentId).push(e.id);
    }
    if (e.sidechain) sidechainCount++;
    switch (e.kind) {
      case 'user': userMessageCount++; break;
      case 'assistant': {
        assistantMessageCount++;
        toolCallCount += e.toolCalls?.length || 0;
        // Risk R4 lock-in: usage was zeroed out on non-primary shards, so
        // this sum counts each msg_… exactly once for cc; pi behavior
        // unchanged because pi shards don't exist.
        if (typeof e.totalTokens === 'number') totalTokens += e.totalTokens;
        if (typeof e.cost === 'number') {
          totalCost += e.cost;
          if (e.cost > maxAssistantCost) maxAssistantCost = e.cost;
        }
        if (e.model) models.add(e.model);
        break;
      }
      case 'toolResult': if (e.isError) failedToolCallCount++; break;
      case 'bashExecution': {
        bashCommandCount++;
        if (typeof e.exitCode === 'number' && e.exitCode !== 0) failedBashCommandCount++;
        break;
      }
      case 'compaction': compactionCount++; break;
      case 'model_change': modelSwitchCount++; break;
      case 'thinking_level_change': thinkingLevelSwitchCount++; break;
      case 'custom':
      case 'custom_message': customCount++; break;
      case 'attachment_card': attachmentCount++; break;
      case 'meta': metaCount++; break;
      case 'error': errorEventCount++; break;
      case 'snapshot': snapshotCount++; break;
      default: break;
    }
  }

  let branchCount = 0;
  for (const kids of childrenById.values()) {
    if (kids.length > 1) branchCount++;
  }

  const durationMs = (startedAt && endedAt) ? (new Date(endedAt) - new Date(startedAt)) : null;

  // Project path resolution chain (plan §5.2):
  //   1. sessionMeta.cwd  (set by adapter in pre-pass)
  //   2. raw entry cwd from the first user/assistant entry (cc per-entry cwd)
  //   3. adapter.decodeProjectDir(projectDir) — last resort, lossy on cc.
  const projectDir = filePath ? path.basename(path.dirname(filePath)) : '';
  const projectPath = resolveProjectPath({ sessionMeta, entries, source: resolvedSource, projectDir });

  const reviewScore = computeReviewScore({
    failedToolCallCount,
    failedBashCommandCount,
    branchCount,
    compactionCount,
    totalCost,
    parseErrors: parseErrors?.length || 0,
    entryCount: entries.length,
  });

  return {
    id: sessionMeta?.id || (filePath ? path.basename(filePath, '.jsonl') : ''),
    filePath: filePath || null,
    source: resolvedSource,
    projectDir,
    projectPath,
    cwd: sessionMeta?.cwd || projectPath || '',
    startedAt,
    endedAt,
    durationMs,
    firstPrompt,
    entryCount: entries.length,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    failedToolCallCount,
    bashCommandCount,
    failedBashCommandCount,
    branchCount,
    compactionCount,
    modelSwitchCount,
    thinkingLevelSwitchCount,
    customCount,
    attachmentCount,
    metaCount,
    sidechainCount,
    errorEventCount,
    snapshotCount,
    totalTokens,
    totalCost,
    maxAssistantCost,
    models: [...models],
    parseErrorCount: parseErrors?.length || 0,
    reviewScore,
    // cc-workflow only: pass the synthesized workflow header through so the
    // UI can render a meaningful banner (script, status, phases, duration).
    workflow: sessionMeta?.workflow || null,
  };
}

function resolveProjectPath({ sessionMeta, entries, source, projectDir }) {
  if (sessionMeta?.cwd) return sessionMeta.cwd;
  for (const e of entries) {
    if (e.kind === 'user' || e.kind === 'assistant') {
      const cwd = e.raw?.cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    }
  }
  if (!projectDir) return '';
  const adapter = getSource(source);
  if (adapter?.decodeProjectDir) return adapter.decodeProjectDir(projectDir);
  return projectDir;
}

function computeReviewScore({ failedToolCallCount, failedBashCommandCount, branchCount, compactionCount, totalCost, parseErrors, entryCount }) {
  let score = 0;
  score += failedToolCallCount * 4;
  score += failedBashCommandCount * 6;
  score += branchCount * 5;
  score += compactionCount * 3;
  score += Math.min(40, Math.floor(totalCost * 100));
  score += parseErrors * 10;
  if (entryCount > 500) score += 5;
  return score;
}

module.exports = { buildSessionSummary, computeReviewScore };
