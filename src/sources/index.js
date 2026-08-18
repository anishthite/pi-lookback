// Source-adapter registry.
//
// Each adapter implements the contract documented in plan §1.2. This
// module is the single point of lookup; downstream code uses getSource(id)
// or sniffSource(filePath) to route work to the right adapter.

'use strict';

const fs = require('fs');

// per review-simplicity.md P-2: slice A's defensive try/catch require is
// gone; both adapters are now production code paths and a load failure
// should be a hard error, not a silent skip.
const pi = require('./pi');
const claudeCode = require('./claude-code');
const ccWorkflow = require('./cc-workflow');

// Registry order matters for sniffSource: pi/cc sniffs are O(1) on the
// already-parsed firstLine; cc-workflow falls back to opening the file.
// Keep cc-workflow last so cheap paths win.
const REGISTRY = { [pi.id]: pi, [claudeCode.id]: claudeCode, [ccWorkflow.id]: ccWorkflow };

function getSource(id) { return REGISTRY[id] || null; }
function listSources() { return Object.keys(REGISTRY); }
function defaultRoots() {
  const out = {};
  for (const [id, adapter] of Object.entries(REGISTRY)) {
    try { out[id] = adapter.defaultRoot(); }
    catch { out[id] = null; }
  }
  return out;
}

/**
 * Read the first non-blank line of a file and JSON-parse it.
 * Bounded to ~8KB to keep sniff cheap. Returns null if the file is
 * unreadable, empty, or the first line is not valid JSON.
 */
function readFirstJsonLine(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    fd = null;
    const text = buf.slice(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const first = (nl === -1 ? text : text.slice(0, nl)).trim();
    if (!first) return null;
    return JSON.parse(first);
  } catch {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    return null;
  }
}

/**
 * File-shape autodetection. Reads only the first non-blank JSON line and
 * asks each adapter whether it recognizes the file. Returns the adapter id
 * or null when no adapter claims the file.
 */
function sniffSource(filePath, firstLine) {
  const fl = firstLine || readFirstJsonLine(filePath);
  if (fl) {
    for (const a of Object.values(REGISTRY)) {
      try { if (a.sniff(filePath, fl)) return a.id; }
      catch { /* keep going */ }
    }
    // First-line parsed cleanly but no adapter claimed it. Don't waste a
    // 64KB read sniffing further — sniffFile is for the pretty-printed-JSON
    // path where firstLine itself is null.
    return null;
  }
  // Second pass: adapters that opt into full-file sniffing (e.g. pretty-
  // printed JSON documents where the first line is not parseable JSON).
  for (const a of Object.values(REGISTRY)) {
    if (typeof a.sniffFile !== 'function') continue;
    try { if (a.sniffFile(filePath)) return a.id; }
    catch { /* keep going */ }
  }
  return null;
}

module.exports = { getSource, listSources, defaultRoots, sniffSource, REGISTRY, readFirstJsonLine };
