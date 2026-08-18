#!/usr/bin/env node
// tools/cache-bust-detector.js
// Reproducible detector for prompt-cache busts in pi session JSONL.
//
// Bust definition: walking assistant messages in order, a "bust" at turn n+1
// is recorded when
//   prefix_n   = cacheRead_n + cacheWrite_n
//   cacheRead_{n+1} < BUST_THRESHOLD * prefix_n   AND   prefix_n > PREFIX_MIN
//
// Each bust is attributed by inspecting the JSONL events that sit between turn
// n and turn n+1 ("interlude") plus the wall-clock gap.  Attribution priority:
//   compaction > model_change > thinking_level_change > branch_summary >
//   custom/custom_message > idle_gt_5min > fast_silent_bust > silent_other.
//
// Usage:
//   node tools/cache-bust-detector.js [--root <dir>] [--out <file>]
//                                     [--threshold 0.5] [--prefix-min 5000]
//                                     [--json]
//
// Default --root is ~/.pi/agent/sessions
// --json prints one JSON line per session to stdout for downstream pipelines.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function parseArgs(argv) {
  const o = {
    root: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
    out: null,
    threshold: 0.5,
    prefixMin: 5000,
    json: false,
    ttlMs: 5 * 60 * 1000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--threshold') o.threshold = parseFloat(argv[++i]);
    else if (a === '--prefix-min') o.prefixMin = parseInt(argv[++i], 10);
    else if (a === '--ttl-min') o.ttlMs = parseFloat(argv[++i]) * 60 * 1000;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 26).join('\n'));
      process.exit(0);
    }
  }
  return o;
}

function findJsonl(root) {
  try {
    return execSync(`find ${JSON.stringify(root)} -name '*.jsonl'`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function classifyBust(b, ttlMs) {
  const set = [...new Set(b.interlude)];
  if (set.includes('compaction')) return 'compaction';
  if (set.includes('model_change')) return 'model_change';
  if (set.includes('thinking_level_change')) return 'thinking_change';
  if (set.includes('branch_summary')) return 'branch_event';
  if (set.includes('custom') || set.includes('custom_message')) return 'custom_inject';
  if (b.gapMs != null && b.gapMs > ttlMs) return 'idle_gt_ttl';
  if (b.gapMs != null && b.gapMs < 30000) return 'fast_silent_bust';
  return 'silent_other';
}

function analyzeFile(file, opts) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n').filter(Boolean);
  const events = [];
  let parseFail = 0;
  for (const ln of lines) {
    try { events.push(JSON.parse(ln)); } catch { parseFail++; }
  }
  if (!events.length) return null;

  const turns = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'message' && e.message?.role === 'assistant' && e.message?.usage) {
      turns.push({
        idx: i,
        t: e.timestamp ? Date.parse(e.timestamp) : null,
        usage: e.message.usage,
        modelId: e.message.modelId || null,
      });
    }
  }

  const busts = [];
  for (let n = 1; n < turns.length; n++) {
    const prev = turns[n - 1], cur = turns[n];
    const prefix = (prev.usage.cacheRead || 0) + (prev.usage.cacheWrite || 0);
    const read = cur.usage.cacheRead || 0;
    if (prefix > opts.prefixMin && read < opts.threshold * prefix) {
      const interlude = events.slice(prev.idx + 1, cur.idx).map(x => x.type);
      const gapMs = (cur.t && prev.t) ? (cur.t - prev.t) : null;
      busts.push({
        turn: n, prevIdx: prev.idx, curIdx: cur.idx,
        prefix, read, lost: prefix - read,
        gapMs, interlude,
        prevModel: prev.modelId, curModel: cur.modelId,
      });
    }
  }

  // Plateau detector: longest run of identical cacheRead values
  let plateauVal = 0, runLen = 0, longest = 0, longestVal = 0;
  for (const t of turns) {
    if (t.usage.cacheRead === plateauVal) runLen++;
    else { if (runLen > longest) { longest = runLen; longestVal = plateauVal; }
      plateauVal = t.usage.cacheRead; runLen = 1; }
  }
  if (runLen > longest) { longest = runLen; longestVal = plateauVal; }

  const first = events.find(e => e.type === 'session');
  const last = events[events.length - 1];
  const tStart = first?.timestamp ? Date.parse(first.timestamp) : (turns[0]?.t || null);
  const tEnd = last?.timestamp ? Date.parse(last.timestamp) : null;

  return {
    file, sid: first?.id || path.basename(file), cwd: first?.cwd || '',
    durMs: (tStart && tEnd) ? (tEnd - tStart) : 0,
    entries: events.length, turns: turns.length,
    parseFail,
    busts: busts.length, bustsList: busts,
    bustLostTokens: busts.reduce((s, b) => s + b.lost, 0),
    totalCacheRead: turns.reduce((s, t) => s + (t.usage.cacheRead || 0), 0),
    totalCacheWrite: turns.reduce((s, t) => s + (t.usage.cacheWrite || 0), 0),
    plateau: { value: longestVal, length: longest },
    customCount: (text.match(/"type":"custom_message"/g) || []).length
                  + (text.match(/"type":"custom"/g) || []).length,
    compactionCount: (text.match(/"type":"compaction"/g) || []).length,
    modelChangeCount: (text.match(/"type":"model_change"/g) || []).length,
  };
}

function summarize(results, opts) {
  const totalBusts = results.reduce((s, r) => s + r.busts, 0);
  const totalLost = results.reduce((s, r) => s + r.bustLostTokens, 0);
  const totalTurns = results.reduce((s, r) => s + r.turns, 0);
  const cat = {};
  for (const r of results) for (const b of r.bustsList) {
    const k = classifyBust(b, opts.ttlMs);
    cat[k] = (cat[k] || 0) + 1;
  }

  // Cohort analysis
  let low = [], hi = [];
  for (const r of results) {
    if (r.turns < 10) continue;
    const rate = r.busts / r.turns;
    if (r.customCount === 0) low.push(rate); else hi.push(rate);
  }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

  return {
    sessions: results.length,
    turnsTotal: totalTurns,
    busts: totalBusts,
    lostTokens: totalLost,
    attribution: Object.fromEntries(
      Object.entries(cat).sort((a, b) => b[1] - a[1])),
    cohort: {
      vanillaSessions: low.length,
      extensionSessions: hi.length,
      vanillaBustsPerTurn: +mean(low).toFixed(4),
      extensionBustsPerTurn: +mean(hi).toFixed(4),
      ratio: +(mean(hi) / Math.max(mean(low), 1e-9)).toFixed(2),
    },
    plateauSessions: results.filter(r => r.plateau.length >= 5 && r.plateau.value > 5000).length,
  };
}

function main() {
  const opts = parseArgs(process.argv);
  const files = findJsonl(opts.root);
  process.stderr.write(`scanning ${files.length} jsonl files under ${opts.root}\n`);
  const results = [];
  for (const f of files) {
    const r = analyzeFile(f, opts);
    if (r) results.push(r);
    if (opts.json) process.stdout.write(JSON.stringify(r) + '\n');
  }
  const summary = summarize(results, opts);
  if (!opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  }
  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify({ opts, summary, results }, null, 2));
    process.stderr.write(`wrote ${opts.out}\n`);
  }
}

if (require.main === module) main();
module.exports = { analyzeFile, classifyBust, summarize };
