// Source-agnostic dispatch shim.
//
// `parseSessionFile` was the single entry point for pi JSONL ingestion.
// As of slice A (plan §1.4) it dispatches to the appropriate adapter
// under src/sources/ based on either an explicit source hint or a
// first-line content sniff. The pi-shape normalization logic now lives
// in src/sources/pi.js and is reachable here unchanged.
//
// Read-only: never writes session files.

'use strict';

const { getSource, sniffSource } = require('./sources');

/**
 * Parse a session JSONL file.
 *
 *  @param {string} filePath  absolute path to a .jsonl session file
 *  @param {{source?: string}} [opts] explicit source-id hint (skips sniff)
 *  @returns {{
 *    entries: object[],
 *    parseErrors: {line:number, reason:string, preview?:string}[],
 *    sessionMeta: object|null,
 *    filePath: string,
 *    source: string|null
 *  }}
 */
function parseSessionFile(filePath, { source } = {}) {
  const id = source || sniffSource(filePath);
  const adapter = id ? getSource(id) : null;
  if (!adapter) {
    return {
      entries: [],
      parseErrors: [{ line: 0, reason: `unknown source for ${filePath}`, preview: '' }],
      sessionMeta: null,
      filePath,
      source: null,
    };
  }
  return adapter.parseFile(filePath);
}

// per review-simplicity.md P-1: the normalizeEntry / parseSessionText
// re-export shims (slice-A scaffolding) had zero call sites outside the
// adapters themselves. Anything that needs the pi normalizer now imports
// `require('./sources/pi')` directly; the cc tests already do this.
module.exports = { parseSessionFile };
