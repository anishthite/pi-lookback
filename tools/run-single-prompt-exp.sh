#!/usr/bin/env bash
# Single-invocation multi-tool-call experiment.  Avoids the --continue
# cross-invocation breakpoint reshuffle and the intercom lock that broke the
# previous run.  Each treatment fires ONE pi --print call whose prompt forces
# the model to make several tool calls in a row, so cacheRead/cacheWrite
# trajectories are observed WITHIN a single agent invocation.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXP="${EXP_DIR:-/tmp/cache-exp2}"
MODEL="${MODEL:-anthropic/claude-sonnet-4-0}"
mkdir -p "$EXP"/{vanilla,extended}

PROMPT='I am running a benchmark.  Run each of these bash commands in order, ONE AT A TIME with separate tool calls (do not chain with &&), and after each one tell me a single-sentence summary of its output before moving to the next command:
1. ls /etc | head -30
2. cat /etc/hosts
3. uname -a
4. date
5. echo done
Do all five.'

run_one () {
  local name="$1"; shift
  local flags="$*"
  local sd="$EXP/$name"
  mkdir -p "$sd"
  echo "=== treatment: $name  flags: $flags ==="
  pi --print --model "$MODEL" --session-dir "$sd" $flags "$PROMPT" \
    >"$sd/out.log" 2>&1 || echo "  (failed: $(tail -3 $sd/out.log))"
  echo "  done; jsonl=$(ls $sd/*.jsonl 2>/dev/null | head -1)"
}

run_one vanilla  "--no-extensions --no-skills --no-context-files --no-prompt-templates"
run_one extended ""

echo
echo "=== per-treatment turn-by-turn usage ==="
for t in vanilla extended; do
  echo "--- $t ---"
  node -e '
    const fs = require("fs");
    const { execSync } = require("child_process");
    const files = execSync("ls "+process.argv[1]+"/*.jsonl 2>/dev/null", {encoding:"utf8"}).trim().split("\n").filter(Boolean);
    let n=0, types={};
    let prevPrefix = 0;
    for (const f of files){
      const lines = fs.readFileSync(f,"utf8").trim().split("\n");
      for (const l of lines){
        try{ const e = JSON.parse(l);
          types[e.type] = (types[e.type]||0)+1;
          if (e.type==="message" && e.message?.role==="assistant" && e.message?.usage){
            const u = e.message.usage;
            const drop = n>0 && u.cacheRead < prevPrefix ? `  DROP=${prevPrefix-u.cacheRead}` : "";
            console.log(`t${n++}: input=${u.input.toString().padStart(4)} cacheRead=${u.cacheRead.toString().padStart(6)} cacheWrite=${u.cacheWrite.toString().padStart(6)} output=${u.output}${drop}`);
            prevPrefix = u.cacheRead + u.cacheWrite;
          }
        }catch{}
      }
    }
    console.log("event types:", JSON.stringify(types));
  ' "/tmp/cache-exp2/$t"
done
