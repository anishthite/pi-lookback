// Renderer smoke + per-kind coverage tests for src/export-html.js.
//
// per review-tests.md U1: a throw inside renderEntry on any kind would
// previously be invisible — no test exercised the renderer at all. This
// suite walks every fixture in fixtures/ (both pi and cc) and asserts:
//   (a) renderSessionHtml does not throw,
//   (b) returned HTML is non-empty and contains <html,
//   (c) every distinct `kind` present in the parsed entries produces a
//       kind-<kind> class hit in the rendered output (the renderer's
//       inline CSS keys off that class, so a missing match = missing
//       branch).
//
// No test framework: plain asserts and pass/fail tallies.

'use strict';

const fs = require('fs');
const path = require('path');

const { parseSessionFile } = require('../src/parser');
const { buildSessionSummary } = require('../src/summary');
const { detectSignals } = require('../src/signals');
const { renderSessionHtml } = require('../src/export-html');

const FIX_ROOT = path.join(__dirname, '..', 'fixtures');
const FIX_CC = path.join(FIX_ROOT, 'claude-code');

function listFixtures() {
  const out = [];
  for (const f of fs.readdirSync(FIX_ROOT)) {
    if (f.endsWith('.jsonl')) out.push(path.join(FIX_ROOT, f));
  }
  if (fs.existsSync(FIX_CC)) {
    for (const f of fs.readdirSync(FIX_CC)) {
      if (f.endsWith('.jsonl')) out.push(path.join(FIX_CC, f));
    }
  }
  return out;
}

const results = [];
function t(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ----- generic shape per fixture -----

for (const fixturePath of listFixtures()) {
  const label = path.relative(FIX_ROOT, fixturePath);

  t(`renderSessionHtml renders ${label} without throwing`, () => {
    const parsed = parseSessionFile(fixturePath);
    const summary = buildSessionSummary(parsed);
    const signals = detectSignals(parsed);
    const html = renderSessionHtml({ summary, entries: parsed.entries, signals });
    assert(typeof html === 'string' && html.length > 0, 'html is non-empty string');
    assert(html.includes('<html'), 'contains <html');
    assert(html.includes('<body'), 'contains <body');
  });

  t(`renderSessionHtml covers every kind in ${label}`, () => {
    const parsed = parseSessionFile(fixturePath);
    const summary = buildSessionSummary(parsed);
    const signals = detectSignals(parsed);
    const html = renderSessionHtml({ summary, entries: parsed.entries, signals });
    const kinds = new Set(parsed.entries.map((e) => e.kind).filter(Boolean));
    for (const k of kinds) {
      // The renderer emits `<div class="kind kind-<kind>">...` for every
      // entry. A missing match means the kind fell through to JSON
      // pretty-print OR the kind classname pipeline silently regressed.
      assert(
        html.includes(`kind-${k}`),
        `kind="${k}" not rendered (no kind-${k} class in HTML for ${label})`
      );
    }
  });
}

// ----- direct: source badge on header -----

t('renderSessionHtml stamps source badge for pi and claude-code sessions', () => {
  const piParsed = parseSessionFile(path.join(FIX_ROOT, 'simple-linear.jsonl'));
  const piHtml = renderSessionHtml({
    summary: buildSessionSummary(piParsed),
    entries: piParsed.entries,
    signals: detectSignals(piParsed),
  });
  assert(piHtml.includes('source-pi'), 'pi source-pi badge present');

  const ccParsed = parseSessionFile(path.join(FIX_CC, 'cc-simple-turn.jsonl'));
  const ccHtml = renderSessionHtml({
    summary: buildSessionSummary(ccParsed),
    entries: ccParsed.entries,
    signals: detectSignals(ccParsed),
  });
  assert(ccHtml.includes('source-claude-code'), 'cc source-claude-code badge present');
});

// ----- direct: sidechain renders a subagent badge -----

t('renderSessionHtml stamps sidechain badge on cc-sidechain fixture', () => {
  const parsed = parseSessionFile(path.join(FIX_CC, 'cc-sidechain.jsonl'));
  const html = renderSessionHtml({
    summary: buildSessionSummary(parsed),
    entries: parsed.entries,
    signals: detectSignals(parsed),
  });
  assert(html.includes('sidechain-flag'), 'subagent badge rendered');
});

// ----- direct: HTML escaping holds (apostrophe + angle brackets) -----

t('renderEntry HTML-escapes apostrophes and angle brackets in entry text', () => {
  // per review-security.md S-8 in-renderer regression guard.
  const parsed = parseSessionFile(path.join(FIX_ROOT, 'simple-linear.jsonl'));
  parsed.entries.unshift({
    id: 'XSS', parentId: null, timestamp: null, raw: {}, source: 'pi', sidechain: false,
    kind: 'user', text: `it's a <script>alert("x")</script> & "test"`, tokens: 0, promptType: 'user',
  });
  const html = renderSessionHtml({
    summary: buildSessionSummary(parsed),
    entries: parsed.entries,
    signals: detectSignals(parsed),
  });
  assert(!html.includes('<script>'), 'raw <script> never appears in output');
  assert(html.includes('&#39;'), 'apostrophe escaped as &#39;');
  assert(html.includes('&lt;script&gt;'), 'tags escaped');
});

// ----- Report -----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}` + (r.ok ? '' : ` — ${r.err}`));
}
console.log(`\n${passed}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
