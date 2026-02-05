# Architecture Overview

This document provides visual diagrams and detailed explanations of the D365 F&O MCP Server architecture.

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Request Flow](#request-flow)
3. [Component Architecture](#component-architecture)
4. [Data Flow](#data-flow)
5. [Deployment Architecture](#deployment-architecture)
6. [Database Schema](#database-schema)

---

## High-Level Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        VS[Visual Studio 2022 17.14+<br/>GitHub Copilot Agent Mode]
        VSCODE[VS Code<br/>GitHub Copilot Extension]
    end

    subgraph "Azure Cloud"
        subgraph "App Service"
            MCP[MCP Server<br/>Node.js 22 LTS<br/>Express 5.x HTTP]
        end
        
        subgraph "Storage"
            BLOB[Azure Blob Storage<br/>xpp-metadata.db<br/>~500MB]
        end
    end

    subgraph "MCP Server Components"
        HTTP[HTTP Transport Layer<br/>Express + Rate Limiting]
        PROTO[MCP Protocol Handler<br/>JSON-RPC 2.0]
        TOOLS[Tool Handlers<br/>6 MCP Tools]
        DB[(SQLite Database<br/>FTS5 Full-Text Search<br/>584,799 symbols)]
        CACHE[Redis Cache<br/>Optional]
    end

    VS -->|"Streamable HTTP<br/>OAuth 2.0"| MCP
    VSCODE -->|"Streamable HTTP<br/>OAuth 2.0"| MCP
    MCP -->|"Download on startup"| BLOB
    MCP --> HTTP
    HTTP --> PROTO
    PROTO --> TOOLS
    TOOLS --> DB
    TOOLS -.->|"Optional"| CACHE
    
    style VS fill:#68217A,color:#fff
    style VSCODE fill:#0078D4,color:#fff
    style MCP fill:#00A4EF,color:#fff
    style BLOB fill:#FF6C00,color:#fff
    style DB fill:#4CAF50,color:#fff
    style CACHE fill:#DC382D,color:#fff
```

---

## Request Flow

```mermaid
sequenceDiagram
    participant IDE as Visual Studio 2022 /<br/>VS Code
    participant HTTP as HTTP Transport
    participant MCP as MCP Protocol
    participant Handler as Tool Handler
    participant Tool as Tool Implementation
    participant Cache as Redis Cache
    participant DB as SQLite DB

    IDE->>HTTP: POST /mcp<br/>JSON-RPC Request
    HTTP->>HTTP: Rate Limit Check
    HTTP->>MCP: Parse JSON-RPC
    MCP->>MCP: Route Method
    
    alt Initialize
        MCP-->>IDE: Server Capabilities
    else Tools List
        MCP-->>IDE: 6 Tool Definitions
    else Tool Call
        MCP->>Handler: Route to Handler
        Handler->>Tool: Execute Tool
        Tool->>Cache: Check Cache
        alt Cache Hit
            Cache-->>Tool: Cached Result
        else Cache Miss
            Tool->>DB: FTS5 Query
            DB-->>Tool: Symbol Results
            Tool->>Cache: Store Result
        end
        Tool-->>Handler: Tool Result
        Handler-->>MCP: Formatted Response
        MCP-->>IDE: JSON-RPC Response
    end
```

---

## Component Architecture

```mermaid
graph LR
    subgraph "Entry Point"
        INDEX[index.ts<br/>Main Entry]
    end

    subgraph "Server Layer"
        SERVER[mcpServer.ts<br/>MCP Server Config]
        TRANSPORT[transport.ts<br/>HTTP Transport]
        HANDLER[toolHandler.ts<br/>Tool Router]
    end

    subgraph "Tool Layer"
        SEARCH[search.ts<br/>search Tool]
        CLASS[classInfo.ts<br/>get_class_info Tool]
        TABLE[tableInfo.ts<br/>get_table_info Tool]
        COMP[completion.ts<br/>code_completion Tool]
        GEN[codeGen.ts<br/>generate_code Tool]
        EXT[extensionSearch.ts<br/>search_extensions Tool]
    end

    subgraph "Metadata Layer"
        SYMBOL[symbolIndex.ts<br/>SQLite + FTS5]
        PARSER[xmlParser.ts<br/>XML Metadata]
    end

    subgraph "Infrastructure"
        CACHE_SVC[redisCache.ts<br/>Cache Service]
        RATE[rateLimiter.ts<br/>Rate Limiting]
        DOWNLOAD[download.ts<br/>Azure Blob DL]
    end

    INDEX --> SERVER
    INDEX --> TRANSPORT
    INDEX --> SYMBOL
    INDEX --> PARSER
    INDEX --> CACHE_SVC
    INDEX --> DOWNLOAD

    SERVER --> HANDLER
    HANDLER --> SEARCH
    HANDLER --> CLASS
    HANDLER --> TABLE
    HANDLER --> COMP
    HANDLER --> GEN
    HANDLER --> EXT

    SEARCH --> SYMBOL
    CLASS --> SYMBOL
    CLASS --> PARSER
    TABLE --> SYMBOL
    TABLE --> PARSER
    COMP --> SYMBOL
    EXT --> SYMBOL

    SEARCH -.-> CACHE_SVC
    CLASS -.-> CACHE_SVC
    TABLE -.-> CACHE_SVC
    COMP -.-> CACHE_SVC

    TRANSPORT --> RATE
    
    style INDEX fill:#FF6C00,color:#fff
    style SYMBOL fill:#4CAF50,color:#fff
    style CACHE_SVC fill:#DC382D,color:#fff
```

---

## Data Flow

### 1. Startup Flow

```mermaid
graph TD
    START([Server Startup]) --> ENV[Load .env Config]
    ENV --> CACHE_INIT[Initialize Redis Cache<br/>Optional]
    CACHE_INIT --> DB_CHECK{Database<br/>Exists?}
    
    DB_CHECK -->|Yes| DB_LOAD[Load SQLite Database]
    DB_CHECK -->|No| AZURE_CHECK{Azure Blob<br/>Configured?}
    
    AZURE_CHECK -->|Yes| DOWNLOAD[Download from Azure Blob]
    AZURE_CHECK -->|No| INDEX_META[Index Local Metadata]
    
    DOWNLOAD --> DB_LOAD
    INDEX_META --> DB_LOAD
    
    DB_LOAD --> FTS_INIT[Initialize FTS5 Index]
    FTS_INIT --> COUNT[Count Symbols<br/>~584,799]
    COUNT --> MCP_INIT[Initialize MCP Server]
    MCP_INIT --> HTTP_START[Start HTTP Server<br/>Port 8080]
    HTTP_START --> READY([Server Ready])
    
    style START fill:#4CAF50,color:#fff
    style READY fill:#4CAF50,color:#fff
    style DOWNLOAD fill:#FF6C00,color:#fff
    style DB_LOAD fill:#2196F3,color:#fff
```

### 2. Search Query Flow

```mermaid
graph TD
    QUERY([User Search Query]) --> CACHE_KEY[Generate Cache Key<br/>search:query:limit]
    CACHE_KEY --> CACHE_CHECK{Cache Hit?}
    
    CACHE_CHECK -->|Yes| CACHE_RETURN[Return Cached Results]
    CACHE_CHECK -->|No| FTS_QUERY[FTS5 Full-Text Search]
    
    FTS_QUERY --> RESULTS[Raw Symbol Results]
    RESULTS --> FORMAT[Format Results<br/>TYPE: Name - Signature]
    FORMAT --> CACHE_STORE[Store in Cache<br/>TTL: 1 hour]
    CACHE_STORE --> RETURN([Return Results])
    CACHE_RETURN --> RETURN
    
    style QUERY fill:#4CAF50,color:#fff
    style CACHE_CHECK fill:#FF9800,color:#fff
    style FTS_QUERY fill:#2196F3,color:#fff
    style RETURN fill:#4CAF50,color:#fff
```

### 3. Class Info Query Flow

```mermaid
graph TD
    CLASS_REQ([Get Class Info]) --> DB_LOOKUP[Symbol Index Lookup]
    DB_LOOKUP --> FOUND{Symbol Found?}
    
    FOUND -->|No| ERROR_404[Return Not Found]
    FOUND -->|Yes| CACHE_CHECK{Cache Hit?}
    
    CACHE_CHECK -->|Yes| CACHE_RETURN[Return Cached Class Info]
    CACHE_CHECK -->|No| XML_PARSE[Parse XML Metadata File]
    
    XML_PARSE --> XML_SUCCESS{Parsing<br/>Successful?}
    
    XML_SUCCESS -->|Yes| EXTRACT[Extract Class Details<br/>Methods, Inheritance, etc.]
    XML_SUCCESS -->|No| FALLBACK[Fallback to Database<br/>Basic Symbol Info]
    
    EXTRACT --> CACHE_STORE[Store in Cache]
    FALLBACK --> RESPONSE
    CACHE_STORE --> RESPONSE([Return Class Info])
    CACHE_RETURN --> RESPONSE
    ERROR_404 --> RESPONSE
    
    style CLASS_REQ fill:#4CAF50,color:#fff
    style XML_PARSE fill:#FF9800,color:#fff
    style FALLBACK fill:#DC382D,color:#fff
    style RESPONSE fill:#4CAF50,color:#fff
```

---

## Deployment Architecture

```mermaid
graph TB
    subgraph "GitHub"
        REPO[GitHub Repository<br/>main branch]
    end

    subgraph "GitHub Actions CI/CD"
        BUILD[Build Job<br/>npm ci, test, build]
        DEPLOY[Deploy Job<br/>Azure App Service]
    end

    subgraph "Azure Resources"
        subgraph "Resource Group: rg-xpp-mcp"
            APP[App Service<br/>app-xpp-mcp-*<br/>Linux P0v3<br/>Node.js 22-lts]
            STORAGE[Storage Account<br/>st-xpp-mcp-*<br/>StorageV2, Hot, LRS]
        end
    end

    subgraph "Monitoring"
        LOGS[Application Insights<br/>Logs & Metrics]
        HEALTH[Health Endpoint<br/>/health Status Checks]
    end

    REPO -->|Push/PR| BUILD
    BUILD -->|Tests Pass| DEPLOY
    DEPLOY -->|Deploy Package| APP
    APP -->|Startup Download| STORAGE
    APP --> LOGS
    APP --> HEALTH
    
    style REPO fill:#000,color:#fff
    style BUILD fill:#4CAF50,color:#fff
    style DEPLOY fill:#FF9800,color:#fff
    style APP fill:#0078D4,color:#fff
    style STORAGE fill:#FF6C00,color:#fff
```

---

## Database Schema

```mermaid
erDiagram
    SYMBOLS {
        integer id PK
        text name
        text type "class|table|method|field|enum|edt"
        text parentName "nullable"
        text signature "nullable"
        text filePath
        text model
        text description "Enhanced: human-readable description"
        text tags "Enhanced: comma-separated semantic tags"
        text sourceSnippet "Enhanced: first 10 lines preview"
        integer complexity "Enhanced: complexity score 0-100"
        text usedTypes "Enhanced: comma-separated types used"
        text methodCalls "Enhanced: comma-separated method calls"
        text inlineComments "Enhanced: extracted comments"
        text extendsClass "Enhanced: inheritance info"
        text implementsInterfaces "Enhanced: interface implementations"
        text usageExample "Enhanced: generated usage example"
    }
    
    SYMBOLS_FTS {
        text name "FTS5 indexed"
        text type "FTS5 indexed"
        text model "FTS5 indexed"
        text description "FTS5 indexed - Enhanced"
        text tags "FTS5 indexed - Enhanced"
        text sourceSnippet "FTS5 indexed - Enhanced"
        text inlineComments "FTS5 indexed - Enhanced"
    }
    
    SYMBOLS ||--|| SYMBOLS_FTS : "mirrored for FTS5"
```

### Symbol Types

| Type | Description | Example |
|------|-------------|---------|
| `class` | X++ Class | `CustTable`, `SalesLine` |
| `table` | AOT Table | `CustTable`, `InventTable` |
| `method` | Class/Table Method | `insert()`, `validateWrite()` |
| `field` | Table Field | `AccountNum`, `Name` |
| `enum` | Enumeration | `NoYes`, `TransactionType` |
| `edt` | Extended Data Type | `CustAccount`, `ItemId` |

### Enhanced Metadata Fields

The database now includes rich contextual metadata for better GitHub Copilot integration:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `description` | TEXT | Human-readable description | "CustTable class extending SalesTable" |
| `tags` | TEXT | Semantic tags (comma-separated) | "validation, query, customer" |
| `sourceSnippet` | TEXT | First 10 lines of code | "public boolean validate() {...}" |
| `complexity` | INTEGER | Complexity score (0-100) | 45 |
| `usedTypes` | TEXT | Referenced types | "CustTable, SalesLine, InventTable" |
| `methodCalls` | TEXT | Called methods | "select, insert, validateWrite" |
| `inlineComments` | TEXT | Extracted comments | "Validate customer account..." |
| `extendsClass` | TEXT | Parent class (for classes) | "FormRun" |
| `implementsInterfaces` | TEXT | Interfaces implemented | "Runnable, Serializable" |
| `usageExample` | TEXT | Generated usage example | "CustTable custTable = new..." |

### Semantic Tags

Automatically extracted tags help Copilot understand code context:

**Method Tags:** validation, initialization, data-modification, query, deletion, calculation, conversion, event-handler, transaction, error-handling, database-query, set-based, loop, conditional, async, static-method

**Class Tags:** controller, utility, business-logic, builder-pattern, factory-pattern, event-handler, abstract, final, runnable

**Domain Tags:** customer, vendor, inventory, sales, purchasing, ledger, tax, project, warehouse, production

### Indexes

```sql
-- Primary Key
CREATE UNIQUE INDEX idx_symbols_id ON symbols(id);

-- Type-based queries
CREATE INDEX idx_symbols_type ON symbols(type);

-- Name lookups
CREATE INDEX idx_symbols_name ON symbols(name);

-- Model filtering
CREATE INDEX idx_symbols_model ON symbols(model);

-- Unique constraint to prevent duplicates
CREATE UNIQUE INDEX idx_symbols_unique 
    ON symbols(name, type, COALESCE(parent_name, ''), model);

-- Full-Text Search (FTS5) with enhanced fields
CREATE VIRTUAL TABLE symbols_fts USING fts5(
    name, type, parent_name, signature,
    description, tags, source_snippet, inline_comments,
    content='symbols',
    content_rowid='id'
);
```

---

## MCP Protocol Endpoints

```mermaid
graph LR
    subgraph "MCP Protocol Methods"
        INIT[initialize<br/>Server Capabilities]
        NOTIFY[notifications/initialized<br/>Handshake Complete]
        TOOLS_LIST[tools/list<br/>6 Available Tools]
        TOOLS_CALL[tools/call<br/>Execute Tool]
        RES_LIST[resources/list<br/>Empty]
        RES_TMPL[resources/templates/list<br/>Empty]
        PROMPT_LIST[prompts/list<br/>Code Review Prompt]
        PING[ping<br/>Health Check]
    end

    INIT -.-> CAPS[Capabilities:<br/>tools, resources, prompts]
    TOOLS_LIST -.-> TOOL_DEFS[Tool Definitions:<br/>search, get_class_info,<br/>get_table_info, code_completion,<br/>generate_code,<br/>search_extensions]
    TOOLS_CALL -.-> EXEC[Tool Execution:<br/>search DB, parse XML,<br/>return results]
    
    style INIT fill:#4CAF50,color:#fff
    style TOOLS_CALL fill:#2196F3,color:#fff
```

### Tool Arguments & Responses

#### 1. search
**Input:**
```json
{
  "query": "CustTable",
  "type": "all",
  "limit": 20
}
```

**Output:**
```
Found 5 matches:

[TABLE] CustTable
[METHOD] CustTable.insert - boolean insert()
[FIELD] CustTable.AccountNum - str AccountNum
```

**Type Filter Options:** `class`, `table`, `field`, `method`, `enum`, `all`

#### 2. get_class_info
**Input:**
```json
{
  "className": "CustTable"
}
```

**Output:** Markdown-formatted class details with methods, inheritance, modifiers

#### 3. get_table_info
**Input:**
```json
{
  "tableName": "CustTable"
}
```

**Output:** Markdown-formatted table schema with fields, indexes, relations

#### 4. code_completion
**Input:**
```json
{
  "objectName": "CustTable",
  "prefix": "set"
}
```

**Output:** List of matching methods starting with "set"

#### 5. generate_code
**Input:**
```json
{
  "pattern": "batch-job",
  "name": "MyBatch"
}
```

**Output:** X++ code template for batch job

#### 6. search_extensions
**Input:**
```json
{
  "query": "Cust",
  "prefix": "ISV_"
}
```

**Output:** Search results filtered to custom/ISV models only

---

## Performance Optimizations

```mermaid
graph TD
    subgraph "Caching Strategy"
        L1[Request] --> L2{Redis Cache}
        L2 -->|Hit| L3[Return Cached]
        L2 -->|Miss| L4[Query Database]
        L4 --> L5[FTS5 Index Scan]
        L5 --> L6[Format Results]
        L6 --> L7[Store in Cache<br/>TTL: 1h]
        L7 --> L3
    end

    subgraph "Rate Limiting"
        R1[Client Request] --> R2{Rate Check}
        R2 -->|OK| R3[Process Request]
        R2 -->|Exceeded| R4[429 Too Many Requests]
    end

    subgraph "Connection Pooling"
        C1[SQLite] --> C2[Single Connection<br/>Read-Only Mode]
        C3[Redis] --> C4[Connection Pool<br/>Max 10]
    end
    
    style L3 fill:#4CAF50,color:#fff
    style R4 fill:#DC382D,color:#fff
    style L5 fill:#2196F3,color:#fff
```

### Caching TTLs

| Cache Type | TTL | Rationale |
|------------|-----|-----------|
| Search Results | 1 hour | Metadata rarely changes |
| Class Info | 1 hour | Static AOT metadata |
| Table Info | 1 hour | Static AOT metadata |
| Completions | 30 min | Frequently accessed |
| Extension Search | 30 min | Less frequent updates |

### Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/mcp` | 100 requests | 15 minutes |
| `/health` | 1000 requests | 15 minutes |

---

## Security Architecture

```mermaid
graph TD
    subgraph "Authentication"
        A1[GitHub Copilot] --> A2[OAuth 2.0 Token]
        A2 --> A3[Azure AD Verification]
    end

    subgraph "Authorization"
        B1[App Service] --> B2[Managed Identity]
        B2 --> B3[Azure Blob Access]
    end

    subgraph "Network Security"
        C1[HTTPS Only] --> C2[TLS 1.2+]
        C3[Rate Limiting] --> C4[DDoS Protection]
    end

    subgraph "Data Security"
        D1[Read-Only Database] --> D2[No Sensitive Data]
        D3[Cache Encryption] --> D4[Redis TLS]
    end
    
    style A2 fill:#4CAF50,color:#fff
    style B2 fill:#FF9800,color:#fff
    style C1 fill:#2196F3,color:#fff
```

---

## Error Handling Flow

```mermaid
graph TD
    ERR([Error Occurs]) --> TYPE{Error Type?}
    
    TYPE -->|Network| NET[Network Error<br/>Retry 3x]
    TYPE -->|Database| DB[Database Error<br/>Log & Fallback]
    TYPE -->|Validation| VAL[Validation Error<br/>400 Bad Request]
    TYPE -->|Not Found| NF[404 Not Found]
    TYPE -->|Unknown| UNK[500 Internal Error]
    
    NET --> LOG[Log to Console]
    DB --> LOG
    VAL --> LOG
    NF --> LOG
    UNK --> LOG
    
    LOG --> RESP[Return JSON Error]
    RESP --> CLIENT([Client Receives Error])
    
    style ERR fill:#DC382D,color:#fff
    style LOG fill:#FF9800,color:#fff
    style CLIENT fill:#4CAF50,color:#fff
```

### Error Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": {
      "detail": "Missing required parameter: className"
    }
  }
}
```

---

## Scalability Considerations

```mermaid
graph LR
    subgraph "Vertical Scaling"
        V1[P0v3: 1 vCPU, 1.75GB] -.-> V2[P1v3: 2 vCPU, 3.5GB]
        V2 -.-> V3[P2v3: 4 vCPU, 7GB]
    end

    subgraph "Horizontal Scaling"
        H1[Single Instance] -.-> H2[Scale Out: 2-10 Instances]
        H2 --> LB[Load Balancer]
    end

    subgraph "Caching"
        C1[Redis Cache] --> C2[Shared Cache Layer<br/>Across Instances]
    end

    subgraph "Database"
        D1[SQLite Read-Only] --> D2[No Locking Issues<br/>Concurrent Reads]
    end
    
    style H2 fill:#4CAF50,color:#fff
    style C2 fill:#DC382D,color:#fff
    style D2 fill:#2196F3,color:#fff
```

### Current Capacity

- **Storage:** 500MB database (584,799 symbols)
- **Memory:** 1.75GB (P0v3) - ~800MB used
- **Throughput:** 100 req/15min per IP
- **Latency:** 
  - Cache hit: <10ms
  - Cache miss: 50-200ms
  - Cold start: 15-30s (database download)

---

## Testing Architecture

```mermaid
graph TB
    subgraph "Test Pyramid"
        UNIT[Unit Tests<br/>30 tests<br/>search, classInfo, tableInfo]
        INT[Integration Tests<br/>MCP Protocol, HTTP Transport]
        E2E[End-to-End Tests<br/>symbolIndex, Database]
    end

    subgraph "Test Infrastructure"
        VITEST[Vitest Test Runner]
        MOCKS[Mock Services<br/>Cache, Parser, SymbolIndex]
        SUPER[Supertest<br/>HTTP Integration Testing]
    end

    subgraph "CI/CD Testing"
        CI[GitHub Actions<br/>Run on PR/Push]
        COV[Coverage Reports<br/>v8 Provider]
    end

    UNIT --> VITEST
    INT --> VITEST
    E2E --> VITEST
    
    UNIT --> MOCKS
    INT --> SUPER
    
    VITEST --> CI
    CI --> COV
    
    style UNIT fill:#4CAF50,color:#fff
    style CI fill:#FF9800,color:#fff
    style COV fill:#2196F3,color:#fff
```

---

## Technology Stack

```mermaid
graph TB
    subgraph "Runtime"
        NODE[Node.js 22 LTS]
        TS[TypeScript 5.7]
    end

    subgraph "Web Framework"
        EXPRESS[Express 5.2]
        RATE_LIM[express-rate-limit 8.2]
    end

    subgraph "MCP Protocol"
        SDK[MCP SDK 1.0<br/>modelcontextprotocol/sdk]
        JSONRPC[JSON-RPC 2.0]
    end

    subgraph "Database"
        SQLITE[better-sqlite3 12.6]
        FTS[SQLite FTS5 Extension]
    end

    subgraph "Parsing"
        XML[xml2js 0.6]
        ZOD[zod 4.3 - Validation]
    end

    subgraph "Caching"
        REDIS[ioredis 5.9]
        FAST_XML[fast-xml-parser 5.3]
    end

    subgraph "Azure"
        BLOB[Azure Storage Blob<br/>azure/storage-blob]
        IDENTITY[Azure Identity<br/>azure/identity]
    end

    subgraph "Testing"
        VIT[Vitest 4.0]
        SUPER_T[Supertest 7.2]
    end

    style NODE fill:#68A063,color:#fff
    style SQLITE fill:#003B57,color:#fff
    style REDIS fill:#DC382D,color:#fff
    style VIT fill:#6E9F18,color:#fff
```

---

## Future Enhancements

```mermaid
graph LR
    subgraph "Planned Features"
        F1[Multi-Tenant Support<br/>Per-organization databases]
        F2[GraphQL API<br/>Alternative to JSON-RPC]
        F3[Webhook Notifications<br/>Metadata updates]
        F4[Advanced Analytics<br/>Usage metrics]
    end

    subgraph "Performance"
        P1[PostgreSQL<br/>Replace SQLite for scale]
        P2[CDN Caching<br/>Edge distribution]
        P3[GraphQL DataLoader<br/>Batch queries]
    end

    subgraph "Developer Experience"
        D1[VS Code Extension<br/>Direct integration]
        D2[CLI Tool<br/>Local development]
        D3[REST API<br/>Non-MCP clients]
    end
    
    style F1 fill:#2196F3,color:#fff
    style P1 fill:#FF9800,color:#fff
    style D1 fill:#4CAF50,color:#fff
```

---

## Conclusion

This architecture provides:

✅ **High Performance** - FTS5 full-text search with Redis caching  
✅ **Scalability** - Stateless design, horizontal scaling ready  
✅ **Reliability** - Error handling, rate limiting, health checks  
✅ **Security** - OAuth 2.0, HTTPS, Managed Identity  
✅ **Maintainability** - TypeScript, comprehensive tests, CI/CD  
✅ **Cost-Effective** - Serverless Azure App Service, efficient caching  

The modular design allows for easy extension and adaptation to different D365 F&O environments while maintaining compatibility with the MCP protocol standard.
