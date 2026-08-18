#!/usr/bin/env node

/**
 * Cache bust reduction experiment test harness
 * Simulates pi sessions with different caching strategies
 */

class CacheSimulator {
  constructor(options = {}) {
    this.maxBreakpoints = options.maxBreakpoints || 4;
    this.ttlMinutes = options.ttlMinutes || 5;
    this.strategy = options.strategy || 'sliding'; // 'sliding' | 'pinned'
    this.systemTokens = options.systemTokens || 12537;
    this.reset();
  }

  reset() {
    this.cache = new Map();
    this.breakpoints = [];
    this.currentPrefix = '';
    this.turn = 0;
    this.busts = [];
    this.totalTokensLost = 0;
    this.previousMessages = [];
    this.previousTurnResult = null;
  }

  // Simulate a conversation turn with caching
  simulateTurn(userInput, assistantOutput, dynamicContent = '') {
    this.turn++;
    const timestamp = Date.now();
    
    // Build the full prefix for this turn
    const messages = this.buildPrefix(userInput, assistantOutput, dynamicContent);
    const prefixKey = this.hashPrefix(messages);
    const prefixTokens = this.countTokens(messages);
    
    // Check for cache hit
    const cachedData = this.getCachedData(prefixKey, timestamp);
    const cacheRead = cachedData ? cachedData.tokens : this.systemTokens;
    const cacheWrite = Math.max(0, prefixTokens - cacheRead);
    
    // Update cache with new strategy
    this.updateCache(prefixKey, prefixTokens, timestamp);
    
    // Detect bust
    const bust = this.detectBust(cacheRead, cacheWrite, prefixTokens);
    if (bust) {
      this.busts.push({
        turn: this.turn,
        tokensLost: bust.tokensLost,
        cause: bust.cause,
        cacheRead,
        cacheWrite,
        prefixTokens
      });
      this.totalTokensLost += bust.tokensLost;
    }
    
    return {
      turn: this.turn,
      cacheRead,
      cacheWrite,
      prefixTokens,
      bust: bust || null,
      dynamicContent: dynamicContent.length > 0
    };
  }

  buildPrefix(userInput, assistantOutput, dynamicContent) {
    // Simulate message history with dynamic content injection
    return {
      system: 'System prompt with tools...',
      messages: [
        ...this.previousMessages,
        { role: 'user', content: userInput + dynamicContent },
        { role: 'assistant', content: assistantOutput }
      ]
    };
  }

  hashPrefix(messages) {
    // Hash that's sensitive to exact content changes (like dynamic counters)
    return JSON.stringify(messages);
  }

  countTokens(messages) {
    // Rough token estimation
    const text = JSON.stringify(messages);
    return Math.floor(text.length / 4); // ~4 chars per token
  }

  getCachedData(prefixKey, timestamp) {
    const cached = this.cache.get(prefixKey);
    if (!cached) return null;
    
    // Check TTL expiry
    const ageMinutes = (timestamp - cached.timestamp) / (1000 * 60);
    if (ageMinutes > this.ttlMinutes) {
      this.cache.delete(prefixKey);
      return null;
    }
    
    return cached;
  }

  updateCache(prefixKey, tokens, timestamp) {
    // Implement different breakpoint strategies
    if (this.strategy === 'sliding') {
      this.updateCacheSlidingBreakpoints(prefixKey, tokens, timestamp);
    } else if (this.strategy === 'pinned') {
      this.updateCachePinnedBreakpoints(prefixKey, tokens, timestamp);
    }
  }

  updateCacheSlidingBreakpoints(prefixKey, tokens, timestamp) {
    // Current pi strategy: advance all breakpoints each turn
    this.breakpoints.push({ key: prefixKey, tokens, timestamp });
    
    // Evict oldest if over limit
    if (this.breakpoints.length > this.maxBreakpoints) {
      const evicted = this.breakpoints.shift();
      this.cache.delete(evicted.key);
    }
    
    this.cache.set(prefixKey, { tokens, timestamp });
  }

  updateCachePinnedBreakpoints(prefixKey, tokens, timestamp) {
    // Proposed strategy: keep static system+tools, advance only recent breakpoints
    if (this.breakpoints.length === 0) {
      // First breakpoint: system+tools (never moves)
      this.breakpoints.push({ 
        key: 'system_tools', 
        tokens: this.systemTokens, 
        timestamp, 
        static: true 
      });
      this.cache.set('system_tools', { tokens: this.systemTokens, timestamp });
    }
    
    if (this.breakpoints.length === 1 && tokens > this.systemTokens * 2) {
      // Second breakpoint: stable mid-history (only advance when forced)
      this.breakpoints.push({ 
        key: `stable_${Math.floor(this.turn / 20)}`, 
        tokens: Math.floor(tokens * 0.6), 
        timestamp, 
        stable: true 
      });
    }
    
    // Recent breakpoints advance normally but preserve the static/stable ones
    this.cache.set(prefixKey, { tokens, timestamp });
  }

  detectBust(cacheRead, cacheWrite, prefixTokens) {
    if (this.turn === 1) return null; // No previous turn to compare
    
    const previousResult = this.previousTurnResult;
    if (!previousResult) return null;
    
    const expectedRead = previousResult.cacheRead + previousResult.cacheWrite;
    const actualRead = cacheRead;
    const threshold = expectedRead * 0.5; // 50% threshold from investigation
    
    if (actualRead < threshold && expectedRead > 1000) { // Lower threshold for testing
      return {
        tokensLost: expectedRead - actualRead,
        cause: this.diagnoseBustCause(expectedRead, actualRead)
      };
    }
    
    return null;
  }

  diagnoseBustCause(expected, actual) {
    // Simplified cause detection
    if (actual <= this.systemTokens * 1.1) return 'breakpoint_exhaustion';
    if (this.turn > 1 && this.previousTurnResult?.dynamicContent) return 'dynamic_injection';
    return 'unknown';
  }

  // Store previous turn for comparison
  setPreviousTurnResult(result) {
    this.previousTurnResult = result;
    this.previousMessages = this.previousMessages || [];
    this.previousMessages.push(
      { role: 'user', content: 'Previous user input' },
      { role: 'assistant', content: 'Previous assistant output' }
    );
  }
}

// Experiment runner
class ExperimentRunner {
  runE1_BreakpointStrategy() {
    console.log('=== E1: Breakpoint Strategy Comparison ===\n');
    
    const scenarios = [
      { name: 'Current (Sliding)', strategy: 'sliding' },
      { name: 'Proposed (Pinned)', strategy: 'pinned' }
    ];
    
    const results = scenarios.map(scenario => {
      const sim = new CacheSimulator({ strategy: scenario.strategy });
      const stats = this.runLongSession(sim, 100);
      
      console.log(`${scenario.name}:`);
      console.log(`  Total busts: ${stats.totalBusts}`);
      console.log(`  Tokens lost: ${stats.tokensLost.toLocaleString()}`);
      console.log(`  Plateau detected: ${stats.plateauDetected ? 'YES' : 'NO'}`);
      console.log(`  Cache hit rate: ${(stats.cacheHitRate * 100).toFixed(1)}%`);
      console.log();
      
      return { ...scenario, ...stats };
    });
    
    return results;
  }

  runE2_DynamicContent() {
    console.log('=== E2: Dynamic Content Impact ===\n');
    
    const scenarios = [
      { name: 'Stable Content', useDynamic: false },
      { name: 'Rotating Counter', useDynamic: true, pattern: 'exact' },
      { name: 'Bucketed Counter', useDynamic: true, pattern: 'bucketed' }
    ];
    
    const results = scenarios.map(scenario => {
      const sim = new CacheSimulator({ strategy: 'sliding' });
      const stats = this.runSessionWithDynamicContent(sim, 50, scenario);
      
      console.log(`${scenario.name}:`);
      console.log(`  Total busts: ${stats.totalBusts}`);
      console.log(`  Tokens lost: ${stats.tokensLost.toLocaleString()}`);
      console.log(`  Dynamic-related busts: ${stats.dynamicBusts}`);
      console.log();
      
      return { ...scenario, ...stats };
    });
    
    return results;
  }

  runLongSession(simulator, turns) {
    let results = [];
    
    for (let i = 1; i <= turns; i++) {
      const result = simulator.simulateTurn(
        `User input ${i}`,
        `Assistant response ${i}`,
        ''
      );
      
      if (i > 1) {
        simulator.setPreviousTurnResult(results[results.length - 1]);
      }
      
      results.push(result);
    }
    
    return this.analyzeResults(results, simulator);
  }

  runSessionWithDynamicContent(simulator, turns, scenario) {
    let results = [];
    
    for (let i = 1; i <= turns; i++) {
      let dynamicContent = '';
      
      if (scenario.useDynamic) {
        if (scenario.pattern === 'exact') {
          dynamicContent = `<pruner-note>${i + 25} unpruned tool calls...</pruner-note>`;
        } else if (scenario.pattern === 'bucketed') {
          const bucket = i < 10 ? 'few' : i < 30 ? 'some' : 'many';
          dynamicContent = `<pruner-note>${bucket} unpruned tool calls...</pruner-note>`;
        }
      }
      
      const result = simulator.simulateTurn(
        `User input ${i}`,
        `Assistant response ${i}`,
        dynamicContent
      );
      
      if (i > 1) {
        simulator.setPreviousTurnResult(results[results.length - 1]);
      }
      
      results.push(result);
    }
    
    return this.analyzeResults(results, simulator);
  }

  analyzeResults(results, simulator) {
    const totalBusts = simulator.busts.length;
    const tokensLost = simulator.totalTokensLost;
    const dynamicBusts = simulator.busts.filter(b => b.cause === 'dynamic_injection').length;
    
    // Detect plateau (cacheRead pinning)
    const cacheReads = results.map(r => r.cacheRead).slice(-20); // Last 20 turns
    const plateauDetected = this.detectPlateau(cacheReads);
    
    // Calculate cache hit rate
    const totalTokensProcessed = results.reduce((sum, r) => sum + r.prefixTokens, 0);
    const totalTokensCached = results.reduce((sum, r) => sum + r.cacheRead, 0);
    const cacheHitRate = Math.min(1.0, totalTokensCached / Math.max(totalTokensProcessed, 1));
    
    return {
      totalBusts,
      tokensLost,
      dynamicBusts,
      plateauDetected,
      cacheHitRate,
      turns: results.length
    };
  }

  detectPlateau(cacheReads) {
    if (cacheReads.length < 10) return false;
    
    // Check if cacheRead stays constant for 80% of recent turns
    const mostCommon = cacheReads.sort((a,b) => 
      cacheReads.filter(x => x === a).length - cacheReads.filter(x => x === b).length
    ).pop();
    
    const constantCount = cacheReads.filter(x => x === mostCommon).length;
    return constantCount / cacheReads.length > 0.8;
  }
}

// Run experiments
if (require.main === module) {
  const runner = new ExperimentRunner();
  
  console.log('Cache Bust Reduction Experiments\n');
  console.log('='.repeat(50));
  console.log();
  
  const e1Results = runner.runE1_BreakpointStrategy();
  const e2Results = runner.runE2_DynamicContent();
  
  // Summary
  console.log('=== EXPERIMENT SUMMARY ===\n');
  
  const sliding = e1Results.find(r => r.strategy === 'sliding');
  const pinned = e1Results.find(r => r.strategy === 'pinned');
  
  console.log('E1 Results:');
  console.log(`  Pinned strategy reduces busts by ${((sliding.totalBusts - pinned.totalBusts) / sliding.totalBusts * 100).toFixed(1)}%`);
  console.log(`  Token savings: ${(sliding.tokensLost - pinned.tokensLost).toLocaleString()}`);
  console.log(`  Eliminates plateau: ${sliding.plateauDetected && !pinned.plateauDetected ? 'YES' : 'NO'}`);
  console.log();
  
  const stable = e2Results.find(r => r.name === 'Stable Content');
  const rotating = e2Results.find(r => r.name === 'Rotating Counter');
  const bucketed = e2Results.find(r => r.name === 'Bucketed Counter');
  
  console.log('E2 Results:');
  console.log(`  Rotating content increases busts by ${((rotating.totalBusts - stable.totalBusts) / stable.totalBusts * 100).toFixed(1)}%`);
  console.log(`  Bucketing reduces dynamic busts by ${((rotating.dynamicBusts - bucketed.dynamicBusts) / rotating.dynamicBusts * 100).toFixed(1)}%`);
  console.log();
  
  // Export results
  const experimentResults = {
    timestamp: new Date().toISOString(),
    e1_breakpoint_strategy: e1Results,
    e2_dynamic_content: e2Results,
    summary: {
      pinned_strategy_improvement: (sliding.totalBusts - pinned.totalBusts) / sliding.totalBusts,
      dynamic_content_impact: (rotating.totalBusts - stable.totalBusts) / stable.totalBusts,
      bucketing_effectiveness: (rotating.dynamicBusts - bucketed.dynamicBusts) / rotating.dynamicBusts
    }
  };
  
  const fs = require('fs');
  if (!fs.existsSync('experiments')) {
    fs.mkdirSync('experiments');
  }
  fs.writeFileSync(
    'experiments/results.json', 
    JSON.stringify(experimentResults, null, 2)
  );
  
  console.log('Results exported to experiments/results.json');
}

module.exports = { CacheSimulator, ExperimentRunner };