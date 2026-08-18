// cc-workflow adapter tests. Pure assertion style; no test framework.
// Uses committed fixtures under fixtures/cc-workflow/ — fully deterministic,
// no dependency on ~/.pi/cc-workflow/runs.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const ccWorkflow = require('../src/sources/cc-workflow');
const { sniffSource } = require('../src/sources');
const { parseSessionFile } = require('../src/parser');
const { buildSessionSummary } = require('../src/summary');

const FIX = path.join(__dirname, '..', 'fixtures', 'cc-workflow');
const FIX_CC = path.join(__dirname, '..', 'fixtures', 'claude-code');
const fixRun = (n) => path.join(FIX, n);

const results = [];
function t(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err.message, stack: err.stack }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ---- defaultRoot ----

t('defaultRoot honors PI_CC_WORKFLOW_DIR override', () => {
  const prev = process.env.PI_CC_WORKFLOW_DIR;
  process.env.PI_CC_WORKFLOW_DIR = '/tmp/cc-wf-override';
  try { eq(ccWorkflow.defaultRoot(), '/tmp/cc-wf-override'); }
  finally {
    if (prev === undefined) delete process.env.PI_CC_WORKFLOW_DIR;
    else process.env.PI_CC_WORKFLOW_DIR = prev;
  }
});

t('defaultRoot default lands under ~/.pi/cc-workflow/runs', () => {
  const prev = process.env.PI_CC_WORKFLOW_DIR;
  delete process.env.PI_CC_WORKFLOW_DIR;
  try { eq(ccWorkflow.defaultRoot(), path.join(os.homedir(), '.pi', 'cc-workflow', 'runs')); }
  finally { if (prev !== undefined) process.env.PI_CC_WORKFLOW_DIR = prev; }
});

t('discover tolerates missing root', () => {
  const rows = ccWorkflow.discover('/nonexistent/path/should/not/exist');
  eq(rows.length, 0);
});

t('discover returns positive rows for synthetic root with 2 runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wf-disc-'));
  try {
    fs.writeFileSync(path.join(dir, 'run-a.json'), JSON.stringify({ runId: 'a', journal: [] }));
    fs.writeFileSync(path.join(dir, 'run-b.json'), JSON.stringify({ runId: 'b', journal: [] }));
    fs.writeFileSync(path.join(dir, 'README.txt'), 'ignore me');
    const rows = ccWorkflow.discover(dir);
    eq(rows.length, 2, 'two .json rows discovered');
    for (const r of rows) eq(r.source, 'cc-workflow');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- fixture-backed tests (deterministic) ----

t('discover returns rows tagged cc-workflow with .json paths', () => {
  const rows = ccWorkflow.discover(FIX);
  assert(rows.length >= 3, `expected ≥3 fixture rows, got ${rows.length}`);
  for (const r of rows) {
    eq(r.source, 'cc-workflow', `row source for ${r.filePath}`);
    assert(r.filePath.endsWith('.json'));
    assert(typeof r.projectKey === 'string' && r.projectKey.length > 0);
  }
});

t('sniffSource routes .json via sniffFile fallback', () => {
  eq(sniffSource(fixRun('run-mq5j6x1t-1.json')), 'cc-workflow');
});

t('sniffFile positive on synthetic minimal envelope', () => {
  const tmp = path.join(os.tmpdir(), `cc-wf-pos-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ runId: 'r1', journal: [] }, null, 2));
  try { eq(ccWorkflow.sniffFile(tmp), true); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
});

t('sniffSource still routes pi fixture to pi (no regression)', () => {
  const ccFix = path.join(FIX_CC, 'cc-simple-turn.jsonl');
  if (!fs.existsSync(ccFix)) return;
  eq(sniffSource(ccFix), 'claude-code');
});

t('parseFile (run-mq5hmxa2-1.json, 3 journal entries)', () => {
  const fp = fixRun('run-mq5hmxa2-1.json');
  const p = parseSessionFile(fp);
  eq(p.source, 'cc-workflow');
  eq(p.parseErrors.length, 0, 'no parse errors');
  const assistants = p.entries.filter((e) => e.kind === 'assistant');
  eq(assistants.length, 3, '3 assistant entries');
  eq(p.entries.filter((e) => e.kind === 'user').length, 1, '1 synth user entry');
  eq(p.entries[0].kind, 'user');
  eq(p.entries[0].text, 'whiteboard-fullscreen (complete)');
  eq(p.entries[1].kind, 'assistant');
  assert(p.entries[1].text.startsWith('I have enough'), 'assistant text head');
  eq(p.entries[1].model, null);
  eq(p.entries[1].usage, null);
  // synth-user ts strictly precedes assistant[0] ts (correctness MINOR #2).
  assert(p.entries[0].timestamp < p.entries[1].timestamp, 'synth-user < assistant[0]');
  assert(p.entries[1].timestamp < p.entries[3].timestamp, 'timestamps monotonic');
  // Entry ids unique even if journal[].index is sparse (correctness MINOR #1).
  const ids = new Set(p.entries.map((e) => e.id));
  eq(ids.size, p.entries.length, 'unique entry ids');
  eq(p.sessionMeta.id, 'run-mq5hmxa2-1');
  assert(p.sessionMeta.cwd.endsWith('whiteboard-fullscreen-run-mq5hmxa2-1.js'),
    `cwd ends with script name: ${p.sessionMeta.cwd}`);

  const sum = buildSessionSummary(p);
  eq(sum.source, 'cc-workflow');
  eq(sum.assistantMessageCount, 3);
  eq(sum.userMessageCount, 1);
  eq(sum.firstPrompt, 'whiteboard-fullscreen (complete)');
  eq(sum.totalTokens, 0);
  eq(sum.totalCost, 0);
});

t('parseFile (run-mq5es02x-1.json, mixed string + object results)', () => {
  const fp = fixRun('run-mq5es02x-1.json');
  const p = parseSessionFile(fp);
  eq(p.source, 'cc-workflow');
  const assistants = p.entries.filter((e) => e.kind === 'assistant');
  eq(assistants.length, 3, '3 assistants');
  // Script parsing injects per-agent prompt user entries; the assistant
  // for the schema'd first call carries the stringified object.
  assert(assistants[0].text.includes('"sum": 5'), `expected stringified object on assistants[0], got: ${assistants[0].text}`);
  eq(assistants[1].text, 'PONG');
  eq(assistants[2].text, 'PONG');
});

t('parseFile (run-mq5j6x1t-1.json, status=running)', () => {
  const fp = fixRun('run-mq5j6x1t-1.json');
  const p = parseSessionFile(fp);
  eq(p.source, 'cc-workflow');
  eq(p.parseErrors.length, 0);
  const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const nJournal = Array.isArray(doc.journal) ? doc.journal.length : 0;
  // 1 synth header user + nJournal assistants + up to nJournal synth prompt
  // users (when the workflow script can be parsed). The lower bound is the
  // contract callers depend on; the upper bound just sanity-checks no
  // duplicate injection.
  assert(p.entries.length >= 1 + nJournal, `expected >= ${1 + nJournal} entries, got ${p.entries.length}`);
  assert(p.entries.length <= 1 + nJournal * 2, `expected <= ${1 + nJournal * 2} entries, got ${p.entries.length}`);
  eq(p.entries[0].kind, 'user');
  // If the script parsed, every assistant carries a phase + label.
  const taggedAssistants = p.entries.filter((e) => e.kind === 'assistant' && (e.phaseTitle || e.agentLabel));
  assert(taggedAssistants.length === nJournal, `expected all ${nJournal} assistants tagged with phase/label, got ${taggedAssistants.length}`);
  const sum = buildSessionSummary(p);
  eq(sum.firstPrompt, `${doc.name} (${doc.status})`);
  assert(sum.workflow && sum.workflow.agentCount === nJournal, 'summary.workflow surfaces agentCount');
  assert(sum.workflow.phases.length >= 1, 'summary.workflow.phases populated');
});

// ---- buildSessionSummary fixture-independent ----

t('buildSessionSummary on synthetic empty-journal envelope', () => {
  const tmp = path.join(os.tmpdir(), `cc-wf-bs-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ runId: 'r2', name: 'demo', status: 'complete', journal: [] }));
  try {
    const p = ccWorkflow.parseFile(tmp);
    const sum = buildSessionSummary(p);
    eq(sum.source, 'cc-workflow');
    eq(sum.userMessageCount, 1);
    eq(sum.assistantMessageCount, 0);
    eq(sum.firstPrompt, 'demo (complete)');
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

// ---- malformed / minimal tolerance ----

t('parseFile returns parseError on malformed JSON', () => {
  const tmp = path.join(os.tmpdir(), `cc-wf-bad-${process.pid}.json`);
  fs.writeFileSync(tmp, '{not json');
  try {
    const p = ccWorkflow.parseFile(tmp);
    eq(p.source, 'cc-workflow');
    eq(p.entries.length, 0);
    assert(p.parseErrors.length === 1, 'one parse error');
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

t('parseFile synthesizes minimal envelope (run-id fallback text)', () => {
  const tmp = path.join(os.tmpdir(), `cc-wf-min-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ runId: 'r1', journal: [] }));
  try {
    const p = ccWorkflow.parseFile(tmp);
    eq(p.entries.length, 1); // synth user only
    eq(p.entries[0].kind, 'user');
    // NIT fix: fall back to `run <id>` rather than empty " ()" when name+status missing.
    eq(p.entries[0].text, 'run r1');
    eq(p.sessionMeta.id, 'r1');
    eq(p.sessionMeta.cwd, '');
    eq(p.sessionMeta.timestamp, null);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

t('parseFile falls back to finishedAt when startedAt missing', () => {
  const tmp = path.join(os.tmpdir(), `cc-wf-fin-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    runId: 'rx', finishedAt: 1700000000000,
    journal: [{ index: 0, result: 'x' }],
  }));
  try {
    const p = ccWorkflow.parseFile(tmp);
    assert(p.entries[1].timestamp != null, 'assistant ts derived from finishedAt');
    assert(p.sessionMeta.timestamp != null, 'header ts derived from finishedAt');
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

t('parseFile gives unique ids when journal[].index collides', () => {
  const tmp = path.join(os.tmpdir(), `cc-wf-coll-${process.pid}.json`);
  // Two entries both effectively index=0 (one explicit, one sparse).
  fs.writeFileSync(tmp, JSON.stringify({
    runId: 'rc', journal: [{ index: 0, result: 'a' }, { result: 'b' }],
  }));
  try {
    const p = ccWorkflow.parseFile(tmp);
    const ids = p.entries.map((e) => e.id);
    eq(new Set(ids).size, ids.length, `unique ids, got ${ids}`);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
});

t('sniffFile rejects non-matching JSON', () => {
  const tmp = path.join(os.tmpdir(), `cc-wf-other-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ something: 'else' }));
  try { eq(ccWorkflow.sniffFile(tmp), false); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
});

// ---- report ----
let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ok  ${r.name}`);
  else { failed++; console.log(`FAIL  ${r.name}\n      ${r.err}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
