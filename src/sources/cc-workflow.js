// cc-workflow source adapter.
//
// Implements the source-adapter contract for cc-workflow run journals
// stored under ~/.pi/cc-workflow/runs/*.json. Each file is one pretty-
// printed JSON document with shape:
//   { runId, name, scriptPath, status, startedAt, finishedAt?, journal: [{ index, hash, result }, ...] }
//
// Synthesis: one leading kind:'user' entry (so summary.firstPrompt works)
// + one kind:'assistant' entry per journal item. Timestamps are linearly
// interpolated across [startedAt, finishedAt].

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ID = 'cc-workflow';
const DEFAULT_ROOT = path.join(os.homedir(), '.pi', 'cc-workflow', 'runs');

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const SNIFF_BYTES = 64 * 1024;
const MAX_ENTRY_TEXT_BYTES = 1024 * 1024; // per-entry text cap, matches pi/cc per-line cap spirit

function defaultRoot() {
  return process.env.PI_CC_WORKFLOW_DIR || DEFAULT_ROOT;
}

function discover(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.json')) {
      out.push({
        filePath: path.join(root, e.name),
        source: ID,
        projectKey: e.name.replace(/\.json$/, ''),
      });
    }
  }
  return out;
}

// Stub: run filenames are runIds, not directory-encoded project paths.
// Returns '' intentionally — the cc-workflow source has no project-path
// mapping. Documented stub: keep this in sync if a generic decoder lookup
// is added in src/sources/index.js.
function decodeProjectDir(_name) { return ''; }

// firstLine sniff: only fires if some other reader already JSON-parsed a
// first line for us. Pretty-printed journals make firstLine null, so the
// real recognition happens in sniffFile() below.
function sniff(_filePath, firstLine) {
  if (firstLine && typeof firstLine === 'object') {
    return typeof firstLine.runId === 'string' && Array.isArray(firstLine.journal);
  }
  return false;
}

// Full-file sniff fallback. Bounded 64KB textual check — no JSON parse.
function sniffFile(filePath) {
  if (!filePath || !filePath.endsWith('.json')) return false;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    fd = null;
    const head = buf.slice(0, n).toString('utf8');
    return /"runId"\s*:/.test(head) && /"journal"\s*:/.test(head);
  } catch {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    return false;
  }
}

function parseFile(filePath) {
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
      parseErrors: [{ line: 0, reason: `file exceeds ${MAX_FILE_BYTES} byte size cap (${st.size} bytes)`, preview: '' }],
      sessionMeta: null, filePath, source: ID,
    };
  }
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (err) {
    return {
      entries: [], parseErrors: [{ line: 0, reason: `read failed: ${err.message}`, preview: '' }],
      sessionMeta: null, filePath, source: ID,
    };
  }
  let doc;
  try { doc = JSON.parse(text); }
  catch (err) {
    return {
      entries: [], parseErrors: [{ line: 0, reason: `JSON.parse failed: ${err.message}`, preview: text.slice(0, 120) }],
      sessionMeta: null, filePath, source: ID,
    };
  }
  if (!doc || typeof doc !== 'object') {
    return {
      entries: [], parseErrors: [{ line: 0, reason: 'root is not an object', preview: '' }],
      sessionMeta: null, filePath, source: ID,
    };
  }

  // Sort journal entries by script index so the timeline reflects the script
  // call order, not the (possibly out-of-order) completion order that the
  // workflow runner records when parallel() / pipeline() are used.
  const journal = Array.isArray(doc.journal)
    ? doc.journal.slice().sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
    : [];
  let startedAt = typeof doc.startedAt === 'number' ? doc.startedAt : null;
  const finishedAtRaw = typeof doc.finishedAt === 'number' ? doc.finishedAt : null;
  // Correctness MINOR #3: if startedAt missing but finishedAt present, use it
  // as the only timing signal we have rather than dropping all timestamps.
  if (startedAt == null && finishedAtRaw != null) startedAt = finishedAtRaw;
  const finishedAt = finishedAtRaw != null ? finishedAtRaw : startedAt;
  const span = (finishedAt != null && startedAt != null) ? finishedAt - startedAt : 0;
  const n = journal.length;
  const tsFor = (i) => {
    if (startedAt == null) return null;
    if (n <= 1) return new Date(startedAt).toISOString();
    return new Date(startedAt + Math.round(span * (i / Math.max(1, n - 1)))).toISOString();
  };

  const name = typeof doc.name === 'string' ? doc.name : '';
  const status = typeof doc.status === 'string' ? doc.status : '';
  const runId = typeof doc.runId === 'string' && doc.runId
    ? doc.runId
    : path.basename(filePath, '.json');
  const scriptPath = typeof doc.scriptPath === 'string' ? doc.scriptPath : '';
  // Best-effort: parse the workflow script alongside the journal to pull
  // per-agent metadata (label, phase, prompt preview). Bounded read, never
  // throws — if anything fails we fall back to bare journal entries.
  const scriptMeta = parseScriptMetadata(scriptPath);
  const headerTs = startedAt != null ? new Date(startedAt).toISOString() : null;
  // Correctness MINOR #2: synth-user ts strictly precedes assistant[0] ts
  // so consumers relying on monotonic ordering don't see a tie at the head.
  const synthUserTs = startedAt != null ? new Date(startedAt - 1).toISOString() : null;

  // Synthetic leading user entry so summary.firstPrompt + userMessageCount
  // get a sensible value without special-casing summary.js.
  // NIT: when both name/status empty, fall back to run id so the library
  // UI doesn't show the broken-looking ' ()'.
  const synthText = (name || status) ? `${name} (${status})` : `run ${runId}`;
  const entries = [];
  entries.push({
    id: 'workflow-user',
    parentId: null,
    timestamp: synthUserTs,
    raw: { runId, name, status, scriptPath },
    source: ID,
    sidechain: false,
    kind: 'user',
    text: synthText,
    tokens: synthText.length,
    promptType: 'user',
  });

  // Per-entry timestamp budget. Each agent occupies (2 + 2 * toolCallCount)
  // slots: synth-user prompt + (tool-call assistant + tool-result) per tool +
  // final assistant result. Pre-tally so we can interpolate monotonically
  // across [startedAt, finishedAt] regardless of how many tool calls were
  // captured per agent.
  let slotCount = 0;
  for (let i = 0; i < n; i++) {
    const tcCount = Array.isArray(journal[i]?.toolCalls) ? journal[i].toolCalls.length : 0;
    slotCount += 2 + 2 * tcCount;
  }
  slotCount = Math.max(1, slotCount);
  let slotCursor = 0;
  const slotTs = () => {
    if (startedAt == null) return null;
    const slot = slotCursor++;
    if (slotCount <= 1) return new Date(startedAt).toISOString();
    return new Date(startedAt + Math.round(span * (slot / (slotCount - 1)))).toISOString();
  };

  for (let i = 0; i < n; i++) {
    const j = journal[i] || {};
    const meta = scriptMeta[j.index] || scriptMeta[i] || {};
    const r = j.result;
    let text;
    if (typeof r === 'string') text = r;
    else if (r == null) text = '';
    else {
      try { text = JSON.stringify(r, null, 2); }
      catch { text = String(r); }
    }
    // NIT: per-entry text cap to bound parsed-cache memory on pathological runs.
    let textTruncated = false;
    if (text.length > MAX_ENTRY_TEXT_BYTES) {
      text = text.slice(0, MAX_ENTRY_TEXT_BYTES);
      textTruncated = true;
    }
    // Inject a synthetic user entry per agent carrying the prompt the agent
    // was actually called with. Lets the UI render "what was asked" instead
    // of just "what came back".
    if (meta.prompt) {
      entries.push({
        id: `agent-${i}-prompt`,
        parentId: null,
        timestamp: slotTs(),
        raw: { agentIndex: j.index, label: meta.label, phase: meta.phase },
        source: ID,
        sidechain: false,
        kind: 'user',
        text: meta.prompt,
        tokens: meta.prompt.length,
        promptType: 'agent-call',
        agentLabel: meta.label || null,
        phaseTitle: meta.phase || null,
        agentIndex: typeof j.index === 'number' ? j.index : i,
      });
    } else {
      // Prompt slot is reserved in slotCount even when meta.prompt is empty;
      // burn it so the rest of the interpolation stays aligned.
      slotCursor++;
    }

    // Expand the recorded subagent tool-call chain (added by
    // @anishthite/pi-cc-workflow after journal v1) into synthetic
    // assistant + toolResult entries. The existing tree/trace renderers
    // pick these up via kind + toolCalls/toolCallId without any further
    // special-casing. The agent's phaseTitle/agentIndex/agentLabel are
    // propagated so the workflow tree's phase grouping still works and
    // the parallel-count dedup (Set on agentIndex) doesn't inflate.
    const tcChain = Array.isArray(j.toolCalls) ? j.toolCalls : [];
    const sharedAgentMeta = {
      source: ID,
      sidechain: false,
      agentLabel: meta.label || null,
      phaseTitle: meta.phase || null,
      agentIndex: typeof j.index === 'number' ? j.index : i,
    };
    for (let k = 0; k < tcChain.length; k++) {
      const tc = tcChain[k] || {};
      const tcId = typeof tc.id === 'string' && tc.id ? tc.id : `agent-${i}-tc-${k}`;
      const tcName = typeof tc.name === 'string' ? tc.name : 'tool';
      const tcArgs = (tc.arguments && typeof tc.arguments === 'object') ? tc.arguments : {};
      const tcResultText = typeof tc.result === 'string' ? tc.result : '';
      const isError = !!tc.isError;
      const truncated = !!tc.resultTruncated;
      entries.push({
        id: `agent-${i}-tc-${k}-call`,
        parentId: null,
        timestamp: slotTs(),
        raw: tc,
        ...sharedAgentMeta,
        kind: 'assistant',
        text: '',
        textTruncated: false,
        thinking: '',
        toolCalls: [{ id: tcId, name: tcName, arguments: tcArgs }],
        model: null, provider: null, api: null,
        usage: null, cost: null, totalTokens: null,
        stopReason: null, responseId: null, messageId: null, shardOf: null,
        agentToolStep: true,
      });
      entries.push({
        id: `agent-${i}-tc-${k}-result`,
        parentId: null,
        timestamp: slotTs(),
        raw: tc,
        ...sharedAgentMeta,
        kind: 'toolResult',
        toolName: tcName,
        toolCallId: tcId,
        text: tcResultText,
        isError,
        outputBytes: tcResultText.length,
        truncated,
        agentToolStep: true,
      });
    }

    entries.push({
      // Correctness MINOR #1: use loop index `i` unconditionally so a sparse
      // or duplicated journal[].index can't collide and silently mask an entry
      // in api.js Array.find lookups.
      id: `agent-${i}`,
      parentId: null,
      timestamp: slotTs(),
      raw: j,
      source: ID,
      sidechain: false,
      kind: 'assistant',
      text,
      textTruncated,
      thinking: '',
      toolCalls: [],
      model: null,
      provider: null,
      api: null,
      usage: null,
      cost: null,
      totalTokens: null,
      stopReason: null,
      responseId: null,
      messageId: null,
      shardOf: null,
      // cc-workflow-specific render hints (treeLabel/entryHtml read these).
      agentLabel: meta.label || null,
      phaseTitle: meta.phase || null,
      agentHash: typeof j.hash === 'string' ? j.hash : null,
      agentIndex: typeof j.index === 'number' ? j.index : i,
    });
  }

  // Phase summary for the library/detail header.
  const phaseCounts = {};
  for (const m of Object.values(scriptMeta)) {
    if (m.phase) phaseCounts[m.phase] = (phaseCounts[m.phase] || 0) + 1;
  }
  const sessionMeta = {
    id: runId,
    cwd: scriptPath,
    version: '',
    gitBranch: '',
    model: null,
    permissionMode: null,
    tools: [], mcpServers: [], agents: [],
    timestamp: headerTs,
    name,
    status,
    synthesized: true,
    source: ID,
    workflow: {
      runId,
      name,
      status,
      scriptPath,
      startedAt,
      finishedAt,
      durationMs: span,
      agentCount: n,
      phases: Object.entries(phaseCounts).map(([title, count]) => ({ title, count })),
      description: scriptMeta.__description || null,
    },
  };

  return { entries, parseErrors: [], sessionMeta, filePath, source: ID };
}

// --- script-metadata parser ------------------------------------------------
//
// Bounded, best-effort scan of the workflow script to pull per-agent
// {label, phase, prompt} triples keyed by agent index (0-based, in script
// order). Never throws; on any failure returns {} so callers fall back to
// bare journal entries.
//
// Strategy: scan tokens linearly. Track the most recent `phase('Title')`
// call. Each time we hit `agent(` at top-level paren depth, capture the
// FIRST argument (a string/template literal) as the prompt, then scan the
// remainder of the call for `label: '...'` / `phase: '...'` keys. Tag the
// resulting record with the running agent index.
const SCRIPT_MAX_BYTES = 1 * 1024 * 1024; // 1MB ceiling on script size

function parseScriptMetadata(scriptPath) {
  if (!scriptPath) return {};
  let text;
  try {
    const st = fs.statSync(scriptPath);
    if (!st.isFile() || st.size > SCRIPT_MAX_BYTES) return {};
    text = fs.readFileSync(scriptPath, 'utf8');
  } catch { return {}; }

  const out = {};
  // Pull meta.description for the header (purely cosmetic; tolerant regex).
  const descMatch = text.match(/description\s*:\s*(['"`])((?:\\.|(?!\1).)*?)\1/);
  if (descMatch) out.__description = unescapeStringLiteral(descMatch[1], descMatch[2]);

  let i = 0;
  let currentPhase = null;
  let agentIndex = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    // Skip line comments and block comments cheaply.
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i); i = nl === -1 ? len : nl + 1; continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2); i = end === -1 ? len : end + 2; continue;
    }
    // Skip string/template literals at the OUTER level too — otherwise the
    // word 'agent(' or 'phase(' inside a prompt body produces ghost matches.
    if (ch === '"' || ch === "'" || ch === '`') {
      const close = scanStringLiteral(text, i, ch);
      i = close === -1 ? len : close + 1;
      continue;
    }
    // phase('Title')
    if (text.startsWith('phase(', i) && !isIdentChar(text[i - 1] || ' ')) {
      const argEnd = findCallArgsEnd(text, i + 'phase('.length);
      if (argEnd > 0) {
        const argText = text.slice(i + 'phase('.length, argEnd);
        const m = argText.match(/^\s*(['"`])((?:\\.|(?!\1).)*?)\1/);
        if (m) currentPhase = unescapeStringLiteral(m[1], m[2]);
        i = argEnd + 1; continue;
      }
    }
    // agent('prompt' | `prompt`, { ... })
    if (text.startsWith('agent(', i) && !isIdentChar(text[i - 1] || ' ')) {
      const argsStart = i + 'agent('.length;
      const argsEnd = findCallArgsEnd(text, argsStart);
      if (argsEnd > 0) {
        const argsText = text.slice(argsStart, argsEnd);
        const prompt = extractFirstStringArg(argsText);
        const labelMatch = argsText.match(/\blabel\s*:\s*(['"`])((?:\\.|(?!\1).)*?)\1/);
        const phaseMatch = argsText.match(/\bphase\s*:\s*(['"`])((?:\\.|(?!\1).)*?)\1/);
        const label = labelMatch ? unescapeStringLiteral(labelMatch[1], labelMatch[2]) : null;
        const explicitPhase = phaseMatch ? unescapeStringLiteral(phaseMatch[1], phaseMatch[2]) : null;
        out[agentIndex] = {
          label,
          phase: explicitPhase || currentPhase,
          prompt: prompt ? truncate(prompt, 4000) : null,
        };
        agentIndex++;
        i = argsEnd + 1; continue;
      }
    }
    i++;
  }
  return out;
}

function isIdentChar(c) { return /[A-Za-z0-9_$.]/.test(c || ''); }

// Walk a balanced parenthesised call-args region starting AT the char just
// past the opening '('. Returns the index of the matching ')'. Respects
// string/template/regex literals and nested braces/brackets. Returns -1 on
// mismatch (we then skip this site).
function findCallArgsEnd(text, start) {
  let depth = 1;
  let i = start;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const close = scanStringLiteral(text, i, c);
      if (close === -1) return -1;
      i = close + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl === -1 ? len : nl + 1; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? len : e + 2; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0 && c === ')') return i; }
    i++;
  }
  return -1;
}

function scanStringLiteral(text, start, quote) {
  let i = start + 1;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (quote === '`' && c === '$' && text[i + 1] === '{') {
      // Template expression — find matching '}' allowing nesting.
      let depth = 1; i += 2;
      while (i < len && depth > 0) {
        const cc = text[i];
        if (cc === '{') depth++;
        else if (cc === '}') depth--;
        else if (cc === '"' || cc === "'" || cc === '`') {
          const e = scanStringLiteral(text, i, cc);
          if (e === -1) return -1;
          i = e;
        }
        i++;
      }
      continue;
    }
    if (c === quote) return i;
    i++;
  }
  return -1;
}

function extractFirstStringArg(argsText) {
  // Skip leading whitespace, then expect ' " or `.
  let i = 0;
  while (i < argsText.length && /\s/.test(argsText[i])) i++;
  const q = argsText[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const end = scanStringLiteral(argsText, i, q);
  if (end === -1) return null;
  const raw = argsText.slice(i + 1, end);
  return unescapeStringLiteral(q, raw);
}

function unescapeStringLiteral(quote, raw) {
  if (quote !== '`') {
    return raw.replace(/\\([\\"'nrt`$])/g, (_, c) => (
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
    ));
  }
  // Template literal: keep ${...} expressions visible as-is — they're a
  // useful signal of how the workflow stitched prompts together.
  return raw.replace(/\\([\\`$nrt])/g, (_, c) => (
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
  ));
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated, full length ${s.length}]`;
}

module.exports = {
  id: ID,
  defaultRoot,
  discover,
  parseFile,
  decodeProjectDir,
  sniff,
  sniffFile,
  // exported for tests
  parseScriptMetadata,
};
