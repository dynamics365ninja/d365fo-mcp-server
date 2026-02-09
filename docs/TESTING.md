# Test Documentation

This project uses [Vitest](https://vitest.dev/) as the testing framework.

## Running Tests

```bash
# Run all tests in watch mode
npm test

# Run tests once (CI mode)
npm test -- --run

# Run tests with coverage
npm test -- --coverage

# Run specific test file
npm test -- tests/tools/search.test.ts
```

## Test Structure

Tests are organized into the following directories:

- `tests/tools/` - Unit tests for MCP tools (search, classInfo, tableInfo, etc.)
- `tests/server/` - Tests for server components (transport, MCP protocol)
- `tests/` - Integration tests and database tests

## Test Coverage

The test suite covers:

### Tools (Unit Tests)
- **search.test.ts**: Tests for symbol search functionality
  - Search with results
  - Empty query handling
  - Cache integration
  - MaxResults parameter
  - Error handling

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

## Writing New Tests

When adding new functionality, ensure to:

1. Create unit tests for individual functions/tools
2. Use mocks for external dependencies (database, cache, parser)
3. Test both success and error scenarios
4. Test edge cases (empty inputs, null values, etc.)
5. Maintain test isolation - each test should be independent

### Example Test

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myFunction } from '../../src/myModule';

describe('myFunction', () => {
  beforeEach(() => {
    // Setup mocks
  });

  it('should handle valid input', () => {
    const result = myFunction('test');
    expect(result).toBe('expected');
  });

  it('should handle errors gracefully', () => {
    expect(() => myFunction(null)).toThrow();
  });
});
```

## CI/CD Integration

Tests run automatically in GitHub Actions on:
- Every push to main branch
- Pull requests
- Before deployment to production

Tests must pass before deployment proceeds. The CI workflow will fail if any tests fail.

## Mock Strategy

We use Vitest's built-in mocking for:
- **XppSymbolIndex**: Database operations are mocked to avoid file I/O
- **RedisCacheService**: Cache operations return controlled test data
- **XmlParser**: XML parsing is mocked with predefined structures

This ensures tests run fast and are deterministic.

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
