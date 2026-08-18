// Standalone HTML export of a single session.
// Self-contained: includes inline CSS, no external assets.
// Slice F (plan §1.1, §2.2): adds session_meta / attachment_card / error /
// snapshot / meta kinds and a source + sidechain header.

'use strict';

// per review-security.md S-8: include the apostrophe in the escape map so
// any string interpolated into an HTML attribute context can't break out.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtCost(n) { return typeof n === 'number' ? `$${n.toFixed(4)}` : '—'; }
function fmtTokens(n) { return typeof n === 'number' ? n.toLocaleString() : '—'; }
function fmtDate(s) { return s ? new Date(s).toLocaleString() : ''; }

function renderEntry(e) {
  const sidechainBadge = e.sidechain
    ? `<span class="sidechain-flag">subagent</span>${e.agentId ? ` <span class="agent-id">${esc(e.agentId)}</span>` : ''}`
    : '';
  const head = `<div class="kind kind-${e.kind}">${esc(e.kind)}</div>${sidechainBadge}<div class="meta">${esc(e.id || '')} ${fmtDate(e.timestamp)}</div>`;
  let body = '';
  if (e.kind === 'user') body = `<pre class="text">${esc(e.text || '')}</pre>`;
  else if (e.kind === 'assistant') {
    body += e.thinking ? `<details><summary>thinking</summary><pre>${esc(e.thinking)}</pre></details>` : '';
    body += e.text ? `<pre class="text">${esc(e.text)}</pre>` : '';
    if (e.toolCalls?.length) {
      body += '<div class="toolcalls">' + e.toolCalls.map((tc) =>
        `<details><summary>tool ${esc(tc.name)} <code>${esc(tc.id || '')}</code></summary><pre>${esc(JSON.stringify(tc.arguments, null, 2))}</pre></details>`
      ).join('') + '</div>';
    }
    const usage = e.usage ? ` · ${fmtTokens(e.totalTokens)} tok · ${fmtCost(e.cost)}` : '';
    body += `<div class="model">${esc(e.model || '')}${usage}</div>`;
  } else if (e.kind === 'toolResult') {
    body = `<div class="meta">tool=${esc(e.toolName || '')} ${e.isError ? '<span class="err">ERROR</span>' : ''}</div><pre class="text">${esc(e.text || '')}</pre>`;
  } else if (e.kind === 'bashExecution') {
    body = `<pre class="cmd">$ ${esc(e.command)}</pre><div class="meta">exit ${e.exitCode}${e.truncated ? ' truncated' : ''}${e.cancelled ? ' cancelled' : ''}</div><pre class="text">${esc(e.output || '')}</pre>`;
  } else if (e.kind === 'compaction') {
    body = `<div class="meta">tokens before: ${e.tokensBefore}${e.tokensAfter != null ? ` · after: ${e.tokensAfter}` : ''}${e.mechanism ? ` · ${esc(e.mechanism)}` : ''}${e.trigger ? ` · ${esc(e.trigger)}` : ''}</div><pre class="text">${esc(e.summary || '')}</pre>`;
  } else if (e.kind === 'model_change') {
    body = `<div class="meta">${esc(e.provider || '')}/${esc(e.modelId || '')}</div>`;
  } else if (e.kind === 'thinking_level_change') {
    body = `<div class="meta">level=${esc(e.thinkingLevel || '')}</div>`;
  } else if (e.kind === 'custom' || e.kind === 'custom_message') {
    body = `<div class="meta">${esc(e.customType || '')}</div>`;
    if (e.content) body += `<details><summary>content</summary><pre>${esc(typeof e.content === 'string' ? e.content : JSON.stringify(e.content))}</pre></details>`;
  } else if (e.kind === 'session_meta') {
    body = `<div class="meta">cwd=${esc(e.cwd || '')} · cc=${esc(e.version || '')} · git=${esc(e.gitBranch || '')} · model=${esc(e.model || '')}${e.permissionMode ? ' · ' + esc(e.permissionMode) : ''}${e.synthesized ? ' · synthesized' : ''}</div>`;
    if (e.tools?.length) body += `<details><summary>tools (${e.tools.length})</summary><pre>${esc(e.tools.join('\n'))}</pre></details>`;
  } else if (e.kind === 'attachment_card') {
    body = `<div class="meta">subtype=${esc(e.subtype || '')}</div><details><summary>payload</summary><pre>${esc(JSON.stringify(e.payload || {}, null, 2).slice(0, 1200))}</pre></details>`;
  } else if (e.kind === 'error') {
    body = `<div class="meta"><span class="err">ERROR</span>${e.severity ? ' · ' + esc(e.severity) : ''}${e.httpStatus ? ' · ' + e.httpStatus : ''}${e.retryAttempt != null ? ' · retry ' + e.retryAttempt : ''}</div><pre class="text">${esc(e.errorMessage || '')}</pre>${e.cause ? `<div class="meta">cause: ${esc(e.cause)}</div>` : ''}`;
  } else if (e.kind === 'snapshot') {
    const files = (e.trackedFiles || []).map((f) => esc(f.path)).join('\n');
    body = `<div class="meta">tracked: ${(e.trackedFiles || []).length} files${e.messageId ? ' · msg=' + esc(e.messageId) : ''}</div><details><summary>paths</summary><pre>${files}</pre></details>`;
  } else if (e.kind === 'meta') {
    body = `<div class="meta">${esc(e.metaType || '')}</div><details><summary>payload</summary><pre>${esc(JSON.stringify(e.payload || {}, null, 2).slice(0, 800))}</pre></details>`;
  } else {
    body = `<pre class="text">${esc(JSON.stringify(e, null, 2).slice(0, 800))}</pre>`;
  }
  return `<div class="entry">${head}${body}</div>`;
}

function renderSessionHtml({ summary, entries, signals }) {
  const css = `
    body { font: 13px/1.45 -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 1rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 18px; margin: 0 0 .25rem; }
    .meta { color: #555; font-size: 12px; }
    .summary { background: #f6f6f6; padding: .6rem .8rem; border-radius: 4px; margin: .5rem 0 1rem; }
    .entry { border: 1px solid #e0e0e0; border-radius: 4px; padding: .5rem .6rem; margin: .35rem 0; }
    .kind { display: inline-block; font-size: 11px; text-transform: uppercase; padding: 1px 6px; border-radius: 3px; background: #eee; color: #333; margin-right: 6px; }
    .kind-user { background: #dbeafe; color: #1e3a8a; }
    .kind-assistant { background: #ede9fe; color: #5b21b6; }
    .kind-toolResult { background: #f3f4f6; color: #374151; }
    .kind-bashExecution { background: #fef3c7; color: #92400e; }
    .kind-compaction { background: #cffafe; color: #155e75; }
    .kind-model_change { background: #fce7f3; color: #9d174d; }
    .kind-session_meta { background: #ecfeff; color: #0e7490; }
    .kind-attachment_card { background: #fdf4ff; color: #86198f; }
    .kind-error { background: #fee2e2; color: #b00020; }
    .kind-snapshot { background: #f1f5f9; color: #334155; }
    .kind-meta { background: #f5f5f4; color: #6b7280; }
    .sidechain-flag { display: inline-block; font-size: 10.5px; padding: 1px 6px; margin-left: .25rem; border-radius: 3px; background: #e0e7ff; color: #4338ca; font-weight: 600; text-transform: uppercase; }
    .agent-id { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #555; }
    pre { background: #fafafa; border: 1px solid #eee; padding: .4rem .55rem; border-radius: 3px; white-space: pre-wrap; word-break: break-word; font: 12px ui-monospace, Menlo, monospace; max-height: 400px; overflow: auto; }
    .err { color: #b00020; font-weight: 600; }
    .toolcalls details { margin-top: .3rem; }
    .model { color: #777; font-size: 11px; margin-top: .35rem; }
    .source-badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 3px; margin-left: .35rem; }
    .source-pi { background: #dbeafe; color: #1e3a8a; }
.source-claude-code { background: #fef3c7; color: #92400e; }
    .source-cc-workflow { background: #dcfce7; color: #166534; }
  `;
  const signalsHtml = signals?.length
    ? `<div class="meta">Signals: ${signals.map((s) => esc(s.kind)).join(', ')}</div>`
    : '';
  const sourceBadge = summary.source
    ? `<span class="source-badge source-${esc(summary.source)}">${esc(summary.source)}</span>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(summary.firstPrompt || summary.id)}</title><style>${css}</style></head><body>
<h1>${esc(summary.firstPrompt?.slice(0,160) || summary.id)} ${sourceBadge}</h1>
<div class="summary">
  <div><b>Session</b> ${esc(summary.id)} · ${esc(summary.projectPath)} · ${fmtDate(summary.startedAt)}</div>
  <div class="meta">${summary.entryCount} entries · ${summary.assistantMessageCount} assistant · ${summary.toolCallCount} tool calls · ${summary.failedToolCallCount} failed · ${fmtTokens(summary.totalTokens)} tokens · ${fmtCost(summary.totalCost)} · ${summary.branchCount} branches · ${summary.compactionCount} compactions${summary.sidechainCount ? ` · ${summary.sidechainCount} subagent` : ''}</div>
  ${signalsHtml}
</div>
${entries.map(renderEntry).join('\n')}
</body></html>`;
}

module.exports = { renderSessionHtml };
