#!/usr/bin/env node
// pi-lookback HTTP server.
// Local-only static + API. No external deps.
//
// Slice F (plan §1.7): multi-source CLI flags
//   --source pi|claude-code|cc-workflow|both   (which roots are active)
//   --pi-sessions <dir>                   (override pi root)
//   --claude-sessions <dir>               (override claude-code root)
//   --cc-workflow-sessions <dir>          (override cc-workflow runs root)
//   --sessions <dir>                      (legacy: single root, sniffed)
//   env PI_SESSIONS_DIR, CLAUDE_SESSIONS_DIR, PI_CC_WORKFLOW_DIR

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const api = require('./src/api');
const { defaultSessionsRoots } = require('./src/scanner');
const { sniffSource } = require('./src/sources');

const DEFAULT_PORT = parseInt(process.env.PI_LOOKBACK_PORT || '0', 10) || 7878;
const DEFAULT_HOST = process.env.PI_LOOKBACK_HOST || '127.0.0.1';

function parseArgs(argv) {
  const out = {
    port: DEFAULT_PORT, host: DEFAULT_HOST,
    sessions: null,
    piSessions: null,
    claudeSessions: null,
    ccWorkflowSessions: null,
    source: null, // pi | claude-code | cc-workflow | both | null (default: all)
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i+1]) out.port = parseInt(argv[++i], 10);
    else if (a === '--host' && argv[i+1]) out.host = argv[++i];
    else if (a === '--sessions' && argv[i+1]) out.sessions = argv[++i];
    else if (a === '--pi-sessions' && argv[i+1]) out.piSessions = argv[++i];
    else if (a === '--claude-sessions' && argv[i+1]) out.claudeSessions = argv[++i];
    else if (a === '--cc-workflow-sessions' && argv[i+1]) out.ccWorkflowSessions = argv[++i];
    else if (a === '--source' && argv[i+1]) out.source = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log([
        'Usage: pi-lookback [options]',
        '  --port <n>                 HTTP port (default 7878)',
        '  --host <h>                 bind host (default 127.0.0.1)',
        '  --source pi|claude-code|cc-workflow|both   restrict to one source (default: all)',
        '  --pi-sessions <dir>        override pi sessions root',
        '  --claude-sessions <dir>    override claude-code projects root',
        '  --cc-workflow-sessions <dir>  override cc-workflow runs root',
        '  --sessions <dir>           single-root mode (auto-sniff source)',
        '',
        'Env:',
        '  PI_SESSIONS_DIR            default pi root',
        '  CLAUDE_SESSIONS_DIR        default claude-code root',
        '  PI_CC_WORKFLOW_DIR         default cc-workflow runs root',
        '  PI_LOOKBACK_PORT / _HOST   default port/host',
      ].join('\n'));
      process.exit(0);
    }
  }
  // per review-security.md S-6: reject unknown --source values up-front.
  // Empty string and undefined both behave as the default (all sources).
  if (out.source != null && out.source !== '') {
    const { listSources } = require('./src/sources');
    const known = new Set([...listSources(), 'both']);
    if (!known.has(out.source)) {
      console.error(`pi-lookback: unknown --source "${out.source}". Valid: ${[...known].join(', ')}.`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Translate CLI + env + defaults into a {pi, 'claude-code'} root map.
 * Resolution order (plan §1.7): explicit --pi-sessions/--claude-sessions
 * > --sessions (single root, sniffed) > --source modulates defaults
 * > env-var defaults.
 */
function resolveRoots(opts) {
  const defaults = defaultSessionsRoots();
  let roots = {
    pi: defaults.pi,
    'claude-code': defaults['claude-code'],
    'cc-workflow': defaults['cc-workflow'],
  };

  if (opts.source === 'pi') { roots['claude-code'] = null; roots['cc-workflow'] = null; }
  else if (opts.source === 'claude-code') { roots.pi = null; roots['cc-workflow'] = null; }
  else if (opts.source === 'cc-workflow') { roots.pi = null; roots['claude-code'] = null; }
  // 'both' or null leaves the defaults.

  if (opts.piSessions) roots.pi = opts.piSessions;
  if (opts.claudeSessions) roots['claude-code'] = opts.claudeSessions;
  if (opts.ccWorkflowSessions) roots['cc-workflow'] = opts.ccWorkflowSessions;

  if (opts.sessions) {
    // Single-root mode: try to sniff a representative file. Heuristic:
    // walk one .jsonl from the dir and ask the registry which source claims it.
    const sniffed = sniffFirstFile(opts.sessions);
    if (sniffed === 'claude-code') {
      roots = { pi: null, 'claude-code': opts.sessions, 'cc-workflow': null };
    } else if (sniffed === 'cc-workflow') {
      roots = { pi: null, 'claude-code': null, 'cc-workflow': opts.sessions };
    } else {
      // Default to pi-only — back-compat with the legacy single-root flag.
      roots = { pi: opts.sessions, 'claude-code': null, 'cc-workflow': null };
    }
  }
  return roots;
}

function sniffFirstFile(dir) {
  try {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          const s = sniffSource(full);
          if (s) return s;
        }
      }
    }
  } catch { /* fall through */ }
  return null;
}

function logStartup(addr, roots) {
  console.log(`pi-lookback listening on http://${addr.address}:${addr.port}`);
  console.log('Sources active:');
  for (const [sourceId, root] of Object.entries(roots)) {
    if (!root) {
      console.log(`  ${pad(sourceId, 12)} (disabled)`);
      continue;
    }
    let count = 0;
    try {
      const stack = [root];
      while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); }
        catch { continue; }
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.isFile() && e.name.endsWith('.jsonl')) count++;
        }
      }
    } catch { /* ignore */ }
    console.log(`  ${pad(sourceId, 12)} \u2192 ${root}   (${count} files)`);
  }
}
function pad(s, n) { return String(s).padEnd(n); }

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const mime = MIME[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
    // per review-security.md S-7: tear down the FD if the client hangs up
    // mid-transfer so we don't leak file descriptors under load.
    const s = fs.createReadStream(full);
    res.on('close', () => s.destroy());
    s.on('error', () => { try { res.end(); } catch {} });
    s.pipe(res);
  });
}

async function handleApi(req, res, parsed) {
  const pathname = parsed.pathname;
  const q = parsed.query || {};
  const t0 = Date.now();
  try {
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() });
    if (pathname === '/api/stats') return sendJson(res, 200, api.globalStats());
    if (pathname === '/api/sessions') {
      const list = api.listAllSummaries();
      let out = list;
      if (q.project) out = out.filter((s) => (s.projectPath || '').includes(q.project));
      if (q.hasErrors === '1') out = out.filter((s) => (s.failedToolCallCount + s.failedBashCommandCount) > 0);
      if (q.hasBranches === '1') out = out.filter((s) => s.branchCount > 0);
      if (q.hasCompactions === '1') out = out.filter((s) => s.compactionCount > 0);
      if (q.model) out = out.filter((s) => (s.models || []).some((m) => m.includes(q.model)));
      // Slice E/F: source + sidechain filters.
      if (q.source) out = out.filter((s) => s.source === q.source);
      if (q.hasSidechain === '1') out = out.filter((s) => (s.sidechainCount || 0) > 0);
      const sort = q.sort || 'recent';
      out.sort((a, b) => {
        if (sort === 'score') return (b.reviewScore || 0) - (a.reviewScore || 0);
        if (sort === 'cost') return (b.totalCost || 0) - (a.totalCost || 0);
        if (sort === 'duration') return (b.durationMs || 0) - (a.durationMs || 0);
        if (sort === 'errors') return ((b.failedToolCallCount + b.failedBashCommandCount) || 0) - ((a.failedToolCallCount + a.failedBashCommandCount) || 0);
        return new Date(b.startedAt || 0) - new Date(a.startedAt || 0);
      });
      return sendJson(res, 200, { count: out.length, sessions: out, elapsedMs: Date.now() - t0 });
    }
    const m1 = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (m1) {
      const detail = api.getSessionDetail(m1[1]);
      if (!detail) return sendJson(res, 404, { error: 'session not found', id: m1[1] });
      return sendJson(res, 200, { ...detail, elapsedMs: Date.now() - t0 });
    }
    const mInit = pathname.match(/^\/api\/sessions\/([^/]+)\/initial-input$/);
    if (mInit) {
      const data = await api.getInitialInput(mInit[1]);
      if (!data) return sendJson(res, 404, { error: 'session not found or has no user messages', id: mInit[1] });
      return sendJson(res, 200, { ...data, elapsedMs: Date.now() - t0 });
    }
    const m2 = pathname.match(/^\/api\/sessions\/([^/]+)\/entry\/([^/]+)$/);
    if (m2) {
      const e = api.getEntryRaw(m2[1], m2[2]);
      if (!e) return sendJson(res, 404, { error: 'entry not found' });
      return sendJson(res, 200, { entry: e, elapsedMs: Date.now() - t0 });
    }
    if (pathname === '/api/search') {
      const result = api.search(q.q || '', { limit: parseInt(q.limit || '100', 10) });
      return sendJson(res, 200, { ...result, elapsedMs: Date.now() - t0 });
    }
    if (pathname === '/api/export' && q.id) {
      const detail = api.getSessionDetail(q.id);
      if (!detail) return send(res, 404, 'not found');
      const html = require('./src/export-html').renderSessionHtml(detail);
      // per review-security.md S-5: derive the download filename from the
      // resolved session id (not the raw query param) and strip to a safe
      // [A-Za-z0-9._-] set to neutralize header injection / path tricks.
      const safeName = String(detail.summary.id || q.id)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 128) || 'session';
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${safeName}.html"`,
      });
      return res.end(html);
    }
    return sendJson(res, 404, { error: 'unknown api route', pathname });
  } catch (err) {
    return sendJson(res, 500, { error: err.message, stack: err.stack });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pn = parsed.pathname || '/';
    if (pn.startsWith('/api/')) {
      // handleApi is async; any uncaught rejection should be reported as 500
      // rather than crashing the process.
      Promise.resolve(handleApi(req, res, parsed)).catch((err) => {
        try {
          sendJson(res, 500, { error: err && err.message ? err.message : String(err), stack: err && err.stack });
        } catch { /* response already sent */ }
      });
      return;
    }
    return serveStatic(req, res, pn);
  });
}

function main() {
  const opts = parseArgs(process.argv);
  const roots = resolveRoots(opts);
  api.setSessionsRoots(roots);
  const server = createServer();
  server.listen(opts.port, opts.host, () => {
    logStartup(server.address(), roots);
  });
}

if (require.main === module) main();

module.exports = { createServer, parseArgs, resolveRoots };
