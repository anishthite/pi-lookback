// Improvement-signal heuristics. Each detector receives a parsed session
// and returns an array of zero or more signals. Signals are surfaced as
// badges in the UI and used by the global "review-worthy" ranking.

'use strict';

const CORRECTION_RE = /\b(no(t)?( that)?|wrong|you forgot|actually|fix(?:\b|ed)|i said|that('?s| is) (not|wrong)|incorrect|stop|don'?t|undo)\b/i;

const HIGH_COST_THRESHOLD = 1.00;          // USD per session
const BRANCH_HEAVY_THRESHOLD = 5;
const COMPACTION_HEAVY_THRESHOLD = 2;
const HUGE_OUTPUT_THRESHOLD = 50 * 1024;    // 50KB per tool result
const LONG_NO_TOOL_STRETCH = 3;             // consecutive assistant msgs with no tool calls

function detectSignals(parsed) {
  const { entries } = parsed;
  const signals = [];

  // 1) Failed tool calls
  for (const e of entries) {
    if (e.kind === 'toolResult' && e.isError) {
      signals.push({ kind: 'failed_tool', entryId: e.id, toolName: e.toolName, msg: `Tool ${e.toolName} returned error` });
    }
    if (e.kind === 'bashExecution' && typeof e.exitCode === 'number' && e.exitCode !== 0) {
      signals.push({ kind: 'failed_bash', entryId: e.id, exitCode: e.exitCode, msg: `bash exit ${e.exitCode}: ${e.command?.slice(0,80)}` });
    }
    // Slice E: assistant stopReason set unified across pi + cc. pi emits
    // 'error'/'aborted'; cc emits Anthropic-API values 'refusal' alongside
    // 'end_turn'/'tool_use'/'stop_sequence'/'pause_turn'/'max_tokens'.
    // per review-correctness.md C-4: `max_tokens` is a normal end-of-turn
    // for long outputs (not a failure) and was over-flagging mid-task.
    if (e.kind === 'assistant' &&
        (e.stopReason === 'error' || e.stopReason === 'aborted' ||
         e.stopReason === 'refusal')) {
      signals.push({ kind: 'aborted_assistant', entryId: e.id, msg: `Assistant stopReason=${e.stopReason}` });
    }
    if (e.kind === 'toolResult' && (e.outputBytes || 0) > HUGE_OUTPUT_THRESHOLD) {
      signals.push({ kind: 'huge_output', entryId: e.id, bytes: e.outputBytes, msg: `Tool output ${e.outputBytes}B` });
    }
    if (e.kind === 'toolResult' && e.truncated) {
      signals.push({ kind: 'truncated_output', entryId: e.id, msg: 'Tool result truncated' });
    }
  }

  // 2) Repeated failed commands (normalized whitespace)
  const cmdFailures = new Map();
  for (const e of entries) {
    if (e.kind === 'bashExecution' && e.exitCode !== 0 && e.command) {
      const norm = e.command.replace(/\s+/g, ' ').trim();
      cmdFailures.set(norm, (cmdFailures.get(norm) || 0) + 1);
    }
  }
  for (const [cmd, n] of cmdFailures.entries()) {
    if (n >= 2) signals.push({ kind: 'repeated_failed_command', count: n, msg: `Failed ${n}×: ${cmd.slice(0,80)}` });
  }

  // 3) User corrections
  for (const e of entries) {
    if (e.kind === 'user' && e.text && CORRECTION_RE.test(e.text)) {
      signals.push({ kind: 'user_correction', entryId: e.id, msg: `User correction: ${e.text.slice(0,120)}` });
    }
  }

  // 4) Long no-tool stretches
  let stretch = 0;
  for (const e of entries) {
    if (e.kind !== 'assistant') continue;
    if (!e.toolCalls || e.toolCalls.length === 0) {
      stretch++;
      if (stretch === LONG_NO_TOOL_STRETCH) {
        signals.push({ kind: 'long_no_tool_stretch', entryId: e.id, msg: `≥${LONG_NO_TOOL_STRETCH} assistant msgs without tool use` });
      }
    } else {
      stretch = 0;
    }
  }

  // 5) High cost.
  //    Cross-source contract: every assistant entry populates `e.cost` (pi
  //    pulls from `m.usage.cost.total`; cc computes from sources/pricing.js).
  //    Unknown cc models yield null and are skipped here, never NaN.
  let totalCost = 0;
  for (const e of entries) if (typeof e.cost === 'number') totalCost += e.cost;
  if (totalCost > HIGH_COST_THRESHOLD) {
    signals.push({ kind: 'high_cost', total: totalCost, msg: `Session cost $${totalCost.toFixed(3)}` });
  }

  // 6) Branch-heavy / compaction-heavy
  const childrenById = new Map();
  for (const e of entries) {
    if (e.parentId) {
      if (!childrenById.has(e.parentId)) childrenById.set(e.parentId, []);
      childrenById.get(e.parentId).push(e.id);
    }
  }
  let branchCount = 0;
  for (const kids of childrenById.values()) if (kids.length > 1) branchCount++;
  if (branchCount >= BRANCH_HEAVY_THRESHOLD) {
    signals.push({ kind: 'branch_heavy', count: branchCount, msg: `${branchCount} branches` });
  }
  const compactionCount = entries.filter((e) => e.kind === 'compaction').length;
  if (compactionCount >= COMPACTION_HEAVY_THRESHOLD) {
    signals.push({ kind: 'compaction_heavy', count: compactionCount, msg: `${compactionCount} compactions` });
  }

  // 7) Verification-missing (heuristic): implementation-shaped session that never
  // runs a test/lint/build/validation command.
  const looksImplementation = entries.some((e) =>
    (e.kind === 'bashExecution' && /\b(node|tsc|npm|pnpm|yarn|bun|cargo|go |python|pytest|jest|vitest|make)\b/.test(e.command || '')) ||
    // Slice E: cc tool names include 'MultiEdit'; pi tool names are
    // lower-case 'write' / 'edit'. Regex is case-insensitive in both.
    (e.kind === 'toolResult' && /^(write|edit|multiedit)$/i.test(e.toolName || ''))
  );
  const verified = entries.some((e) => {
    if (e.kind === 'bashExecution') {
      return /\b(test|lint|build|tsc|pytest|vitest|jest|cargo (test|check)|go test|npm test|pnpm test)\b/.test(e.command || '');
    }
    return false;
  });
  if (looksImplementation && !verified) {
    signals.push({ kind: 'verification_missing', msg: 'Implementation-shaped session without verification command' });
  }

  return signals;
}

function aggregateSignalCounts(signals) {
  const m = {};
  for (const s of signals) m[s.kind] = (m[s.kind] || 0) + 1;
  return m;
}

module.exports = { detectSignals, aggregateSignalCounts };
