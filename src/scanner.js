// Multi-source session scanner.
//
// Wraps per-source adapter discover() calls to produce a unified list of
// session files across pi (`~/.pi/agent/sessions/`) and Claude Code
// (`~/.claude/projects/`). The single-source helpers (`listSessionFiles`,
// `defaultSessionsRoot`, `decodeProjectDir`) are preserved verbatim for
// back-compat with test/metrics.js and any external callers (plan §1.5).
//
// Read-only: never modifies session files.

'use strict';

const fs = require('fs');
const pi = require('./sources/pi');
const { getSource, defaultRoots } = require('./sources');

// ----- single-source helpers (back-compat) -----

function defaultSessionsRoot() {
  return pi.defaultRoot();
}

function listSessionFiles(root = defaultSessionsRoot()) {
  return pi.discover(root).map((row) => row.filePath);
}

function decodeProjectDir(name) {
  return pi.decodeProjectDir(name);
}

function fileStats(filePath) {
  try { return fs.statSync(filePath); }
  catch { return null; }
}

// ----- multi-source helpers (slice E) -----

/**
 * Return the default on-disk roots for every registered source. Env vars
 * `PI_SESSIONS_DIR` and `CLAUDE_SESSIONS_DIR` override the adapter defaults.
 * Returns an object keyed by source id; a value may be `null` if the
 * adapter cannot resolve a default (e.g. HOME unset).
 */
function defaultSessionsRoots() {
  // Adapter.defaultRoot() is already env-aware (PI_SESSIONS_DIR,
  // CLAUDE_SESSIONS_DIR, PI_CC_WORKFLOW_DIR). Don't double-read env here —
  // trust the adapter so the env-var name lives in exactly one place.
  const adapterRoots = defaultRoots();
  return {
    pi: adapterRoots.pi || null,
    'claude-code': adapterRoots['claude-code'] || null,
    'cc-workflow': adapterRoots['cc-workflow'] || null,
  };
}

/**
 * Walk every configured source's root and return a flat array of rows
 *   { filePath, source, projectKey?, isSubagent? }
 * with `source` set to the source-id whose discover() yielded the file.
 * Null roots are silently skipped.
 *
 *  @param {{[sourceId: string]: string|null}} roots
 */
function listSessionFilesMulti(roots) {
  const out = [];
  for (const [sourceId, root] of Object.entries(roots)) {
    if (!root) continue;
    const adapter = getSource(sourceId);
    if (!adapter) continue;
    for (const row of adapter.discover(root)) {
      out.push({ ...row, source: sourceId });
    }
  }
  return out;
}

module.exports = {
  // single-source
  listSessionFiles, defaultSessionsRoot, decodeProjectDir, fileStats,
  // multi-source
  listSessionFilesMulti, defaultSessionsRoots,
};
