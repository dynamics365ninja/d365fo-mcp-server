# Test Documentation

This project uses [Vitest](https://vitest.dev/) as the testing framework.

## Running Tests

```bash
# Run all tests in watch mode
npm test

# Run tests with coverage
npm test -- --coverage

# Run specific test file
npm test tests/tools/search.test.ts
```

## Test Structure

Tests are organized into the following directories:

- `tests/tools/` - Unit tests for MCP tools (search, batchSearch, classInfo, tableInfo, intelligent tools)
- `tests/server/` - Integration tests for server components (transport, MCP protocol)
- `tests/utils/` - Unit tests for utility functions (fuzzyMatching, modelClassifier, suggestionEngine)
- `tests/` - Root-level tests (symbolIndex, setup configuration)

## Test Coverage

The test suite covers:

### Tools (Unit Tests)
- **search.test.ts**: Tests for symbol search functionality
  - Search with results
  - Empty query handling
  - Cache integration
  - MaxResults parameter
  - Error handling

- **batchSearch.test.ts**: Tests for parallel batch search functionality
  - Multiple parallel queries execution
  - Result aggregation and deduplication
  - Individual query error handling
  - Empty batch handling
  - Performance optimization validation

- **searchSuggestions.test.ts**: Integration tests for intelligent search suggestions
  - Typo correction when no results found ("Did you mean?")
  - Broader search suggestions  
  - Narrower search suggestions
  - Integration with search tool and term relationship graph
  - Cache integration for suggestions

- **classInfo.test.ts**: Tests for class information retrieval
  - XML parsing
  - Database fallback when XML missing
  - Class not found handling
  - Error handling

- **tableInfo.test.ts**: Tests for table information retrieval
  - XML parsing
  - Database fallback when XML missing
  - Table not found handling
  - Error handling

- **intelligentTools.test.ts**: Tests for intelligent code generation tools
  - Pattern analysis (analyze_code_patterns)
  - Method implementation suggestions (suggest_method_implementation)
  - Class completeness analysis (analyze_class_completeness)
  - API usage patterns (get_api_usage_patterns)
  - Cache integration for pattern analysis
  - Error handling and empty result scenarios

### Server Components (Integration Tests)
- **transport.test.ts**: Tests for MCP protocol transport layer
  - Initialize request handling
  - Tools list endpoint
  - Tool call execution
  - Notification handling
  - Ping endpoint
  - Resource templates
  - Invalid method handling
  - Health endpoint

### Database Tests
- **symbolIndex.test.ts**: Tests for SQLite symbol indexing
  - Database creation
  - Symbol addition and retrieval
  - Full-text search
  - Symbol counting
  - Method/field retrieval

### Utilities (Unit Tests)
- **fuzzyMatching.test.ts**: Tests for fuzzy string matching algorithms
  - Levenshtein distance calculation (edit distance)
  - Similarity scoring (normalized 0.0-1.0)
  - Fuzzy match finding with threshold
  - Probable typo detection
  - Broader/narrower search generation
  - Root term extraction

- **modelClassifier.test.ts**: Tests for D365FO model classification
  - Parsing CUSTOM_MODELS environment variable
  - Custom vs standard model identification
  - EXTENSION_PREFIX matching logic
  - Model filtering by type (custom/standard)
  - Case-insensitive model name comparison

- **suggestionEngine.test.ts**: Tests for intelligent suggestion system
  - Typo correction with Levenshtein distance
  - Broader and narrower search suggestions
  - Term relationship graph building and traversal
  - Suggestion formatting and ranking
  - Limit enforcement and result deduplication

## Writing New Tests

When adding new functionality, ensure to:

1. Create unit tests for individual functions/tools
2. Use mocks for external dependencies (database, cache, parser)
3. Test both success and error scenarios
4. Test edge cases (empty inputs, null values, etc.)
5. Maintain test isolation - each test should be independent

## CI/CD Integration

Tests run automatically in GitHub Actions on:
- Every push to main and develop branches
- Pull requests to main and develop branches
- Matrix testing on Node.js 20.x and 22.x

**Note:** Tests currently run with `continue-on-error: true` in the CI pipeline, meaning the build can proceed even if tests fail. This is temporary during active development.

## Mock Strategy

We use Vitest's `vi.fn()` to create mock implementations:
- **XppSymbolIndex**: Database operations (searchSymbols, getClassMethods, etc.) are mocked with predefined return values
- **RedisCacheService**: Cache operations (get, set, getFuzzy) return controlled test data and track calls
- **Parser, WorkspaceScanner, HybridSearch**: Mocked as empty objects when not needed for specific tests

Mocks are created with partial types and reset in `beforeEach()` hooks to ensure test isolation and deterministic behavior.

## Coverage Requirements

Aim for:
- **80%+ line coverage** for critical paths
- **100% coverage** for error handling
- **All exported functions** should have tests

Run coverage reports with:
```bash
npm test -- --coverage
```

Coverage reports are generated in `coverage/` directory.
