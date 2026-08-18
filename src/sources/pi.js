// pi source adapter.
//
// Implements the source-adapter contract (plan §1.2) for pi-agent JSONL
// sessions stored under ~/.pi/agent/sessions/. This module owns the pi
// JSONL normalization logic that previously lived in src/parser.js — moved
// verbatim, no behavior change. See plans/2026-06-04-claude-code-adapter.md
// slice A.
//
// scout-findings.md §3 enumerates the field surface this adapter must
// produce; downstream code (summary.js, signals.js, export-html.js,
// public/app.js) reads those exact names.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ID = 'pi';
const DEFAULT_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');

// per review-security.md S-1 / S-2 / S-4: bounded-RAM parsing guards.
const MAX_FILE_BYTES = 256 * 1024 * 1024;   // 256 MB hard cap per .jsonl
const MAX_LINE_BYTES = 16 * 1024 * 1024;    // 16 MB hard cap per single line
const MAX_PARSE_ERRORS = 1000;              // suppress the rest with overflow marker

function defaultRoot() {
  return process.env.PI_SESSIONS_DIR || DEFAULT_ROOT;
}

/**
 * Walk a pi sessions root and yield one row per .jsonl file.
 * Returns plain objects (not a generator) so callers can spread freely.
 */
function discover(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push({ filePath: full, source: ID, projectKey: path.basename(path.dirname(full)) });
      }
    }
  }
  return out;
}

/** Decode pi's project-directory naming convention back to a real path. */
function decodeProjectDir(name) {
  // pi encodes "/" as "-" inside surrounding "--" delimiters.
  // Example: "--Users-anishthite-workspace-pi-lookback--" -> "/Users/anishthite/workspace/pi-lookback"
  if (typeof name !== 'string') return '';
  let s = name;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  return '/' + s.split('-').filter(Boolean).join('/');
}

/**
 * Recognize pi files by their session-header line.
 * Pi sessions begin with {"type":"session","version":...,"id":...}.
 */
function sniff(_filePath, firstLine) {
  return !!(firstLine && firstLine.type === 'session');
}

/** Read and parse a pi .jsonl file. Returns ParsedSession (plan §1.2). */
function parseFile(filePath) {
  // per review-security.md S-1: refuse oversized files before allocating.
  let st;
  try { st = fs.statSync(filePath); }
  catch (err) {
    return {
      entries: [], parseErrors: [{ line: 0, reason: `stat failed: ${err.message}`, preview: '' }],
      sessionMeta: null, filePath, source: ID,
    };
  }
  if (st.size > MAX_FILE_BYTES) {
    return {
      entries: [],
      parseErrors: [{
        line: 0,
        reason: `file exceeds ${MAX_FILE_BYTES} byte size cap (${st.size} bytes)`,
        preview: '',
      }],
      sessionMeta: null, filePath, source: ID,
    };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = parseSessionText(text, filePath);
  // Adapter contract: every ParsedSession carries source.
  parsed.source = ID;
  return parsed;
}

// ---------------------------------------------------------------------------
// Internal parsing — lifted verbatim from src/parser.js (slice A is a pure
// refactor; semantics MUST stay identical for pi sessions).
// ---------------------------------------------------------------------------

function parseSessionText(text, filePath) {
  // per review-security.md S-2 / S-4: indexOf-based line iteration to
  // avoid the split-array allocation; line/error caps to bound memory.
  const entries = [];
  const parseErrors = [];
  let parseErrorsOverflow = 0;
  const addError = (line, reason, preview) => {
    if (parseErrors.length < MAX_PARSE_ERRORS) parseErrors.push({ line, reason, preview });
    else parseErrorsOverflow++;
  };
  let sessionMeta = null;

  let start = 0;
  let lineNo = 0;
  const len = text.length;
  while (start <= len) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? len : nl;
    lineNo++;
    const lineLen = end - start;
    if (lineLen > MAX_LINE_BYTES) {
      addError(lineNo, `line exceeds ${MAX_LINE_BYTES} byte cap (${lineLen} bytes)`, '');
    } else if (lineLen > 0) {
      const ln = text.slice(start, end);
      if (ln.trim()) {
        let obj;
        try { obj = JSON.parse(ln); }
        catch (err) { addError(lineNo, err.message, ln.slice(0, 120)); obj = null; }
        if (obj) {
          if (obj.type === 'session') sessionMeta = obj;
          else entries.push(normalizeEntry(obj));
        }
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  if (parseErrorsOverflow > 0) {
    parseErrors.push({
      line: -1,
      reason: `parseErrors overflow; ${parseErrorsOverflow} additional errors suppressed`,
      preview: '',
    });
  }

  return { entries, parseErrors, sessionMeta, filePath };
}

/**
 * Map a raw pi JSONL object to a normalized trace entry.
 * Adds derived metadata that the UI/API rely on.
 */
function normalizeEntry(raw) {
  const base = {
    id: raw.id || null,
    parentId: raw.parentId ?? null,
    timestamp: raw.timestamp || null,
    raw,
    source: ID,
    sidechain: false,
  };

  const t = raw.type;

  if (t === 'message') {
    const m = raw.message || {};
    const role = m.role;
    if (role === 'user') {
      return { ...base, kind: 'user', text: extractText(m.content), tokens: textLength(m.content), promptType: 'user' };
    }
    if (role === 'assistant') {
      const { text, thinking, toolCalls } = decomposeAssistantContent(m.content);
      return {
        ...base,
        kind: 'assistant',
        text,
        thinking,
        toolCalls,
        model: m.model || null,
        provider: m.provider || null,
        api: m.api || null,
        usage: m.usage || null,
        cost: m.usage?.cost?.total ?? null,
        totalTokens: m.usage?.totalTokens ?? null,
        stopReason: m.stopReason || null,
        responseId: m.responseId || null,
        messageId: null,
        shardOf: null,
      };
    }
    if (role === 'toolResult') {
      const { text, outputBytes } = extractToolResultText(m.content);
      return {
        ...base,
        kind: 'toolResult',
        toolCallId: m.toolCallId || null,
        toolName: m.toolName || null,
        isError: !!m.isError,
        text,
        outputBytes,
        details: m.details || null,
        fullOutputPath: m.fullOutputPath || null,
        truncated: !!m.truncated,
      };
    }
    if (role === 'bashExecution') {
      return {
        ...base,
        kind: 'bashExecution',
        command: m.command || '',
        output: m.output || '',
        outputBytes: typeof m.output === 'string' ? m.output.length : 0,
        exitCode: typeof m.exitCode === 'number' ? m.exitCode : null,
        cancelled: !!m.cancelled,
        truncated: !!m.truncated,
        fullOutputPath: m.fullOutputPath || null,
        excludeFromContext: !!m.excludeFromContext,
      };
    }
    // Unknown message role — still normalize gracefully
    return { ...base, kind: 'message_unknown', role: role || 'unknown' };
  }

  if (t === 'compaction') {
    return {
      ...base,
      kind: 'compaction',
      summary: raw.summary || '',
      firstKeptEntryId: raw.firstKeptEntryId || null,
      tokensBefore: raw.tokensBefore ?? null,
      tokensAfter: null,
      trigger: null,
      mechanism: 'pi-native',
      fromHook: !!raw.fromHook,
      details: raw.details || null,
    };
  }
  if (t === 'branch_summary') {
    return {
      ...base,
      kind: 'branch_summary',
      fromId: raw.fromId || null,
      summary: raw.summary || '',
      details: raw.details || null,
    };
  }
  if (t === 'model_change') {
    return {
      ...base,
      kind: 'model_change',
      provider: raw.provider || null,
      modelId: raw.modelId || null,
    };
  }
  if (t === 'thinking_level_change') {
    return {
      ...base,
      kind: 'thinking_level_change',
      thinkingLevel: raw.thinkingLevel || null,
    };
  }
  if (t === 'custom') {
    return {
      ...base,
      kind: 'custom',
      customType: raw.customType || null,
      data: raw.data || null,
    };
  }
  if (t === 'custom_message') {
    return {
      ...base,
      kind: 'custom_message',
      customType: raw.customType || null,
      content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content || ''),
      display: raw.display !== false,
      details: raw.details || null,
    };
  }
  if (t === 'label') {
    return {
      ...base,
      kind: 'label',
      label: raw.label || raw.name || '',
    };
  }
  // Unknown entry type — graceful fallback for forward compatibility.
  return { ...base, kind: 'unknown', type: t || 'no-type' };
}

function decomposeAssistantContent(content) {
  let text = '';
  let thinking = '';
  const toolCalls = [];
  if (!Array.isArray(content)) return { text, thinking, toolCalls };
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') text += (text ? '\n' : '') + (part.text || '');
    else if (part.type === 'thinking') thinking += (thinking ? '\n' : '') + (part.thinking || '');
    else if (part.type === 'toolCall') {
      toolCalls.push({
        id: part.id || null,
        name: part.name || null,
        arguments: part.arguments ?? null,
      });
    }
  }
  return { text, thinking, toolCalls };
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && p.type === 'text' ? p.text || '' : ''))
    .filter(Boolean)
    .join('\n');
}

function textLength(content) {
  return extractText(content).length;
}

function extractToolResultText(content) {
  if (typeof content === 'string') return { text: content, outputBytes: content.length };
  if (!Array.isArray(content)) return { text: '', outputBytes: 0 };
  let text = '';
  let outputBytes = 0;
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text') {
      text += (text ? '\n' : '') + (p.text || '');
      outputBytes += (p.text || '').length;
    }
  }
  return { text, outputBytes };
}

module.exports = {
  id: ID,
  defaultRoot,
  discover,
  parseFile,
  decodeProjectDir,
  sniff,
  // Internal helpers exported for test/back-compat. Do not rely on these
  // from non-adapter code.
  normalizeEntry,
  parseSessionText,
};
