#!/usr/bin/env node
// Walk all pi sessions, emit per-session summary + aggregate friction signals.
// Output: sessions_summary.json (array) and aggregate.json
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = process.env.PI_SESSIONS || `${process.env.HOME}/.pi/agent/sessions`;

async function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function newSummary(file) {
  return {
    file: path.relative(ROOT, file),
    cwd: null,
    sessionId: null,
    startedAt: null,
    endedAt: null,
    durationSec: 0,
    sizeBytes: fs.statSync(file).size,
    model: null,
    thinkingLevel: null,
    modelChanges: 0,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    toolCallsByName: {},
    toolErrorsByName: {},
    // friction signals
    dupConsecutiveCalls: 0,        // same tool+args back-to-back
    dupArgsAcrossCalls: 0,         // same tool+args repeated anywhere (count of repeats)
    largeReadCount: 0,             // Read tool that probably returned >5k chars (we approximate via toolResult length)
    largeToolResults: 0,           // any toolResult > 50KB
    hugeToolResults: 0,            // any toolResult > 200KB
    bashLongOutputs: 0,            // Bash result > 20KB
    failedRetries: 0,              // tool err followed by same tool name within next 3 calls
    parallelBatches: 0,            // assistant turns with >1 toolCall (good - parallelism used)
    serialToolTurns: 0,            // assistant turns with exactly 1 toolCall (potential missed batching)
    pureThinkingTurns: 0,
    pureTextTurns: 0,
    multiToolTurns: 0,
    subagentDispatches: 0,
    workflowDispatches: 0,
    asyncDispatches: 0,
    goalCheckpoints: 0,
    goalStales: 0,
    compactionEvents: 0,
    todoCalls: 0,
    askUserCalls: 0,
    interruptedFinish: false,
    // token usage
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    // text size
    userPromptTotalChars: 0,
    assistantTextTotalChars: 0,
    thinkingTotalChars: 0,
    // misc
    firstUserPrompt: null,
    stopReasons: {},
    errorSamples: [],
  };
}

function safeArgs(a) {
  try { return JSON.stringify(a); } catch { return ''; }
}

async function processFile(file) {
  const s = newSummary(file);
  let lastToolCall = null; // {name,args}
  const seenCalls = new Map(); // name|args -> count
  const recentToolNames = []; // for failed retry detection
  const recentErrors = []; // index in tool name array
  let toolIdx = 0;
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let firstTs = null, lastTs = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (ev.type === 'session') {
      s.sessionId = ev.id;
      s.cwd = ev.cwd;
      s.startedAt = ev.timestamp;
    } else if (ev.type === 'model_change') {
      s.model = ev.modelId;
      s.modelChanges++;
    } else if (ev.type === 'thinking_level_change') {
      s.thinkingLevel = ev.thinkingLevel;
    } else if (ev.type === 'custom' || ev.type === 'custom_message') {
      const ct = ev.customType || '';
      if (ct.includes('goal-event') || ct.includes('goal-continuation')) s.goalCheckpoints++;
      if (typeof ev.content === 'string' && ev.content.includes('GOAL STALE')) s.goalStales++;
      if (ct.includes('compaction')) s.compactionEvents++;
    } else if (ev.type === 'message') {
      const m = ev.message || ev;
      const role = m.role;
      const content = m.content || [];
      if (role === 'user') {
        s.userTurns++;
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            s.userPromptTotalChars += c.text.length;
            if (!s.firstUserPrompt) s.firstUserPrompt = c.text.slice(0, 200);
          }
        }
      } else if (role === 'assistant') {
        s.assistantTurns++;
        const toolCalls = [];
        let textChars = 0, thinkingChars = 0;
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string') textChars += c.text.length;
          else if (c.type === 'thinking' && typeof c.thinking === 'string') thinkingChars += c.thinking.length;
          else if (c.type === 'toolCall') toolCalls.push(c);
        }
        s.assistantTextTotalChars += textChars;
        s.thinkingTotalChars += thinkingChars;
        if (toolCalls.length === 0 && textChars > 0) s.pureTextTurns++;
        if (toolCalls.length === 0 && textChars === 0 && thinkingChars > 0) s.pureThinkingTurns++;
        if (toolCalls.length > 1) { s.parallelBatches++; s.multiToolTurns++; }
        if (toolCalls.length === 1) s.serialToolTurns++;
        if (m.usage) {
          s.totalTokens += m.usage.totalTokens || 0;
          s.inputTokens += m.usage.input || 0;
          s.outputTokens += m.usage.output || 0;
          s.cacheRead += m.usage.cacheRead || 0;
          s.cacheWrite += m.usage.cacheWrite || 0;
          s.cost += (m.usage.cost && m.usage.cost.total) || 0;
        }
        if (m.stopReason) s.stopReasons[m.stopReason] = (s.stopReasons[m.stopReason] || 0) + 1;
        for (const tc of toolCalls) {
          s.toolCalls++;
          const name = tc.name || 'unknown';
          s.toolCallsByName[name] = (s.toolCallsByName[name] || 0) + 1;
          const argsStr = safeArgs(tc.arguments).slice(0, 4000);
          const key = `${name}|${argsStr}`;
          // dup consecutive
          if (lastToolCall && lastToolCall.key === key) s.dupConsecutiveCalls++;
          // dup anywhere
          const prev = seenCalls.get(key) || 0;
          if (prev > 0) s.dupArgsAcrossCalls++;
          seenCalls.set(key, prev + 1);
          lastToolCall = { key, name };
          recentToolNames.push(name);
          toolIdx++;
          if (name === 'subagent') s.subagentDispatches++;
          if (name === 'workflow') s.workflowDispatches++;
          if (name === 'todo') s.todoCalls++;
          if (name === 'ask_user_question') s.askUserCalls++;
          if (name === 'subagent' && argsStr.includes('"async":true')) s.asyncDispatches++;
          // failed retry detection: if recent error was same name within last 3
          for (const ri of recentErrors) {
            if (toolIdx - ri.idx <= 3 && ri.name === name) {
              s.failedRetries++;
              break;
            }
          }
        }
      } else if (role === 'toolResult' || role === 'tool') {
        const name = m.toolName || 'unknown';
        const isError = !!m.isError;
        // sum content length
        let totalLen = 0;
        const content = m.content || [];
        for (const c of content) {
          if (typeof c === 'string') totalLen += c.length;
          else if (c && typeof c.text === 'string') totalLen += c.text.length;
        }
        if (isError) {
          s.toolErrors++;
          s.toolErrorsByName[name] = (s.toolErrorsByName[name] || 0) + 1;
          recentErrors.push({ idx: toolIdx, name });
          if (recentErrors.length > 20) recentErrors.shift();
          if (s.errorSamples.length < 10) {
            const txt = content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('').slice(0, 300);
            s.errorSamples.push({ tool: name, text: txt });
          }
        }
        const nlow = String(name).toLowerCase();
        if (totalLen > 50_000) s.largeToolResults++;
        if (totalLen > 200_000) s.hugeToolResults++;
        if (nlow === 'read' && totalLen > 5_000) s.largeReadCount++;
        if (nlow === 'bash' && totalLen > 20_000) s.bashLongOutputs++;
      }
    }
  }
  if (firstTs && lastTs) {
    s.endedAt = new Date(lastTs).toISOString();
    s.durationSec = Math.round((lastTs - firstTs) / 1000);
  }
  return s;
}

async function main() {
  const files = [];
  for await (const f of walk(ROOT)) files.push(f);
  console.error(`Found ${files.length} sessions`);
  const summaries = [];
  let i = 0;
  for (const f of files) {
    i++;
    try {
      const s = await processFile(f);
      summaries.push(s);
    } catch (e) {
      console.error(`FAIL ${f}: ${e.message}`);
    }
    if (i % 50 === 0) console.error(`  ${i}/${files.length}`);
  }
  fs.writeFileSync('sessions_summary.json', JSON.stringify(summaries, null, 2));
  // aggregate
  const agg = {
    sessions: summaries.length,
    totalTokens: 0, totalCost: 0, totalToolCalls: 0, totalToolErrors: 0,
    totalUserTurns: 0, totalAssistantTurns: 0,
    totalDupConsecutive: 0, totalDupArgs: 0, totalFailedRetries: 0,
    totalLargeReads: 0, totalLargeToolResults: 0, totalHugeToolResults: 0, totalBashLongOutputs: 0,
    totalParallelBatches: 0, totalSerialToolTurns: 0,
    totalSubagentDispatches: 0, totalWorkflowDispatches: 0, totalAsyncDispatches: 0,
    totalAskUser: 0, totalTodo: 0,
    totalGoalStales: 0, totalGoalCheckpoints: 0,
    toolUsage: {}, toolErrors: {},
    modelUsage: {},
    bySession: { errorRateTop: [], dupArgsTop: [], failedRetriesTop: [], costTop: [], serialOverParallelTop: [], largeReadsTop: [], hugeResultsTop: [], goalStalesTop: [] },
  };
  for (const s of summaries) {
    agg.totalTokens += s.totalTokens;
    agg.totalCost += s.cost;
    agg.totalToolCalls += s.toolCalls;
    agg.totalToolErrors += s.toolErrors;
    agg.totalUserTurns += s.userTurns;
    agg.totalAssistantTurns += s.assistantTurns;
    agg.totalDupConsecutive += s.dupConsecutiveCalls;
    agg.totalDupArgs += s.dupArgsAcrossCalls;
    agg.totalFailedRetries += s.failedRetries;
    agg.totalLargeReads += s.largeReadCount;
    agg.totalLargeToolResults += s.largeToolResults;
    agg.totalHugeToolResults += s.hugeToolResults;
    agg.totalBashLongOutputs += s.bashLongOutputs;
    agg.totalParallelBatches += s.parallelBatches;
    agg.totalSerialToolTurns += s.serialToolTurns;
    agg.totalSubagentDispatches += s.subagentDispatches;
    agg.totalWorkflowDispatches += s.workflowDispatches;
    agg.totalAsyncDispatches += s.asyncDispatches;
    agg.totalAskUser += s.askUserCalls;
    agg.totalTodo += s.todoCalls;
    agg.totalGoalStales += s.goalStales;
    agg.totalGoalCheckpoints += s.goalCheckpoints;
    for (const [n, c] of Object.entries(s.toolCallsByName)) agg.toolUsage[n] = (agg.toolUsage[n] || 0) + c;
    for (const [n, c] of Object.entries(s.toolErrorsByName)) agg.toolErrors[n] = (agg.toolErrors[n] || 0) + c;
    if (s.model) agg.modelUsage[s.model] = (agg.modelUsage[s.model] || 0) + 1;
  }
  function topN(arr, key, n=10, extra=[]) {
    return arr
      .filter(s => (typeof key === 'function' ? key(s) : s[key]) > 0)
      .sort((a, b) => (typeof key === 'function' ? key(b) - key(a) : b[key] - a[key]))
      .slice(0, n)
      .map(s => {
        const o = { file: s.file, cwd: s.cwd, prompt: s.firstUserPrompt };
        if (typeof key === 'function') o.value = key(s);
        else o[key] = s[key];
        for (const k of extra) o[k] = s[k];
        return o;
      });
  }
  agg.bySession.dupArgsTop = topN(summaries, 'dupArgsAcrossCalls', 10, ['toolCalls']);
  agg.bySession.failedRetriesTop = topN(summaries, 'failedRetries', 10, ['toolErrors', 'toolCalls']);
  agg.bySession.costTop = topN(summaries, 'cost', 10, ['totalTokens', 'toolCalls']);
  agg.bySession.errorRateTop = topN(summaries, s => s.toolErrors / Math.max(1, s.toolCalls), 10, ['toolErrors', 'toolCalls']);
  agg.bySession.serialOverParallelTop = topN(summaries, s => s.serialToolTurns - s.parallelBatches * 2, 10, ['serialToolTurns', 'parallelBatches', 'toolCalls']);
  agg.bySession.largeReadsTop = topN(summaries, 'largeReadCount', 10, ['toolCalls']);
  agg.bySession.hugeResultsTop = topN(summaries, 'hugeToolResults', 10, ['toolCalls', 'totalTokens']);
  agg.bySession.goalStalesTop = topN(summaries, 'goalStales', 10);
  fs.writeFileSync('aggregate.json', JSON.stringify(agg, null, 2));
  console.log(`Done. ${summaries.length} sessions analyzed.`);
  console.log(`Tokens: ${agg.totalTokens.toLocaleString()}  Cost: $${agg.totalCost.toFixed(2)}`);
  console.log(`Tool calls: ${agg.totalToolCalls.toLocaleString()}  errors: ${agg.totalToolErrors}`);
  console.log(`Dup-args calls (waste): ${agg.totalDupArgs}  Failed retries: ${agg.totalFailedRetries}`);
  console.log(`Parallel batches: ${agg.totalParallelBatches}  Serial tool turns: ${agg.totalSerialToolTurns}  (ratio ${(agg.totalParallelBatches/(agg.totalSerialToolTurns||1)).toFixed(2)})`);
  console.log(`Subagent: ${agg.totalSubagentDispatches}  Workflow: ${agg.totalWorkflowDispatches}  Async: ${agg.totalAsyncDispatches}`);
  console.log(`Large reads (>5k): ${agg.totalLargeReads}  Huge tool results (>200k): ${agg.totalHugeToolResults}  Bash long outputs (>20k): ${agg.totalBashLongOutputs}`);
  console.log(`Goal stales: ${agg.totalGoalStales}  Goal checkpoints: ${agg.totalGoalCheckpoints}`);
}
main().catch(e => { console.error(e); process.exit(1); });
