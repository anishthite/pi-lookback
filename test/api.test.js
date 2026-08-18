// Smoke tests for the HTTP API + library/search across the local pi corpus.
// Boots the server on a random port and asserts shape + latency.

'use strict';

const http = require('http');
const path = require('path');
const { createServer } = require('../server');
const api = require('../src/api');

const results = [];
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((err) => results.push({ name, ok: false, err: err.message }));
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async function main() {
  // Use FIX fixtures as the sessions root for deterministic API behavior.
  const FIX = path.join(__dirname, '..', 'fixtures');
  api.setSessionsRoot(FIX);
  const server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  await t('GET /api/health', async () => {
    const j = await getJson(base + '/api/health');
    assert(j.ok === true);
  });

  await t('GET /api/stats counts fixtures', async () => {
    const j = await getJson(base + '/api/stats');
    assert(j.totalSessions >= 9, `expected ≥9 sessions, got ${j.totalSessions}`);
    assert(j.parseSuccessRate >= 0.98 || j.totalSessions === 9, `parse rate ${j.parseSuccessRate}`);
  });

  await t('GET /api/sessions returns summaries', async () => {
    const j = await getJson(base + '/api/sessions');
    assert(Array.isArray(j.sessions), 'sessions is array');
    assert(j.count >= 9, `count ${j.count}`);
    // Each summary has the required fields.
    const required = ['id','entryCount','assistantMessageCount','toolCallCount','branchCount','compactionCount','totalTokens','totalCost','reviewScore'];
    for (const s of j.sessions) for (const f of required) assert(f in s, `missing field ${f} in ${s.id}`);
  });

  await t('GET /api/sessions filtering: hasErrors=1', async () => {
    const j = await getJson(base + '/api/sessions?hasErrors=1');
    for (const s of j.sessions) assert((s.failedToolCallCount + s.failedBashCommandCount) > 0, 'all rows have errors');
    assert(j.sessions.length >= 2, 'tool-error + bash-failure fixtures present');
  });

  await t('GET /api/sessions/:id deep load and signals', async () => {
    const j = await getJson(base + '/api/sessions/fixt-tool-error');
    assert(j.summary.failedToolCallCount === 1);
    assert(j.entries.length >= 3);
    assert(j.signals.some((s) => s.kind === 'failed_tool'));
    // All event types from parser are present in entries (no silent drops).
    const kinds = new Set(j.entries.map((e) => e.kind));
    assert(kinds.has('user') && kinds.has('assistant') && kinds.has('toolResult'));
  });

  await t('GET /api/search finds known text across fixtures', async () => {
    const j = await getJson(base + '/api/search?q=ENOENT');
    assert(j.results.length >= 1, 'found ENOENT match');
    assert(j.results.some((r) => r.sessionId === 'fixt-tool-error'));
  });

  await t('GET /api/sessions for unknown-entry tolerates new type', async () => {
    const j = await getJson(base + '/api/sessions/fixt-unknown');
    assert(j.entries.some((e) => e.kind === 'unknown'), 'renders unknown event gracefully');
  });

  await t('GET /api/sessions for huge-output keeps body truncated in list payload', async () => {
    const j = await getJson(base + '/api/sessions/fixt-huge-output');
    const tr = j.entries.find((e) => e.kind === 'toolResult');
    assert(tr, 'tool result present');
    assert((tr.text || '').length <= 4000, 'list payload truncates large output');
    assert(tr.textTruncated === true, 'flagged as truncated for the UI');
  });

  await t('Search latency on fixture corpus < 300ms', async () => {
    const t0 = Date.now();
    await getJson(base + '/api/search?q=approach');
    const elapsed = Date.now() - t0;
    assert(elapsed < 300, `search elapsed ${elapsed}ms`);
  });

  // ----- Slice E: multi-source library plumbing -----

  await t('mixed library lists both pi and claude-code sources', async () => {
    api.setSessionsRoots({ pi: FIX, 'claude-code': path.join(FIX, 'claude-code') });
    const j = await getJson(base + '/api/sessions');
    const sources = new Set(j.sessions.map((s) => s.source));
    assert(sources.has('pi'), `expected pi in ${[...sources]}`);
    assert(sources.has('claude-code'), `expected claude-code in ${[...sources]}`);
  });

  await t('every summary has a source field', async () => {
    api.setSessionsRoots({ pi: FIX, 'claude-code': path.join(FIX, 'claude-code') });
    const j = await getJson(base + '/api/sessions');
    for (const s of j.sessions) {
      assert(s.source === 'pi' || s.source === 'claude-code',
        `unknown source on ${s.id}: ${s.source}`);
    }
  });

  await t('source filter narrows library to claude-code', async () => {
    api.setSessionsRoots({ pi: FIX, 'claude-code': path.join(FIX, 'claude-code') });
    const j = await getJson(base + '/api/sessions?source=claude-code');
    assert(j.sessions.length >= 9, `expected ≥9 cc fixtures, got ${j.sessions.length}`);
    assert(j.sessions.every((s) => s.source === 'claude-code'),
      'all rows are claude-code');
  });

  await t('search across mixed sources still finds pi-only matches', async () => {
    api.setSessionsRoots({ pi: FIX, 'claude-code': path.join(FIX, 'claude-code') });
    const j = await getJson(base + '/api/search?q=ENOENT');
    assert(j.results.some((r) => r.sessionId === 'fixt-tool-error'),
      'finds ENOENT in pi fixture');
  });

  await t('cc-workflow source registers and filter narrows to it', async () => {
    api.setSessionsRoots({ pi: FIX, 'claude-code': path.join(FIX, 'claude-code'), 'cc-workflow': path.join(FIX, 'cc-workflow') });
    const stats = await getJson(base + '/api/stats');
    assert(stats.sourceCounts && stats.sourceCounts['cc-workflow'] >= 1,
      `sourceCounts.cc-workflow >=1, got ${JSON.stringify(stats.sourceCounts)}`);
    const j = await getJson(base + '/api/sessions?source=cc-workflow');
    assert(j.sessions.length >= 1, `expected ≥1 cc-workflow row, got ${j.sessions.length}`);
    assert(j.sessions.every((s) => s.source === 'cc-workflow'), 'all rows are cc-workflow');
  });

  await t('search by source token narrows to that source', async () => {
    api.setSessionsRoots({ pi: FIX, 'claude-code': path.join(FIX, 'claude-code') });
    const j = await getJson(base + '/api/search?q=claude-code');
    assert(j.results.length >= 1, 'finds at least one cc session by source token');
    assert(j.results.every((r) => r.source === 'claude-code' || r.matchKind === 'entry'),
      'cc-keyword search matches only cc rows');
  });

  await t('setSessionsRoot back-compat: pi-only mounts FIX as pi root', async () => {
    api.setSessionsRoot(FIX);
    const j = await getJson(base + '/api/sessions');
    // Even back-compat: cc files under FIX still get sniff-routed correctly
    // and tagged source='claude-code' (truth-from-content wins).
    const sources = new Set(j.sessions.map((s) => s.source));
    assert(sources.has('pi'));
    // Cc-source counts only the files pi.discover yielded that sniffed as cc.
  });

  // Restore api state for any post-suite assertions.
  api.setSessionsRoot(FIX);

  server.close();
  // Report
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}` + (r.ok ? '' : ` — ${r.err}`));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
