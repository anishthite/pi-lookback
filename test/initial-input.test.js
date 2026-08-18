// Asserts that pi-lookback's initial-input reconstruction produces a
// systemPromptText that is BYTE-EXACT to what pi.buildSystemPrompt() would
// produce given the same inputs. This is the contract behind "reconstructs
// the initial system prompt exactly as pi does it using the function from pi".
//
// Strategy: synthesize a minimal ParsedSession with one user entry, ask
// buildInitialInput() for the reconstruction, then independently call
// pi.buildSystemPrompt() with the same loaders pi-lookback used. They must
// agree byte-for-byte.

'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { buildInitialInput } = require('../src/initial-input');

function findPiInstallRoot() {
  // Try a few common shapes. Node's bin dir -> ../lib/node_modules/... is
  // the reliable one for nvm/global npm installs. The which-pi shape is
  // brittle because the bin often symlinks straight into the package.
  const tries = [];
  const nodePrefix = path.dirname(path.dirname(process.execPath));
  tries.push(path.join(nodePrefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent'));
  try {
    const which = require('child_process').spawnSync('which', ['pi'], { encoding: 'utf8' });
    const piBin = (which.stdout || '').trim();
    if (piBin) {
      let real;
      try { real = fs.realpathSync(piBin); } catch { real = piBin; }
      let dir = path.dirname(real);
      for (let i = 0; i < 8; i++) {
        const pj = path.join(dir, 'package.json');
        if (fs.existsSync(pj)) {
          try {
            const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
            if (j && j.name === '@earendil-works/pi-coding-agent') { tries.push(dir); break; }
          } catch { /* keep walking */ }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch { /* fall through */ }
  for (const c of tries) if (fs.existsSync(path.join(c, 'dist', 'index.js'))) return c;
  return null;
}

async function main() {
  const piRoot = findPiInstallRoot();
  if (!piRoot) {
    console.log('skip: pi install not found on PATH');
    process.exit(0);
  }
  const idx = await import(pathToFileURL(path.join(piRoot, 'dist', 'index.js')).href);
  const sp  = await import(pathToFileURL(path.join(piRoot, 'dist', 'core', 'system-prompt.js')).href);
  const pi = { ...idx, buildSystemPrompt: sp.buildSystemPrompt };

  const cwd = process.cwd();
  const parsed = {
    source: 'pi',
    sessionMeta: { cwd },
    entries: [
      { kind: 'user', id: 'u1', text: 'hello' },
    ],
  };
  const result = await buildInitialInput(parsed);

  if (!result) throw new Error('buildInitialInput returned null');
  if (result.renderedSource !== 'pi-buildSystemPrompt') {
    throw new Error(`expected renderedSource=pi-buildSystemPrompt, got ${result.renderedSource}`);
  }

  // Independently call pi with the SAME loader inputs and compare.
  const agentDir = pi.getAgentDir();
  const contextFiles = pi.loadProjectContextFiles({ cwd, agentDir });
  const skills = pi.loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills;
  const piRendered = pi.buildSystemPrompt({
    cwd,
    selectedTools: ['read', 'bash', 'edit', 'write'],
    toolSnippets: {
      read:  'Read file contents',
      bash:  'Execute bash commands (ls, grep, find, etc.)',
      edit:  'Make precise file edits with exact text replacement, including multiple disjoint edits in one call',
      write: 'Create or overwrite files',
    },
    contextFiles,
    skills,
  });

  if (result.rendered.systemPromptText !== piRendered) {
    const a = result.rendered.systemPromptText;
    const b = piRendered;
    let firstDiff = 0;
    while (firstDiff < a.length && firstDiff < b.length && a[firstDiff] === b[firstDiff]) firstDiff++;
    console.error(`MISMATCH at offset ${firstDiff}/${Math.max(a.length, b.length)}`);
    console.error('lookback:', JSON.stringify(a.slice(Math.max(0, firstDiff - 40), firstDiff + 40)));
    console.error('pi:      ', JSON.stringify(b.slice(Math.max(0, firstDiff - 40), firstDiff + 40)));
    throw new Error('systemPromptText does not match pi.buildSystemPrompt() output');
  }

  // Also verify the labeled sections concatenate back to the same string.
  const recombined = result.rendered.systemPromptSections.map((s) => s.text).join('');
  if (recombined !== piRendered) {
    throw new Error(`labeled sections recombined (${recombined.length} chars) != pi output (${piRendered.length} chars)`);
  }

  console.log(`ok: byte-exact match (${piRendered.length} chars, ${result.rendered.systemPromptSections.length} labeled sections)`);
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
