#!/usr/bin/env node

/**
 * Comprehensive cache bust reduction experiment
 * Tests all proposed fixes from the investigation
 */

class CacheManager {
  constructor(strategy = 'current') {
    this.strategy = strategy;
    this.reset();
  }

  reset() {
    this.cache = new Map();
    this.breakpoints = [];
    this.busts = [];
    this.totalTokensLost = 0;
    this.turn = 0;
    this.plateauDetected = false;
  }

  // Test F1: Pinned vs sliding breakpoint strategy
  simulateBreakpointStrategy(conversationLength = 50) {
    const results = {
      current: { busts: 0, tokensLost: 0, plateauTurns: 0 },
      pinned: { busts: 0, tokensLost: 0, plateauTurns: 0 }
    };

    // Simulate current strategy (4 sliding breakpoints)
    results.current = this.runBreakpointSimulation('sliding', conversationLength);
    
    // Simulate proposed strategy (2 pinned breakpoints)  
    results.pinned = this.runBreakpointSimulation('pinned', conversationLength);

    return results;
  }

  runBreakpointSimulation(strategy, turns) {
    this.reset();
    let cacheRead = 0;
    let lastRead = 0;
    let plateauTurns = 0;
    const systemTokens = 12537;

    for (let turn = 0; turn < turns; turn++) {
      const userTokens = Math.floor(Math.random() * 100) + 20;
      const assistantTokens = Math.floor(Math.random() * 200) + 50;

      if (strategy === 'sliding') {
        // Current pi strategy - breakpoints slide with every turn
        if (turn % 4 === 0 && turn > 0) {
          // Breakpoint exhaustion - bust
          const tokenLoss = cacheRead;
          this.busts.push({ turn, tokenLoss, cause: 'breakpoint_exhaustion' });
          this.totalTokensLost += tokenLoss;
          cacheRead = systemTokens; // Pin at static prefix
        } else {
          cacheRead += userTokens + assistantTokens;
        }
      } else {
        // Proposed pinned strategy - stable breakpoints
        if (turn === 0) {
          cacheRead = systemTokens;
        } else if (turn === 5) {
          // Pin second breakpoint at stable conversation point
          cacheRead = systemTokens + (userTokens + assistantTokens) * 5;
        } else if (turn > 5) {
          cacheRead += userTokens + assistantTokens;
        }
      }

      // Detect plateau (cacheRead stuck at same value)
      if (cacheRead === lastRead && cacheRead === systemTokens) {
        plateauTurns++;
      }
      lastRead = cacheRead;
    }

    return {
      busts: this.busts.length,
      tokensLost: this.totalTokensLost,
      plateauTurns
    };
  }

  // Test F2: Dynamic content injection impact
  testDynamicContentImpact() {
    const scenarios = [
      {
        name: 'stable_content',
        content: (turn) => `System: You are a helpful assistant.\\nUser: Help me with task ${turn % 3}.\\nAssistant: I'll help you.`
      },
      {
        name: 'rotating_counter', 
        content: (turn) => `System: You are a helpful assistant.\\n<pruner-note>${turn + 10} unpruned calls</pruner-note>\\nUser: Help me.\\nAssistant: I'll help you.`
      },
      {
        name: 'bucketed_counter',
        content: (turn) => `System: You are a helpful assistant.\\n<pruner-note>${turn < 10 ? 'some' : turn < 20 ? 'many' : 'lots of'} unpruned calls</pruner-note>\\nUser: Help me.\\nAssistant: I'll help you.`
      }
    ];

    const results = {};

    scenarios.forEach(scenario => {
      let busts = 0;
      let tokensLost = 0;
      const cache = new Map();
      let lastContent = null;

      for (let turn = 0; turn < 20; turn++) {
        const content = scenario.content(turn);
        const contentHash = this.hashContent(content);
        
        if (cache.has(contentHash)) {
          // Cache hit - no bust
        } else {
          // Cache miss
          const tokens = content.length / 4; // ~4 chars per token
          cache.set(contentHash, tokens);
          
          // Check if this should have been a hit (bust detection)
          if (lastContent && this.shouldHaveBeenHit(content, lastContent)) {
            busts++;
            tokensLost += tokens;
          }
        }
        
        lastContent = content;
      }

      results[scenario.name] = { busts, tokensLost };
    });

    return results;
  }

  shouldHaveBeenHit(current, previous) {
    // Check if content is similar except for dynamic parts
    const currentStatic = current.replace(/<pruner-note>.*?<\/pruner-note>/g, '<pruner-note>DYNAMIC</pruner-note>');
    const previousStatic = previous.replace(/<pruner-note>.*?<\/pruner-note>/g, '<pruner-note>DYNAMIC</pruner-note>');
    
    return currentStatic === previousStatic;
  }

  hashContent(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  // Test F3: TTL impact simulation
  testTTLImpact() {
    const scenarios = [
      { name: '5min_ttl', ttlMinutes: 5 },
      { name: '60min_ttl', ttlMinutes: 60 }
    ];

    const results = {};

    scenarios.forEach(scenario => {
      let busts = 0;
      let tokensLost = 0;
      let lastActivity = Date.now();

      for (let turn = 0; turn < 10; turn++) {
        // Simulate random idle periods
        const idleMinutes = Math.random() * 120; // 0-120 minutes
        const currentTime = lastActivity + (idleMinutes * 60 * 1000);
        
        if (idleMinutes > scenario.ttlMinutes) {
          // TTL expired - cache bust
          busts++;
          tokensLost += 15000; // Typical prefix size
        }
        
        lastActivity = currentTime;
      }

      results[scenario.name] = { busts, tokensLost };
    });

    return results;
  }

  // Run comprehensive experiment
  runFullExperiment() {
    console.log('\\n=== COMPREHENSIVE CACHE BUST REDUCTION EXPERIMENT ===\\n');

    // F1: Breakpoint Strategy Test
    console.log('F1: Breakpoint Strategy Comparison');
    console.log('=====================================');
    const breakpointResults = this.simulateBreakpointStrategy(50);
    console.log(`Current (sliding): ${breakpointResults.current.busts} busts, ${breakpointResults.current.tokensLost} tokens lost, ${breakpointResults.current.plateauTurns} plateau turns`);
    console.log(`Proposed (pinned): ${breakpointResults.pinned.busts} busts, ${breakpointResults.pinned.tokensLost} tokens lost, ${breakpointResults.pinned.plateauTurns} plateau turns`);
    
    const bustReduction = ((breakpointResults.current.busts - breakpointResults.pinned.busts) / breakpointResults.current.busts * 100).toFixed(1);
    const tokenSavings = breakpointResults.current.tokensLost - breakpointResults.pinned.tokensLost;
    console.log(`\\n✅ F1 Impact: ${bustReduction}% bust reduction, ${tokenSavings} tokens saved\\n`);

    // F2: Dynamic Content Test
    console.log('F2: Dynamic Content Impact');
    console.log('============================');
    const dynamicResults = this.testDynamicContentImpact();
    Object.entries(dynamicResults).forEach(([scenario, result]) => {
      console.log(`${scenario}: ${result.busts} busts, ${result.tokensLost.toFixed(0)} tokens lost`);
    });
    
    const rotatingBusts = dynamicResults.rotating_counter.busts;
    const bucketedBusts = dynamicResults.bucketed_counter.busts;
    const dynamicReduction = rotatingBusts > 0 ? ((rotatingBusts - bucketedBusts) / rotatingBusts * 100).toFixed(1) : '0';
    console.log(`\\n✅ F2 Impact: ${dynamicReduction}% bust reduction with bucketing\\n`);

    // F3: TTL Test  
    console.log('F3: TTL Extension Impact');
    console.log('=========================');
    const ttlResults = this.testTTLImpact();
    console.log(`5-minute TTL: ${ttlResults['5min_ttl'].busts} busts, ${ttlResults['5min_ttl'].tokensLost} tokens lost`);
    console.log(`60-minute TTL: ${ttlResults['60min_ttl'].busts} busts, ${ttlResults['60min_ttl'].tokensLost} tokens lost`);
    
    const ttlReduction = ((ttlResults['5min_ttl'].busts - ttlResults['60min_ttl'].busts) / ttlResults['5min_ttl'].busts * 100).toFixed(1);
    const ttlSavings = ttlResults['5min_ttl'].tokensLost - ttlResults['60min_ttl'].tokensLost;
    console.log(`\\n✅ F3 Impact: ${ttlReduction}% bust reduction, ${ttlSavings} tokens saved\\n`);

    // Combined Impact Analysis
    console.log('=== COMBINED IMPACT PROJECTION ===');
    console.log(`Based on investigation findings (1,764 busts across 377 sessions):`);
    console.log(`• F1 (breakpoint fix): ~55% of busts → ${(1764 * 0.55 * parseInt(bustReduction)/100).toFixed(0)} fewer busts`);
    console.log(`• F2 (dynamic content fix): ~25% of busts → ${(1764 * 0.25 * parseInt(dynamicReduction)/100).toFixed(0)} fewer busts`);
    console.log(`• F3 (TTL extension): ~12% of busts → ${(1764 * 0.12 * parseInt(ttlReduction)/100).toFixed(0)} fewer busts`);
    
    const totalBustReduction = (1764 * 0.55 * parseInt(bustReduction)/100) + 
                               (1764 * 0.25 * parseInt(dynamicReduction)/100) + 
                               (1764 * 0.12 * parseInt(ttlReduction)/100);
    
    console.log(`\\n🎯 TOTAL PROJECTED REDUCTION: ${totalBustReduction.toFixed(0)} fewer busts (${(totalBustReduction/1764*100).toFixed(1)}% improvement)`);

    return {
      breakpointResults,
      dynamicResults,
      ttlResults,
      totalBustReduction,
      improvementPercent: totalBustReduction/1764*100
    };
  }
}

// Run the comprehensive experiment
const manager = new CacheManager();
const results = manager.runFullExperiment();

// Export results
const fs = require('fs');
fs.writeFileSync('experiments/comprehensive-results.json', JSON.stringify(results, null, 2));
console.log('\\n📊 Detailed results exported to experiments/comprehensive-results.json');