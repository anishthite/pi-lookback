// Reconstruct an "initial request" view for a session.
//
// Why this exists: pi does NOT persist the rendered system prompt to JSONL
// sessions. The first request the model sees is roughly:
//
//   <pi base system prompt>
//   + <append-system-prompt> (CLI flag)
//   + <project_context> = AGENTS.md / CLAUDE.md collected by pi
//   + <available_skills> section listing SKILL.md files
//   + Current date / cwd footer
//   + first user message
//
// Only the last item lands in the JSONL. The rest is reconstructed here by
// **delegating to pi's own exports** (loaded via dynamic import from the
// installed pi package). The string returned by pi.buildSystemPrompt() is
// the canonical answer; the labeled-sections view exists for UX and is
// runtime-verified to concatenate back to that exact string.
//
// If pi isn't discoverable on disk we fall back to a hand-rolled assembly
// (the legacy v1 code) so the modal still renders.
//
// Hard tokens we DO know come from two logged events:
//   - custom { customType: 'stats_initial_prompt_estimate', data: {...} }
//   - first assistant usage: { cacheWrite, input, ... }
//
// Read-only. Never writes anything.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Bound any single embedded file content so we don't blow up the response.
const MAX_FILE_PREVIEW_BYTES = 32 * 1024;
const MAX_FILE_TOTAL_BYTES   = 512 * 1024;

// Default tool snippets pi ships with. Mirrors the `promptSnippet` field on
// each built-in tool definition under pi/dist/core/tools/*.js. We use these
// when re-assembling the system prompt; if the user disabled tools at the
// CLI we can't know that from the JSONL alone, so we render the default set.
const DEFAULT_TOOL_SNIPPETS = {
  read:  'Read file contents',
  bash:  'Execute bash commands (ls, grep, find, etc.)',
  edit:  'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
  write: 'Create or overwrite files',
  ls:    'List directory contents',
  grep:  'Search file contents for patterns (respects .gitignore)',
  find:  'Find files by glob pattern (respects .gitignore)',
};
const DEFAULT_SELECTED_TOOLS = ['read', 'bash', 'edit', 'write'];

/**
 * Build the initial-input breakdown for a parsed session.
 *
 * @param {object} parsed   ParsedSession from src/parser.js
 * @returns {Promise<object|null>}   structured breakdown, or null if no first user msg
 */
async function buildInitialInput(parsed) {
  if (!parsed || !Array.isArray(parsed.entries)) return null;
  const entries = parsed.entries;
  const source = parsed.source || 'pi';
  const sessionMeta = parsed.sessionMeta || null;
  const cwd = sessionMeta?.cwd || '';

  const firstUser = entries.find((e) => e.kind === 'user');
  if (!firstUser) return null;

  if (source === 'claude-code') {
    return buildInitialInputClaudeCode(parsed, firstUser);
  }

  // cc-workflow sessions have no "initial input" concept; the synthetic
  // first user entry is just a label. Skip reconstruction entirely.
  if (source === 'cc-workflow') return null;

  // Preferred path: delegate to pi's own exports for a byte-exact match.
  const pi = await loadPi();
  if (pi) {
    try {
      return await buildInitialInputViaPi(parsed, firstUser, pi);
    } catch (err) {
      // Fall through to legacy assembly with a warning note.
      return buildInitialInputLegacy(parsed, firstUser, {
        piLoadError: `pi delegation failed: ${err && err.message ? err.message : String(err)}`,
      });
    }
  }

  return buildInitialInputLegacy(parsed, firstUser, {
    piLoadError: 'pi install not discoverable; falling back to hand-rolled reconstruction',
  });
}

/**
 * Legacy hand-rolled path. Kept for the case where pi can't be dynamically
 * imported (no install on PATH, broken symlinks, etc.). Same shape as the
 * pi-delegated path so the UI is identical.
 */
function buildInitialInputLegacy(parsed, firstUser, opts) {
  const entries = parsed.entries;
  const source = parsed.source || 'pi';
  const sessionMeta = parsed.sessionMeta || null;
  const cwd = sessionMeta?.cwd || '';
  const firstAssistant = entries.find((e) => e.kind === 'assistant');
  const statsCustom = entries.find(
    (e) => e.kind === 'custom' && e.customType === 'stats_initial_prompt_estimate'
  );

  // Extension fingerprints — guessed from customType values present anywhere
  // in the session. Useful because extensions inject sizable content into the
  // system prompt that the user usually forgot they installed.
  const customTypes = new Set();
  for (const e of entries) {
    if (e.kind === 'custom' || e.kind === 'custom_message') {
      if (e.customType) customTypes.add(e.customType);
    }
  }
  const extensionHints = inferExtensions(customTypes);

  const composition = [];
  let totalEmbedded = 0;

  // 1) Pi base system prompt — read from the installed pi package source.
  composition.push(piBaseSystemPromptItem());

  // 2) AGENTS.md / CLAUDE.md context files pi would have loaded.
  //    pi looks in cwd + parents + home dirs. We approximate.
  for (const item of contextFileCandidates(cwd)) {
    const got = readWithCap(item.path, totalEmbedded);
    totalEmbedded = got.runningTotal;
    composition.push({
      kind: 'context-file',
      role: 'project-instructions',
      path: item.path,
      origin: item.origin,
      exists: got.exists,
      size: got.size,
      truncated: got.truncated,
      content: got.content,
    });
  }

  // 3) Skills pi would have surfaced (SKILL.md files under skill roots).
  for (const item of skillsCandidates(cwd)) {
    const got = readWithCap(item.path, totalEmbedded);
    totalEmbedded = got.runningTotal;
    composition.push({
      kind: 'skill',
      role: 'available-skill',
      path: item.path,
      name: item.name,
      origin: item.origin,
      exists: got.exists,
      size: got.size,
      truncated: got.truncated,
      content: got.content,
    });
  }

  // 4) Extension fingerprints — what we *inferred* injected into the prompt.
  for (const ext of extensionHints) {
    composition.push({ kind: 'extension', name: ext.name, evidence: ext.evidence });
  }

  // 5) The first user message itself — full text, no truncation cap.
  composition.push({
    kind: 'first-user-message',
    role: 'user',
    text: firstUser.text || '',
    chars: (firstUser.text || '').length,
  });

  const tokens = {
    // From stats_initial_prompt_estimate (logged by pi when available).
    estimate: statsCustom?.data || null,
    // From the first assistant turn's usage record — this is the ground truth
    // for what was actually billed on the first request.
    firstAssistantUsage: firstAssistant?.usage || null,
    firstAssistantModel: firstAssistant?.model || null,
    firstAssistantProvider: firstAssistant?.provider || null,
  };

  // Build the actual rendered system prompt the same way pi does, with each
  // section labeled. This is the substantive answer to "what was sent":
  // sections concatenated equal the prompt that buildSystemPrompt() in pi's
  // installed source would produce given today's AGENTS.md / SKILL.md files.
  const rendered = renderLabeledSystemPrompt({
    cwd,
    contextFiles: composition
      .filter((c) => c.kind === 'context-file' && c.exists)
      .map((c) => ({ path: c.path, content: c.content, origin: c.origin })),
    skills: composition
      .filter((c) => c.kind === 'skill' && c.exists)
      .map((c) => ({
        path: c.path, name: c.name, origin: c.origin,
        frontmatter: parseSkillFrontmatter(c.content || ''),
      }))
      .filter((s) => !s.frontmatter.disableModelInvocation),
    firstUserText: firstUser.text || '',
  });

  const notes = [
    'pi does not persist the exact rendered system prompt in JSONL sessions.',
    'Fallback (hand-rolled) reconstruction: pi install was not discoverable, so the sections below come from a local re-implementation of pi/dist/core/system-prompt.js rather than from pi itself.',
    'CLI overrides (--system-prompt, --append-system-prompt, --tools, --no-skills, etc.) are NOT visible in the JSONL, so the reconstruction assumes pi defaults.',
    'The cacheWrite token count on the first assistant turn is the ground-truth size of what actually went over the wire.',
  ];
  if (opts && opts.piLoadError) notes.unshift(`(${opts.piLoadError})`);

  return {
    source,
    cwd,
    firstUserId: firstUser.id || null,
    firstUserText: firstUser.text || '',
    firstUserChars: (firstUser.text || '').length,
    firstAssistantId: firstAssistant?.id || null,
    tokens,
    composition,
    rendered,
    notes,
    renderedSource: 'legacy-fallback',
  };
}

// --------------------------------------------------------------------------
// pi-delegated path --- the preferred reconstruction.
//
// Uses pi's exported functions so the rendered string is byte-identical to
// what pi itself would produce given the same cwd + agentDir.
// --------------------------------------------------------------------------

// Map pi-defaults selectedTools -> promptSnippet, sourced from
// pi/dist/core/tools/<tool>.js. Kept here (rather than pulled from pi's tool
// registry) because the tool registry requires constructing tool definitions
// with real cwd/operations; for a read-only prompt reconstruction we only
// need the snippet strings, which are stable per pi version.
const PI_DEFAULT_TOOL_SNIPPETS = {
  read:  'Read file contents',
  bash:  'Execute bash commands (ls, grep, find, etc.)',
  edit:  'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
  write: 'Create or overwrite files',
  ls:    'List directory contents',
  grep:  'Search file contents for patterns (respects .gitignore)',
  find:  'Find files by glob pattern (respects .gitignore)',
};
const PI_DEFAULT_SELECTED_TOOLS = ['read', 'bash', 'edit', 'write'];

let _piModulePromise = null;

/**
 * Resolve and dynamic-import pi's ESM bundle. Returns null if pi can't be
 * located (no install on PATH, missing dist/, etc.) so callers can fall back.
 * Cached after first call.
 */
async function loadPi() {
  if (_piModulePromise) return _piModulePromise;
  _piModulePromise = (async () => {
    for (const root of candidatePiInstallDirs()) {
      const indexEntry = path.join(root, 'dist', 'index.js');
      const sysPromptEntry = path.join(root, 'dist', 'core', 'system-prompt.js');
      if (!safeStat(indexEntry) || !safeStat(sysPromptEntry)) continue;
      try {
        // pi's index.js re-exports loaders + skill helpers, but does NOT
        // re-export buildSystemPrompt --- that one lives at
        // ./core/system-prompt.js. Import both and merge into one object.
        const idx = await import(pathToFileURL(indexEntry).href);
        const sp  = await import(pathToFileURL(sysPromptEntry).href);
        const mod = {
          buildSystemPrompt: sp.buildSystemPrompt,
          loadProjectContextFiles: idx.loadProjectContextFiles,
          loadSkills: idx.loadSkills,
          formatSkillsForPrompt: idx.formatSkillsForPrompt,
          getAgentDir: idx.getAgentDir,
        };
        if (typeof mod.buildSystemPrompt === 'function' &&
            typeof mod.loadProjectContextFiles === 'function' &&
            typeof mod.loadSkills === 'function' &&
            typeof mod.formatSkillsForPrompt === 'function' &&
            typeof mod.getAgentDir === 'function') {
          return { mod, installRoot: root };
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  })();
  return _piModulePromise;
}

/**
 * pi-delegated reconstruction. Produces:
 *   - composition: same shape the legacy path returns (for UI parity)
 *   - rendered.systemPromptText: EXACTLY pi.buildSystemPrompt(opts)
 *   - rendered.systemPromptSections: labeled sections whose concatenation
 *     equals systemPromptText (asserted at runtime; mismatch -> exception so
 *     the caller falls back to the legacy path with a warning)
 */
async function buildInitialInputViaPi(parsed, firstUser, piLoaded) {
  const { mod: pi, installRoot } = piLoaded;
  const entries = parsed.entries;
  const source = parsed.source || 'pi';
  const sessionMeta = parsed.sessionMeta || null;
  const cwd = sessionMeta?.cwd || '';
  const firstAssistant = entries.find((e) => e.kind === 'assistant');
  const statsCustom = entries.find(
    (e) => e.kind === 'custom' && e.customType === 'stats_initial_prompt_estimate'
  );

  const customTypes = new Set();
  for (const e of entries) {
    if (e.kind === 'custom' || e.kind === 'custom_message') {
      if (e.customType) customTypes.add(e.customType);
    }
  }
  const extensionHints = inferExtensions(customTypes);

  const agentDir = pi.getAgentDir();

  // pi's own loaders. These are the same calls pi makes during startup.
  const contextFiles = pi.loadProjectContextFiles({ cwd: cwd || process.cwd(), agentDir });
  const skillsResult = pi.loadSkills({
    cwd: cwd || process.cwd(),
    agentDir,
    skillPaths: [],
    includeDefaults: true,
  });
  const skills = Array.isArray(skillsResult?.skills) ? skillsResult.skills : [];

  const buildOpts = {
    cwd: cwd || process.cwd(),
    selectedTools: PI_DEFAULT_SELECTED_TOOLS,
    toolSnippets: PI_DEFAULT_TOOL_SNIPPETS,
    contextFiles,
    skills,
  };
  const systemPromptText = pi.buildSystemPrompt(buildOpts);

  // Composition view (one item per logical input pi consumed).
  const composition = [];
  let totalEmbedded = 0;
  composition.push(piBaseSystemPromptItem());
  for (const cf of contextFiles) {
    const size = Buffer.byteLength(cf.content || '', 'utf8');
    const cap = Math.min(MAX_FILE_PREVIEW_BYTES, Math.max(0, MAX_FILE_TOTAL_BYTES - totalEmbedded));
    const truncated = size > cap;
    const content = truncated ? Buffer.from(cf.content || '', 'utf8').slice(0, cap).toString('utf8') : (cf.content || '');
    totalEmbedded += Math.min(size, cap);
    composition.push({
      kind: 'context-file',
      role: 'project-instructions',
      path: cf.path,
      origin: 'pi.loadProjectContextFiles',
      exists: true,
      size,
      truncated,
      content,
    });
  }
  for (const sk of skills) {
    const got = readWithCap(sk.filePath, totalEmbedded);
    totalEmbedded = got.runningTotal;
    composition.push({
      kind: 'skill',
      role: 'available-skill',
      path: sk.filePath,
      name: sk.name,
      origin: 'pi.loadSkills',
      exists: got.exists,
      size: got.size,
      truncated: got.truncated,
      content: got.content,
      disableModelInvocation: !!sk.disableModelInvocation,
    });
  }
  for (const ext of extensionHints) {
    composition.push({ kind: 'extension', name: ext.name, evidence: ext.evidence });
  }
  composition.push({
    kind: 'first-user-message',
    role: 'user',
    text: firstUser.text || '',
    chars: (firstUser.text || '').length,
  });

  // Build labeled sections that concatenate to systemPromptText.
  // We re-create pi's structure (header / context_block / skills_block /
  // footer) and then assert byte-equality. If pi's template ever changes in
  // a way we don't track, the assertion fires and the caller falls back.
  const sections = buildLabeledSectionsFromPiOutput({
    systemPromptText,
    cwd: buildOpts.cwd,
    contextFiles,
    skills,
    selectedTools: PI_DEFAULT_SELECTED_TOOLS,
    formatSkillsForPrompt: pi.formatSkillsForPrompt,
    installRoot,
  });
  const recombined = sections.map((s) => s.text).join('');
  if (recombined !== systemPromptText) {
    // Surface the mismatch in a way buildInitialInput's catch handler picks up.
    const expectedLen = systemPromptText.length;
    const gotLen = recombined.length;
    throw new Error(`labeled-sections recombination drifted from pi.buildSystemPrompt (${gotLen} vs ${expectedLen} chars)`);
  }

  return {
    source,
    cwd,
    firstUserId: firstUser.id || null,
    firstUserText: firstUser.text || '',
    firstUserChars: (firstUser.text || '').length,
    firstAssistantId: firstAssistant?.id || null,
    tokens: {
      estimate: statsCustom?.data || null,
      firstAssistantUsage: firstAssistant?.usage || null,
      firstAssistantModel: firstAssistant?.model || null,
      firstAssistantProvider: firstAssistant?.provider || null,
    },
    composition,
    rendered: {
      systemPromptSections: sections,
      systemPromptText,
      systemPromptChars: systemPromptText.length,
      firstUserMessage: { label: 'first user message', origin: 'session JSONL', text: firstUser.text || '' },
    },
    notes: [
      'Rendered system prompt below is BYTE-EXACT to what pi.buildSystemPrompt() produces (pi was loaded via dynamic import from ' + installRoot + ').',
      'pi does not persist the rendered prompt in JSONL; the inputs (AGENTS.md, SKILL.md, cwd) are read from disk RIGHT NOW, so file contents may differ from session time.',
      'CLI overrides (--system-prompt, --append-system-prompt, --tools, --no-skills, custom tool/extension snippets) are NOT visible in the JSONL, so the reconstruction assumes pi defaults.',
      'The cacheWrite token count on the first assistant turn is the ground-truth size of what actually went over the wire.',
    ],
    renderedSource: 'pi-buildSystemPrompt',
    piInstallRoot: installRoot,
  };
}

/**
 * Slice the pi-rendered string into labeled sections (for the UI's
 * "which file contributed which substring" view) without rebuilding pi's
 * template by hand. Strategy: locate the known anchor substrings inside
 * the pi output and use them as splits. Each split is tagged with the
 * source file/origin we know contributed it.
 */
function buildLabeledSectionsFromPiOutput(args) {
  const { systemPromptText, cwd, contextFiles, skills, formatSkillsForPrompt } = args;
  const sections = [];
  let cursor = 0;
  const push = (label, origin, end) => {
    if (end <= cursor) return;
    sections.push({ label, origin, text: systemPromptText.slice(cursor, end) });
    cursor = end;
  };

  // 1) Header through project_context (exclusive). pi always emits the same
  //    "<project_context>" opener if any context files exist; otherwise the
  //    next anchor is formatSkillsForPrompt(skills) (which always starts
  //    with "\n\nThe following skills..."); otherwise the date footer.
  const ctxOpen = '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n';
  const skillsBlock = (skills && skills.length > 0) ? formatSkillsForPrompt(skills) : '';
  const dateAnchor = '\nCurrent date: ';

  // index of project_context block (if any).
  const ctxIdx = contextFiles.length > 0 ? systemPromptText.indexOf(ctxOpen) : -1;
  // index of skills block (if any). formatSkillsForPrompt result includes the
  // "\n\nThe following skills..." preamble; find by full prefix match.
  const skillsIdx = skillsBlock ? systemPromptText.indexOf(skillsBlock) : -1;
  const dateIdx = systemPromptText.indexOf(dateAnchor);

  // base block ends at whichever comes first: ctx, skills, or date.
  const candidates = [ctxIdx, skillsIdx, dateIdx].filter((i) => i >= 0);
  const baseEnd = candidates.length > 0 ? Math.min(...candidates) : systemPromptText.length;
  push('base / header+tools+guidelines+pi-docs',
    'pi.buildSystemPrompt (header through pi-docs paragraph)',
    baseEnd);

  // 2) project_context block, with one section per file.
  if (ctxIdx >= 0) {
    push('project_context / open',
      'pi.buildSystemPrompt',
      ctxIdx + ctxOpen.length);
    for (const cf of contextFiles) {
      const piece = `<project_instructions path="${cf.path}">\n${cf.content}\n</project_instructions>\n\n`;
      const at = systemPromptText.indexOf(piece, cursor);
      if (at < 0) {
        // Drift between cf.content and what pi rendered; lump remainder as
        // a single unknown context section so we don't lose bytes.
        const nextAnchor = skillsIdx >= 0 ? skillsIdx : (dateIdx >= 0 ? dateIdx : systemPromptText.length);
        push('project_instructions (unsplit)', cf.path, nextAnchor);
        break;
      }
      push(`project_instructions (${pathTail(cf.path)})`,
        'pi.loadProjectContextFiles · ' + cf.path,
        at + piece.length);
    }
    const close = '</project_context>\n';
    const closeAt = systemPromptText.indexOf(close, cursor);
    if (closeAt >= 0) push('project_context / close', 'pi.buildSystemPrompt', closeAt + close.length);
  }

  // 3) skills block. Emit the preamble as one section and each <skill>...</skill>
  //    as its own section so the UI can highlight per-skill provenance.
  if (skillsIdx >= 0 && skillsBlock) {
    // Preamble: everything up to (and including) the <available_skills> tag.
    const preambleEnd = skillsBlock.indexOf('<available_skills>\n');
    if (preambleEnd >= 0) {
      push('skills / preamble',
        'pi.formatSkillsForPrompt',
        skillsIdx + preambleEnd + '<available_skills>\n'.length);
    }
    // Each skill <skill>...</skill>\n
    for (const sk of skills) {
      if (sk.disableModelInvocation) continue;
      const block =
        '  <skill>\n' +
        `    <name>${escXmlPi(sk.name)}</name>\n` +
        `    <description>${escXmlPi(sk.description)}</description>\n` +
        `    <location>${escXmlPi(sk.filePath)}</location>\n` +
        '  </skill>\n';
      const at = systemPromptText.indexOf(block, cursor);
      if (at < 0) continue;
      push(`skill (${sk.name})`,
        'pi.loadSkills · ' + sk.filePath,
        at + block.length);
    }
    // closing </available_skills> with no trailing newline (pi joins with \n).
    const closeAt = systemPromptText.indexOf('</available_skills>', cursor);
    if (closeAt >= 0) push('skills / close', 'pi.formatSkillsForPrompt', closeAt + '</available_skills>'.length);
  }

  // 4) footer (\nCurrent date: ...\nCurrent working directory: ...).
  if (dateIdx >= 0) {
    push('footer / date+cwd', 'pi.buildSystemPrompt (rebuilt each request)', systemPromptText.length);
  } else if (cursor < systemPromptText.length) {
    // Catch-all so we never silently drop bytes.
    push('tail / unclassified', 'pi.buildSystemPrompt', systemPromptText.length);
  }
  return sections;
}

function escXmlPi(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// --------------------------------------------------------------------------
// Labeled assembly --- mirrors pi/dist/core/system-prompt.js buildSystemPrompt
// exactly so the concatenation of section.text equals the string pi would have
// produced. Each section carries a {label, origin, text} so the UI can
// highlight which file/feature contributed which substring.
// --------------------------------------------------------------------------

function renderLabeledSystemPrompt({ cwd, contextFiles, skills, firstUserText }) {
  const piInstall = candidatePiInstallDirs()[0] || '';
  const readmePath   = piInstall ? path.join(piInstall, 'README.md') : '(pi README.md)';
  const docsPath     = piInstall ? path.join(piInstall, 'docs') : '(pi docs/)';
  const examplesPath = piInstall ? path.join(piInstall, 'examples') : '(pi examples/)';

  // Tool list section (pi-defaults; CLI may have changed this).
  const visibleTools = DEFAULT_SELECTED_TOOLS.filter((n) => !!DEFAULT_TOOL_SNIPPETS[n]);
  const toolsList = visibleTools.length
    ? visibleTools.map((n) => `- ${n}: ${DEFAULT_TOOL_SNIPPETS[n]}`).join('\n')
    : '(none)';

  // Guidelines section --- pi always appends these two; extensions can add
  // more via promptGuidelines but we can't read those from JSONL.
  const guidelines = [
    '- Be concise in your responses',
    '- Show file paths clearly when working with files',
  ].join('\n');

  // Date + cwd footer is computed at request time. We use the current date
  // here, NOT the session date, because pi rebuilds the prompt each request.
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const promptCwd = (cwd || '').replace(/\\/g, '/');

  const sections = [];
  const push = (label, origin, text) => sections.push({ label, origin, text });

  // 1. Header + tools + guidelines + pi-doc paragraph (pi's hardcoded base).
  push(
    'base / header',
    'pi/dist/core/system-prompt.js · buildSystemPrompt (header)',
    'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n'
  );
  push('base / tools list', 'pi defaults + tool promptSnippet', toolsList + '\n');
  push(
    'base / extra-tools disclaimer',
    'pi/dist/core/system-prompt.js (hardcoded)',
    '\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n'
  );
  push('base / guidelines', 'pi defaults + extension promptGuidelines (CLI-time)', guidelines + '\n');
  push(
    'base / pi-docs paragraph',
    'pi/dist/core/system-prompt.js (hardcoded, uses installed pi paths)',
    '\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n' +
    `- Main documentation: ${readmePath}\n` +
    `- Additional docs: ${docsPath}\n` +
    `- Examples: ${examplesPath} (extensions, custom tools, SDK)\n` +
    '- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory\n' +
    '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)\n' +
    '- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing\n' +
    '- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)'
  );

  // 2. <project_context> block --- one <project_instructions> per AGENTS.md.
  if (contextFiles.length > 0) {
    push('project_context / open',
      'pi system-prompt.js (lines 102-105)',
      '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n');
    for (const cf of contextFiles) {
      push(`project_instructions (${pathTail(cf.path)})`,
        `${cf.origin || ''} · ${cf.path}`,
        `<project_instructions path="${cf.path}">\n${cf.content}\n</project_instructions>\n\n`);
    }
    push('project_context / close', 'pi system-prompt.js', '</project_context>\n');
  }

  // 3. <available_skills> block --- one <skill> per SKILL.md frontmatter.
  if (skills.length > 0) {
    push('skills / preamble',
      'pi/dist/core/skills.js · formatSkillsForPrompt',
      "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n");
    for (const sk of skills) {
      const name = String(sk.frontmatter.name || sk.name || '');
      const desc = String(sk.frontmatter.description || '');
      push(`skill (${name})`,
        `${sk.origin || ''} · ${sk.path} · name+description+location only (body NOT injected; model loads via read tool on demand)`,
        '  <skill>\n' +
        `    <name>${escXml(name)}</name>\n` +
        `    <description>${escXml(desc)}</description>\n` +
        `    <location>${escXml(sk.path)}</location>\n` +
        '  </skill>\n');
    }
    push('skills / close', 'pi/dist/core/skills.js', '</available_skills>');
  }

  // 4. Date + cwd footer.
  push('footer / date+cwd',
    'pi system-prompt.js (rebuilt each request)',
    `\nCurrent date: ${date}\nCurrent working directory: ${promptCwd}`);

  const systemPromptText = sections.map((s) => s.text).join('');

  // 5. User message --- not part of the system prompt, but is what arrives
  // as the first user turn. Surfaced for completeness.
  return {
    systemPromptSections: sections,
    systemPromptText,
    systemPromptChars: systemPromptText.length,
    firstUserMessage: { label: 'first user message', origin: 'session JSONL', text: firstUserText || '' },
  };
}

function pathTail(p) { const parts = String(p).split('/'); return parts.slice(-2).join('/'); }

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Minimal SKILL.md frontmatter parser: extracts the keys pi actually reads
// (name, description, disableModelInvocation). Avoids pulling in a full YAML
// dependency; SKILL.md frontmatter is always flat key:value.
function parseSkillFrontmatter(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const body = text.slice(4, end);
  const out = {};
  let curKey = null;
  let curVal = [];
  const flush = () => { if (curKey) out[curKey] = curVal.join('\n').trim(); curKey = null; curVal = []; };
  for (const raw of body.split('\n')) {
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (m && !raw.startsWith(' ')) {
      flush();
      curKey = m[1];
      curVal = [stripQuotes(m[2])];
    } else if (curKey) {
      curVal.push(raw.replace(/^\s+/, ''));
    }
  }
  flush();
  if (typeof out.disableModelInvocation === 'string') {
    out.disableModelInvocation = out.disableModelInvocation.toLowerCase() === 'true';
  }
  return out;
}
function stripQuotes(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// --------------------------------------------------------------------------

function piBaseSystemPromptItem() {
  // Best effort: locate pi's installed system-prompt.js so the user can see
  // the exact template that produces the base prompt. We don't execute it.
  const candidates = candidatePiInstallDirs();
  for (const root of candidates) {
    const p = path.join(root, 'dist', 'core', 'system-prompt.js');
    if (safeStat(p)) {
      return {
        kind: 'base-system-prompt',
        role: 'pi-builtin',
        path: p,
        note: 'pi base system prompt template — buildSystemPrompt() in this file produces the prompt sent before AGENTS.md / skills are appended.',
        exists: true,
      };
    }
  }
  return {
    kind: 'base-system-prompt',
    role: 'pi-builtin',
    path: '(pi install not found on $PATH or in common npm globals)',
    exists: false,
    note: 'pi base system prompt — installed pi package not located; see https://www.npmjs.com/package/@earendil-works/pi-coding-agent for source.',
  };
}

function candidatePiInstallDirs() {
  const out = [];
  const push = (p) => { if (p) out.push(p); };
  // 1) Resolve from PATH: `which pi` -> the bin script. The bin is often a
  //    symlink that points directly INTO the published package (e.g.
  //    .nvm/.../bin/pi -> .nvm/.../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js)
  //    rather than to a sibling under .../bin/. Handle both shapes.
  try {
    const which = require('child_process').spawnSync('which', ['pi'], { encoding: 'utf8' });
    const piBin = (which.stdout || '').trim();
    if (piBin) {
      let real;
      try { real = fs.realpathSync(piBin); } catch { real = piBin; }

      // Shape A: realpath lands INSIDE the published package. Walk up until
      // we find a package.json whose name is @earendil-works/pi-coding-agent.
      let dir = path.dirname(real);
      for (let i = 0; i < 8; i++) {
        const pj = path.join(dir, 'package.json');
        if (safeStat(pj)) {
          try {
            const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
            if (j && j.name === '@earendil-works/pi-coding-agent') {
              push(dir);
              break;
            }
          } catch { /* keep walking */ }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }

      // Shape B: realpath sits under the npm prefix's bin/, so the package
      // lives at prefix/lib/node_modules/... or prefix/node_modules/....
      const bin = path.dirname(real);
      const prefix = path.dirname(bin);
      push(path.join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
      push(path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent'));
    }
  } catch { /* fall through */ }
  // 2) NPM globals near current node binary.
  push(path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
  return [...new Set(out)];
}

// --------------------------------------------------------------------------

/**
 * Files pi treats as project_context (AGENTS.md / CLAUDE.md), walking from
 * cwd up toward `/` and into common home dirs. Order matters: the UI lists
 * them in walk-order so the user can see precedence.
 */
function contextFileCandidates(cwd) {
  const names = ['AGENTS.md', 'CLAUDE.md'];
  const out = [];
  const seen = new Set();
  const push = (p, origin) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ path: abs, origin });
  };

  if (cwd) {
    let dir = cwd;
    let safety = 20;
    while (safety-- > 0) {
      for (const n of names) push(path.join(dir, n), `walk:${dir}`);
      const parent = path.dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
  }
  const home = os.homedir();
  // pi only reads its own agent dir (~/.pi/agent). It does NOT read
  // ~/.claude, ~/.codex, or ~/.gemini even if those exist as symlinks to
  // the same file --- those locations are for other agent tools and would
  // not have been loaded into the prompt. See pi/dist/core/resource-loader.js
  // loadProjectContextFiles(): only walks cwd-ancestors + agentDir.
  push(path.join(home, '.pi', 'agent', 'AGENTS.md'), 'home:.pi/agent');
  push(path.join(home, '.pi', 'agent', 'CLAUDE.md'), 'home:.pi/agent');

  // Dedupe symlinks so the same underlying inode doesn't appear twice.
  // pi.loadProjectContextFiles dedupes by string path, but it also only
  // reads from agentDir + cwd-walk so this only matters for the legacy
  // fallback. We use realpath-dedupe here to be conservative.
  const realSeen = new Set();
  const deduped = [];
  for (const it of out) {
    if (!safeStat(it.path)) continue;
    let real;
    try { real = fs.realpathSync(it.path); } catch { real = it.path; }
    if (realSeen.has(real)) continue;
    realSeen.add(real);
    deduped.push(it);
  }
  return deduped;
}

/**
 * SKILL.md files pi would have surfaced. We look in the standard skill roots.
 * Caps: at most 60 skills returned so the response stays small.
 */
function skillsCandidates(cwd) {
  const home = os.homedir();
  const roots = [
    { dir: path.join(home, '.pi', 'agent', 'skills'), origin: 'home:.pi/agent/skills' },
    { dir: path.join(home, '.agents', 'skills'), origin: 'home:.agents/skills' },
  ];
  // npm-installed pi-subagents / context-mode / pi-web-access ship skills too.
  for (const piRoot of candidatePiInstallDirs()) {
    roots.push({ dir: path.join(piRoot, '..', '..', 'pi-subagents', 'skills'), origin: 'npm:pi-subagents/skills' });
    roots.push({ dir: path.join(piRoot, '..', '..', 'context-mode', 'skills'), origin: 'npm:context-mode/skills' });
    roots.push({ dir: path.join(piRoot, '..', '..', 'pi-web-access', 'skills'), origin: 'npm:pi-web-access/skills' });
    roots.push({ dir: path.join(piRoot, '..', '..', 'pi-autoresearch', 'skills'), origin: 'npm:pi-autoresearch/skills' });
  }
  if (cwd) roots.push({ dir: path.join(cwd, '.pi', 'skills'), origin: 'cwd:.pi/skills' });

  const out = [];
  const MAX = 60;
  for (const { dir, origin } of roots) {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of names) {
      if (!ent.isDirectory()) continue;
      const skillFile = path.join(dir, ent.name, 'SKILL.md');
      if (!safeStat(skillFile)) continue;
      out.push({ path: skillFile, name: ent.name, origin });
      if (out.length >= MAX) return out;
    }
  }
  return out;
}

// --------------------------------------------------------------------------

function inferExtensions(customTypes) {
  const hints = [];
  const hasAny = (prefixes) => prefixes.some((p) =>
    [...customTypes].some((t) => t.startsWith(p)));
  if (hasAny(['context-prune', 'stats_initial_prompt_estimate'])) {
    hints.push({
      name: 'context-mode',
      evidence: 'session contains context-prune-* / stats_initial_prompt_estimate custom events',
    });
  }
  if (hasAny(['subagent-'])) {
    hints.push({ name: 'pi-subagents', evidence: 'session contains subagent-* custom events' });
  }
  return hints;
}

// --------------------------------------------------------------------------

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function readWithCap(p, runningTotal) {
  const st = safeStat(p);
  if (!st || !st.isFile()) {
    return { exists: false, size: 0, content: '', truncated: false, runningTotal };
  }
  const remaining = MAX_FILE_TOTAL_BYTES - runningTotal;
  if (remaining <= 0) {
    return { exists: true, size: st.size, content: '', truncated: true, runningTotal };
  }
  const cap = Math.min(MAX_FILE_PREVIEW_BYTES, remaining);
  let buf;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      buf = Buffer.alloc(Math.min(cap, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally { fs.closeSync(fd); }
  } catch {
    return { exists: true, size: st.size, content: '', truncated: false, runningTotal };
  }
  const content = buf.toString('utf8');
  const truncated = st.size > buf.length;
  return {
    exists: true,
    size: st.size,
    content,
    truncated,
    runningTotal: runningTotal + buf.length,
  };
}

// --------------------------------------------------------------------------
// Claude Code variant. Unlike pi, Claude Code DOES log injected context into
// the JSONL itself — as `attachment` entries with subtypes:
//   - nested_memory          → full CLAUDE.md / AGENTS.md content (snapshot)
//   - skill_listing          → names+descriptions of available skills
//   - mcp_instructions_delta → full MCP-tool instruction blocks
//   - deferred_tools_delta   → names of late-loaded tools
//   - task_reminder          → reminder content
//   - command_permissions    → allowed-command rules
//   - date_change            → a "today is X" reminder
// We build the labeled-sections view directly from those payloads — ground
// truth from the session, not reconstructed from disk.
// --------------------------------------------------------------------------
function buildInitialInputClaudeCode(parsed, firstUser) {
  const entries = parsed.entries;
  const sessionMeta = parsed.sessionMeta || null;
  const cwd = sessionMeta?.cwd || firstUser.cwd || '';

  // Claude Code logs a meta `system_meta` / `session_meta` entry per session
  // with model, gitBranch, cwd, permissionMode — surface that as context too.
  const sessionMetaEntry = entries.find((e) => e.kind === 'session_meta');
  const firstAssistant = entries.find((e) => e.kind === 'assistant');

  // Collect every attachment whose timestamp is at or before the first
  // assistant turn (i.e. that was injected on the initial request). If we
  // have no first assistant yet, accept all attachments in the file.
  const firstAsstTs = firstAssistant?.timestamp ? Date.parse(firstAssistant.timestamp) : Infinity;
  const initialAttachments = entries.filter((e) => {
    if (e.kind !== 'attachment_card') return false;
    const t = e.timestamp ? Date.parse(e.timestamp) : 0;
    return t <= firstAsstTs;
  });

  const sections = [];
  const push = (label, origin, text) => sections.push({ label, origin, text });

  // 1) Note that the base CC system prompt itself is not logged.
  push(
    'base / claude-code system prompt',
    'NOT logged in JSONL (lives in the Claude Code binary as a hardcoded template)',
    '[Claude Code does not persist its base system prompt. The blocks below ARE persisted and were inlined into the initial request as attachments.]'
  );

  if (sessionMetaEntry) {
    push(
      'session_meta',
      'JSONL session_meta entry',
      JSON.stringify({
        cwd: sessionMetaEntry.cwd,
        gitBranch: sessionMetaEntry.gitBranch,
        model: sessionMetaEntry.model,
        permissionMode: sessionMetaEntry.permissionMode,
        toolsAvailable: (sessionMetaEntry.tools || []).length,
        mcpServers: (sessionMetaEntry.mcpServers || []).length,
      }, null, 2)
    );
  }

  for (const att of initialAttachments) {
    const sub = att.subtype || 'unknown';
    const p = att.payload || {};
    const ts = att.timestamp || '';
    if (sub === 'nested_memory') {
      // The single most important block: a CLAUDE.md / AGENTS.md snapshot
      // captured at session time.
      const memPath = p.path || p.content?.path || '(unknown)';
      const memType = p.content?.type || '';
      const text = typeof p.content === 'string' ? p.content : (p.content?.content || '');
      const differs = p.content?.contentDiffersFromDisk;
      push(
        `nested_memory · ${memType || 'memory'} · ${pathTail(memPath)}`,
        `JSONL attachment · ${memPath}${differs ? ' · differsFromDisk=true' : ''} · ${ts}`,
        text
      );
    } else if (sub === 'skill_listing') {
      push('skill_listing', `JSONL attachment · ${ts}`, String(p.content || ''));
    } else if (sub === 'mcp_instructions_delta') {
      const blocks = Array.isArray(p.addedBlocks) ? p.addedBlocks : [];
      const names = Array.isArray(p.addedNames) ? p.addedNames.join(', ') : '';
      push(
        `mcp_instructions_delta (${names || 'mcp'})`,
        `JSONL attachment · ${ts}`,
        blocks.join('\n\n---\n\n')
      );
    } else if (sub === 'deferred_tools_delta') {
      const names = Array.isArray(p.addedNames) ? p.addedNames : [];
      push(
        `deferred_tools_delta (${names.length} tools)`,
        `JSONL attachment · ${ts}`,
        names.join('\n')
      );
    } else if (sub === 'task_reminder') {
      const content = p.content;
      const text = Array.isArray(content) ? JSON.stringify(content, null, 2) : String(content || '');
      push(`task_reminder (itemCount=${p.itemCount ?? '?'})`, `JSONL attachment · ${ts}`, text);
    } else if (sub === 'command_permissions') {
      push('command_permissions', `JSONL attachment · ${ts}`, JSON.stringify(p, null, 2));
    } else if (sub === 'date_change') {
      push('date_change', `JSONL attachment · ${ts}`, JSON.stringify(p, null, 2));
    } else {
      push(`attachment (${sub})`, `JSONL attachment · ${ts}`, JSON.stringify(p, null, 2));
    }
  }

  // Composition view (the disk-reading section for context-files/skills) is
  // less useful for CC because the JSONL ALREADY contains the snapshots. We
  // still surface the first-user-message as a composition item for parity.
  const composition = [
    {
      kind: 'base-system-prompt',
      role: 'claude-code-builtin',
      path: '(claude-code binary)',
      exists: false,
      note: 'Claude Code base system prompt is not logged in JSONL. The nested_memory + skill_listing + mcp_instructions_delta attachments below ARE logged and represent what was actually inlined.',
    },
    ...initialAttachments.map((att) => ({
      kind: 'cc-attachment',
      subtype: att.subtype,
      origin: 'session JSONL',
      timestamp: att.timestamp,
      bytes: JSON.stringify(att.payload || {}).length,
    })),
    {
      kind: 'first-user-message',
      role: 'user',
      text: firstUser.text || '',
      chars: (firstUser.text || '').length,
    },
  ];

  // Token-cost block: CC stores usage on assistant turns; sum cache-creation
  // tokens on the FIRST assistant turn as the ground-truth initial-input cost.
  const usage = firstAssistant?.usage || null;

  const systemPromptText = sections.map((s) => s.text).join('\n\n');
  return {
    source: 'claude-code',
    cwd,
    firstUserId: firstUser.id || null,
    firstUserText: firstUser.text || '',
    firstUserChars: (firstUser.text || '').length,
    firstAssistantId: firstAssistant?.id || null,
    tokens: {
      estimate: null,
      firstAssistantUsage: usage,
      firstAssistantModel: firstAssistant?.model || null,
      firstAssistantProvider: firstAssistant?.provider || null,
    },
    composition,
    rendered: {
      systemPromptSections: sections,
      systemPromptText,
      systemPromptChars: systemPromptText.length,
      firstUserMessage: { label: 'first user message', origin: 'session JSONL', text: firstUser.text || '' },
    },
    notes: [
      'Unlike pi, Claude Code DOES log injected context into the JSONL as `attachment` entries. The sections below are the EXACT bytes captured at session time.',
      'The base Claude Code system prompt itself (“You are Claude Code…”) is NOT logged — it lives hardcoded in the Claude Code binary.',
      'nested_memory.contentDiffersFromDisk=true means the disk file changed after the session ran; the snapshot here is still the version that was actually sent.',
    ],
  };
}

module.exports = { buildInitialInput };
