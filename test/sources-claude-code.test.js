// Claude Code adapter tests against fixtures/claude-code/.
// Pure assertion-based; no test framework dependency.
// See plan §8.1.

'use strict';

const path = require('path');
const { parseSessionFile } = require('../src/parser');
const { buildSessionSummary } = require('../src/summary');
const { detectSignals } = require('../src/signals');
const { costFor, _resetWarnings } = require('../src/sources/pricing');

const FIX = path.join(__dirname, '..', 'fixtures', 'claude-code');
const fix = (name) => path.join(FIX, name);

const results = [];
function t(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ---- sniff routing through the dispatch shim ----

t('parseSessionFile routes cc files via sniff (no source hint)', () => {
  const p = parseSessionFile(fix('cc-simple-turn.jsonl'));
  eq(p.source, 'claude-code', 'sniff selected cc adapter');
});

// ---- cc-simple-turn ----

t('cc-simple-turn: parses without errors', () => {
  const p = parseSessionFile(fix('cc-simple-turn.jsonl'));
  eq(p.parseErrors.length, 0, 'no parse errors');
  eq(p.source, 'claude-code');
  eq(p.entries.length, 2);
  eq(p.entries[0].kind, 'user');
  eq(p.entries[0].text, 'hello');
  eq(p.entries[0].promptType, 'user');
  eq(p.entries[1].kind, 'assistant');
  eq(p.entries[1].stopReason, 'end_turn');
  eq(p.entries[1].text, 'hi there');
  eq(p.entries[1].model, 'claude-opus-4-7');
  // parentId mapping: parentUuid → parentId
  eq(p.entries[1].parentId, p.entries[0].id, 'assistant points at user via parentId');
  // sidechain flag defaults false
  eq(p.entries[0].sidechain, false);
  eq(p.entries[1].sidechain, false);
});

t('cc-simple-turn: assistant carries usage and computed cost (all 4 token kinds)', () => {
  // per review-tests.md T-2: the fixture now exercises cache_creation +
  // cache_read pricing, not just input + output. Catches future regressions
  // where the cache columns get dropped from costFor().
  const p = parseSessionFile(fix('cc-simple-turn.jsonl'));
  const a = p.entries[1];
  assert(a.usage && a.usage.output_tokens === 3, 'usage preserved');
  assert(a.usage.cache_creation_input_tokens === 200, 'cache_creation preserved');
  assert(a.usage.cache_read_input_tokens === 5000, 'cache_read preserved');
  // claude-opus-4-7: input=15, output=75, cacheCreation=18.75, cacheRead=1.5 per million.
  // 10*15 + 3*75 + 200*18.75 + 5000*1.5 = 150 + 225 + 3750 + 7500 = 11625 / 1e6.
  const expected = (10 * 15 + 3 * 75 + 200 * 18.75 + 5000 * 1.5) / 1e6;
  assert(Math.abs(a.cost - expected) < 1e-12, `cost ${a.cost} vs expected ${expected}`);
  // totalTokens stays input+output only — cache tokens are billed separately.
  eq(a.totalTokens, 13);
  eq(a.messageId, 'msg_0001simpleturn');
});

// ---- pricing module direct tests ----

t('pricing: costFor known model with input + output', () => {
  const c = costFor('claude-opus-4-5-20251101', { input_tokens: 1e6, output_tokens: 1e6 });
  eq(c, 90); // 15 + 75
});

t('pricing: costFor uses prefix match for unknown long suffix', () => {
  const c = costFor('claude-sonnet-4-5-99999999', { input_tokens: 1e6, output_tokens: 1e6 });
  eq(c, 18); // 3 + 15
});

t('pricing: unknown model returns null', () => {
  _resetWarnings();
  // Suppress the warn during the test to keep stderr quiet.
  const orig = console.warn;
  console.warn = () => {};
  try {
    const c = costFor('mystery-model', { input_tokens: 100, output_tokens: 100 });
    eq(c, null);
  } finally { console.warn = orig; }
});

t('pricing: costFor with null usage returns null', () => {
  eq(costFor('claude-opus-4-7', null), null);
});

// ---- decodeProjectDir contract ----

t('cc decodeProjectDir reverses dash-encoding', () => {
  const cc = require('../src/sources/claude-code');
  eq(cc.decodeProjectDir('-Users-a-b'), '/Users/a/b');
  eq(cc.decodeProjectDir('-Users-anishthite-workspace-pi-lookback'),
     '/Users/anishthite/workspace/pi/lookback'); // lossy on dashes in path
});

t('pi decodeProjectDir uses --…-- wrapping', () => {
  const pi = require('../src/sources/pi');
  eq(pi.decodeProjectDir('--Users-a-b--'), '/Users/a/b');
});

t('cc and pi decoders are independent functions (no shared global state)', () => {
  // The two adapters use DIFFERENT encoding conventions (pi wraps with --,
  // cc does not). They may agree on inputs that fit both shapes, but each
  // must own its own implementation; importing them must not collide.
  const pi = require('../src/sources/pi');
  const cc = require('../src/sources/claude-code');
  assert(pi.decodeProjectDir !== cc.decodeProjectDir,
         'pi.decodeProjectDir and cc.decodeProjectDir are different references');
});

// ---- cc-tool-success ----

t('cc-tool-success: pairs Read tool_use↔tool_result by id', () => {
  const p = parseSessionFile(fix('cc-tool-success.jsonl'));
  eq(p.parseErrors.length, 0);
  const asst = p.entries.find((e) => e.kind === 'assistant');
  const results = p.entries.filter((e) => e.kind === 'toolResult');
  eq(asst.toolCalls.length, 1);
  eq(asst.toolCalls[0].name, 'Read');
  eq(results.length, 1);
  eq(results[0].toolName, 'Read');
  eq(results[0].toolCallId, 'toolu_R001');
  eq(results[0].isError, false);
  assert(results[0].text.includes('hello world'), 'text payload preserved');
  const sigs = detectSignals(p);
  assert(sigs.every((s) => s.kind !== 'failed_tool'), 'no failed_tool signals');
});

t('cc-tool-success: user kind is suppressed when content is a tool_result', () => {
  const p = parseSessionFile(fix('cc-tool-success.jsonl'));
  // The tool-result-bearing user entry must NOT also produce a `user` entry
  // (plan §2.6). Only the initial "read README.md" user entry counts.
  eq(p.entries.filter((e) => e.kind === 'user').length, 1);
});

// ---- cc-multi-tool-use ----

t('cc-multi-tool-use: one assistant carries two tool_uses, two toolResults emitted', () => {
  const p = parseSessionFile(fix('cc-multi-tool-use.jsonl'));
  eq(p.parseErrors.length, 0);
  const asst = p.entries.find((e) => e.kind === 'assistant');
  eq(asst.toolCalls.length, 2);
  const useIds = asst.toolCalls.map((tc) => tc.id);
  const results = p.entries.filter((e) => e.kind === 'toolResult');
  eq(results.length, 2);
  for (const r of results) assert(useIds.includes(r.toolCallId), `unpaired ${r.toolCallId}`);
  const names = results.map((r) => r.toolName).sort();
  assert(names[0] === 'Grep' && names[1] === 'Read', `tool names ${names}`);
});

// ---- cc-bash-success ----

t('cc-bash-success: emits bashExecution kind with command + no exitCode', () => {
  const p = parseSessionFile(fix('cc-bash-success.jsonl'));
  eq(p.parseErrors.length, 0);
  const bashes = p.entries.filter((e) => e.kind === 'bashExecution');
  eq(bashes.length, 1);
  const b = bashes[0];
  eq(b.command, 'ls -la');
  eq(b.cancelled, false);
  // CC Bash has no native exit code; absent errors → null (Risk R3).
  eq(b.exitCode, null);
  assert(b.output.includes('total 0'), 'stdout preserved');
  assert(p.entries.every((e) => e.kind !== 'toolResult'), 'no toolResult for Bash');
});

t('cc-bash-success: signals do not falsely flag failed_bash', () => {
  const p = parseSessionFile(fix('cc-bash-success.jsonl'));
  const sigs = detectSignals(p);
  assert(sigs.every((s) => s.kind !== 'failed_bash'), 'no false failed_bash');
});

// ---- cc-bash-error ----

t('cc-bash-error: surfaces failed_bash via toolUseResult.isError heuristic', () => {
  const p = parseSessionFile(fix('cc-bash-error.jsonl'));
  eq(p.parseErrors.length, 0);
  const b = p.entries.find((e) => e.kind === 'bashExecution');
  assert(b, 'bashExecution emitted');
  eq(b.exitCode, 1);  // R3 heuristic: isError→1
  assert(b.output.includes('No such file'), 'stderr propagated as output');
  const sigs = detectSignals(p);
  assert(sigs.some((s) => s.kind === 'failed_bash'), 'failed_bash signal fires');
  // Summary rollup must count the failed bash.
  const s = buildSessionSummary(p);
  eq(s.failedBashCommandCount, 1);
  eq(s.bashCommandCount, 1);
});

t('bash exit-code heuristic: stderr-only Traceback also infers failure', () => {
  // Direct unit-test of the regex fallback via the adapter's normalizeEntry.
  const cc = require('../src/sources/claude-code');
  const text = 'cc-bash-success.jsonl mock\nTraceback (most recent call last):\n  File ...\n';
  const fakeAssistant = {
    type: 'assistant', uuid: 'a', timestamp: 't', message: {
      content: [{ type: 'tool_use', id: 'tx', name: 'Bash', input: { command: 'python crash.py' } }],
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
    },
  };
  const fakeUser = {
    type: 'user', uuid: 'u', parentUuid: 'a', timestamp: 't',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tx', is_error: false, content: [{ type: 'text', text }] }] },
  };
  const { parseSessionText } = cc;
  const parsed = parseSessionText(JSON.stringify(fakeAssistant) + '\n' + JSON.stringify(fakeUser) + '\n', 'inmem.jsonl');
  const b = parsed.entries.find((e) => e.kind === 'bashExecution');
  assert(b, 'bashExecution emitted');
  eq(b.exitCode, 1);  // regex fallback fires
});

// ---- cc-sidechain ----

t('cc-sidechain: flags sidechain entries and surfaces agentId', () => {
  const p = parseSessionFile(fix('cc-sidechain.jsonl'));
  eq(p.parseErrors.length, 0);
  const sub = p.entries.filter((e) => e.sidechain);
  assert(sub.length >= 3, `expected ≥3 sidechain entries, got ${sub.length}`);
  assert(sub.every((e) => e.agentId === 'a4044e6'), 'all sidechain entries carry agentId');
  // Main thread stays unflagged.
  const main = p.entries.filter((e) => !e.sidechain);
  assert(main.length >= 2, `expected ≥2 main-thread entries, got ${main.length}`);
  assert(main.every((e) => e.agentId === null), 'main-thread entries have no agentId');
});

// ---- cc-multi-shard-assistant ----

t('cc-multi-shard: shardOf chain + usage on exactly one shard', () => {
  const p = parseSessionFile(fix('cc-multi-shard-assistant.jsonl'));
  eq(p.parseErrors.length, 0);
  const asst = p.entries.filter((e) => e.kind === 'assistant');
  eq(asst.length, 2, 'both shards emitted as separate entries');
  // First shard: no usage, shardOf null.
  eq(asst[0].shardOf, null);
  // Second shard: shardOf points at first shard's uuid.
  eq(asst[1].shardOf, asst[0].id);
  // Usage rollup invariant (Risk R4): exactly ONE shard keeps usage.
  const withUsage = asst.filter((e) => e.usage);
  eq(withUsage.length, 1, 'usage on exactly one shard');
  assert(withUsage[0].cost > 0, 'cost computed');
  // Summary tokens count once.
  const s = buildSessionSummary(p);
  eq(s.totalTokens, 150);  // 100 + 50 from the second shard only
  eq(s.assistantMessageCount, 2);  // shards still count as separate timeline entries
});

// ---- cc-attachment ----

t('cc-attachment: emits attachment_card with subtype', () => {
  const p = parseSessionFile(fix('cc-attachment.jsonl'));
  eq(p.parseErrors.length, 0);
  const att = p.entries.filter((e) => e.kind === 'attachment_card');
  eq(att.length, 1);
  eq(att[0].subtype, 'skill_listing');
  assert(att[0].payload && Array.isArray(att[0].payload.skills), 'payload preserved');
});

// ---- cc-queue-operation ----

t('cc-queue-operation: emits meta kind, user/assistant render normally', () => {
  const p = parseSessionFile(fix('cc-queue-operation.jsonl'));
  eq(p.parseErrors.length, 0);
  const meta = p.entries.filter((e) => e.kind === 'meta');
  eq(meta.length, 1);
  eq(meta[0].metaType, 'queue-operation');
  // sessionMeta synthesized true since no system.init.
  eq(p.sessionMeta.synthesized, true);
  eq(p.sessionMeta.cwd, '/tmp/cc-fixt');
  // user + assistant still emitted.
  assert(p.entries.some((e) => e.kind === 'user'));
  assert(p.entries.some((e) => e.kind === 'assistant'));
});

// ---- cc-malformed-line ----

t('cc-malformed-line: records parse error but keeps valid entries', () => {
  const p = parseSessionFile(fix('cc-malformed-line.jsonl'));
  assert(p.parseErrors.length >= 1, `expected ≥1 parseError, got ${p.parseErrors.length}`);
  // 4 valid lines: user + assistant + user + assistant.
  const validEntries = p.entries.filter((e) => e.kind === 'user' || e.kind === 'assistant');
  eq(validEntries.length, 4);
});

// ---- session_meta synthesis revisit ----

t('cc-simple-turn: sessionMeta synthesized when system.init absent', () => {
  const p = parseSessionFile(fix('cc-simple-turn.jsonl'));
  assert(p.sessionMeta, 'sessionMeta present');
  eq(p.sessionMeta.synthesized, true);
  eq(p.sessionMeta.cwd, '/tmp/cc-fixt');
  eq(p.sessionMeta.id, 'cc-simple-turn');
  eq(p.sessionMeta.model, 'claude-opus-4-7');
});

// ---- compaction: top-level summary mechanism (forward-compat) ----

t('compaction: top-level summary kind emits a compaction entry', () => {
  const cc = require('../src/sources/claude-code');
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'c', timestamp: 't1', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'summary', leafUuid: 'u1', summary: 'Compacted: 3 turns.', sessionId: 'c' }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'c', timestamp: 't2', message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ].join('\n');
  const p = cc.parseSessionText(lines, 'inmem-compaction.jsonl');
  const comps = p.entries.filter((e) => e.kind === 'compaction');
  eq(comps.length, 1);
  eq(comps[0].mechanism, 'top-level-summary');
  assert(comps[0].summary.includes('Compacted'), 'summary preserved');
});

// ---- compaction: boundary + isCompactSummary merge (forward-compat) ----

t('compaction: boundary + isCompactSummary within ±2 lines merges to one entry', () => {
  const cc = require('../src/sources/claude-code');
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: 'c', uuid: 's1', timestamp: 't1', compactMetadata: { preTokens: 50000, postTokens: 8000, trigger: 'auto' } }),
    JSON.stringify({ type: 'user', isCompactSummary: true, sessionId: 'c', uuid: 'u2', parentUuid: 's1', timestamp: 't2', message: { role: 'user', content: 'compacted history: ...' }, leafUuid: 'u1' }),
  ].join('\n');
  const p = cc.parseSessionText(lines, 'inmem-comp2.jsonl');
  const comps = p.entries.filter((e) => e.kind === 'compaction');
  eq(comps.length, 1, `expected 1 merged compaction, got ${comps.length}`);
  eq(comps[0].mechanism, 'system.compact_boundary');
  eq(comps[0].tokensBefore, 50000);
  eq(comps[0].tokensAfter, 8000);
  eq(comps[0].trigger, 'auto');
  assert(comps[0].summary.includes('compacted history'), 'summary text merged in');
  // No standalone user entry for the suppressed isCompactSummary line.
  assert(p.entries.every((e) => e.kind !== 'user' || e.id !== 'u2'), 'merged user line suppressed');
});

// ---- T-3: tool_result.content as STRING (common live shape) ----

t('tool_result.content as string (not array) preserves text', () => {
  // per review-tests.md T-3: live CC corpus emits both shapes for
  // tool_result.content; the array shape was already covered, this nails
  // down the string shape so the collectToolResultText branch is locked in.
  const cc = require('../src/sources/claude-code');
  const asst = {
    type: 'assistant', uuid: 'aa', timestamp: 't',
    message: {
      id: 'mA', role: 'assistant', model: 'claude-opus-4-7',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tX', name: 'Read', input: { file_path: '/x' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  const usr = {
    type: 'user', uuid: 'uu', parentUuid: 'aa', timestamp: 't',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tX', content: 'raw string output, not array' }] },
  };
  const lines = JSON.stringify(asst) + '\n' + JSON.stringify(usr) + '\n';
  const p = cc.parseSessionText(lines, 'inmem-tr-string.jsonl');
  const tr = p.entries.find((e) => e.kind === 'toolResult');
  assert(tr, 'toolResult emitted');
  eq(tr.text, 'raw string output, not array');
  eq(tr.toolName, 'Read');
  eq(tr.isError, false);
});

// ---- T-5: edge-case parseSessionText behavior ----

t('T-5a: empty string returns empty entries / parseErrors without throwing', () => {
  const cc = require('../src/sources/claude-code');
  const p = cc.parseSessionText('', 'inmem-empty.jsonl');
  eq(p.entries.length, 0);
  eq(p.parseErrors.length, 0);
  assert(p.sessionMeta, 'sessionMeta still synthesized (empty stub)');
});

t('T-5b: blank-lines-only string yields nothing, no errors', () => {
  const cc = require('../src/sources/claude-code');
  const p = cc.parseSessionText('\n\n   \n\n', 'inmem-blank.jsonl');
  eq(p.entries.length, 0);
  eq(p.parseErrors.length, 0);
});

t('T-5c: BOM-prefixed first line records a parseError but does not throw', () => {
  // per review-tests.md T-5: document current behavior — we do NOT strip
  // a leading U+FEFF and the JSON.parse failure surfaces as a parseError.
  // If we later add BOM stripping this assertion will flip; that's fine.
  const cc = require('../src/sources/claude-code');
  const goodObj = { type: 'user', uuid: 'u1', sessionId: 's', timestamp: 't', message: { role: 'user', content: 'hi' } };
  const text = '\uFEFF' + JSON.stringify(goodObj) + '\n';
  const p = cc.parseSessionText(text, 'inmem-bom.jsonl');
  assert(p.parseErrors.length >= 1, 'BOM prefix surfaces as parseError');
});

t('T-5d: duplicate tool_use.id — last-wins in registry (documented behavior)', () => {
  // per review-tests.md T-5: if a single session emits two tool_use blocks
  // sharing the same id (a CC bug we've never seen but is technically
  // possible), the registry's `reg.set(id, ...)` overwrites the first.
  // The downstream tool_result therefore pairs against the SECOND tool_use.
  const cc = require('../src/sources/claude-code');
  const a1 = {
    type: 'assistant', uuid: 'a1', timestamp: 't',
    message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'dup', name: 'Read', input: { file_path: '/first' } }],
      usage: { input_tokens: 1, output_tokens: 1 } },
  };
  const a2 = {
    type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: 't',
    message: { id: 'm2', role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'dup', name: 'Bash', input: { command: 'ls' } }],
      usage: { input_tokens: 1, output_tokens: 1 } },
  };
  const u = {
    type: 'user', uuid: 'u1', parentUuid: 'a2', timestamp: 't',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'dup', content: 'result' }] },
  };
  const text = [a1, a2, u].map((x) => JSON.stringify(x)).join('\n') + '\n';
  const p = cc.parseSessionText(text, 'inmem-dup-id.jsonl');
  // Either the bashExecution OR a toolResult-with-toolName=Bash should
  // surface (Bash is the second tool_use). Read should NOT pair.
  const bash = p.entries.find((e) => e.kind === 'bashExecution');
  const trBlocks = p.entries.filter((e) => e.kind === 'toolResult');
  assert(bash || trBlocks.some((tr) => tr.toolName === 'Bash'),
    `last-wins: expected Bash pairing, got ${trBlocks.map((tr) => tr.toolName).join(',')}`);
});

t('T-5e: system.init exercises the session_meta dead branch (forward-compat)', () => {
  // per review-tests.md T-5 / review-simplicity.md P-3: the init branch is
  // dead in the live corpus but kept for forward-compat. This test pins
  // the behavior so a future refactor doesn't silently delete it.
  const cc = require('../src/sources/claude-code');
  const init = {
    type: 'system', subtype: 'init', uuid: 'i1', sessionId: 'cc-init', timestamp: 't0',
    cwd: '/init/cwd', claude_code_version: '9.9.9', model: 'claude-opus-4-7',
    permissionMode: 'plan',
    tools: ['Read', 'Write'], mcp_servers: ['fs'], agents: ['planner'],
  };
  const usr = { type: 'user', uuid: 'u1', parentUuid: 'i1', sessionId: 'cc-init', timestamp: 't1', message: { role: 'user', content: 'go' } };
  const text = [init, usr].map((x) => JSON.stringify(x)).join('\n') + '\n';
  const p = cc.parseSessionText(text, 'inmem-init.jsonl');
  const meta = p.entries.find((e) => e.kind === 'session_meta');
  assert(meta, 'session_meta entry emitted from system.init');
  eq(meta.cwd, '/init/cwd');
  eq(meta.version, '9.9.9');
  eq(meta.synthesized, false);
  assert(meta.tools.includes('Read'), 'tools propagated');
  // sessionMeta header reflects the init line (synthesized:false).
  eq(p.sessionMeta.synthesized, false);
  eq(p.sessionMeta.cwd, '/init/cwd');
});

// ---- sniff routing rejects pi files going to cc and vice-versa ----

t('cc adapter sniff rejects pi session files', () => {
  const cc = require('../src/sources/claude-code');
  const piFirst = { type: 'session', version: 3, id: 'fixt-simple-linear' };
  eq(cc.sniff('whatever.jsonl', piFirst), false);
});

t('pi adapter sniff rejects cc files', () => {
  const pi = require('../src/sources/pi');
  const ccFirst = { type: 'user', sessionId: 'abc', uuid: 'def' };
  eq(pi.sniff('whatever.jsonl', ccFirst), false);
});

// ---- Report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}` + (r.ok ? '' : ` — ${r.err}`));
}
console.log(`\n${passed}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
