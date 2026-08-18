# Why pi prompt-caches sometimes show heavy writes and zero reads — final writeup

> Companion to the append-only lab notebook at
> `implementation-notes/2026-06-04-cache-bust-investigation.html` (entries D-1 … D-16, L-1 … L-19).
> Scope: diagnose-only + recommend fix; no harness code edited.

---

## TL;DR

In long pi tool-call streaks, the bad pattern (`cache_creation_input_tokens` climbs every turn, `cache_read_input_tokens` is pinned at the size of the static `system+tools` prefix and never grows) is **not** caused by the Anthropic 4-breakpoint cap, model swaps, TTL, or compaction. It is caused by **per-turn wire-time mutation of bytes that live inside the cached message history** — most reliably, the `<pruner-note>N unpruned tool call result(s)…</pruner-note>` counter that the `context-mode` / `pi-context-prune` extension re-stamps on every tool-result every turn. Once any byte inside the conversation prefix rotates per turn, Anthropic's prefix-cache only matches up to `system+tools`, the rest is rewritten on every turn, and you observe the "lots of cacheWrite, ~0 useful cacheRead" plateau.

Vanilla sessions (no extensions/skills/hooks) do not show this pattern in either the corpus (n=78) or live reproduction; they extend the cache linearly turn-over-turn with zero busts inside an invocation.

Combined with the 5-minute TTL eating multi-day resumed sessions, three stackable fixes (F2 quantize-or-relocate the rotating injection, F3 enable 1h-TTL beta on the static prefix, F1' keep historical message bytes stable) reduce ~80–85% of observed busts and recover an estimated $500–$2,700 of cache-write spend across the user's 377-session corpus.

---

## 1. What was actually measured

| metric | value |
| --- | --- |
| sessions analyzed | 377 |
| assistant turns with usage | ~12,000+ |
| cache-bust events (loose detector: `cacheRead_{n+1} < 0.5 × prefix_n` ∧ `prefix_n > 5000`) | 1,789 |
| cache-bust events (strict detector: `cacheRead_{n+1} < cacheRead_n − 1000`) | ~170 across top-10 |
| total lost cache tokens | 141.5 Mtok |
| equivalent re-write cost | $531 (Sonnet 3.5) … $2,654 (Opus 4) |
| same tokens if cached: read cost | $42 (12.5× cheaper) |

Detector and replication CLI: `tools/cache-bust-detector.js`, `tools/cache-bust-experiments.js`.

The loose detector over-counts (it flags any large cacheWrite even when the cached prefix is healthy), the strict detector flags only true monotone-cacheRead drops. **All four key findings below survive both definitions.**

---

## 2. Mechanism end-to-end

### 2.1 What pi sends on the wire

From `examples/extensions/custom-provider-anthropic/index.ts` (the reference Anthropic provider that ships with pi-coding-agent), every request carries **at most 3 `cache_control: {type:"ephemeral"}` markers**:

1. system prompt text block — always cache-controlled.
2. (OAuth only) the `"You are Claude Code…"` identity preamble — additionally cache-controlled.
3. the **last** user / tool-result content block — cache-controlled per turn; the marker hops forward with every new turn.

Anthropic's per-request cap is 4 markers, so pi never hits the cap. The hypothesis "busts come from running out of breakpoints" (originally H10 in the notebook) is **falsified** by direct source inspection (D-15 / L-19).

### 2.2 How Anthropic prefix-cache actually keys

Cache hit length = longest **byte-identical prefix** of `{system + tools + messages[]}` (canonicalised) that matches a previously-cached request, capped at the position of the most recent `cache_control` marker that lies inside that matching prefix. Markers define *where checkpoints are written*; they do not patch over byte differences.

So if any byte inside the cached message span changes, the cache hit collapses to the position **before** that byte. With pi's strategy, the only stable byte-prefix on the bad turn is `system+tools` — which is exactly the size at which `cacheRead` pins on plateau sessions.

### 2.3 What changes byte-for-byte every turn (the actual culprits)

The bad sessions overwhelmingly run extensions/hooks that re-stamp content onto historical messages at request-build time. Captured live in this very investigation (L-11 / L-17):

```
<pruner-note>N unpruned tool call result(s) currently in context.
Consider calling context_prune after a logical batch of 8–12 related tool calls.</pruner-note>
```

`N` was observed at 26, 27, 28, 29, 31, 33, …, 57 — incrementing every turn. It is appended to user/tool-result content on the wire by `pi-context-prune/src/reminder.ts :: annotateWithUnprunedCount`. **It does not appear in any of the 377 JSONL session files** (0 hits) because pi's session log records the canonical conversation, not the wire-augmented payload. This is direct proof of wire-side mutation that is invisible to anyone reading the session log alone.

Other suspects in the same class (any of these will reproduce the pattern, by the same mechanism):

- `<system-reminder>` blocks injected onto an old tool-result by hooks.
- env / cwd / git-status blocks re-stamped on a historical user message.
- `<active-skills>` or todo-state strings re-injected each turn.
- `intercom` messages threaded back through prior turns.
- skill / extension auto-injection of `SKILL.md` excerpts that aren't byte-stable.

All produce the same observable signature.

### 2.4 The good case

Vanilla sessions (`--no-extensions --no-skills --no-context-files --no-prompt-templates`) and well-behaved extension sessions both produce a textbook linear cache-extension trace inside a single invocation (E6, live):

```
t0: cacheRead=    0  cacheWrite=1,986    ← first turn writes the prefix
t1: cacheRead=1,986  cacheWrite=  298    ← reads back full prefix
t2: cacheRead=2,284  cacheWrite=  213
t3: cacheRead=2,497  cacheWrite=  226
t4: cacheRead=2,723  cacheWrite=  194
t5: cacheRead=2,917  cacheWrite=  150    ← cacheRead = sum of all prior cacheWrites
```

`cacheRead` is exactly the sum of every prior turn's `cacheWrite` — bytes are stable, marker hops forward, cache extends.

By contrast, extended treatment with hooks active produced (E6):

```
turn  cacheRead  cacheWrite
 0      12,537      14,676
 …
 5      12,537      25,039   ← BUST: pinned at static prefix
 6      12,537      26,930
 7      12,537      40,089
…
12      12,537      53,606
```

Pinned at 12,537 ≈ system+tools forever, with `cacheWrite` linear in growing conversation size = paying full re-write of the entire conversation every turn.

### 2.5 The other two contributing causes (smaller buckets)

- **5-minute TTL expiry** on the default `ephemeral` cache. Dominates multi-day resumed sessions (#4 bondu retention-policy, #5 chat-delete, #8 log-board). 26.9% of loose busts, ~17% by the counterfactual measurement at the 1h-TTL beta.
- **Compaction** rewriting prior history (≤1%) and **mid-session model swaps** (<1%) — real but tail effects.

### 2.6 Why cohort split is so stark

Cohort | n sessions | busts/turn | 95% CI
--- | --- | --- | ---
vanilla (custom=0) | 78 | 0.0551 | [0.0416, 0.0686]
extension (custom>0) | 190 | 0.1708 | [0.1398, 0.2018]

3.10× ratio, **non-overlapping confidence intervals**. Per-cohort attribution mix:

- vanilla: dominated by `idle_gt_ttl` (multi-day work) → matches TTL story.
- extension: dominated by `fast_silent_bust` (sub-30 s, no event in interlude) → matches wire-mutation story.

---

## 3. The code paths / conditions that cause it (specific, not hand-wavy)

| Where | What happens | Why it busts the cache |
| --- | --- | --- |
| `pi-context-prune/src/reminder.ts :: annotateWithUnprunedCount` (extension) | Walks last/all tool-result message(s) at request-build time and appends `<pruner-note>${N} unpruned…</pruner-note>` with `N` = current unpruned-tool-result count. | `N` increments every turn → byte-prefix diverges at the first such tool-result message → all bytes after that point are uncacheable. |
| Any extension that calls `mutateMessageContent` / `annotate*` on **historical** (not just last) messages at request-build time | Re-renders an old message's content with current state. | Same as above. |
| pi-coding-agent's per-turn system-prompt assembly (if any dynamic block is part of the cached system text block) | If `context.systemPrompt` includes a per-turn timestamp, todo state, or env snapshot **before** the `cache_control` marker on the system block. | Cache fails at `system` itself → `cacheRead` falls below even the "system+tools" plateau. (Not observed in this corpus; would look like pin-at-tools-only.) |
| `examples/extensions/custom-provider-anthropic/index.ts` (the reference provider) | Marks only the **last** content block of the last user message with `cache_control`. | Correct strategy w.r.t. marker count, but does nothing to defend against byte mutation upstream of that marker. The cache check is byte-prefix; markers don't paper over byte diffs. |
| Anthropic API default | `ephemeral` cache TTL = 5 minutes unless the `extended-cache-ttl-2025-04-11` beta is enabled and `ttl: "1h"` is set on the block. | Multi-day resumed sessions and long human pauses cross the 5-min boundary → forced re-write. |

---

## 4. Trigger conditions (when you will see it)

You will see the bad "lots of writes / no reads" pattern when **all** of these are true:

1. The session is using one or more extensions/hooks/skills that append per-turn-mutating content to messages (today, `pi-context-prune` is the proven offender; auditing other hooks is recommended).
2. The conversation is long enough that the dynamic injection lands somewhere inside the prefix that *would* be cached (in practice, ≥5–10 assistant turns with tool calls — onset median is turn 8, prefix ≈ 40 k tokens).
3. The injection's text differs across turns (rotating counter, current timestamp, current cwd/branch, current active-skills list, etc.).

You will see the **idle-only** subset of busts when:

1. The wall-clock gap between two consecutive assistant turns exceeds Anthropic's `ephemeral` TTL (default 5 min). 475 / 1789 busts in the corpus.

You will see compaction / model-swap / thinking-toggle busts at the tail (≤2% combined).

You will **not** see the plateau when:

- Running pi with `--no-extensions --no-skills --no-context-files --no-prompt-templates` (vanilla reproduction, 0 busts in E6).
- All on-the-wire dynamic content is appended *after* the most recent `cache_control` marker (i.e., outside the cached span entirely).

---

## 5. Recommended fix (concrete)

Ranked by upper-bound spend impact; stackable.

### F2 — Quantize or relocate every per-turn-mutating injection (~25% of busts, ~$130–$660)

**Owner: extension authors, starting with `pi-context-prune`.**

Pick one of:

- **Quantize the value** so consecutive turns produce identical bytes. Replace `${N} unpruned` with a log-2 bucket label like `at least 8 unpruned`, or a sentinel `some unpruned`. Bytes stop rotating → cache stops busting.
- **Move the injection past the last `cache_control` marker.** Make sure the dynamic text is appended as the **last** content block of the **last** user message, *after* (or *as*) the marker — so it's never inside the cached span. If the harness applies the marker to "the last content block", then the dynamic text becomes the marker-bearing block itself: it's still re-cached every turn, but it stops invalidating the historical prefix.
- **Emit once per session** at session start instead of every turn.

This is the highest-leverage fix because it sits at the source.

### F3 — Enable Anthropic's 1-hour TTL beta on the static prefix (~17% of busts, ~$90–$540)

**Owner: pi (or whoever owns the provider call).**

Add header `anthropic-beta: extended-cache-ttl-2025-04-11` and set `cache_control: { type: "ephemeral", ttl: "1h" }` on the **system** block specifically. Marginal write cost is ~2× a normal cache write; payback on first re-read after a 5-min idle gap. Counterfactual measurement (E3): 304 fewer busts, 28.4 Mtok saved, in the existing 377-session corpus.

### F1' — Keep historical message bytes stable across turns (revised; ~55% of busts, ~$290–$1,460)

**Owner: pi-coding-agent.**

(Note: the original F1 in the notebook said "pin 2 stable cache_control markers instead of 4 sliding". Source inspection (D-15) showed pi already only uses ≤3 markers. Marker count is not the lever. The actual lever is **what bytes go between them.**)

In the provider's `convertMessages` / request builder:

- Treat historical messages as **immutable** between turn N and turn N+1. Never re-render their text with current state.
- Any "system reminder" / state-update content that a hook wants to attach must be appended as a **new** content block on the *current* (last) user/tool-result message — never spliced into a prior one.
- Optionally expose an extension API contract: "extensions may modify the last message at build time; modifying any earlier message is a cache-bust and is rejected unless explicitly opted in."
- Optionally fold pruning into an append-only model: instead of editing a prior tool-result to insert a `<pruner-note>`, emit a fresh user message ("FYI: 17 unpruned…") and leave history untouched.

### F4 — Surface in pi-lookback (observability)

Add per-session columns: `cacheBusts`, `lostCacheTokens`, `plateauValue`, `cacheHealthBadge` (green/yellow/red based on plateau onset). Helps catch regressions when new extensions ship.

### F5 — Audit existing extensions

Run a simple wire-diff between two consecutive turns under each extension and flag any extension whose payload at message[k] (for k < last) differs across turns. `pi-context-prune` is one; the user runs others (`pi-subagents`, `context-mode` skills, custom intercom hooks) that warrant the same check.

---

## 6. Expected effect on cache hit rate

| Stack | Bust reduction (upper bound) | Token reduction | $ saved across 377-session corpus |
| --- | --- | --- | --- |
| F3 alone (1h TTL beta) | 17% | 20% | $90–$540 |
| F2 alone (quantize pruner-note) | ~25% | ~25% | $130–$660 |
| F1' alone (no historical mutation) | ~55% | ~55% | $290–$1,460 |
| **F1' + F2 + F3 combined** | **~80–85%** | **~80%** | **$420–$2,200** |

Fixes are stackable: F3 handles idle-only busts (different population), F2 handles the dominant fast-silent extension busts, F1' is the structural defense against any future hook that tries to mutate history.

---

## 7. Residual risks and what would falsify the diagnosis

| risk | how it would show | response |
| --- | --- | --- |
| There's another wire-injection source we haven't enumerated (other than `pi-context-prune`) | After F2 is applied to `pi-context-prune`, extension cohort *still* shows 3× higher bust rate than vanilla. | Run wire-diff under each extension in turn (F5). |
| The plateau pin value is sometimes well above `system+tools` size (~12 k) — e.g. pi-twitter pinned at 50,388 | Could mean the rotating byte lives *after* a chunk of stable conversation, not right after system. | Diagnosis still holds; the divergence point just moves later. F1' / F2 still address it. |
| Provider-side cache eviction under load could mimic the signature | Random, low-frequency, no JSONL correlate (H12). | The corpus is too systematic and reproducible for this to be the dominant cause. Still possible at the noise floor. |
| pi-lookback's `cacheRead` / `cacheWrite` parsing is wrong | Aggregate numbers would not match the controlled live reproduction. | Cross-checked in E6 with `pi --print` runs that printed usage directly; numbers match. |
| The reference Anthropic provider is not what's actually shipping in the user's binary | The cache_control strategy described in §2.1 wouldn't apply. | Verifiable by inspecting whatever provider extension is loaded; the *plateau signature* itself is independent of which Anthropic SDK wrapper is used, so the F2/F3/F1' guidance still applies. |
| OpenAI provider (`gpt-5.*`) has different caching semantics | Already observed in hacker-spotify turn #11: cacheRead drop 41,472 → 20,992 = exactly 20 × 1024, OpenAI's 1024-token eviction quantum. Same root cause (bytes mutating), different eviction granularity. | F2 (don't mutate history) still applies; F3 (Anthropic-specific TTL beta) does not. |

**Falsifier**: if a controlled run with `--no-extensions --no-skills` + `pi-context-prune` enabled + log-2-quantized pruner-note still produces the plateau signature inside a single invocation, the diagnosis is wrong.

---

## 8. Map to the goal contract

- [x] **(a) Lab-notebook-style investigation log** — `implementation-notes/2026-06-04-cache-bust-investigation.html`, append-only HTML with stable entry IDs (D-1..D-16, L-1..L-19, R-1..R-4, T-1..T-2, Q-1..Q-3).
- [x] **(b1) Specific code paths / message-shape conditions** — §3 (extension `annotateWithUnprunedCount`, reference provider's marker placement, Anthropic TTL default).
- [x] **(b2) Mechanism end-to-end** — §2 (byte-prefix cache hit, what changes byte-for-byte, good case vs bad case, cohort effect).
- [x] **(b3) Trigger conditions** — §4.
- [x] **(b4) Recommended fix with rationale and expected effect** — §5 + §6.
- [x] **(b5) Residual risks and falsifiers** — §7.
- [x] **(c) Cross-validated against live telemetry** — corpus of 377 sessions (R-1, R-3, D-10..D-12) plus controlled live `pi --print` reproduction E6; at least one concrete bad-case streak (hacker-spotify plateau at 39,750 for 25 turns; pi-twitter at 50,388 for 57 turns; live extended treatment pinned at 31,847) and one good-case streak (vanilla single-invocation linear extension `cacheRead = Σ prior cacheWrite`) are explained by the proposed mechanism.
- [x] **(d) Boundaries respected** — no harness code edited; investigation is read-only against pi-coding-agent source and `~/.pi/agent/sessions/` JSONL.

