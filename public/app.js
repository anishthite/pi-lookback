// pi-lookback frontend (no framework).
// Renders three views: library, session (3-pane), search results.
// Talks to /api/... and keeps state in module-level vars.

'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  sessions: [],
  currentDetail: null,
  selectedEntryId: null,
  signalEntryIds: [],
  errorEntryIds: [],
  showParams: (() => { try { return localStorage.getItem('lookback.showParams') === '1'; } catch { return false; } })(),
  // 'tokens' = stacked cacheRead/cacheWrite/input/output (default);
  // 'tools'  = single bar per turn, colored by the tool the assistant
  //           is about to call after that turn — keeps total height +
  //           cache-bust markers so the cache story still reads.
  ttMode: (() => { try { return localStorage.getItem('lookback.ttMode') || 'tokens'; } catch { return 'tokens'; } })(),
  toolCallById: new Map(), // toolCallId -> { name, arguments } from assistant entries
};

// Stable color palette for the tool-coloring mode. Known tools get hand-
// picked hues so the eye learns them; anything unknown falls back to a
// hash-based slate/gray ramp so two sessions are still comparable.
const TOOL_PALETTE = {
  bash: '#f59e0b', shell: '#f59e0b',
  read: '#3b82f6',
  write: '#ef4444',
  edit: '#10b981',
  grep: '#a855f7', fff_multi_grep: '#a855f7', find_files: '#c084fc',
  web_search: '#14b8a6', fetch_content: '#0d9488', get_search_content: '#5eead4', code_search: '#06b6d4',
  todo: '#6b7280',
  subagent: '#ec4899',
  ask_user_question: '#f97316',
  workflow: '#db2777',
  get_goal: '#84cc16',
  propose_goal_draft: '#84cc16',
};
const TOOL_FALLBACK_RAMP = ['#64748b', '#94a3b8', '#475569', '#0ea5e9', '#facc15', '#e11d48', '#7c3aed', '#22d3ee'];
const NO_TOOL_COLOR = '#e5e7eb'; // assistant turn with no tool call
function colorForTool(name) {
  const key = String(name || '').toLowerCase();
  if (!key) return NO_TOOL_COLOR;
  if (TOOL_PALETTE[key]) return TOOL_PALETTE[key];
  // simple deterministic hash → ramp index
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TOOL_FALLBACK_RAMP[h % TOOL_FALLBACK_RAMP.length];
}

// Build a short, human-readable summary of a tool call's arguments — used by
// the "Show tool params" toggle so users see what `bash` actually ran, what
// path `Read` opened, what `Grep` searched for, etc.
function summarizeToolArgs(name, args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (k) => {
    const v = args[k];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  const n = String(name || '').toLowerCase();
  let s = '';
  if (n === 'bash' || n === 'shell') s = pick('command') || pick('cmd');
  else if (n === 'read' || n === 'write' || n === 'edit') s = pick('path') || pick('file_path');
  else if (n === 'grep' || n === 'fff_multi_grep') s = [pick('pattern') || pick('patterns'), pick('path') && '@' + pick('path')].filter(Boolean).join(' ');
  else if (n === 'find_files') s = pick('query');
  else if (n === 'web_search') s = pick('query') || pick('queries');
  else if (n === 'fetch_content') s = pick('url') || pick('urls');
  else if (n === 'todo') s = [pick('action'), pick('subject')].filter(Boolean).join(' · ');
  else {
    // Fallback: first non-trivial string arg, else compact JSON.
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length) { s = `${k}=${v}`; break; }
    }
    if (!s) s = JSON.stringify(args);
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

// per review-security.md S-8: include the apostrophe in the escape map so
// any string interpolated into an HTML attribute context can't break out.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function highlight(s, q) {
  if (!q) return esc(s);
  const i = String(s).toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
}
function fmtCost(n) { return typeof n === 'number' ? `$${n.toFixed(4)}` : '—'; }
function fmtTokens(n) { return typeof n === 'number' ? n.toLocaleString() : '—'; }
function fmtMs(n) {
  if (n == null) return '—';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60) return `${m}m ${ss}s`;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}h ${mm}m`;
}
function fmtDate(s) { return s ? new Date(s).toLocaleString() : ''; }

/* ---------------- API ---------------- */
async function apiJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

/* ---------------- Routing ---------------- */
function showView(name) {
  for (const v of ['library', 'session', 'searchView']) {
    document.getElementById(v).classList.toggle('hidden', v !== name);
  }
}

/* ---------------- Library ---------------- */
async function loadLibrary() {
  const params = new URLSearchParams();
  params.set('sort', $('#sortSel').value);
  if ($('#fSource')?.value) params.set('source', $('#fSource').value);
  if ($('#fErrors').checked) params.set('hasErrors', '1');
  if ($('#fBranches').checked) params.set('hasBranches', '1');
  if ($('#fCompactions').checked) params.set('hasCompactions', '1');
  if ($('#fSidechain')?.checked) params.set('hasSidechain', '1');
  if ($('#fProject').value) params.set('project', $('#fProject').value);
  if ($('#fModel').value) params.set('model', $('#fModel').value);
  $('#libCount').textContent = 'Loading…';
  const t0 = performance.now();
  const data = await apiJson('/api/sessions?' + params.toString());
  state.sessions = data.sessions;
  $('#libCount').textContent = `${data.count} sessions · ${(performance.now() - t0).toFixed(0)} ms`;
  renderLibrary(data.sessions);
}

function renderLibrary(sessions) {
  const root = $('#libraryList');
  if (!sessions.length) { root.innerHTML = '<div class="empty">No sessions match.</div>'; return; }
  root.innerHTML = sessions.map((s) => sessionRowHtml(s)).join('');
  $$('.session-row').forEach((el) => el.addEventListener('click', () => openSession(el.dataset.id)));
}

function sessionRowHtml(s) {
  const badges = [];
  // Slice F: source badge first so the eye lands on it before the noise.
  if (s.source) badges.push(`<span class="badge badge-source source-${esc(s.source)}">${esc(s.source)}</span>`);
  if ((s.failedToolCallCount || 0) + (s.failedBashCommandCount || 0) > 0)
    badges.push(`<span class="badge badge-err">${s.failedToolCallCount + s.failedBashCommandCount} err</span>`);
  if (s.branchCount > 0) badges.push(`<span class="badge badge-branch">${s.branchCount} branch</span>`);
  if (s.compactionCount > 0) badges.push(`<span class="badge badge-comp">${s.compactionCount} compact</span>`);
  if (s.sidechainCount > 0) badges.push(`<span class="badge sidechain-flag">${s.sidechainCount} subagent</span>`);
  if (s.totalCost > 1) badges.push(`<span class="badge badge-cost">$${s.totalCost.toFixed(2)}</span>`);
  for (const k of s.signalKinds || []) if (!['failed_tool','failed_bash','branch_heavy','compaction_heavy','high_cost'].includes(k)) {
    badges.push(`<span class="badge badge-signal">${esc(k)}</span>`);
  }
  return `
  <div class="session-row" data-id="${esc(s.id)}">
    <div class="title-line">
      <div class="first-prompt">${esc(s.firstPrompt || '(no prompt)')}</div>
      <div class="project">${esc(s.projectPath || s.cwd || '')}</div>
    </div>
    <div class="stats">
      <span>${fmtDate(s.startedAt)}</span>
      <span><b>${s.entryCount}</b> entries</span>
      <span><b>${s.assistantMessageCount}</b> turns</span>
      <span><b>${s.toolCallCount}</b> tools</span>
      <span>${fmtTokens(s.totalTokens)} tok</span>
      <span>${fmtCost(s.totalCost)}</span>
      <span>${fmtMs(s.durationMs)}</span>
      <span>${esc((s.models || [])[0] || '')}</span>
      <span class="badges">${badges.join('')}</span>
      <span class="meta">score ${s.reviewScore}</span>
    </div>
  </div>`;
}

/* ---------------- Session detail ---------------- */
async function openSession(id) {
  showView('session');
  $('#sessionTitle').textContent = 'Loading…';
  $('#sessionMeta').textContent = '';
  $('#tracePane').innerHTML = '';
  $('#treePane').innerHTML = '';
  $('#inspectorPane').innerHTML = '<div class="meta">Loading…</div>';
  const t0 = performance.now();
  const detail = await apiJson('/api/sessions/' + encodeURIComponent(id));
  const elapsed = performance.now() - t0;
  state.currentDetail = detail;
  // Index toolCallId -> {name, arguments} so toolResult entries can show params too.
  state.toolCallById = new Map();
  for (const e of detail.entries) {
    if (e.kind === 'assistant' && e.toolCalls?.length) {
      for (const tc of e.toolCalls) {
        if (tc.id) state.toolCallById.set(tc.id, { name: tc.name, arguments: tc.arguments });
      }
    }
  }
  state.selectedEntryId = null;
  $('#sessionTitle').textContent = detail.summary.firstPrompt?.slice(0, 120) || detail.summary.id;
  const wf = detail.summary.workflow;
  if (wf) {
    const statusCls = (wf.status === 'complete') ? 'ok' : (wf.status === 'error' || wf.status === 'failed') ? 'bad' : 'warn';
    const phases = (wf.phases || []).map(p => `<span class="wf-phase-pill">${esc(p.title)} ×${p.count}</span>`).join('');
    $('#sessionMeta').innerHTML = `
      <div class="wf-banner">
        <div class="wf-row"><span class="wf-name">${esc(wf.name || wf.runId)}</span><span class="wf-status wf-status-${statusCls}">${esc(wf.status || '—')}</span><span class="wf-runid">${esc(wf.runId)}</span><span>· ${wf.agentCount} agent${wf.agentCount === 1 ? '' : 's'}</span><span>· ${fmtMs(wf.durationMs)}</span><span>· loaded ${elapsed.toFixed(0)}ms</span></div>
        ${phases ? `<div class="wf-row wf-phases">${phases}</div>` : ''}
        ${wf.description ? `<div class="wf-row wf-desc">${esc(wf.description)}</div>` : ''}
        <div class="wf-row wf-script"><code>${esc(wf.scriptPath || '')}</code></div>
      </div>`;
  } else {
    $('#sessionMeta').innerHTML = `${esc(detail.summary.projectPath || '')} · ${esc(fmtDate(detail.summary.startedAt))} · loaded ${elapsed.toFixed(0)}ms`;
  }
  $('#exportBtn').href = '/api/export?id=' + encodeURIComponent(id);

  renderSessionStats(detail);
  renderSessionSignals(detail);
  renderTokenTimeline(detail);
  renderTree(detail);
  renderTrace(detail);

  // Cache signal+error entry ids for nav.
  state.signalEntryIds = [...new Set((detail.signals || []).map((s) => s.entryId).filter(Boolean))];
  state.errorEntryIds = detail.entries.filter((e) => (e.kind === 'toolResult' && e.isError) || (e.kind === 'bashExecution' && e.exitCode !== 0 && e.exitCode !== null)).map((e) => e.id);
}

function renderSessionStats(d) {
  const s = d.summary;
  // cc-workflow: most pi/cc counters are meaningless 0s. Show a focused
  // line emphasising what's actually present — agents, phases, duration,
  // total bytes of text produced.
  if (s.workflow) {
    const w = s.workflow;
    const totalChars = (d.entries || []).reduce((acc, e) => acc + ((e.kind === 'assistant') ? (e.text || '').length : 0), 0);
    $('#sessionStats').innerHTML = `
      <span><b>${w.agentCount}</b> agents</span>
      <span><b>${(w.phases || []).length}</b> phases</span>
      <span><b>${fmtMs(w.durationMs)}</b></span>
      <span><b>${fmtTokens(totalChars)}</b> result chars</span>
      <span class="meta">tokens/cost not recorded by workflow runner</span>
    `;
    return;
  }
  $('#sessionStats').innerHTML = `
    <span><b>${s.entryCount}</b> entries</span>
    <span><b>${s.userMessageCount}</b> user / <b>${s.assistantMessageCount}</b> assistant</span>
    <span><b>${s.toolCallCount}</b> tool calls (<b class="${s.failedToolCallCount?'errorBadge':''}">${s.failedToolCallCount}</b> failed)</span>
    <span><b>${s.bashCommandCount}</b> bash (<b>${s.failedBashCommandCount}</b> failed)</span>
    <span><b>${s.branchCount}</b> branches</span>
    <span><b>${s.compactionCount}</b> compactions</span>
    <span><b>${s.modelSwitchCount}</b> model switches</span>
    <span><b>${fmtTokens(s.totalTokens)}</b> tokens</span>
    <span><b>${fmtCost(s.totalCost)}</b> total</span>
    <span><b>${fmtMs(s.durationMs)}</b></span>
    <span>models: ${s.models.join(', ') || '—'}</span>
  `;
}

function renderSessionSignals(d) {
  const counts = {};
  for (const s of d.signals || []) counts[s.kind] = (counts[s.kind] || 0) + 1;
  $('#sessionSignals').innerHTML = Object.entries(counts).map(([k, n]) =>
    `<span class="badge badge-signal" title="${esc(k)}">${esc(k)} ${n}</span>`
  ).join('') || '<span class="meta">No improvement signals detected.</span>';
}

/* ---------------- Token timeline ---------------- */
// Normalize per-assistant usage across pi + claude-code shapes so the chart
// works for both. Returns {input, output, cacheRead, cacheWrite, total}.
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = u.input ?? u.input_tokens ?? 0;
  const output = u.output ?? u.output_tokens ?? 0;
  const cacheRead = u.cacheRead ?? u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cacheWrite ?? u.cache_creation_input_tokens ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0) return null;
  return { input, output, cacheRead, cacheWrite, total };
}

function renderTokenTimeline(d) {
  const root = $('#tokenTimeline');
  // Build per-assistant-turn series in chronological order. We also record
  // the tool calls the assistant kicks off in that turn ("what's gonna
  // happen next") so the tool-colored mode can color bars accordingly.
  // A bash tool-call shows up as `bashExecution`, not as a regular tool
  // call — normalize that so bash turns show with the bash color too.
  const turns = [];
  for (const e of d.entries) {
    if (e.kind === 'assistant') {
      const u = normalizeUsage(e.usage);
      if (!u) continue;
      const tools = (e.toolCalls || []).map((tc) => String(tc.name || '').toLowerCase()).filter(Boolean);
      turns.push({ id: e.id, ts: e.timestamp, model: e.model || '', tools, ...u });
    }
  }
  if (!turns.length) { root.innerHTML = ''; return; }
  // For pi sessions, bash runs as a sibling `bashExecution` entry rather
  // than as a toolCall on the assistant. Attribute it to the most recent
  // assistant turn that hasn't been closed by a user message.
  {
    let lastIdx = -1;
    let assistantSeen = 0;
    for (const e of d.entries) {
      if (e.kind === 'assistant' && normalizeUsage(e.usage)) { lastIdx = assistantSeen; assistantSeen++; }
      else if (e.kind === 'user') { lastIdx = -1; }
      else if (e.kind === 'bashExecution' && lastIdx >= 0 && lastIdx < turns.length) {
        if (!turns[lastIdx].tools.includes('bash')) turns[lastIdx].tools.push('bash');
      }
    }
  }

  // Compaction + user-message events get vertical markers; map their position
  // to the running turn index (count of assistant turns seen so far).
  const compactionAtTurnIdx = [];
  const userAtTurnIdx = [];
  let turnCursor = 0;
  for (const e of d.entries) {
    if (e.kind === 'assistant' && normalizeUsage(e.usage)) turnCursor++;
    if (e.kind === 'compaction') compactionAtTurnIdx.push(turnCursor);
    if (e.kind === 'user') userAtTurnIdx.push(turnCursor);
  }

  // Detect cache busts: a turn whose cacheRead drops to <50% of the previous
  // turn's cacheRead AND prior cacheRead was meaningful (>1000). Signals a
  // prompt-cache miss / context reset.
  const bustIdx = new Set();
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1].cacheRead;
    const cur = turns[i].cacheRead;
    if (prev > 1000 && cur < prev * 0.5) bustIdx.add(i);
  }

  const max = Math.max(...turns.map((t) => t.total));
  const W = Math.max(turns.length * 6 + 40, 600);
  const H = 140;
  const padL = 44, padR = 8, padT = 8, padB = 18;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const barW = Math.max(2, Math.floor(innerW / turns.length) - 1);
  const xFor = (i) => padL + i * (innerW / turns.length);
  const yFor = (v) => padT + innerH - (v / max) * innerH;

  // Stacked rects per turn. In 'tokens' mode: cacheRead→cacheWrite→input→output.
  // In 'tools' mode: total-token bar split proportionally across the tools
  // the assistant is about to call ("what's gonna happen next"). Turns
  // with no tool calls render as a muted slab so the rhythm of
  // tool-heavy vs. think-only turns is visible at a glance.
  const mode = state.ttMode === 'tools' ? 'tools' : 'tokens';
  const bars = turns.map((t, i) => {
    const x = xFor(i);
    let y0 = padT + innerH;
    const segs = [];
    if (mode === 'tokens') {
      const stack = [
        ['cacheRead', t.cacheRead, '#10b981'],   // green
        ['cacheWrite', t.cacheWrite, '#3b82f6'],  // blue
        ['input', t.input, '#f59e0b'],            // amber
        ['output', t.output, '#a855f7'],          // purple
      ];
      for (const [name, val, color] of stack) {
        if (val <= 0) continue;
        const h = (val / max) * innerH;
        y0 -= h;
        segs.push(`<rect x="${x}" y="${y0}" width="${barW}" height="${h}" fill="${color}" data-turn="${i}" data-name="${name}" data-val="${val}"></rect>`);
      }
    } else {
      const totalH = (t.total / max) * innerH;
      if (!t.tools.length) {
        y0 -= totalH;
        segs.push(`<rect x="${x}" y="${y0}" width="${barW}" height="${totalH}" fill="${NO_TOOL_COLOR}" data-turn="${i}" data-name="no tool" data-val="${t.total}"></rect>`);
      } else {
        const slice = totalH / t.tools.length;
        for (const name of t.tools) {
          y0 -= slice;
          segs.push(`<rect x="${x}" y="${y0}" width="${barW}" height="${slice}" fill="${colorForTool(name)}" data-turn="${i}" data-name="${esc(name)}" data-val="${t.total}"></rect>`);
        }
      }
    }
    const bust = bustIdx.has(i) ? `<rect x="${x - 0.5}" y="${padT}" width="${barW + 1}" height="${innerH}" fill="none" stroke="#ef4444" stroke-width="1.2" stroke-dasharray="2,2" pointer-events="none"></rect>` : '';
    return segs.join('') + bust;
  }).join('');

  const compactionLines = compactionAtTurnIdx.map((idx) => {
    const x = xFor(Math.min(idx, turns.length));
    return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + innerH}" stroke="#dc2626" stroke-width="2" pointer-events="none"></line>`;
  }).join('');
  const userLines = userAtTurnIdx.map((idx) => {
    const x = xFor(Math.min(idx, turns.length));
    return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + innerH}" stroke="#0d9488" stroke-width="1" stroke-opacity="0.7" pointer-events="none"></line>`;
  }).join('');

  // Y-axis ticks: 0, max/2, max.
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  const ticks = [0, max / 2, max].map((v) => `
    <line x1="${padL}" y1="${yFor(v)}" x2="${W - padR}" y2="${yFor(v)}" stroke="#e5e7eb" stroke-width="1"></line>
    <text x="${padL - 4}" y="${yFor(v) + 3}" text-anchor="end" font-size="10" fill="#6b7280">${fmtK(Math.round(v))}</text>
  `).join('');

  // Totals + bust count summary.
  const sum = turns.reduce((a, t) => ({
    input: a.input + t.input, output: a.output + t.output,
    cacheRead: a.cacheRead + t.cacheRead, cacheWrite: a.cacheWrite + t.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const cacheHitRatio = sum.cacheRead / Math.max(1, sum.cacheRead + sum.cacheWrite + sum.input);

  // Build a per-session tool legend from the tools that actually appear,
  // sorted by call count. Hidden in tokens mode — a static legend would
  // be a wall of swatches for sessions that touched 20+ tools.
  const toolCounts = new Map();
  for (const t of turns) for (const n of t.tools) toolCounts.set(n, (toolCounts.get(n) || 0) + 1);
  const toolLegend = mode === 'tools'
    ? [...toolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([n, c]) => `<span class="tt-legend"><i style="background:${colorForTool(n)}"></i>${esc(n)} <span class="meta">×${c}</span></span>`)
        .join('') + (toolCounts.size > 12 ? `<span class="meta">+${toolCounts.size - 12} more</span>` : '') + (turns.some((t) => !t.tools.length) ? `<span class="tt-legend"><i style="background:${NO_TOOL_COLOR}"></i>no tool</span>` : '')
    : `
        <span class="tt-legend"><i style="background:#10b981"></i>cache read</span>
        <span class="tt-legend"><i style="background:#3b82f6"></i>cache write</span>
        <span class="tt-legend"><i style="background:#f59e0b"></i>input</span>
        <span class="tt-legend"><i style="background:#a855f7"></i>output</span>`;

  root.innerHTML = `
    <div class="tt-header">
      <b>Token timeline</b>
      <span class="tt-mode" role="tablist">
        <button class="tt-mode-btn ${mode==='tokens'?'active':''}" data-mode="tokens" role="tab" aria-selected="${mode==='tokens'}">by token type</button>
        <button class="tt-mode-btn ${mode==='tools'?'active':''}" data-mode="tools" role="tab" aria-selected="${mode==='tools'}">by tool</button>
      </span>
      ${toolLegend}
      <span class="tt-legend"><i class="line" style="background:#dc2626"></i>compaction</span>
      <span class="tt-legend"><i class="user-line"></i>user msg</span>
      <span class="tt-legend"><i class="dash" style="border-color:#ef4444"></i>cache bust</span>
      <span class="meta">${turns.length} turns · peak ${fmtK(max)} tok · cache hit ${(cacheHitRatio*100).toFixed(0)}% · ${bustIdx.size} bust${bustIdx.size===1?'':'s'}</span>
      <span class="meta" id="ttHover"></span>
    </div>
    <div class="tt-scroll">
      <svg id="ttSvg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none">
        ${ticks}
        ${userLines}
        ${bars}
        ${compactionLines}
      </svg>
    </div>`;

  // Hover + click to jump to the corresponding assistant entry.
  const svg = $('#ttSvg');
  const hover = $('#ttHover');
  svg.addEventListener('mousemove', (ev) => {
    const tg = ev.target;
    if (tg && tg.tagName === 'rect' && tg.dataset.turn != null) {
      const t = turns[+tg.dataset.turn];
      const toolsStr = t.tools.length ? ' · next: ' + t.tools.join(',') : ' · (no tool call)';
      hover.textContent = `#${+tg.dataset.turn + 1} ${fmtDate(t.ts)} · cacheR ${fmtK(t.cacheRead)} · cacheW ${fmtK(t.cacheWrite)} · in ${fmtK(t.input)} · out ${fmtK(t.output)} · total ${fmtK(t.total)}${bustIdx.has(+tg.dataset.turn)?' · BUST':''}${toolsStr}`;
    }
  });
  // Mode toggle buttons — persist choice and re-render.
  for (const btn of root.querySelectorAll('.tt-mode-btn')) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.mode === 'tools' ? 'tools' : 'tokens';
      if (next === state.ttMode) return;
      state.ttMode = next;
      try { localStorage.setItem('lookback.ttMode', next); } catch {}
      if (state.currentDetail) renderTokenTimeline(state.currentDetail);
    });
  }
  svg.addEventListener('mouseleave', () => { hover.textContent = ''; });
  svg.addEventListener('click', (ev) => {
    const tg = ev.target;
    if (tg && tg.tagName === 'rect' && tg.dataset.turn != null) {
      const t = turns[+tg.dataset.turn];
      if (t.id) selectEntry(t.id, { scroll: true });
    }
  });
}

function renderTree(d) {
  const root = $('#treePane');
  const childCount = new Map();
  for (const e of d.entries) {
    if (e.parentId) childCount.set(e.parentId, (childCount.get(e.parentId) || 0) + 1);
  }

  const isWorkflow = !!d.summary?.workflow;
  const renderItem = (e, opts = {}) => {
    const errish = (e.kind === 'toolResult' && e.isError) || (e.kind === 'bashExecution' && e.exitCode !== 0 && e.exitCode !== null);
    const branched = (childCount.get(e.id) || 0) > 1;
    const label = treeLabel(e);
    const cls = `tree-item kind-${esc(e.kind)} ${branched ? 'branch-parent' : ''} ${opts.indent ? 'tree-indent' : ''}`;
    return `<div class="${cls}" data-id="${esc(e.id)}"><span class="marker ${errish ? 'error' : e.kind}"></span><span class="ellipsis" title="${esc(label)}">${esc(label)}</span></div>`;
  };

  let html;
  if (isWorkflow) {
    // Group consecutive cc-workflow agent entries by phase. When a phase
    // has >1 distinct agentIndex worth of entries, treat the group as a
    // parallel batch: render a phase header ("Review · 3 parallel agents")
    // and indent the per-agent (prompt + result) pairs beneath it.
    const out = [];
    let i = 0;
    while (i < d.entries.length) {
      const e = d.entries[i];
      const phase = e.phaseTitle;
      if (!phase) { out.push(renderItem(e)); i++; continue; }
      let j = i;
      const indices = new Set();
      while (j < d.entries.length && d.entries[j].phaseTitle === phase) {
        if (typeof d.entries[j].agentIndex === 'number') indices.add(d.entries[j].agentIndex);
        j++;
      }
      const agentN = indices.size;
      const detail = agentN > 1 ? ` · ${agentN} in parallel` : '';
      out.push(`<div class="tree-phase-header"><span class="tree-phase-title">${esc(phase)}</span><span class="tree-phase-detail">${esc(detail)}</span></div>`);
      for (let k = i; k < j; k++) out.push(renderItem(d.entries[k], { indent: true }));
      i = j;
    }
    html = out.join('');
  } else {
    html = d.entries.map((e) => renderItem(e)).join('');
  }
  root.innerHTML = html;
  $$('.tree-item', root).forEach((el) => el.addEventListener('click', () => selectEntry(el.dataset.id, { scroll: true })));
}

function treeLabel(e) {
  // cc-workflow entries carry agentLabel/phaseTitle. The phase already
  // appears in the group header above so we don't repeat it in items;
  // marker glyph + label + (prompt | preview) is enough.
  // Skip this short-form for synthetic tool-call steps (agentToolStep) so
  // they fall through to the default branch and render their tool name(s).
  if ((e.source === 'cc-workflow' || e.agentLabel || e.phaseTitle) && !e.agentToolStep) {
    const label = e.agentLabel || 'agent';
    if (e.kind === 'user' && e.promptType === 'agent-call') {
      return `» ${label} · prompt`;
    }
    if (e.kind === 'assistant') {
      const preview = (e.text || '').replace(/\s+/g, ' ').slice(0, 48);
      return `✓ ${label}${preview ? ' · ' + preview : ''}`;
    }
  }
  switch (e.kind) {
    case 'user': return 'user · ' + (e.text || '').slice(0, 60);
    case 'assistant': {
      const tcs = e.toolCalls || [];
      let label = 'assistant ';
      if (tcs.length) {
        if (state.showParams) {
          label += tcs.map(t => {
            const s = summarizeToolArgs(t.name, t.arguments);
            return s ? `${t.name}(${s})` : t.name;
          }).join(', ');
        } else {
          label += `[${tcs.map(t=>t.name).join(',')}]`;
        }
      }
      return label + ' ' + (e.text || '').slice(0, 50);
    }
    case 'toolResult': {
      const base = `${e.toolName || 'tool'}${e.isError ? ' ✕' : ''}`;
      if (state.showParams) {
        const call = state.toolCallById.get(e.toolCallId);
        const s = call ? summarizeToolArgs(call.name || e.toolName, call.arguments) : '';
        if (s) return `${base} · ${s}`;
      }
      return base;
    }
    case 'bashExecution': return 'bash ' + (e.command || '').slice(0, state.showParams ? 120 : 60);
    case 'compaction': return 'compaction (' + (e.tokensBefore || '?') + ' tok)';
    case 'model_change': return 'model ' + (e.modelId || '');
    case 'thinking_level_change': return 'thinking ' + (e.thinkingLevel || '');
    case 'custom': return 'custom ' + (e.customType || '');
    case 'custom_message': return 'cmsg ' + (e.customType || '');
    // Slice F: cc-specific kinds.
    case 'session_meta': return 'session_meta · ' + (e.model || '');
    case 'attachment_card': return 'attachment · ' + (e.subtype || '');
    case 'error': return 'error · ' + (e.errorMessage || '').slice(0, 50);
    case 'snapshot': return `snapshot · ${(e.trackedFiles || []).length} files`;
    case 'meta': return 'meta · ' + (e.metaType || '');
    default: return e.kind;
  }
}

function renderTrace(d) {
  $('#tracePane').innerHTML = d.entries.map(entryHtml).join('');
  $$('.entry', $('#tracePane')).forEach((el) => el.addEventListener('click', (ev) => {
    selectEntry(el.dataset.id);
    // Clicking a user entry opens the full-text modal (and, for the first
    // user message, the reconstructed initial-input breakdown). Ignore
    // clicks that land inside <details>/<a>/<button> so we don't hijack
    // expand/collapse interactions.
    if (el.classList.contains('kind-user')) {
      const inside = ev.target.closest('a,button,summary,input,textarea');
      if (!inside) openMessageModal(el.dataset.id);
    }
  }));
}

/* ---------------- Modal: full message + initial-input ---------------- */
function openModal(title, html) {
  $('#msgModalTitle').textContent = title;
  $('#msgModalBody').innerHTML = html;
  $('#msgModalBody').scrollTop = 0;
  $('#msgModal').classList.remove('hidden');
}
function closeModal() { $('#msgModal').classList.add('hidden'); }

function openMessageModal(entryId) {
  const d = state.currentDetail;
  if (!d) return;
  const e = d.entries.find((x) => x.id === entryId);
  if (!e) return;
  // Detect whether this is the FIRST user message — if so, the modal will
  // also embed the reconstructed initial-input view (system prompt + skills
  // + context files + token estimate). For non-first user messages we just
  // show the full untruncated text.
  const firstUser = d.entries.find((x) => x.kind === 'user');
  const isFirst = !!firstUser && firstUser.id === entryId;
  const fullTextHtml = `
    <h3>User message</h3>
    <div class="grid-kv">
      <b>entry id</b><div><code>${esc(e.id || '')}</code></div>
      <b>timestamp</b><div>${esc(fmtDate(e.timestamp))}</div>
      <b>chars</b><div>${(e.text||'').length} (note: trace pane truncates at 4000)</div>
    </div>
    <pre>${esc(e.text || '')}${e.textTruncated ? '\n…truncated by API — the FULL text below is loaded separately' : ''}</pre>
  `;
  if (!isFirst) {
    openModal('User message', fullTextHtml);
    return;
  }
  // For the first user message, fetch the reconstructed initial-input.
  openModal(
    'Initial request · first user message',
    fullTextHtml + '<h3>Initial request composition</h3><div class="meta">Loading…</div>'
  );
  openInitialInputModal(d.summary.id, { keepFirstSection: fullTextHtml });
}

async function openInitialInputModal(sessionId, { keepFirstSection = '' } = {}) {
  if (!keepFirstSection) {
    openModal('Initial request', '<div class="meta">Loading…</div>');
  }
  try {
    const data = await apiJson('/api/sessions/' + encodeURIComponent(sessionId) + '/initial-input');
    openModal('Initial request · reconstructed', keepFirstSection + renderInitialInput(data));
  } catch (err) {
    openModal('Initial request', `<div class="note">Failed: ${esc(err.message)}</div>`);
  }
}

function renderInitialInput(data) {
  const est = data.tokens?.estimate || null;
  const usage = data.tokens?.firstAssistantUsage || null;
  const tokensRows = [];
  if (usage) {
    tokensRows.push(`<b>actual cache-write (first turn)</b><div><b>${fmtTokens(usage.cacheWrite || usage.cache_creation_input_tokens || 0)}</b> tokens — the size of what was sent and cached on the first request</div>`);
    tokensRows.push(`<b>actual input</b><div>${fmtTokens(usage.input || usage.input_tokens || 0)}</div>`);
    tokensRows.push(`<b>actual output</b><div>${fmtTokens(usage.output || usage.output_tokens || 0)}</div>`);
  }
  if (est) {
    tokensRows.push(`<b>pi estimate (uncalibrated)</b><div>${fmtTokens(est.estimatedUncalibratedTokens)}</div>`);
    tokensRows.push(`<b>pi estimate (final)</b><div>${fmtTokens(est.estimatedFinalTokens)}</div>`);
    tokensRows.push(`<b>pi actual initial-input</b><div><b>${fmtTokens(est.actualInitialInputTokens)}</b> tokens (logged by pi at session start)</div>`);
    tokensRows.push(`<b>pi injected (system+context)</b><div>${fmtTokens(est.actualInjectedTokens)} tokens</div>`);
    tokensRows.push(`<b>first user prompt</b><div>${fmtTokens(est.firstUserTokens)} tokens</div>`);
    tokensRows.push(`<b>provider / model</b><div>${esc(est.provider || '')} / ${esc(est.model || '')}</div>`);
  } else {
    tokensRows.push(`<b>pi estimate</b><div class="meta">not logged for this session (older pi or context-mode disabled)</div>`);
  }
  const tokensHtml = `
    <h3>Token cost of the initial request</h3>
    <div class="grid-kv">${tokensRows.join('')}</div>
  `;

  const notesHtml = (data.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('');

  const compHtml = (data.composition || []).map(renderCompositionItem).join('');

  // Labeled, sectioned assembly of the actual rendered system prompt.
  // Each section is the exact substring pi would have emitted.
  const rendered = data.rendered;
  let renderedHtml = '';
  if (rendered) {
    const sections = rendered.systemPromptSections || [];
    const rows = sections.map((s, i) => `
      <div class="sp-section" data-idx="${i}">
        <div class="sp-label">
          <span class="sp-num">#${i + 1}</span>
          <span class="sp-name">${esc(s.label)}</span>
          <span class="sp-meta">${s.text.length} chars · ${esc(s.origin || '')}</span>
        </div>
        <pre class="sp-text">${esc(s.text)}</pre>
      </div>`).join('');
    const firstUser = rendered.firstUserMessage || { text: '', label: 'first user message', origin: '' };
    const sourceLabel = data.source === 'cc-workflow'
      ? '<b>cc-workflow</b> · run journals do not capture a rendered system prompt.'
      : data.source === 'claude-code'
      ? '<b>Claude Code</b> · sections below are <b>exact bytes</b> captured in the JSONL at session time (ground truth, except for the base prompt which lives in the CC binary).'
      : '<b>pi</b> · pi does not log the rendered prompt; sections below are <b>reconstructed</b> by running <code>buildSystemPrompt()</code> on today\u2019s files on disk.';
    renderedHtml = `
      <h3>Rendered system prompt (labeled by section)</h3>
      <div class="sp-source-banner">${sourceLabel}</div>
      <div class="meta" style="margin-bottom:.4rem">
        Total: <b>${rendered.systemPromptChars.toLocaleString()}</b> chars across <b>${sections.length}</b> sections.
        <button id="copySpBtn" class="sp-copy">Copy full prompt</button>
        <button id="toggleSpBtn" class="sp-copy">Show raw concatenated</button>
      </div>
      <div id="spSectioned">${rows}</div>
      <div id="spRaw" class="sp-raw hidden"><pre>${esc(rendered.systemPromptText || '')}</pre></div>
      <h3>Then the user message arrives</h3>
      <div class="sp-section">
        <div class="sp-label">
          <span class="sp-num">user</span>
          <span class="sp-name">${esc(firstUser.label)}</span>
          <span class="sp-meta">${(firstUser.text || '').length} chars · ${esc(firstUser.origin || '')}</span>
        </div>
        <pre class="sp-text">${esc(firstUser.text || '')}</pre>
      </div>`;
  }

  // Defer bindings until after innerHTML lands.
  setTimeout(() => {
    const copyBtn = document.getElementById('copySpBtn');
    if (copyBtn && rendered) copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(rendered.systemPromptText || '').then(
        () => { copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy full prompt', 1200); },
        () => { copyBtn.textContent = 'Copy failed'; }
      );
    });
    const toggleBtn = document.getElementById('toggleSpBtn');
    if (toggleBtn) toggleBtn.addEventListener('click', () => {
      const sectioned = document.getElementById('spSectioned');
      const raw = document.getElementById('spRaw');
      const showRaw = sectioned.classList.toggle('hidden');
      raw.classList.toggle('hidden', !showRaw);
      toggleBtn.textContent = showRaw ? 'Show sectioned' : 'Show raw concatenated';
    });
  }, 0);

  return `${tokensHtml}${renderedHtml}<h3>Discovery details</h3>${notesHtml}${compHtml}`;
}

function renderCompositionItem(c) {
  const kindClass = esc(c.kind);
  if (c.kind === 'base-system-prompt') {
    return `<div class="composition-item ${kindClass}">
      <div class="h"><span>pi base system prompt</span><span class="small">${esc(c.path)}</span></div>
      <div class="meta">${esc(c.note || '')}</div>
    </div>`;
  }
  if (c.kind === 'context-file') {
    return `<div class="composition-item ${kindClass}">
      <div class="h"><span>context file</span><span class="small">${esc(c.path)} · ${esc(c.origin || '')} · ${c.size} B${c.truncated ? ' (truncated)' : ''}</span></div>
      <details><summary>show content</summary><pre>${esc(c.content || '')}</pre></details>
    </div>`;
  }
  if (c.kind === 'skill') {
    return `<div class="composition-item ${kindClass}">
      <div class="h"><span>skill · ${esc(c.name || '')}</span><span class="small">${esc(c.origin || '')} · ${esc(c.path)}</span></div>
      <details><summary>show SKILL.md (${c.size} B${c.truncated ? ', truncated' : ''})</summary><pre>${esc(c.content || '')}</pre></details>
    </div>`;
  }
  if (c.kind === 'extension') {
    return `<div class="composition-item ${kindClass}">
      <div class="h"><span>extension active · ${esc(c.name)}</span></div>
      <div class="meta">${esc(c.evidence || '')}</div>
    </div>`;
  }
  if (c.kind === 'first-user-message') {
    return `<div class="composition-item ${kindClass}">
      <div class="h"><span>first user message</span><span class="small">${c.chars} chars</span></div>
      <pre>${esc(c.text || '')}</pre>
    </div>`;
  }
  return `<div class="composition-item"><div class="h"><span>${kindClass}</span></div><pre>${esc(JSON.stringify(c, null, 2))}</pre></div>`;
}

function entryHtml(e) {
  const errish = (e.kind === 'toolResult' && e.isError) || (e.kind === 'bashExecution' && e.exitCode !== 0 && e.exitCode !== null);
  // cc-workflow header chip — shows phase + label on both the synthetic
  // user (prompt) and the assistant (result) entries.
  const wfChip = (e.source === 'cc-workflow' && (e.phaseTitle || e.agentLabel))
    ? `<div class="wf-chip"><span class="wf-phase">${esc(e.phaseTitle || '—')}</span><span class="wf-label">${esc(e.agentLabel || 'agent')}</span>${e.kind === 'user' ? '<span class="wf-tag">prompt</span>' : '<span class="wf-tag wf-tag-result">result</span>'}${e.agentHash ? `<span class="wf-hash">#${esc(e.agentHash)}</span>` : ''}</div>`
    : '';
  let body = wfChip;
  if (e.kind === 'user') body += `<div class="text">${esc(e.text || '')}</div>`;
  else if (e.kind === 'assistant') {
    if (e.thinking) body += `<details><summary>thinking (${e.thinking.length} chars${e.thinkingTruncated?', truncated':''})</summary><pre>${esc(e.thinking)}</pre></details>`;
    if (e.text) body += `<div class="text">${esc(e.text)}${e.textTruncated?'<span class="meta">…truncated</span>':''}</div>`;
    if (e.toolCalls?.length) {
      body += '<div class="toolcalls">' + e.toolCalls.map(tc => `
        <div class="toolcall">
          <span class="name">${esc(tc.name || '')}</span>
          <span class="meta"> ${esc(tc.id || '')}</span>
          <details${state.showParams ? ' open' : ''}><summary>arguments${state.showParams && summarizeToolArgs(tc.name, tc.arguments) ? ' · ' + esc(summarizeToolArgs(tc.name, tc.arguments)) : ''}</summary><pre>${esc(JSON.stringify(tc.arguments, null, 2))}</pre></details>
        </div>`).join('') + '</div>';
    }
    body += `<div class="meta">${esc(e.model || '')} · ${fmtTokens(e.totalTokens)} tok · ${fmtCost(e.cost)} · stop=${esc(e.stopReason || '')}</div>`;
  } else if (e.kind === 'toolResult') {
    body = `<div class="head">tool=${esc(e.toolName || '')} ${e.isError ? '<span class="errorBadge">ERROR</span>' : ''} ${e.outputBytes ? `· ${e.outputBytes}B` : ''}</div><pre>${esc(e.text || '')}${e.textTruncated?'\n…truncated':''}</pre>`;
  } else if (e.kind === 'bashExecution') {
    body = `<pre style="background:#1f2937;color:#e5e7eb;">$ ${esc(e.command)}</pre><div class="meta">exit ${e.exitCode}${e.truncated?' · truncated':''}${e.cancelled?' · cancelled':''}</div><pre>${esc(e.output || '')}${e.outputTruncated?'\n…truncated':''}</pre>`;
  } else if (e.kind === 'compaction') {
    body = `<div class="meta">tokens before: <b>${e.tokensBefore}</b> · firstKept: <code>${esc(e.firstKeptEntryId || '')}</code></div><pre>${esc(e.summary || '')}</pre>`;
  } else if (e.kind === 'branch_summary') {
    body = `<div class="meta">from=${esc(e.fromId || '')}</div><pre>${esc(e.summary || '')}</pre>`;
  } else if (e.kind === 'model_change') {
    body = `<div class="meta">${esc(e.provider || '')}/${esc(e.modelId || '')}</div>`;
  } else if (e.kind === 'thinking_level_change') {
    body = `<div class="meta">level=${esc(e.thinkingLevel || '')}</div>`;
  } else if (e.kind === 'custom' || e.kind === 'custom_message') {
    body = `<div class="meta">${esc(e.customType || '')}</div>`;
    const c = e.content || (e.data ? JSON.stringify(e.data) : '');
    if (c) body += `<details><summary>content</summary><pre>${esc(typeof c === 'string' ? c : JSON.stringify(c))}</pre></details>`;
  } else if (e.kind === 'session_meta') {
    body = `<div class="meta">cwd=${esc(e.cwd || '')} · cc=${esc(e.version || '')} · git=${esc(e.gitBranch || '')} · model=${esc(e.model || '')}${e.permissionMode ? ' · ' + esc(e.permissionMode) : ''}${e.synthesized ? ' · synthesized' : ''}</div>`;
    if (e.tools?.length) body += `<details><summary>tools (${e.tools.length})</summary><pre>${esc(e.tools.join('\n'))}</pre></details>`;
  } else if (e.kind === 'attachment_card') {
    body = `<div class="meta">subtype=${esc(e.subtype || '')}</div><details><summary>payload</summary><pre>${esc(JSON.stringify(e.payload || {}, null, 2).slice(0, 1200))}</pre></details>`;
  } else if (e.kind === 'error') {
    body = `<div class="head"><span class="errorBadge">ERROR</span>${e.severity ? ' · ' + esc(e.severity) : ''}${e.httpStatus ? ' · ' + e.httpStatus : ''}${e.retryAttempt != null ? ' · retry ' + e.retryAttempt : ''}</div><pre>${esc(e.errorMessage || '')}</pre>${e.cause ? `<div class="meta">cause: ${esc(e.cause)}</div>` : ''}`;
  } else if (e.kind === 'snapshot') {
    const files = (e.trackedFiles || []).map((f) => esc(f.path)).join('\n');
    body = `<div class="meta">tracked: ${(e.trackedFiles || []).length} files${e.messageId ? ' · msg=' + esc(e.messageId) : ''}</div><details><summary>paths</summary><pre>${files}</pre></details>`;
  } else if (e.kind === 'meta') {
    body = `<div class="meta">${esc(e.metaType || '')}</div><details><summary>payload</summary><pre>${esc(JSON.stringify(e.payload || {}, null, 2).slice(0, 800))}</pre></details>`;
  } else {
    body = `<pre>${esc(JSON.stringify(e, null, 2).slice(0, 600))}</pre>`;
  }
  // Slice F: sidechain flag + agentId badge on the entry head.
  const sidechainHtml = e.sidechain
    ? `<span class="sidechain-flag">subagent</span>${e.agentId ? ` <span class="agent-id">${esc(e.agentId)}</span>` : ''}`
    : '';
  return `<div class="entry kind-${esc(e.kind)} ${errish ? 'error' : ''}" data-id="${esc(e.id || '')}">
    <div class="head">
      <span class="kind ${e.kind}">${esc(e.kind)}</span>
      ${sidechainHtml}
      <span>${esc(e.id || '')}</span>
      <span>${fmtDate(e.timestamp)}</span>
    </div>
    ${body}
  </div>`;
}

function selectEntry(id, { scroll = false } = {}) {
  state.selectedEntryId = id;
  $$('.entry').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  $$('.tree-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  const e = state.currentDetail?.entries.find((x) => x.id === id);
  if (!e) return;
  renderInspector(e);
  if (scroll) {
    const target = $(`.entry[data-id="${CSS.escape(id)}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderInspector(e) {
  const kv = [];
  const add = (k, v) => kv.push(`<b>${esc(k)}</b><div>${typeof v === 'string' ? esc(v) : esc(JSON.stringify(v))}</div>`);
  add('kind', e.kind); add('id', e.id || ''); add('parentId', e.parentId || ''); add('timestamp', fmtDate(e.timestamp));
  if (e.kind === 'user') { add('chars', (e.text || '').length); add('tokens (chars)', e.tokens || 0); }
  if (e.kind === 'assistant') {
    add('model', e.model || ''); add('provider', e.provider || ''); add('api', e.api || '');
    add('stopReason', e.stopReason || ''); add('totalTokens', e.totalTokens || 0);
    add('cost', fmtCost(e.cost)); add('responseId', e.responseId || '');
    add('toolCalls', (e.toolCalls || []).length); add('thinkingChars', (e.thinking || '').length);
    add('textChars', (e.text || '').length);
  }
  if (e.kind === 'toolResult') { add('toolName', e.toolName || ''); add('toolCallId', e.toolCallId || ''); add('isError', !!e.isError); add('outputBytes', e.outputBytes || 0); add('truncated', !!e.truncated); }
  if (e.kind === 'bashExecution') { add('command', e.command || ''); add('exitCode', e.exitCode); add('cancelled', e.cancelled); add('truncated', e.truncated); add('outputBytes', e.outputBytes || 0); add('excludeFromContext', e.excludeFromContext); }
  if (e.kind === 'compaction') {
    add('tokensBefore', e.tokensBefore); add('tokensAfter', e.tokensAfter);
    add('trigger', e.trigger || ''); add('mechanism', e.mechanism || '');
    add('firstKeptEntryId', e.firstKeptEntryId || ''); add('fromHook', e.fromHook);
  }
  if (e.kind === 'model_change') { add('provider', e.provider || ''); add('modelId', e.modelId || ''); }
  if (e.kind === 'custom' || e.kind === 'custom_message') { add('customType', e.customType || ''); }
  // Slice F: per-kind inspector views for new cc kinds.
  if (e.kind === 'session_meta') {
    add('cwd', e.cwd || ''); add('version', e.version || ''); add('gitBranch', e.gitBranch || '');
    add('model', e.model || ''); add('permissionMode', e.permissionMode || '');
    add('tools', (e.tools || []).length); add('mcpServers', (e.mcpServers || []).length);
    add('synthesized', !!e.synthesized);
  }
  if (e.kind === 'attachment_card') { add('subtype', e.subtype || ''); }
  if (e.kind === 'error') {
    add('errorMessage', (e.errorMessage || '').slice(0, 200)); add('cause', e.cause || '');
    add('severity', e.severity || ''); add('httpStatus', e.httpStatus); add('retryAttempt', e.retryAttempt);
  }
  if (e.kind === 'snapshot') { add('messageId', e.messageId || ''); add('files', (e.trackedFiles || []).length); }
  if (e.kind === 'meta') { add('metaType', e.metaType || ''); }
  if (e.sidechain) { add('sidechain', true); add('agentId', e.agentId || ''); }
  if (e.source) add('source', e.source);
  $('#inspectorPane').innerHTML = `<div class="kv">${kv.join('')}</div>
    <details style="margin-top:.6rem;"><summary>raw JSON</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details>`;
}

function jumpToList(ids, dir) {
  if (!ids.length) return;
  const cur = state.selectedEntryId;
  const idx = ids.indexOf(cur);
  let next;
  if (idx === -1) next = ids[0];
  else next = ids[(idx + dir + ids.length) % ids.length];
  selectEntry(next, { scroll: true });
}

/* ---------------- Search ---------------- */
async function runSearch(q) {
  if (!q.trim()) return;
  showView('searchView');
  $('#searchTitle').innerHTML = `Searching for <b>${esc(q)}</b>…`;
  $('#searchResults').innerHTML = '';
  const t0 = performance.now();
  const data = await apiJson('/api/search?q=' + encodeURIComponent(q));
  const elapsed = performance.now() - t0;
  $('#searchStatus').textContent = `${data.results.length} hits · ${elapsed.toFixed(0)} ms`;
  $('#searchTitle').innerHTML = `Search <b>${esc(q)}</b> — ${data.results.length} hits in ${elapsed.toFixed(0)}ms`;
  $('#searchResults').innerHTML = data.results.length
    ? data.results.map((r) => `
      <div class="search-result" data-id="${esc(r.sessionId)}" data-entry="${esc(r.entryId || '')}">
        <div><b>${esc(r.firstPrompt || r.sessionId)}</b></div>
        <div class="meta">${esc(r.projectPath || '')} · ${esc(r.matchKind)} ${r.entryKind ? '· ' + esc(r.entryKind) : ''} ${r.toolName ? '· ' + esc(r.toolName) : ''}</div>
        <div class="snippet">${highlight(r.snippet || '', q)}</div>
      </div>`).join('')
    : '<div class="empty">No matches.</div>';
  $$('.search-result').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.id, entry = el.dataset.entry;
    openSession(id).then(() => entry && setTimeout(() => selectEntry(entry, { scroll: true }), 100));
  }));
}

/* ---------------- Init ---------------- */
async function loadGlobalStats() {
  try {
    const s = await apiJson('/api/stats');
    $('#topStats').innerHTML = `
      <span><b>${s.totalSessions}</b> sessions</span>
      <span><b>${s.totalEntries.toLocaleString()}</b> entries</span>
      <span><b>${(s.parseSuccessRate * 100).toFixed(1)}%</b> parsed</span>
      <span><b>${(s.totalCost || 0).toFixed(2)}</b> $ tracked</span>
    `;
    // H-1: populate source filter from observed sourceCounts so new adapters
    // (cc-workflow, future) appear automatically without HTML edits.
    const sel = document.getElementById('fSource');
    if (sel) {
      const current = sel.value;
      const counts = s.sourceCounts || {};
      const keys = Object.keys(counts).sort();
      sel.innerHTML = '<option value="">All</option>' + keys.map((k) =>
        `<option value="${k}">${k} (${counts[k]})</option>`
      ).join('');
      if (keys.includes(current)) sel.value = current;
    }
  } catch (err) { $('#topStats').textContent = 'stats error: ' + err.message; }
}

function bindUi() {
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(e.target.value);
  });
  const spt = $('#showParamsToggle');
  if (spt) {
    spt.checked = state.showParams;
    spt.addEventListener('change', () => {
      state.showParams = spt.checked;
      try { localStorage.setItem('lookback.showParams', state.showParams ? '1' : '0'); } catch {}
      if (state.currentDetail) {
        renderTree(state.currentDetail);
        renderTrace(state.currentDetail);
        if (state.selectedEntryId) selectEntry(state.selectedEntryId);
      }
    });
  }
  $('#initialInputBtn')?.addEventListener('click', () => {
    if (state.currentDetail?.summary?.id) openInitialInputModal(state.currentDetail.summary.id);
  });
  // Modal close (backdrop / × / Esc)
  $('#msgModal').addEventListener('click', (e) => {
    if (e.target.dataset.close === '1') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#msgModal').classList.contains('hidden')) closeModal();
  });
  $('#backBtn').addEventListener('click', () => { showView('library'); loadLibrary(); });
  $('#searchBackBtn').addEventListener('click', () => { showView('library'); });
  $('#sortSel').addEventListener('change', loadLibrary);
  for (const id of ['fSource','fErrors','fBranches','fCompactions','fSidechain']) {
    const el = $('#' + id);
    if (el) el.addEventListener('change', loadLibrary);
  }
  for (const id of ['fProject','fModel']) $('#'+id).addEventListener('input', debounce(loadLibrary, 200));
  $('#nextSignalBtn').addEventListener('click', () => jumpToList(state.signalEntryIds, 1));
  $('#prevSignalBtn').addEventListener('click', () => jumpToList(state.signalEntryIds, -1));
  $('#nextErrorBtn').addEventListener('click', () => jumpToList(state.errorEntryIds, 1));
  $('#prevErrorBtn').addEventListener('click', () => jumpToList(state.errorEntryIds, -1));
  document.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
  });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

(async function main() {
  bindUi();
  await loadGlobalStats();
  await loadLibrary();
})();
