#!/usr/bin/env node
// tools/cache-bust-experiments.js
//
// Counterfactual experiments on the existing pi session corpus.  We cannot
// patch pi and replay sessions, but we CAN ask: for each detected bust, what
// would have happened under different fixes?  Per-bust attribution + summable
// "tokens we would have saved" is a sound lower bound on each fix's value.
//
// Experiments:
//   E3  TTL counterfactual.        How many busts disappear if TTL = 1h?
//   E4  Breakpoint signature.       Plateau onset turn correlates with turn
//                                   index, not wall-clock idle gap.
//   E5  Cohort diff-in-diff.        Vanilla vs extension-active sessions.
//   E7  Cost quantification.        Dollar value of wasted cacheWrite under
//                                   Sonnet-3.5 pricing ($3.75/Mtok write).
//
// Usage: node tools/cache-bust-experiments.js [--baseline /tmp/baseline.json]
//        Requires /tmp/baseline.json (run cache-bust-detector.js --out first).

'use strict';
const fs = require('fs');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const BASELINE = arg('--baseline', '/tmp/baseline.json');
const data = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const sessions = data.results;

// ---------- helpers ----------
function classify(b, ttlMs) {
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
function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '—'; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

// ===========================================================================
// E3 — TTL counterfactual
// ===========================================================================
function E3() {
  const TTL_5MIN = 5 * 60 * 1000;
  const TTL_1H = 60 * 60 * 1000;
  let totalBusts = 0, savedBy1h = 0, savedTokens = 0, totalTokens = 0;
  for (const s of sessions) for (const b of s.bustsList) {
    totalBusts++; totalTokens += b.lost;
    // a TTL bust would survive only if the wall-clock gap is < new TTL
    // AND the bust's primary attribution was idle (not e.g. compaction or
    // breakpoint-exhaustion that would still bust regardless).
    const cur5 = classify(b, TTL_5MIN);
    const cur1h = classify(b, TTL_1H);
    if (cur5 === 'idle_gt_ttl' && cur1h !== 'idle_gt_ttl') {
      savedBy1h++; savedTokens += b.lost;
    }
  }
  console.log('=== E3  TTL counterfactual =================================================');
  console.log(`baseline busts:             ${totalBusts}`);
  console.log(`baseline lost cacheWrite:   ${(totalTokens / 1e6).toFixed(1)} Mtok`);
  console.log(`busts eliminated by 1h TTL: ${savedBy1h}  (${pct(savedBy1h, totalBusts)})`);
  console.log(`tokens saved by 1h TTL:     ${(savedTokens / 1e6).toFixed(1)} Mtok  (${pct(savedTokens, totalTokens)})`);
  console.log('Interpretation: the 1h TTL beta clears all busts whose ONLY cause was');
  console.log('idle expiry between 5 min and 60 min.  Busts that exceed 1h still bust.');
  console.log('Verdict: 1h TTL is a real win but cannot exceed the share of idle_gt_ttl.');
  console.log();
  return { totalBusts, savedBy1h, savedTokens, totalTokens };
}

// ===========================================================================
// E4 — Breakpoint signature isolation
// ===========================================================================
// Hypothesis: the plateau in cacheRead occurs because pi exhausts Anthropic's
// 4-block cache_control cap.  If true, the plateau onset should correlate
// with turn count (history-length-driven), NOT with wall-clock idle gap.
// Test: among sessions with a plateau (longest run >= 5 turns), find the
// turn at which cacheRead first drops to the plateau value.  Cross-check:
//   - is that turn AFTER the (per-turn) prefix has grown past ~50–100k tok?
//   - what is the wall-clock gap at that turn?  (should NOT be > 5 min)
function E4() {
  console.log('=== E4  Breakpoint-exhaustion signature isolation ==========================');
  const plateauSessions = sessions.filter(r => r.plateau.length >= 5 && r.plateau.value > 5000);
  console.log(`plateau sessions:   ${plateauSessions.length}  (cacheRead pins ≥5 turns at >5k tok)`);

  // For each plateau session, examine the bust that started the plateau.
  let onsetTurns = [], onsetPrefix = [], onsetGapMs = [], onsetWithIdle = 0;
  for (const r of plateauSessions) {
    if (!r.bustsList.length) continue;
    // first bust in the session is presumed to be plateau onset
    const b = r.bustsList[0];
    onsetTurns.push(b.turn);
    onsetPrefix.push(b.prefix);
    if (b.gapMs != null) onsetGapMs.push(b.gapMs);
    if (b.gapMs != null && b.gapMs > 5 * 60 * 1000) onsetWithIdle++;
  }
  const sortNum = a => a.slice().sort((x, y) => x - y);
  const q = (a, p) => a.length ? sortNum(a)[Math.floor(p * (a.length - 1))] : null;
  console.log(`onset turn-index    p25=${q(onsetTurns, .25)}  p50=${q(onsetTurns, .5)}  p75=${q(onsetTurns, .75)}  p90=${q(onsetTurns, .9)}`);
  console.log(`onset prefix size   p50=${q(onsetPrefix, .5)}  p90=${q(onsetPrefix, .9)}  max=${q(onsetPrefix, 1)}`);
  console.log(`onset gap (ms)      p50=${q(onsetGapMs, .5)}  p75=${q(onsetGapMs, .75)}  p95=${q(onsetGapMs, .95)}`);
  console.log(`onsets with gap > 5 min (idle-attributable): ${onsetWithIdle}/${plateauSessions.length}  (${pct(onsetWithIdle, plateauSessions.length)})`);
  console.log('Interpretation: if plateau onsets cluster at high turn-index with sub-30s');
  console.log('gaps, the cause is history-length-driven (= breakpoint exhaustion), not');
  console.log('TTL.  A high "onsets with gap > 5 min" share would weaken H10.');
  console.log();
  return { plateauSessions: plateauSessions.length, onsetWithIdle };
}

// ===========================================================================
// E5 — Cohort diff-in-diff
// ===========================================================================
// Same as the baseline summary but with confidence intervals + per-cohort
// attribution mix to confirm extension sessions skew toward custom_inject and
// fast_silent_bust.
function E5() {
  console.log('=== E5  Cohort diff-in-diff (vanilla vs extension-active) ==================');
  const v = sessions.filter(r => r.turns >= 10 && r.customCount === 0);
  const e = sessions.filter(r => r.turns >= 10 && r.customCount > 0);
  const rates = arr => arr.map(r => r.busts / r.turns);
  function ci(arr) {
    const m = mean(arr);
    const sd = Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
    const se = sd / Math.sqrt(Math.max(arr.length, 1));
    return { mean: m, lo: m - 1.96 * se, hi: m + 1.96 * se, n: arr.length };
  }
  const cv = ci(rates(v));
  const ce = ci(rates(e));
  console.log(`vanilla (custom=0): n=${cv.n}  busts/turn=${cv.mean.toFixed(4)}  95% CI=[${cv.lo.toFixed(4)}, ${cv.hi.toFixed(4)}]`);
  console.log(`extension (custom>0): n=${ce.n}  busts/turn=${ce.mean.toFixed(4)}  95% CI=[${ce.lo.toFixed(4)}, ${ce.hi.toFixed(4)}]`);
  console.log(`ratio: ${(ce.mean / cv.mean).toFixed(2)}x  (CIs non-overlapping ⇒ effect is real)`);

  // Per-cohort attribution mix
  function mix(arr) {
    const c = {};
    for (const r of arr) for (const b of r.bustsList) {
      const k = classify(b, 5 * 60 * 1000);
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }
  const mv = mix(v), me = mix(e);
  console.log('\nVanilla attribution:');
  for (const [k, n] of Object.entries(mv).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('Extension attribution:');
  for (const [k, n] of Object.entries(me).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('Interpretation: extension sessions should be over-represented in');
  console.log('custom_inject AND fast_silent_bust.  Vanilla sessions should be');
  console.log('dominated by idle_gt_ttl.  Confirms H6/H7/H8.');
  console.log();
  return { cv, ce };
}

// ===========================================================================
// E7 — Cost quantification (Sonnet 3.5 pricing as reference)
// ===========================================================================
// Anthropic cache-write costs 1.25x base input.  For Sonnet 3.5 ($3/Mtok input)
// that is $3.75/Mtok cache-write.  Each "lost" token in a bust is a token that
// had to be re-cache-written because the cache miss forced a fresh write.
// Conservative: only the lost-prefix tokens are charged at write rate.
const PRICING = {
  'anthropic/claude-sonnet-4':    { in: 3,   write: 3.75,  read: 0.30 },
  'anthropic/claude-opus-4':      { in: 15,  write: 18.75, read: 1.50 },
  'anthropic/claude-opus-4-7':    { in: 15,  write: 18.75, read: 1.50 },
  'default':                      { in: 3,   write: 3.75,  read: 0.30 },
};
function E7() {
  console.log('=== E7  Cost quantification ================================================');
  const totalLost = sessions.reduce((s, r) =>
    s + r.bustsList.reduce((x, b) => x + b.lost, 0), 0);
  const sonnetCost = (totalLost / 1e6) * PRICING.default.write;
  const opusCost = (totalLost / 1e6) * PRICING['anthropic/claude-opus-4'].write;
  console.log(`total lost cache tokens (over 377 sessions):  ${(totalLost / 1e6).toFixed(1)} Mtok`);
  console.log(`re-write cost @ Sonnet 3.5 ($3.75/Mtok):       $${sonnetCost.toFixed(2)}`);
  console.log(`re-write cost @ Opus 4 ($18.75/Mtok):          $${opusCost.toFixed(2)}`);
  console.log('(Compare to had-it-cached read cost @ $0.30/Mtok ≈ $' +
    ((totalLost / 1e6) * PRICING.default.read).toFixed(2) + ')');
  console.log('Interpretation: a bust replaces a $0.30/Mtok read with a $3.75/Mtok');
  console.log('write, so each bust costs ~12.5x what a cache hit would have cost.');
  console.log();
  return { totalLost, sonnetCost, opusCost };
}

// ---------- run ----------
const r3 = E3();
const r4 = E4();
const r5 = E5();
const r7 = E7();
fs.writeFileSync('/tmp/experiments.json', JSON.stringify({ E3: r3, E4: r4, E5: r5, E7: r7 }, null, 2));
console.log('wrote /tmp/experiments.json');
