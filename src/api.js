// In-process API used by the HTTP server.
// Builds and caches session summaries, exposes search, and serves full traces.
// Read-only: only reads JSONL files; never writes them.
//
// Slice E (plan §1.6): multi-source plumbing. The library now mixes pi and
// Claude Code sessions in one list, each row tagged with its `source`.
// `setSessionsRoot(root)` is preserved as a back-compat shim that mounts
// `root` as the pi-source only; new code should use `setSessionsRoots`.

'use strict';

const fs = require('fs');
const path = require('path');
const {
  listSessionFilesMulti, defaultSessionsRoots, fileStats,
} = require('./scanner');
const { parseSessionFile } = require('./parser');
const { buildSessionSummary } = require('./summary');
const { detectSignals, aggregateSignalCounts } = require('./signals');
const { buildInitialInput } = require('./initial-input');

const SUMMARY_CACHE = new Map();   // filePath -> { mtimeMs, size, summary, signalCounts, signalKinds }
const PARSED_CACHE = new Map();    // filePath -> { mtimeMs, parsed }
const PARSED_CACHE_MAX = 24;

let SESSIONS_ROOTS = defaultSessionsRoots();

function setSessionsRoots(roots) {
  // Accept partial updates; null clears a source.
  SESSIONS_ROOTS = {
    pi: 'pi' in (roots || {}) ? roots.pi : SESSIONS_ROOTS.pi,
    'claude-code': 'claude-code' in (roots || {}) ? roots['claude-code'] : SESSIONS_ROOTS['claude-code'],
    'cc-workflow': 'cc-workflow' in (roots || {}) ? roots['cc-workflow'] : SESSIONS_ROOTS['cc-workflow'],
  };
  SUMMARY_CACHE.clear();
  PARSED_CACHE.clear();
}

/**
 * Back-compat shim: treats `root` as the pi-source root only and clears the
 * Claude Code root. test/metrics.js and pre-slice-E callers depend on this.
 */
function setSessionsRoot(root) {
  setSessionsRoots({ pi: root, 'claude-code': null, 'cc-workflow': null });
}

function getSessionsRoot() { return SESSIONS_ROOTS.pi; }
function getSessionsRoots() { return { ...SESSIONS_ROOTS }; }

// ----- file enumeration with dedup -----

/**
 * Return the unique set of session files across all configured sources.
 * If the same absolute path is yielded by multiple adapters' discover()
 * (e.g. nested roots), the FIRST occurrence wins; subsequent dupes are
 * silently dropped. This makes overlapping `setSessionsRoots` configs safe.
 */
function enumerateFiles() {
  const seen = new Set();
  const out = [];
  for (const row of listSessionFilesMulti(SESSIONS_ROOTS)) {
    if (seen.has(row.filePath)) continue;
    seen.add(row.filePath);
    out.push(row);
  }
  return out;
}

// ----- summary cache -----

function loadSummary(filePath) {
  const st = fileStats(filePath);
  if (!st) return null;
  const key = filePath;
  const cached = SUMMARY_CACHE.get(key);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;

  let parsed;
  try { parsed = parseSessionFile(filePath); }
  catch (err) {
    const errSummary = errorSummary(filePath, err, st);
    SUMMARY_CACHE.set(key, errSummary);
    return errSummary;
  }
  const summary = buildSessionSummary(parsed);
  const signals = detectSignals(parsed);
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    summary,
    signalCounts: aggregateSignalCounts(signals),
    signalKinds: [...new Set(signals.map((s) => s.kind))],
  };
  SUMMARY_CACHE.set(key, entry);
  return entry;
}

function errorSummary(filePath, err, st) {
  return {
    mtimeMs: st.mtimeMs,
    size: st.size,
    summary: {
      id: path.basename(filePath, '.jsonl'),
      filePath,
      source: null,
      projectDir: path.basename(path.dirname(filePath)),
      projectPath: '',
      cwd: '',
      startedAt: null,
      endedAt: null,
      durationMs: null,
      firstPrompt: `(unparseable: ${err.message})`,
      entryCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      failedToolCallCount: 0,
      bashCommandCount: 0,
      failedBashCommandCount: 0,
      branchCount: 0,
      compactionCount: 0,
      modelSwitchCount: 0,
      thinkingLevelSwitchCount: 0,
      customCount: 0,
      attachmentCount: 0,
      metaCount: 0,
      sidechainCount: 0,
      errorEventCount: 0,
      snapshotCount: 0,
      totalTokens: 0,
      totalCost: 0,
      maxAssistantCost: 0,
      models: [],
      parseErrorCount: 1,
      reviewScore: 0,
      error: err.message,
    },
    signalCounts: {},
    signalKinds: [],
  };
}

function listAllSummaries() {
  const files = enumerateFiles();
  const out = [];
  for (const row of files) {
    const entry = loadSummary(row.filePath);
    if (entry) {
      out.push({
        ...entry.summary,
        // Prefer the source the adapter set during parsing (truth from content).
        // Fall back to the discover-row's source (truth from directory).
        source: entry.summary.source || row.source,
        signalCounts: entry.signalCounts,
        signalKinds: entry.signalKinds,
      });
    }
  }
  return out;
}

// ----- parsed cache -----

function loadParsed(filePath) {
  const st = fileStats(filePath);
  if (!st) return null;
  const cached = PARSED_CACHE.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.parsed;
  const parsed = parseSessionFile(filePath);
  PARSED_CACHE.set(filePath, { mtimeMs: st.mtimeMs, parsed });
  if (PARSED_CACHE.size > PARSED_CACHE_MAX) {
    const oldestKey = PARSED_CACHE.keys().next().value;
    PARSED_CACHE.delete(oldestKey);
  }
  return parsed;
}

function loadParsedById(id) {
  for (const [filePath, entry] of SUMMARY_CACHE.entries()) {
    if (entry.summary.id === id) return loadParsed(filePath);
  }
  for (const row of enumerateFiles()) {
    const entry = loadSummary(row.filePath);
    if (entry && entry.summary.id === id) return loadParsed(row.filePath);
  }
  return null;
}

function getSessionDetail(id) {
  const parsed = loadParsedById(id);
  if (!parsed) return null;
  const summary = buildSessionSummary(parsed);
  const signals = detectSignals(parsed);
  const entries = parsed.entries.map((e) => {
    const copy = { ...e };
    delete copy.raw;
    if (typeof copy.text === 'string' && copy.text.length > 4000) {
      copy.textTruncated = true;
      copy.text = copy.text.slice(0, 4000);
    }
    if (typeof copy.output === 'string' && copy.output.length > 4000) {
      copy.outputTruncated = true;
      copy.output = copy.output.slice(0, 4000);
    }
    if (typeof copy.thinking === 'string' && copy.thinking.length > 2000) {
      copy.thinkingTruncated = true;
      copy.thinking = copy.thinking.slice(0, 2000);
    }
    return copy;
  });
  return { summary, entries, signals, parseErrors: parsed.parseErrors };
}

async function getInitialInput(sessionId) {
  const parsed = loadParsedById(sessionId);
  if (!parsed) return null;
  return buildInitialInput(parsed);
}

function getEntryRaw(sessionId, entryId) {
  const parsed = loadParsedById(sessionId);
  if (!parsed) return null;
  const e = parsed.entries.find((x) => x.id === entryId);
  return e || null;
}

// ----- search -----

function search(query, { limit = 100 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { query: '', results: [] };
  const needle = q.toLowerCase();
  const results = [];

  for (const row of enumerateFiles()) {
    const entry = loadSummary(row.filePath);
    if (!entry) continue;
    const sum = entry.summary;
    // Slice E: search hay includes source so a user can type 'claude-code'
    // and narrow the library by typing into the search box.
    const hayParts = [
      sum.firstPrompt || '', sum.cwd || '', sum.projectPath || '', sum.id || '',
      sum.source || '',
      ...(sum.models || []),
    ];
    if (hayParts.join(' ').toLowerCase().includes(needle)) {
      results.push({
        sessionId: sum.id,
        source: sum.source,
        projectPath: sum.projectPath,
        firstPrompt: sum.firstPrompt,
        matchKind: 'summary',
        snippet: sum.firstPrompt?.slice(0, 200) || '',
      });
      if (results.length >= limit) break;
      continue;
    }
    const parsed = loadParsed(row.filePath);
    if (!parsed) continue;
    for (const e of parsed.entries) {
      const hay = entrySearchHay(e);
      const idx = hay.indexOf(needle);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 60);
      const end = Math.min(hay.length, idx + 140);
      results.push({
        sessionId: sum.id,
        source: sum.source,
        projectPath: sum.projectPath,
        firstPrompt: sum.firstPrompt,
        matchKind: 'entry',
        entryId: e.id,
        entryKind: e.kind,
        toolName: e.toolName || null,
        snippet: hay.slice(start, end),
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }
  return { query: q, results };
}

// per review-security.md S-3: cap every per-entry hay field at
// HAY_FIELD_CAP bytes so one 100MB Read output cannot make a search
// query allocate O(100MB) for every entry it scans. 8KB is enough to
// contain useful needle context without unbounded blow-up.
const HAY_FIELD_CAP = 8 * 1024;
function cap(v) {
  if (typeof v !== 'string') return '';
  return v.length > HAY_FIELD_CAP ? v.slice(0, HAY_FIELD_CAP) : v;
}
function entrySearchHay(e) {
  let s = '';
  if (e.text)     s += ' ' + cap(e.text);
  if (e.thinking) s += ' ' + cap(e.thinking);
  if (e.toolName) s += ' ' + cap(e.toolName);
  if (e.command)  s += ' ' + cap(e.command);
  if (e.output)   s += ' ' + cap(e.output);
  if (e.summary)  s += ' ' + cap(e.summary);
  if (e.toolCalls?.length) {
    for (const tc of e.toolCalls) {
      s += ' ' + cap(tc.name || '');
      if (tc.arguments) {
        try { s += ' ' + cap(JSON.stringify(tc.arguments)); } catch {}
      }
    }
  }
  return s.toLowerCase();
}

// ----- global stats -----

function globalStats() {
  const files = enumerateFiles();
  let totalSessions = files.length;
  let totalEntries = 0;
  let parseFailedSessions = 0;
  let totalCost = 0;
  let totalTokens = 0;
  let totalToolCalls = 0;
  let totalFailedTools = 0;
  let totalBranches = 0;
  let totalCompactions = 0;
  let totalParseErrors = 0;
  const signalKindsTotal = {};
  const projects = new Set();
  const sourceCounts = {};
  for (const row of files) {
    const e = loadSummary(row.filePath);
    if (!e) continue;
    const s = e.summary;
    totalEntries += s.entryCount;
    if (s.error) parseFailedSessions++;
    totalCost += s.totalCost || 0;
    totalTokens += s.totalTokens || 0;
    totalToolCalls += s.toolCallCount || 0;
    totalFailedTools += s.failedToolCallCount || 0;
    totalBranches += s.branchCount || 0;
    totalCompactions += s.compactionCount || 0;
    totalParseErrors += s.parseErrorCount || 0;
    if (s.projectPath) projects.add(s.projectPath);
    if (s.source) sourceCounts[s.source] = (sourceCounts[s.source] || 0) + 1;
    for (const [k, v] of Object.entries(e.signalCounts || {})) {
      signalKindsTotal[k] = (signalKindsTotal[k] || 0) + v;
    }
  }
  return {
    sessionsRoot: SESSIONS_ROOTS.pi,                       // back-compat
    sessionsRoots: { ...SESSIONS_ROOTS },
    sourceCounts,
    totalSessions,
    totalEntries,
    parseFailedSessions,
    parseSuccessRate: totalSessions ? (totalSessions - parseFailedSessions) / totalSessions : 1,
    totalCost,
    totalTokens,
    totalToolCalls,
    totalFailedTools,
    totalBranches,
    totalCompactions,
    totalParseErrors,
    projectsCount: projects.size,
    signalKindsTotal,
  };
}

module.exports = {
  setSessionsRoot, setSessionsRoots, getSessionsRoot, getSessionsRoots,
  listAllSummaries, getSessionDetail, getEntryRaw, getInitialInput,
  search, globalStats,
};
