// Per-model price table for cost computation.
//
// Pi sessions carry `message.usage.cost.total` directly; Claude Code
// sessions only carry token counts in `message.usage`. The cc adapter
// computes `entry.cost` from this table so the downstream `high_cost`
// signal and `totalCost` rollup work uniformly across both sources.
// See plan §3.1.
//
// Prices are USD per million tokens. Source: Anthropic public pricing
// as of 2026-06-04. Maintenance is an L-followup (Risk R1) — update
// this table when new models ship.

'use strict';

const PRICES = Object.freeze({
  // Opus family
  'claude-opus-4-5-20251101':   { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-opus-4-5':            { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-opus-4-7':            { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-opus-4':              { input: 15, output: 75, cacheCreation: 18.75, cacheRead: 1.5 },
  // Sonnet family
  'claude-sonnet-4-5-20250929': { input: 3,  output: 15, cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-4-5':          { input: 3,  output: 15, cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-sonnet-4':            { input: 3,  output: 15, cacheCreation: 3.75,  cacheRead: 0.3 },
  // Haiku family
  'claude-haiku-4-5':           { input: 1,  output: 5,  cacheCreation: 1.25,  cacheRead: 0.1 },
  'claude-haiku-4':             { input: 1,  output: 5,  cacheCreation: 1.25,  cacheRead: 0.1 },
  // Claude 3.x family (per review-correctness.md C-6 — surface in live
  // corpora that still reference legacy model ids). Anthropic public list
  // prices, USD per million tokens.
  'claude-3-5-sonnet':          { input: 3,    output: 15,   cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-3-5-haiku':           { input: 0.8,  output: 4,    cacheCreation: 1,     cacheRead: 0.08 },
  'claude-3-opus':              { input: 15,   output: 75,   cacheCreation: 18.75, cacheRead: 1.5 },
  'claude-3-sonnet':            { input: 3,    output: 15,   cacheCreation: 3.75,  cacheRead: 0.3 },
  'claude-3-haiku':             { input: 0.25, output: 1.25, cacheCreation: 0.3,   cacheRead: 0.03 },
  // Synthetic / placeholder models — zero cost.
  '<synthetic>':                { input: 0,  output: 0,  cacheCreation: 0,     cacheRead: 0 },
});

// Tracks models we've already warned about (prevent log spam).
const WARNED = new Set();

/**
 * Resolve a model name to a price record, walking back prefix segments
 * if the exact id is unknown. E.g. 'claude-opus-4-5-20260801' (unseen)
 * falls back to 'claude-opus-4-5', then 'claude-opus-4'.
 * Returns null when no prefix matches.
 */
function matchPrefix(model) {
  if (typeof model !== 'string' || !model) return null;
  const parts = model.split('-');
  while (parts.length > 2) {
    parts.pop();
    const key = parts.join('-');
    if (PRICES[key]) return PRICES[key];
  }
  return null;
}

/**
 * Compute the USD cost of a single assistant turn given the Anthropic
 * usage object. Returns null when the model is unknown OR usage is
 * malformed — the caller treats null as "uncosted" and the high_cost
 * signal simply skips it.
 *
 *  @param {string|null} model  e.g. 'claude-opus-4-7'
 *  @param {object|null} usage  message.usage from a cc assistant entry
 *  @returns {number|null}
 */
function costFor(model, usage) {
  if (!model || !usage || typeof usage !== 'object') return null;
  const price = PRICES[model] || matchPrefix(model);
  if (!price) {
    if (!WARNED.has(model)) {
      WARNED.add(model);
      // Single-line console warning; downstream tests filter stderr.
      console.warn(`[pricing] unknown model "${model}" — cost will be null`);
    }
    return null;
  }
  const i  = usage.input_tokens || 0;
  const o  = usage.output_tokens || 0;
  const cc = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  return (i * price.input + o * price.output + cc * price.cacheCreation + cr * price.cacheRead) / 1e6;
}

/**
 * Test-only helper to reset the warning set so unit tests can assert
 * the same model triggers a warning across runs without cross-talk.
 */
function _resetWarnings() { WARNED.clear(); }

module.exports = { PRICES, costFor, matchPrefix, _resetWarnings };
