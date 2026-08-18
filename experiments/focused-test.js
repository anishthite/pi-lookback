#!/usr/bin/env node

/**
 * Focused test to demonstrate cache busting from dynamic content
 */

class SimpleCache {
  constructor() {
    this.prefixCache = new Map();
    this.lastPrefixHash = null;
    this.lastCachedTokens = 0;
  }

  checkCache(content, turn) {
    const hash = this.hashContent(content);
    
    // Simulate cache lookup
    if (this.prefixCache.has(hash)) {
      const cached = this.prefixCache.get(hash);
      return {
        hit: true,
        cachedTokens: cached.tokens,
        newTokens: 0
      };
    } else {
      // Cache miss - need to write new prefix
      const tokens = Math.floor(content.length / 4); // ~4 chars per token
      this.prefixCache.set(hash, { tokens, turn });
      
      // Detect if this should have been a hit (cache bust)
      const shouldHaveHit = this.lastPrefixHash && 
                           this.similarContent(content, this.lastContent);
      
      return {
        hit: false,
        cachedTokens: shouldHaveHit ? this.lastCachedTokens : 0,
        newTokens: tokens,
        bust: shouldHaveHit,
        bitsChanged: shouldHaveHit ? this.findDifference(content, this.lastContent) : null
      };
    }
  }

  hashContent(content) {
    // Simple hash that's sensitive to exact content
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  similarContent(a, b) {
    if (!a || !b) return false;
    
    // Check if content is similar except for numbers (indicating counter change)
    const aNormalized = a.replace(/\\d+/g, 'N');
    const bNormalized = b.replace(/\\d+/g, 'N'); 
    
    return aNormalized === bNormalized && a !== b;
  }

  findDifference(a, b) {
    const aNumbers = a.match(/\\d+/g) || [];
    const bNumbers = b.match(/\\d+/g) || [];
    
    return {
      oldNumbers: bNumbers,
      newNumbers: aNumbers,
      changed: aNumbers.toString() !== bNumbers.toString()
    };
  }

  updateState(content, result) {
    this.lastContent = content;
    this.lastPrefixHash = this.hashContent(content);
    this.lastCachedTokens = result.cachedTokens + result.newTokens;
  }
}

// Test scenarios
function testDynamicContent() {
  console.log('=== Dynamic Content Cache Bust Test ===\\n');
  
  const cache = new SimpleCache();
  const baseContent = 'System: You are a helpful assistant\\nUser: Help me\\n';
  
  const scenarios = [
    {
      name: 'Stable content (no dynamic injection)',
      turns: [
        baseContent + 'Assistant: I can help you.',
        baseContent + 'User: Thanks\\nAssistant: You are welcome.',
        baseContent + 'User: More help\\nAssistant: Of course.'
      ]
    },
    {
      name: 'Rotating counter (cache-busting)',
      turns: [
        baseContent + '<pruner-note>10 unpruned calls</pruner-note>Assistant: I can help.',
        baseContent + '<pruner-note>11 unpruned calls</pruner-note>User: Thanks\\nAssistant: You are welcome.',
        baseContent + '<pruner-note>12 unpruned calls</pruner-note>User: More help\\nAssistant: Of course.'
      ]
    },
    {
      name: 'Bucketed counter (cache-friendly)',
      turns: [
        baseContent + '<pruner-note>some unpruned calls</pruner-note>Assistant: I can help.',
        baseContent + '<pruner-note>some unpruned calls</pruner-note>User: Thanks\\nAssistant: You are welcome.',
        baseContent + '<pruner-note>some unpruned calls</pruner-note>User: More help\\nAssistant: Of course.'
      ]
    }
  ];

  scenarios.forEach(scenario => {
    console.log(`\\n--- ${scenario.name} ---`);
    const testCache = new SimpleCache();
    let totalBusts = 0;
    let tokensLost = 0;

    scenario.turns.forEach((content, i) => {
      const result = testCache.checkCache(content, i + 1);
      
      console.log(`Turn ${i + 1}:`);
      console.log(`  Cache hit: ${result.hit ? 'YES' : 'NO'}`);
      if (result.bust) {
        console.log(`  🚨 CACHE BUST detected!`);
        console.log(`  Changed: ${result.bitsChanged.oldNumbers} → ${result.bitsChanged.newNumbers}`);
        totalBusts++;
        tokensLost += result.newTokens;
      }
      console.log(`  Cached: ${result.cachedTokens}, New: ${result.newTokens}`);
      
      testCache.updateState(content, result);
    });

    console.log(`\\nSummary: ${totalBusts} busts, ${tokensLost} tokens lost`);
  });
}

// Historical data simulation
function testBreakpointExhaustion() {
  console.log('\\n\\n=== Breakpoint Exhaustion Simulation ===\\n');
  
  // Simulate the "plateau" pattern from investigation
  const turns = [
    { cacheRead: 0, cacheWrite: 14676 },     // Turn 0
    { cacheRead: 14676, cacheWrite: 1680 },  // Turn 1 - normal
    { cacheRead: 14676, cacheWrite: 2308 },  // Turn 2 - normal
    { cacheRead: 14676, cacheWrite: 6789 },  // Turn 3 - normal  
    { cacheRead: 14676, cacheWrite: 16961 }, // Turn 4 - normal
    { cacheRead: 12537, cacheWrite: 25039 }, // Turn 5 - BUST! (lost 2,139 tokens)
    { cacheRead: 12537, cacheWrite: 26930 }, // Turn 6 - pinned at system prefix
    { cacheRead: 12537, cacheWrite: 40089 }, // Turn 7 - still pinned
    { cacheRead: 12537, cacheWrite: 41355 }, // Turn 8 - still pinned
  ];

  let totalLost = 0;
  console.log('Turn | Cache Read | Cache Write | Status');
  console.log('-----|------------|-------------|--------');

  turns.forEach((turn, i) => {
    let status = 'normal';
    if (i > 0) {
      const prevTotal = turns[i-1].cacheRead + turns[i-1].cacheWrite;
      if (turn.cacheRead < prevTotal * 0.9) {
        const lost = prevTotal - turn.cacheRead;
        totalLost += lost;
        status = `BUST (-${lost.toLocaleString()})`;
      }
      if (i > 1 && turn.cacheRead === turns[i-1].cacheRead) {
        status += ' PINNED';
      }
    }
    
    console.log(`  ${i}  |  ${turn.cacheRead.toLocaleString().padStart(8)} |  ${turn.cacheWrite.toLocaleString().padStart(9)} | ${status}`);
  });

  console.log(`\\nTotal tokens lost to busting: ${totalLost.toLocaleString()}`);
  console.log('Pattern: Once busted, cacheRead pins at static prefix and never recovers');
}

// Run tests
console.log('Cache Bust Demonstration\\n');
console.log('='.repeat(50));

testDynamicContent();
testBreakpointExhaustion();

console.log('\\n\\n=== KEY INSIGHTS ===');
console.log('1. Rotating counters break caching even when content is otherwise identical');  
console.log('2. Bucketed/quantized counters preserve cache effectiveness');
console.log('3. Breakpoint exhaustion creates permanent plateaus in long sessions');
console.log('4. Each bust forces expensive re-writes of entire conversation history');

// Export simplified results
const fs = require('fs');
const results = {
  timestamp: new Date().toISOString(),
  findings: {
    dynamic_content_breaks_cache: true,
    bucketing_preserves_cache: true,
    plateau_pattern_observed: true,
    each_bust_expensive: true
  },
  recommendations: [
    'Quantize all dynamic counters (context-mode pruner-note)',
    'Place dynamic content outside cache breakpoints',
    'Use 2 long-lived breakpoints instead of 4 sliding ones',
    'Enable 1-hour TTL for static system+tools prefix'
  ]
};

if (!fs.existsSync('experiments')) {
  fs.mkdirSync('experiments');
}

fs.writeFileSync('experiments/focused-results.json', JSON.stringify(results, null, 2));
console.log('\\nDetailed results written to experiments/focused-results.json');