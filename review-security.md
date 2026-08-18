# Security + Read-Only Invariant Review — Claude Code Source Adapter

Scope: `src/sources/claude-code.js`, `src/sources/index.js`, `src/scanner.js`, `src/api.js`, `src/parser.js`, `src/export-html.js`, `server.js`, `public/app.js`.

TL;DR: M9 read-only invariant holds structurally — there is **zero** filesystem write API surface anywhere in the new adapter or any code it touches. The empirical 50/50 result is consistent with the static evidence. Findings are concentrated in (a) DoS via unbounded reads/parses, (b) one HTTP header-injection nit on the export filename, and (c) a few minor render/sniff tightening notes. No blockers.

---

## Read-only enforcement (M9 — structural verification)

**Correct — invariant holds structurally.**

- CITE: `grep -E "fs\.(write|append|utimes|chmod|unlink|rename|mkdir|symlink|link|rmdir)"` on `src/`, `server.js`, `public/` → **zero matches**.
- CITE: `grep -E "child_process|exec\(|spawn\("` → **zero matches**.
- CITE: `grep -E "createWriteStream|writeFile|appendFile"` → **zero matches**.
- The only fs APIs used anywhere are read-side: `readFileSync` (`src/sources/pi.js:71`, `src/sources/claude-code.js:107`), `openSync`+`readSync`+`closeSync` (`src/sources/index.js:38`), `readdirSync`, `statSync`/`existsSync`, and `createReadStream` (only against `PUBLIC_DIR`, `server.js:170`).
- `SUMMARY_CACHE` and `PARSED_CACHE` are pure in-process `Map`s (`src/api.js:18-20`); they are never serialized or persisted. No temp files are created during parse/stream.
- `discover()` (`claude-code.js:62-90`) uses `readdirSync(..., { withFileTypes: true })`, which returns lstat-shaped Dirents. **Symlinks under `~/.claude/projects/` are silently dropped**: a symlinked `evil.jsonl` → `/etc/passwd` has `e.isSymbolicLink() === true` and fails both `e.isDirectory()` and `e.isFile()`, so it is never queued or read. Good defense in depth.

Severity: **n/a (passes).** Worth pinning with a test that asserts `fs.writeSync`/`writeFileSync`/etc. are never required from the adapter module graph.

---

## DoS — unbounded reads and parses

### major — no max file size guard
- CITE: `src/sources/claude-code.js:107` `const text = fs.readFileSync(filePath, 'utf8')`. Same shape in `src/sources/pi.js:71`.
- EVIDENCE: A single multi-GB `.jsonl` under `~/.claude/projects/` will be loaded entirely into memory before parsing. There is no size precheck. `loadParsed`/`loadSummary` (`src/api.js:78-93, 130-141`) call this on every file enumerated by `discover()`, and `globalStats`/`listAllSummaries` iterate **all** sessions, so a single oversize file kills the server boot.
- FIX: In `parseFile`, `statSync(filePath).size`-gate before `readFileSync`. Suggested cap: 256 MB. On overflow, return `{ entries: [], parseErrors: [{line:0, reason:'file exceeds size cap'}], sessionMeta:null, ... }` so the row still renders in the library as an error tile.

### major — no max line length guard / per-entry size guards
- CITE: `claude-code.js:114-122` splits the entire file on `\n` and JSON-parses each line.
- EVIDENCE: A 2 GB single-line JSONL would `JSON.parse` a 2 GB string. Also, `text.split('\n')` allocates one array slot per line; combined with the above, that's two full copies of the file in RAM.
- FIX: After the size gate, walk the buffer with a streaming line splitter (`readline` over `createReadStream`) and skip/flag any line longer than e.g. 16 MB. As a secondary belt, when an entry is normalized, soft-cap `extractMessageContentText` output length (currently unbounded join, `claude-code.js:644-652`).

### major — search hay can concatenate arbitrarily large fields
- CITE: `src/api.js:240-258` `entrySearchHay()` concatenates full `e.text + e.thinking + e.output + e.command + e.summary + JSON.stringify(tc.arguments)`. The parsed entries used here are the full-fat ones from `loadParsed` — **not** the 4000/2000-char truncated copies that `getSessionDetail` returns (`src/api.js:179-194`).
- EVIDENCE: A session containing a 100 MB tool output (e.g. a giant Read result) makes every search query O(100 MB) per call, and one global concat happens per entry per file per search. Could be used to lock the server with one `q=x` request, and on a typical user corpus the latency cost is already non-trivial.
- FIX: Cap each field at e.g. 8 KB before concat in `entrySearchHay`. Or cache a lowercased hay per entry on first parse and reuse from `PARSED_CACHE`.

### minor — parseErrors array unbounded
- CITE: `claude-code.js:117-122` pushes one object per malformed line into `parseErrors`; same for `:558` (`tool_result references unknown tool_use_id`).
- EVIDENCE: A pathological all-garbage file with 10M lines produces a 10M-element array (each holding a 120-char preview). ~1 GB RAM.
- FIX: Cap at 1000 entries; track an overflow count.

### minor — `fs.createReadStream` not destroyed on early client close
- CITE: `server.js:170` `fs.createReadStream(full).pipe(res)`.
- EVIDENCE: If the browser disconnects mid-flight, the stream is not destroyed → fd leak under repeated reload.
- FIX: `const s = fs.createReadStream(full); res.on('close', () => s.destroy()); s.pipe(res);`.

---

## Path traversal via project-key

### nit — `decodeProjectDir` synthesizes attacker-controlled cwd string
- CITE: `claude-code.js:99-103`. A subdirectory named `-..-..-etc-passwd` round-trips to `/../../etc/passwd`.
- EVIDENCE: Purely cosmetic; the decoded string is never fed to `fs`. It is rendered in the library via `esc()` in `public/app.js:81, 128, 144` → no HTML injection risk. Flagging only because it could mislead a user reading the library list.
- FIX: Optional — strip `..` segments in `decodeProjectDir` before returning.

### Correct — symlink ingestion blocked
- CITE: `claude-code.js:73-89`. As above, `withFileTypes: true` means symlinks are visible as `isSymbolicLink()` and excluded by `e.isFile()`. A malicious symlink under `~/.claude/projects/<key>/evil.jsonl → /etc/passwd` will be silently skipped. Verified.

---

## HTML render safety

### Correct — all interpolations route through `esc()`
- CITE: `public/app.js:17-19` defines `esc(s) = String(s ?? '').replace(/[&<>"]/g, …)`. Applied at every `${...}` site in template strings for `firstPrompt`, `projectPath`, `cwd`, `model`, `agentId`, `source`, `toolName`, `command`, `output`, `text`, `thinking`, `errorMessage`, `metaType`, `subtype`, `customType`, etc. Same shape in `src/export-html.js`.
- Attachment cards, meta payloads, and tool-call arguments are rendered via `esc(JSON.stringify(...))` (`app.js:373, 397, 401, 413`; `export-html.js:39, 57, 61, 67, 73`). The objects are stringified then escaped — no raw object goes into innerHTML.
- The `sidechain-flag` agentId badge is escaped (`app.js:431`, `export-html.js:18`). Model strings are escaped (`app.js:357`). The source name appears in a class attribute as `source-${esc(s.source)}`; `esc` blocks `"` so the attribute cannot break out. Good.

### nit — esc does not escape single-quote
- CITE: `public/app.js:18`, `src/export-html.js:9`.
- EVIDENCE: All template literals use double-quoted attributes, so `'` cannot break out. Future regression risk if anyone writes `<x attr='${esc(x)}'>`. Cheap to harden.
- FIX: Add `"'": "&#39;"` to the replacement map.

### nit — `JSON.stringify(...).slice(N)` can split UTF-16 surrogates
- CITE: `app.js:397, 413`; `export-html.js:57, 73`.
- EVIDENCE: Cosmetic — would yield a stray replacement char in the inspector. No security impact.

### nit — assistant model field is rendered without registry check
- The schema explicitly notes "model can change mid-session"; an arbitrary `m.model` string flows into the timeline and library badges. It is `esc()`d, so safe. Flagged only as a reminder.

---

## HTTP-level findings

### minor — `content-disposition` filename built from raw `q.id`
- CITE: `server.js:159-163`
  ```
  res.writeHead(200, { ..., 'content-disposition': `attachment; filename="${q.id}.html"` });
  ```
- EVIDENCE: Node 18+ rejects `\r`/`\n` in header values (so CRLF injection throws rather than escapes), but `q.id` can still contain `"`, `;`, `/`, or non-ASCII bytes that confuse the downloaded filename. `q.id` is user-controlled (URL query) and `api.getSessionDetail(q.id)` was already happy if it matched any session id.
- FIX: Sanitize to `[A-Za-z0-9._-]` for the disposition filename, or use the canonical `detail.summary.id` (the resolved session id) rather than echoing back the query param:
  ```js
  const safe = String(detail.summary.id).replace(/[^A-Za-z0-9._-]/g, '_');
  res.writeHead(200, { ..., 'content-disposition': `attachment; filename="${safe}.html"` });
  ```

### Correct — `?source=` is a pure equality filter
- CITE: `server.js:139`, `src/api.js`. `q.source` flows into `(s) => s.source === q.source` only; never used as path, never used as a key lookup. `?source=__proto__` does nothing.

### Correct — static file path traversal blocked
- CITE: `server.js:147-152`. `path.normalize(path.join(PUBLIC_DIR, rel))` + `startsWith(PUBLIC_DIR)` correctly defeats `/..%2Fetc%2Fpasswd`.

### Correct — server binds 127.0.0.1 by default
- CITE: `server.js:25`. `PI_LOOKBACK_HOST` env can override; documenting in README would be wise so users don't accidentally bind 0.0.0.0.

---

## CLI / env

### Correct — no shell invocation
- `--source`, `--pi-sessions`, `--claude-sessions`, `--sessions`, `PI_SESSIONS_DIR`, `CLAUDE_SESSIONS_DIR` flow into `setSessionsRoots(roots)` → `adapter.discover(root)` → `fs.readdirSync`/`fs.readFileSync`. No `exec`/`spawn` anywhere.
- `discover` is null/missing-tolerant (`!root || !fs.existsSync(root) → return []`, `claude-code.js:64`). A bogus `--claude-sessions /nope` produces an empty source rather than an error. Worth a startup warning, but safe.

### nit — `--source` value not validated against registry
- CITE: `server.js:30-50, 70-78`. Unknown `--source foo` is silently treated as "neither pi nor claude-code" because the branches `=== 'pi'` and `=== 'claude-code'` both fail-through to "leave defaults".
- FIX: After parse, validate `opts.source` against `listSources()` and reject with a clear error message.

---

## Prototype pollution

### Correct — no `{ ...raw }` spreads
- CITE: `grep -E "\\.\\.\\.(raw|obj)"` on `src/` → no hits in adapter normalization. The adapter constructs entries by selective field extraction. `payload: raw` (`claude-code.js:497, 501`) stores a *reference*, but no merge happens.
- `JSON.parse` in V8 treats `"__proto__"` as an own property rather than as the prototype setter, so even the raw object cannot pollute Object.prototype via the parse step alone.

---

## Open handles

- `src/sources/index.js:36-48` `readFirstJsonLine` opens an fd, reads, and closes it in the success path; the catch closes if `fd != null`. Good.
- `parseFile` uses `readFileSync` (no fd to leak).
- `fs.createReadStream` in `server.js:170` — see minor finding above.

---

## Dependencies

### Correct — zero runtime/dev dependencies
- CITE: `package.json` has no `dependencies` and no `devDependencies` keys. Verified by `grep -n "dependencies" package.json` → no hits. Plan §1.1 invariant holds.

---

## Summary of recommended actions (in priority order)

1. **Add file-size + line-length guards in `parseSessionText` / `parseFile`** (major DoS hardening).
2. **Cap per-field length in `entrySearchHay`** (major; mitigates global search lock).
3. **Cap `parseErrors` array length** (minor).
4. **Sanitize export `content-disposition` filename** (minor).
5. **Validate `--source` against `listSources()`** (nit).
6. **Destroy createReadStream on res close** (nit).
7. **Add `'` to `esc()` replacement map** (nit, defense in depth).
8. **Optional: strip `..` from `decodeProjectDir` output** (cosmetic nit).

None of these touch the M9 read-only contract. The adapter is structurally sound against the sacred invariant — empirical 50/50 + structural absence of any write API in the module graph is robust evidence.
