# Cache Bust Reduction Experiments

## Objective
Test proposed fixes for reducing cache busting in pi sessions, based on investigation findings showing:
- 63% "silent" busts with no visible cause (likely breakpoint exhaustion + dynamic injection)
- 27% TTL expiry (5-min timeout)
- Extension-heavy sessions have 3.1x higher bust rates

## Experiment Design

### E1: Breakpoint Strategy Optimization (F1)
**Hypothesis**: Current 4-sliding-breakpoint strategy causes exhaustion. Pin 2 long-lived breakpoints instead.

**Test Setup**:
- Create mock pi session with varying breakpoint strategies
- Measure cache effectiveness across 100+ turns
- Compare current vs proposed strategies

**Metrics**: 
- Cache hit rate
- Tokens lost to busting
- Plateau detection (cacheRead pinning)

### E2: Dynamic Content Isolation (F2) 
**Hypothesis**: Rotating content (pruner-note counters, env blocks) inside cached zones breaks caching.

**Test Setup**:
- Simulate messages with/without dynamic counters in cached zones  
- Test bucketing strategies ("≥10 unpruned" vs exact count)
- Measure cache stability

**Metrics**:
- Cache invalidation frequency
- Prefix stability across turns

### E3: TTL Extension (F3)
**Hypothesis**: 1-hour TTL vs 5-minute TTL reduces idle-time busts.

**Test Setup**:
- Compare bust rates for sessions with idle periods >5min <1hr
- Test on historical data subset

**Metrics**:
- Bust attribution to TTL expiry
- Cost savings from extended caching

### E4: Extension Impact Audit (F5)
**Hypothesis**: context-mode extension is the primary dynamic injection source.

**Test Setup**:
- Analyze sessions with/without context-mode
- Test modified context-mode with stable counters
- Measure before/after bust rates

**Metrics**:
- Bust rate correlation with extension activity
- Impact of counter quantization

## Implementation Plan

1. **Build test harness** - Mock pi session generator with configurable caching
2. **Implement F1** - Test new breakpoint strategy
3. **Implement F2** - Test dynamic content isolation
4. **Validate F3** - Historical data analysis for TTL impact
5. **Audit F5** - Extension modification and testing
6. **Integrate fixes** - Combined solution testing
7. **Measure impact** - Before/after comparison on real sessions

## Success Criteria
- Reduce "silent" bust rate from 63% to <30%
- Reduce TTL-related busts from 27% to <10% 
- Eliminate plateau signatures in long sessions
- Maintain cache hit rates >80% in extension-heavy sessions

## Risk Assessment
- Changes to pi core caching logic (high impact)
- Extension compatibility (context-mode modification needed)
- Anthropic API beta feature dependency (1hr TTL)