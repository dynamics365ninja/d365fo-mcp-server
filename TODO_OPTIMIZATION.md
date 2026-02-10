# MCP Server Optimization: Reduce Exploratory Tool Calls

## Problem Statement

AI agents (GitHub Copilot) exhibit **non-deterministic, exploratory behavior**:

```
Observed pattern:
1. search("dimension") 
2. search("DimensionAttribute")     ← Refinement based on step 1 results
3. search("dimension helper")        ← Exploring different angle
4. get_class_info("DimensionAttribute") ← Deeper dive
5. search("financial dimension")     ← Broader context
```

**Issue:** Cannot predict workflow in advance → Composite tools won't help

## Root Causes

1. **Minimal tool responses** → AI needs multiple calls to build context
2. **No related suggestions** → AI explores blindly
3. **Limited caching** → Repeated calls aren't fast enough
4. **Sequential exploration** → No way to parallelize independent queries

## Optimization Strategy

### Priority 1: Rich Context in Tool Responses ⭐⭐⭐

**Goal:** Reduce follow-up calls by returning predictable context upfront

#### Implementation for `search` tool:

```typescript
// BEFORE (current):
"Found 5 matches:
[CLASS] DimensionAttribute
[CLASS] DimensionSet"

// AFTER (rich context):
"Found 5 matches:

📦 [CLASS] DimensionAttribute
   ├─ Package: Dimensions
   ├─ Extends: Object
   ├─ Common methods: find(), create(), validate() (use code_completion for full list)
   ├─ Used by: DimensionDefaultingService, LedgerDimensionHelper
   ├─ Related types: DimensionAttributeValue, DimensionAttributeSet
   └─ Workspace: Not found in workspace
   
📦 [CLASS] DimensionSet
   ├─ Common usage: DimensionSet::findByDimension()
   └─ Methods: find(), create()

🔍 Related searches you might need:
   • 'dimension helper' - Find helper classes for dimensions
   • 'dimension validation' - Find validation patterns
   • 'ledger dimension' - Ledger-specific dimension classes
   
💡 Common patterns found:
   • Most classes use DimensionDefaultingService for initialization
   • Helper classes typically named *DimensionHelper
   
📌 Tips:
   • Use get_class_info("DimensionAttribute") for full method signatures
   • Use code_completion(className="DimensionAttribute") for IntelliSense
   • Use get_api_usage_patterns("DimensionAttribute") to see how it's initialized"
```

**Changes needed:**
- [ ] Enhance `symbolIndex.searchSymbols()` to return metadata (extends, package, common methods)
- [ ] Add relationship detection (used by, related types)
- [ ] Implement "related searches" suggestion engine
- [ ] Add pattern detection for common usage
- [ ] Add contextual tips based on search results

**Impact:** Reduce 3-5 exploratory calls → 1 call with rich response

---

### Priority 2: Smart Caching with Fuzzy Matching ⭐⭐⭐

**Goal:** Make repeated/similar searches instantaneous

#### Current caching:
```typescript
search("dimension")    → 50ms (cache miss)
search("dimension")    → 5ms (cache hit) ✅
search("dimensions")   → 50ms (cache miss) ❌ Different key!
```

#### Enhanced caching:
```typescript
class SmartCache {
  // Fuzzy key matching
  async getFuzzy(query: string, threshold = 0.8) {
    const normalized = query.toLowerCase().trim();
    const cachedKeys = await this.redis.keys('search:*');
    
    for (const key of cachedKeys) {
      const similarity = levenshtein(normalized, extractQuery(key));
      if (similarity > threshold) {
        return await this.get(key);
      }
    }
    return null;
  }
  
  // Proactive warming
  async warmRelated(className: string) {
    // When get_class_info("CustTable") is called
    // → Proactively cache common follow-ups:
    await Promise.all([
      this.warmup(() => get_table_info("CustTable")),
      this.warmup(() => code_completion("CustTable")),
      this.warmup(() => get_api_usage_patterns("CustTable"))
    ]);
  }
}
```

**Changes needed:**
- [ ] Add fuzzy matching to cache keys (Levenshtein distance)
- [ ] Implement cache warming for predictable follow-ups
- [ ] Add cache analytics to identify common patterns
- [ ] Normalize queries before caching (trim, lowercase, remove special chars)

**Impact:** 30-50% faster on similar/repeated queries

---

### Priority 3: Batch Search Tool ⭐⭐

**Goal:** Allow AI to parallelize independent searches

#### New tool:
```typescript
export const BatchSearchSchema = z.object({
  queries: z.array(z.object({
    query: z.string(),
    type: z.enum(['class', 'table', 'all']).optional().default('all'),
    limit: z.number().optional().default(10)
  })).describe('Multiple search queries to execute in parallel'),
});

// AI can call:
batch_search({
  queries: [
    { query: "dimension", type: "class" },
    { query: "helper", type: "class" },
    { query: "validation" }
  ]
})

// Returns:
{
  results: {
    "dimension": [...],
    "helper": [...],
    "validation": [...]
  },
  executionTime: "45ms" // Parallel execution!
}
```

**Changes needed:**
- [ ] Create `src/tools/batchSearch.ts`
- [ ] Implement parallel query execution (Promise.all)
- [ ] Add batch_search to tool registry
- [ ] Update copilot-instructions.md with batch_search examples

**Impact:** 3 HTTP requests → 1 HTTP request (3x faster for independent queries)

---

### Priority 4: Search Suggestions / "Did you mean" ⭐

**Goal:** Guide AI when search yields no/poor results

#### Implementation:
```typescript
async function searchWithSuggestions(query: string) {
  const results = await symbolIndex.searchSymbols(query);
  
  if (results.length === 0) {
    // Find similar terms
    const suggestions = await findSimilarTerms(query);
    return {
      matches: [],
      suggestions: {
        didYouMean: suggestions.typos,      // "dimnesion" → "dimension"
        broader: suggestions.broader,        // "DimensionAttr" → try "Dimension*"
        related: suggestions.related,        // "dimension" → ["financial", "ledger"]
        tryExtensions: true                  // Suggest search_extensions() for custom code
      }
    };
  }
  
  return { matches: results };
}
```

**Changes needed:**
- [ ] Implement fuzzy term matching (Levenshtein, phonetic)
- [ ] Build term relationship graph from symbol index
- [ ] Add suggestion engine to search tool
- [ ] Return structured suggestions in response

**Impact:** Reduce failed/retry searches by 50%

---

## Implementation Plan

### Phase 1: Quick Wins (1-2 days)
- [ ] Rich context in search responses (templates)
- [ ] Fuzzy cache matching
- [ ] Search suggestions on empty results

### Phase 2: Performance (2-3 days)
- [ ] Batch search tool
- [ ] Cache warming
- [ ] Related searches engine

### Phase 3: Intelligence (3-5 days)
- [ ] Pattern detection in search results
- [ ] Relationship graph between symbols
- [ ] Usage frequency tracking

## Expected Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Avg calls per task | 8-12 | 4-6 | 50% reduction |
| Cache hit rate | 20% | 60% | 3x better |
| Parallel searches | 0% | 40% | Batch API |
| Empty result retries | 2-3 | 0-1 | Suggestions |
| **Total time** | **~4s** | **~1.5s** | **2.7x faster** |

## Notes

- Cannot eliminate non-determinism (AI agent decides)
- Can only optimize for **common exploration patterns**
- Focus on making each tool call more valuable
- Rich responses > More tool definitions

## References

- Levenshtein distance: https://en.wikipedia.org/wiki/Levenshtein_distance
- MCP Protocol: https://modelcontextprotocol.io/
- Redis fuzzy search: https://redis.io/commands/keys/
