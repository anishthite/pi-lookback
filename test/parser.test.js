// Parser + summary + signals tests against the local fixture corpus.
// Pure assertion-based; no test framework dependency.

'use strict';

const path = require('path');
const { parseSessionFile } = require('../src/parser');
const { buildSessionSummary } = require('../src/summary');
const { detectSignals, aggregateSignalCounts } = require('../src/signals');

const FIX = path.join(__dirname, '..', 'fixtures');

const results = [];
function t(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ---- simple-linear ----
t('simple-linear: parses without errors', () => {
  const p = parseSessionFile(path.join(FIX, 'simple-linear.jsonl'));
  eq(p.parseErrors.length, 0, 'no parse errors');
  eq(p.sessionMeta?.id, 'fixt-simple-linear');
  eq(p.entries.length, 3); // model_change + user + assistant
  const s = buildSessionSummary(p);
  eq(s.userMessageCount, 1);
  eq(s.assistantMessageCount, 1);
  eq(s.toolCallCount, 0);
});

// ---- tool-success ----
t('tool-success: counts tool call and result', () => {
  const p = parseSessionFile(path.join(FIX, 'tool-success.jsonl'));
  const s = buildSessionSummary(p);
  eq(s.toolCallCount, 1);
  eq(s.failedToolCallCount, 0);
  const sigs = detectSignals(p);
  assert(sigs.every((x) => x.kind !== 'failed_tool'), 'no failed_tool signals');
});

// ---- tool-error ----
t('tool-error: detects failed tool', () => {
  const p = parseSessionFile(path.join(FIX, 'tool-error.jsonl'));
  const s = buildSessionSummary(p);
  eq(s.failedToolCallCount, 1);
  const sigs = detectSignals(p);
  assert(sigs.some((x) => x.kind === 'failed_tool'), 'failed_tool signal present');
});

// ---- bash-failure: repeated failed command ----
t('bash-failure: detects repeated_failed_command', () => {
  const p = parseSessionFile(path.join(FIX, 'bash-failure.jsonl'));
  const s = buildSessionSummary(p);
  eq(s.failedBashCommandCount, 2);
  const sigs = detectSignals(p);
  assert(sigs.some((x) => x.kind === 'repeated_failed_command' && x.count === 2), 'repeated_failed_command');
  assert(sigs.filter((x) => x.kind === 'failed_bash').length === 2, 'two failed_bash signals');
});

// ---- branching ----
t('branching: counts branches via parentId tree', () => {
  const p = parseSessionFile(path.join(FIX, 'branching.jsonl'));
  const s = buildSessionSummary(p);
  eq(s.branchCount, 1, 'u1 has 3 children');
});

// ---- compaction ----
t('compaction: counts compactions and preserves summary', () => {
  const p = parseSessionFile(path.join(FIX, 'compaction.jsonl'));
  const s = buildSessionSummary(p);
  eq(s.compactionCount, 2);
  const comps = p.entries.filter((e) => e.kind === 'compaction');
  assert(comps[0].summary.includes('Compacted'), 'first compaction summary preserved');
  const sigs = detectSignals(p);
  assert(sigs.some((x) => x.kind === 'compaction_heavy'), 'compaction_heavy signal');
});

// ---- unknown-entry ----
t('unknown-entry: gracefully classifies unknown type', () => {
  const p = parseSessionFile(path.join(FIX, 'unknown-entry.jsonl'));
  eq(p.parseErrors.length, 0);
  assert(p.entries.some((e) => e.kind === 'unknown'), 'unknown kind present');
});

// ---- huge-output ----
t('huge-output: detects huge_output and truncated_output', () => {
  const p = parseSessionFile(path.join(FIX, 'huge-output.jsonl'));
  const sigs = detectSignals(p);
  assert(sigs.some((x) => x.kind === 'huge_output'), 'huge_output signal');
  assert(sigs.some((x) => x.kind === 'truncated_output'), 'truncated_output signal');
});

// ---- corrupt ----
t('corrupt: records parse errors but keeps valid lines', () => {
  const p = parseSessionFile(path.join(FIX, 'corrupt.jsonl'));
  assert(p.parseErrors.length >= 1, 'records at least one parse error');
  assert(p.entries.length >= 2, 'still keeps the valid entries');
});

// ---- user correction detection ----
t('correction: regex catches common correction phrases', () => {
  const { detectSignals } = require('../src/signals');
  const parsed = {
    entries: [
      { kind: 'user', id: 'u1', text: 'no that is wrong, fix it' },
      { kind: 'user', id: 'u2', text: 'thanks!' },
      { kind: 'user', id: 'u3', text: 'actually, undo' },
    ],
  };
  const sigs = detectSignals(parsed);
  const correctionEntries = sigs.filter((s) => s.kind === 'user_correction').map((s) => s.entryId);
  assert(correctionEntries.includes('u1'), 'flags wrong/fix');
  assert(correctionEntries.includes('u3'), 'flags actually/undo');
  assert(!correctionEntries.includes('u2'), 'does not flag thanks');
});

// ---- Report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}` + (r.ok ? '' : ` — ${r.err}`));
}
console.log(`\n${passed}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
