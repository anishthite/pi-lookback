#!/usr/bin/env bash
# tools/run-live-experiment.sh
#
# E6 — Live pi cache-bust experiment.
#
# Runs the same 5-prompt workload under three treatments:
#   A. vanilla       (--no-extensions --no-skills --no-context-files --no-prompt-templates)
#   B. extended      (default config: extensions + skills + AGENTS.md all loaded)
#   C. quiet         (extensions on but --no-skills --no-context-files to isolate context-mode)
#
# Each treatment writes to a separate session-dir.  After the runs we parse the
# resulting JSONL with tools/cache-bust-detector.js and compare cacheRead /
# cacheWrite trajectories.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXP="${EXP_DIR:-/tmp/cache-exp}"
MODEL="${MODEL:-anthropic/claude-sonnet-4-0}"
mkdir -p "$EXP"/{vanilla,extended,quiet}

# Workload: each prompt issues a bash command whose output is large enough
# (a few KB) that the assembled conversation crosses Anthropic's 1024-token
# minimum cache size after the first few turns.  Same workload across all
# treatments so cache-write/read deltas are directly comparable.
PROMPTS=(
  "Run 'find /usr/share/dict/words -maxdepth 0 -type f && head -200 /usr/share/dict/words' and tell me how many words start with 'a'."
  "Run 'ls -la /etc | head -60' and list any files whose name starts with the letter h."
  "Run 'cat /etc/passwd | head -30' and tell me how many lines contained the substring 'bin'."
  "Run 'ps aux | head -40' and tell me the user that owns the most processes in that slice."
  "Run 'env | sort | head -50' and summarise in one line how many env vars start with the letter P."
)

run_treatment () {
  local name="$1"; shift
  local flags="$*"
  local sd="$EXP/$name"
  rm -rf "$sd"; mkdir -p "$sd"
  echo "=== treatment: $name  flags: $flags ==="
  local first=1
  for p in "${PROMPTS[@]}"; do
    if [[ $first -eq 1 ]]; then
      first=0
      pi --print --model "$MODEL" --session-dir "$sd" $flags "$p" \
        >"$sd/turn-out.log" 2>&1 || echo "  (turn failed)"
    else
      pi --print --continue --model "$MODEL" --session-dir "$sd" $flags "$p" \
        >>"$sd/turn-out.log" 2>&1 || echo "  (turn failed)"
    fi
    echo "  turn done"
  done
}

run_treatment vanilla  "--no-extensions --no-skills --no-context-files --no-prompt-templates"
run_treatment extended ""
run_treatment quiet    "--no-skills --no-context-files --no-prompt-templates"

echo
echo "=== per-treatment cache trajectory ==="
for t in vanilla extended quiet; do
  echo "--- $t ---"
  node "$ROOT/tools/cache-bust-detector.js" --root "$EXP/$t" --threshold 0.5 --prefix-min 100 2>/dev/null | jq '{turns:.turnsTotal,busts:.busts,lost:.lostTokens,plateau:.plateauSessions,attribution}' 2>/dev/null \
    || node "$ROOT/tools/cache-bust-detector.js" --root "$EXP/$t" --threshold 0.5 --prefix-min 100 2>/dev/null
done
