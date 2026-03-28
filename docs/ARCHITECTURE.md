# Architecture Overview

This document provides visual diagrams and detailed explanations of the D365 F&O MCP Server architecture.

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Request Flow](#request-flow)
3. [Component Architecture](#component-architecture)
4. [Data Flow](#data-flow)
5. [C# Bridge Architecture](#c-bridge-architecture)
6. [Deployment Architecture](#deployment-architecture)
7. [Database Schema](#database-schema)

---

## High-Level Architecture

````mermaid
graph TB
    subgraph "Client Layer"
        VS[Visual Studio 2022 17.14+ GitHub Copilot Agent Mode]
        VS2026[Visual Studio 2026 GitHub Copilot Agent Mode]
    end

    subgraph "Azure Cloud"
        subgraph "App Service"
            MCP[MCP Server - Node.js 24 LTS, Express 5.x HTTP]
        end
        
        subgraph "Storage"
            BLOB[Azure Blob Storage - Symbols and Labels DBs]
        end
    end

    subgraph "MCP Server Components"
        HTTP[HTTP Transport Layer - Express + Rate Limiting]
        PROTO[MCP Protocol Handler - JSON-RPC 2.0]
        TOOLS[Tool Handlers - 54 MCP Tools]
        DB[(Symbols Database - FTS5, 584K+ symbols)]
        LDB[(Labels Database - FTS5, 19M+ labels, 70 languages)]
        CACHE[Redis Cache - Optional]
    end

    subgraph "C# Metadata Bridge — Windows only"
        BRIDGE_EXE[D365MetadataBridge.exe - .NET 4.8 child process]
        READ_SVC[MetadataReadService - Read operations]
        WRITE_SVC[MetadataWriteService - Create/Modify via API]
        IMETA[IMetadataProvider - Live D365FO metadata]
        XREF[(DYNAMICSXREFDB - Cross-reference database)]
    end

    VS -->|"Streamable HTTP, API Key"| MCP
    VS2026 -->|"Streamable HTTP, API Key"| MCP
    MCP -->|"Download on startup"| BLOB
    MCP --> HTTP
    HTTP --> PROTO
    PROTO --> TOOLS
    TOOLS --> DB
    TOOLS --> LDB
    TOOLS -.->|"Optional"| CACHE
    TOOLS -.->|"Read/Write via bridge"| BRIDGE_EXE
    BRIDGE_EXE --> READ_SVC
    BRIDGE_EXE --> WRITE_SVC
    READ_SVC --> IMETA
    WRITE_SVC -->|"Create / Update"| IMETA
    BRIDGE_EXE --> XREF
    
    style VS fill:#68217A,color:#fff
    style VS2026 fill:#0078D4,color:#fff
    style MCP fill:#00A4EF,color:#fff
    style BLOB fill:#FF6C00,color:#fff
    style DB fill:#4CAF50,color:#fff
    style LDB fill:#4CAF50,color:#fff
    style CACHE fill:#DC382D,color:#fff
    style BRIDGE_EXE fill:#512BD4,color:#fff
    style READ_SVC fill:#512BD4,color:#fff
    style WRITE_SVC fill:#E65100,color:#fff
    style IMETA fill:#512BD4,color:#fff
```

---

## Request Flow

````mermaid
sequenceDiagram
    participant IDE as Visual Studio 2022 / 2026
    participant HTTP as HTTP Transport
    participant MCP as MCP Protocol
    participant Handler as Tool Handler
    participant Tool as Tool Implementation
    participant Bridge as C# Bridge (Windows)
    participant Cache as Redis Cache
    participant DB as SQLite DB

    IDE->>HTTP: POST /mcp JSON-RPC Request
    HTTP->>HTTP: Rate Limit Check
    HTTP->>MCP: Parse JSON-RPC
    MCP->>MCP: Route Method
    
    alt Initialize
        MCP-->>IDE: Server Capabilities
    else Tools List
        MCP-->>IDE: 54 Tool Definitions
    else Tool Call
        MCP->>Handler: Route to Handler
        Handler->>Tool: Execute Tool
        alt Read Operation (get_table_info, get_class_info, ...)
            Tool->>Bridge: tryBridge*() — bridge-primary (12 tools)
            alt Bridge Available & Object Found
                Bridge-->>Tool: Live Metadata Result
            else Bridge Unavailable
                Tool->>Cache: Check Cache
                alt Cache Hit
                    Cache-->>Tool: Cached Result
                else Cache Miss
                    Tool->>DB: FTS5 Query
                    DB-->>Tool: Symbol Results
                    Tool->>Cache: Store Result
                end
            end
        else Write Operation (create_d365fo_file, modify_d365fo_file)
            Tool->>Bridge: bridge*() — 18 create types, 25 of 25 modify ops
            alt Bridge Available & Type Supported
                Bridge-->>Tool: Write Result (file path)
            else Bridge Unavailable
                Tool->>Tool: Error — bridge is required for all modify operations
            end
        else Index Maintenance (update_symbol_index, undo_last_modification)
            Tool->>DB: Remove stale symbols + labels from SQLite
            Tool->>Cache: Invalidate Redis cache entries
            Tool->>Bridge: Refresh provider state
        end
        Tool-->>Handler: Tool Result
        Handler-->>MCP: Formatted Response
        MCP-->>IDE: JSON-RPC Response
    end
```

---

## Component Architecture

````mermaid
graph LR
    subgraph "Entry Point"
        INDEX[index.ts - Main Entry]
    end

    subgraph "Server Layer"
        SERVER[mcpServer.ts - MCP Server Config]
        TRANSPORT[transport.ts - HTTP Transport]
        HANDLER[toolHandler.ts - Tool Router]
    end

    subgraph "Tool Layer"
        subgraph "Search & Discovery"
            SEARCH[search.ts - search]
            BATCH[batchSearch.ts - batch_search]
            EXT[extensionSearch.ts - search_extensions]
            REFS[findReferences.ts - find_references]
            COMP[completion.ts - code_completion]
        end
        subgraph "Object Info"
            CLASS[classInfo.ts - get_class_info]
            TABLE[tableInfo.ts - get_table_info]
            FORM[formInfo.ts - get_form_info]
            QUERY[queryInfo.ts - get_query_info]
            VIEW[viewInfo.ts - get_view_info]
            ENUM[enumInfo.ts - get_enum_info]
            EDT[edtInfo.ts - get_edt_info]
            REPORT[reportInfo.ts - get_report_info]
            ENTITY[dataEntityInfo.ts - get_data_entity_info]
            SIGNATURE[methodSignature.ts - get_method_signature]
            MSRC[getMethodSource.ts - get_method_source]
        end
        subgraph "Extensions & Security"
            COCEXT[findCocExtensions.ts - find_coc_extensions]
            EVTHDL[findEventHandlers.ts - find_event_handlers]
            TBLEXT[tableExtensionInfo.ts - get_table_extension_info]
            EXTPTS[analyzeExtensionPoints.ts - analyze_extension_points]
            EXTSTRAT[extensionStrategyAdvisor.ts - recommend_extension_strategy]
            SECART[securityArtifactInfo.ts - get_security_artifact_info]
            SECCOV[securityCoverageInfo.ts - get_security_coverage_for_object]
            MENU[menuItemInfo.ts - get_menu_item_info]
        end
        subgraph "Code Generation"
            GEN[codeGen.ts - generate_code]
            GENXML[generateD365Xml.ts - generate_d365fo_xml]
            CREATE[createD365File.ts - create_d365fo_file]
            MODIFY[modifyD365File.ts - modify_d365fo_file]
            SMTABLE[generateSmartTable.ts - generate_smart_table]
            SMFORM[generateSmartForm.ts - generate_smart_form]
            SMRPT[generateSmartReport.ts - generate_smart_report]
        end
        subgraph "Analysis & Patterns"
            PATTERN[analyzePatterns.ts - analyze_code_patterns]
            SUGGEST[suggestImplementation.ts - suggest_method_implementation]
            COMPLETE[analyzeCompleteness.ts - analyze_class_completeness]
            API[apiUsagePatterns.ts - get_api_usage_patterns]
            KNOWLEDGE[xppKnowledge.ts - get_xpp_knowledge]
            TPAT[getTablePatterns.ts - get_table_patterns]
            FPAT[getFormPatterns.ts - get_form_patterns]
            SEDT[suggestEdt.ts - suggest_edt]
        end
        subgraph "Labels"
            SLABELS[searchLabels.ts - search_labels]
            GLABEL[getLabelInfo.ts - get_label_info]
            CLABEL[createLabel.ts - create_label]
            RLABEL[renameLabel.ts - rename_label]
        end
        subgraph "Workspace"
            WSINFO[xppTools.ts - get_workspace_info]
            VERIFYD[verifyD365Project.ts - verify_d365fo_project]
            VALNAME[validateObjectNaming.ts - validate_object_naming]
        end
    end

    subgraph "Metadata Layer"
        SYMBOL[symbolIndex.ts - SQLite + FTS5]
        PARSER[xmlParser.ts - XML Metadata]
    end

    subgraph "Infrastructure"
        CACHE_SVC[redisCache.ts - Cache Service]
        RATE[rateLimiter.ts - Rate Limiting]
        DOWNLOAD[download.ts - Azure Blob DL]
    end

    subgraph "C# Metadata Bridge — Windows only"
        BCLIENT[bridgeClient.ts - JSON-RPC child process]
        BADAPT[bridgeAdapter.ts - 12 tryBridge* read + 32 bridge* write]
        BTYPES[bridgeTypes.ts - Response types incl. BridgeWriteResult, BridgeDeleteResult, BridgeCapabilities]
    end

    INDEX --> SERVER
    INDEX --> TRANSPORT
    INDEX --> SYMBOL
    INDEX --> PARSER
    INDEX --> CACHE_SVC
    INDEX --> DOWNLOAD
    INDEX --> BCLIENT

    SERVER --> HANDLER
    HANDLER --> SEARCH
    HANDLER --> BATCH
    HANDLER --> EXT
    HANDLER --> REFS
    HANDLER --> COMP
    HANDLER --> CLASS
    HANDLER --> TABLE
    HANDLER --> FORM
    HANDLER --> QUERY
    HANDLER --> VIEW
    HANDLER --> ENUM
    HANDLER --> EDT
    HANDLER --> REPORT
    HANDLER --> ENTITY
    HANDLER --> SIGNATURE
    HANDLER --> MSRC
    HANDLER --> COCEXT
    HANDLER --> EVTHDL
    HANDLER --> TBLEXT
    HANDLER --> EXTPTS
    HANDLER --> SECART
    HANDLER --> SECCOV
    HANDLER --> MENU
    HANDLER --> GEN
    HANDLER --> GENXML
    HANDLER --> CREATE
    HANDLER --> MODIFY
    HANDLER --> SMTABLE
    HANDLER --> SMFORM
    HANDLER --> SMRPT
    HANDLER --> PATTERN
    HANDLER --> SUGGEST
    HANDLER --> COMPLETE
    HANDLER --> API
    HANDLER --> TPAT
    HANDLER --> FPAT
    HANDLER --> SEDT
    HANDLER --> SLABELS
    HANDLER --> GLABEL
    HANDLER --> CLABEL
    HANDLER --> RLABEL
    HANDLER --> WSINFO
    HANDLER --> VERIFYD
    HANDLER --> VALNAME

    CLASS -.-> BADAPT
    TABLE -.-> BADAPT
    ENUM -.-> BADAPT
    EDT -.-> BADAPT
    FORM -.-> BADAPT
    QUERY -.-> BADAPT
    VIEW -.-> BADAPT
    REPORT -.-> BADAPT
    ENTITY -.-> BADAPT
    SEARCH -.-> BADAPT
    REFS -.-> BADAPT
    MSRC -.-> BADAPT
    BADAPT --> BCLIENT
    BCLIENT --> BTYPES

    SEARCH --> SYMBOL
    BATCH --> SYMBOL
    EXT --> SYMBOL
    REFS --> SYMBOL
    COMP --> SYMBOL
    CLASS --> SYMBOL
    CLASS --> PARSER
    TABLE --> SYMBOL
    TABLE --> PARSER
    FORM --> SYMBOL
    FORM --> PARSER
    QUERY --> SYMBOL
    QUERY --> PARSER
    VIEW --> SYMBOL
    VIEW --> PARSER
    ENUM --> SYMBOL
    ENUM --> PARSER
    EDT --> SYMBOL
    EDT --> PARSER
    REPORT --> SYMBOL
    REPORT --> PARSER
    ENTITY --> SYMBOL
    ENTITY --> PARSER
    SIGNATURE --> SYMBOL
    SIGNATURE --> PARSER
    MSRC --> SYMBOL
    MSRC --> PARSER
    COCEXT --> SYMBOL
    EVTHDL --> SYMBOL
    TBLEXT --> SYMBOL
    EXTPTS --> SYMBOL
    SECART --> SYMBOL
    SECART --> PARSER
    SECCOV --> SYMBOL
    MENU --> SYMBOL
    PATTERN --> SYMBOL
    SUGGEST --> SYMBOL
    COMPLETE --> SYMBOL
    API --> SYMBOL
    TPAT --> SYMBOL
    FPAT --> SYMBOL
    SMTABLE --> SYMBOL
    SMFORM --> SYMBOL
    SMRPT --> SYMBOL
    SEDT --> SYMBOL
    SLABELS --> SYMBOL
    GLABEL --> SYMBOL
    VALNAME --> SYMBOL

    SEARCH -.-> CACHE_SVC
    BATCH -.-> CACHE_SVC
    CLASS -.-> CACHE_SVC
    TABLE -.-> CACHE_SVC
    FORM -.-> CACHE_SVC
    QUERY -.-> CACHE_SVC
    VIEW -.-> CACHE_SVC
    ENUM -.-> CACHE_SVC
    COMP -.-> CACHE_SVC
    SIGNATURE -.-> CACHE_SVC
    REFS -.-> CACHE_SVC

    TRANSPORT --> RATE
    
    style INDEX fill:#FF6C00,color:#fff
    style SYMBOL fill:#4CAF50,color:#fff
    style CACHE_SVC fill:#DC382D,color:#fff
```

---

## Data Flow

### 1. Startup Flow

````mermaid
graph TD
    START([Server Startup]) --> ENV[Load .env Config]
    ENV --> CACHE_INIT[Initialize Redis Cache - Optional]
    CACHE_INIT --> DB_CHECK{Database Exists?}
    
    DB_CHECK -->|Yes| DB_LOAD[Load SQLite Database]
    DB_CHECK -->|No| AZURE_CHECK{Azure Blob Configured?}
    
    AZURE_CHECK -->|Yes| DOWNLOAD[Download from Azure Blob]
    AZURE_CHECK -->|No| INDEX_META[Index Local Metadata]
    
    DOWNLOAD --> DB_LOAD
    INDEX_META --> DB_LOAD
    
    DB_LOAD --> FTS_INIT[Initialize FTS5 Index]
    FTS_INIT --> COUNT[Count Symbols - 584K+]
    COUNT --> BRIDGE_CHECK{Windows + D365FO DLLs?}
    
    BRIDGE_CHECK -->|Yes| BRIDGE_START[Start D365MetadataBridge.exe child process]
    BRIDGE_CHECK -->|No| MCP_INIT
    
    BRIDGE_START --> BRIDGE_PING[Ping bridge — wait for 'pong']
    BRIDGE_PING --> MCP_INIT[Initialize MCP Server]
    MCP_INIT --> HTTP_START[Start HTTP Server - Port 8080]
    HTTP_START --> READY([Server Ready])
    
    style START fill:#4CAF50,color:#fff
    style READY fill:#4CAF50,color:#fff
    style DOWNLOAD fill:#FF6C00,color:#fff
    style DB_LOAD fill:#2196F3,color:#fff
    style BRIDGE_START fill:#512BD4,color:#fff
```

### 2. Search Query Flow

````mermaid
graph TD
    QUERY([User Search Query]) --> CACHE_KEY[Generate Cache Key - search:query:limit]
    CACHE_KEY --> CACHE_CHECK{Cache Hit?}
    
    CACHE_CHECK -->|Yes| CACHE_RETURN[Return Cached Results]
    CACHE_CHECK -->|No| FTS_QUERY[FTS5 Full-Text Search]
    
    FTS_QUERY --> RESULTS[Raw Symbol Results]
    RESULTS --> FORMAT[Format Results - TYPE: Name - Signature]
    FORMAT --> CACHE_STORE[Store in Cache - TTL: 1 hour]
    CACHE_STORE --> RETURN([Return Results])
    CACHE_RETURN --> RETURN
    
    style QUERY fill:#4CAF50,color:#fff
    style CACHE_CHECK fill:#FF9800,color:#fff
    style FTS_QUERY fill:#2196F3,color:#fff
    style RETURN fill:#4CAF50,color:#fff
```

### 3. Class Info Query Flow

````mermaid
graph TD
    CLASS_REQ([Get Class Info]) --> BRIDGE_TRY{Bridge Available?}
    
    BRIDGE_TRY -->|Yes| BRIDGE_CALL[tryBridgeClass — IMetadataProvider]
    BRIDGE_TRY -->|No| DB_LOOKUP
    
    BRIDGE_CALL --> BRIDGE_OK{Object Found?}
    BRIDGE_OK -->|Yes| RESPONSE
    BRIDGE_OK -->|No| DB_LOOKUP[Symbol Index Lookup]
    
    DB_LOOKUP --> FOUND{Symbol Found?}
    
    FOUND -->|No| ERROR_404[Return Not Found]
    FOUND -->|Yes| CACHE_CHECK{Cache Hit?}
    
    CACHE_CHECK -->|Yes| CACHE_RETURN[Return Cached Class Info]
    CACHE_CHECK -->|No| XML_PARSE[Parse XML Metadata File]
    
    XML_PARSE --> XML_SUCCESS{Parsing Successful?}
    
    XML_SUCCESS -->|Yes| EXTRACT[Extract Class Details - Methods, Inheritance, etc.]
    XML_SUCCESS -->|No| FALLBACK[Fallback to Database - Basic Symbol Info]
    
    EXTRACT --> CACHE_STORE[Store in Cache]
    FALLBACK --> RESPONSE
    CACHE_STORE --> RESPONSE([Return Class Info])
    CACHE_RETURN --> RESPONSE
    ERROR_404 --> RESPONSE
    
    style CLASS_REQ fill:#4CAF50,color:#fff
    style BRIDGE_CALL fill:#512BD4,color:#fff
    style XML_PARSE fill:#FF9800,color:#fff
    style FALLBACK fill:#DC382D,color:#fff
    style RESPONSE fill:#4CAF50,color:#fff
```

---

## C# Bridge Architecture

> **The C# bridge is mandatory on Windows D365FO development VMs.** All write operations
> (`create_d365fo_file`, `modify_d365fo_file`) require it. Read operations fall back to
> SQLite + XML parser when the bridge is unavailable (Azure deployment).
> See [BRIDGE.md](BRIDGE.md) for endpoint reference and [SETUP.md](SETUP.md) for build instructions.

### Process Lifecycle

````mermaid
sequenceDiagram
    participant MCP as MCP Server (Node.js)
    participant Bridge as D365MetadataBridge.exe (.NET 4.8)
    participant Meta as IMetadataProvider (D365FO DLLs)
    participant XRef as DYNAMICSXREFDB (SQL Server)

    MCP->>Bridge: spawn child process (stdio JSON-RPC)
    Bridge->>Bridge: Load D365FO DLLs from PackagesLocalDirectory
    Bridge->>Meta: Initialize IMetadataProvider
    Bridge->>XRef: Open SQL connection (optional)
    Bridge-->>MCP: ready (stdout)

    loop Every tool call
        MCP->>Bridge: JSON-RPC request (stdin)
        alt Read operation
            Bridge->>Meta: Query metadata
            Meta-->>Bridge: Result
        else Write operation
            Bridge->>Meta: Create/Modify via DiskProvider
            Meta-->>Bridge: Write result + file path
        else Cross-reference query
            Bridge->>XRef: SQL query on DYNAMICSXREFDB
            XRef-->>Bridge: Rows
        end
        Bridge-->>MCP: JSON-RPC response (stdout)
    end

    MCP->>Bridge: SIGTERM / process.kill()
    Bridge->>Bridge: Dispose providers, close SQL
```

### Integration Pattern — Bridge-First with Fallback

Every read tool uses the **try-bridge-first** pattern:

```
Tool handler:
  1. tryBridge*(args)        → call C# bridge via JSON-RPC (stdin/stdout)
     ├─ Bridge available + object found → return live metadata
     └─ Bridge unavailable or error    → continue to step 2
  2. symbolIndex.search()    → FTS5 query on SQLite symbols database
  3. xmlParser.parse()       → Parse raw XML from PackagesLocalDirectory
  4. Format + cache result   → Store in Redis (optional)
```

Write tools (`create_d365fo_file`, `modify_d365fo_file`) have **no fallback** — if the bridge
is unavailable, they return an error. This is by design: only the C# `IMetadataProvider` API
can safely create/modify D365FO objects (correct XML encoding, AOT path, `.rnrproj` registration).

### C# Components

````mermaid
graph TB
    subgraph "D365MetadataBridge.exe"
        MAIN[Program.cs — stdin/stdout JSON-RPC loop]
        ROUTER[RequestRouter — dispatches method → handler]
        
        subgraph "Read Services"
            READ_META[MetadataReadService]
            READ_CLASS[getClassInfo, getMethodSource, getMethodSignature]
            READ_TABLE[getTableInfo, getEnumInfo, getEdtInfo]
            READ_FORM[getFormInfo, getQueryInfo, getViewInfo]
            READ_REPORT[getReportInfo, getDataEntityInfo]
            READ_SEARCH[search, findReferences]
        end

        subgraph "Write Services"
            WRITE_META[MetadataWriteService]
            WRITE_CREATE[createObject — 18 object types]
            WRITE_MODIFY[modifyObject — 25 operation types]
        end

        subgraph "Cross-Reference Service"
            XREF_SVC[CrossReferenceService]
            XREF_COC[findCocExtensions — CoC detection]
            XREF_EVT[findEventHandlers — event handler detection]
            XREF_REF[findReferences — enriched caller/callee]
            XREF_API[getApiUsagePatterns — usage statistics]
        end

        subgraph "DLL Loading"
            LOADER[AssemblyResolver — loads D365FO DLLs]
            IMETA_PROV[IMetadataProvider — read access]
            DISK_PROV[DiskProvider — write access via explicit interface casts]
        end
    end

    MAIN --> ROUTER
    ROUTER --> READ_META
    ROUTER --> WRITE_META
    ROUTER --> XREF_SVC
    READ_META --> READ_CLASS
    READ_META --> READ_TABLE
    READ_META --> READ_FORM
    READ_META --> READ_REPORT
    READ_META --> READ_SEARCH
    WRITE_META --> WRITE_CREATE
    WRITE_META --> WRITE_MODIFY
    READ_META --> IMETA_PROV
    WRITE_META --> DISK_PROV
    XREF_SVC --> XREF_COC
    XREF_SVC --> XREF_EVT
    XREF_SVC --> XREF_REF
    XREF_SVC --> XREF_API

    style MAIN fill:#512BD4,color:#fff
    style WRITE_META fill:#E65100,color:#fff
    style XREF_SVC fill:#1565C0,color:#fff
```

### TypeScript Components

| File | Role |
|------|------|
| `src/bridge/bridgeClient.ts` | Spawns `.exe`, manages stdin/stdout JSON-RPC, handles timeouts & restarts |
| `src/bridge/bridgeAdapter.ts` | 12 `tryBridge*()` read functions + 32 `bridge*()` write functions |
| `src/bridge/bridgeTypes.ts` | TypeScript interfaces for bridge responses (`BridgeClassInfo`, `BridgeWriteResult`, etc.) |

### Write Operations — DiskProvider Discovery

Creating and modifying D365FO objects through the official API requires several non-obvious steps
that the bridge handles internally:

1. **DiskProvider discovery** — `IMetadataProvider` does not expose write methods directly.
   The bridge casts to internal interfaces (`IMetadataProviderInternal`, `IDiskModelProvider`)
   to reach `DiskProvider` which has `SaveObject()`.

2. **ModelSaveInfo resolution** — every write must specify which model owns the file.
   The bridge reads the model descriptor (`Descriptor/Model.xml`) to construct `ModelSaveInfo`.

3. **Explicit interface casts** — some D365FO interfaces hide members behind explicit
   implementations. The bridge casts to the exact interface (e.g. `ITable.SaveExtension()`)
   rather than calling via the class hierarchy.

4. **Auto-refresh** — after a successful write, the bridge invalidates its internal metadata
   cache so subsequent reads reflect the change immediately. The MCP server also invalidates
   its own SQLite + Redis caches.

### Index Lifecycle & Cache Invalidation

````mermaid
sequenceDiagram
    participant Tool as MCP Tool Handler
    participant Bridge as C# Bridge
    participant SQLite as SQLite Index
    participant Redis as Redis Cache

    Tool->>Bridge: bridgeCreate/Modify(args)
    Bridge-->>Tool: { success, filePath }

    Tool->>SQLite: Remove stale symbols by filePath
    Tool->>SQLite: Re-index new/updated file
    Tool->>Redis: Invalidate cache keys (objectName, type)
    Tool->>Bridge: Refresh internal metadata state
    Note over Tool: Subsequent get_*_info calls see updated data
```

### Data Source Comparison

| Capability | SQLite + FTS5 | XML Parser | C# Bridge |
|-----------|--------------|------------|-----------|
| Available on | All platforms | All platforms | Windows VM only |
| Symbol search (name, type) | ✅ Fast | ❌ | ✅ Live |
| Method signatures | ✅ Static snapshot | ✅ Parse on demand | ✅ Live |
| Method bodies | ✅ `sourceSnippet` (10 lines) | ✅ Full source | ✅ Full source |
| Cross-references (callers) | ✅ FTS approximation | ❌ | ✅ Exact (DYNAMICSXREFDB) |
| Create objects | ❌ | ❌ | ✅ 18 types |
| Modify objects | ❌ | ❌ | ✅ 25 operations |
| Label operations | ✅ Search | ❌ | ✅ Create/Rename |

---

## Deployment Architecture

````mermaid
graph TB
    subgraph "GitHub"
        REPO[GitHub Repository - main branch]
    end

    subgraph "GitHub Actions CI/CD"
        BUILD[Build Job - npm ci, test, build]
        DEPLOY[Deploy Job - Azure App Service]
    end

    subgraph "Azure Resources"
        subgraph "Resource Group: rg-xpp-mcp"
            APP[App Service - app-xpp-mcp - Linux P0v3, Node.js 24-lts]
            STORAGE[Storage Account - st-xpp-mcp - StorageV2, Hot, LRS]
        end
    end

    subgraph "Monitoring"
        LOGS[Application Insights - Logs & Metrics]
        HEALTH[Health Endpoint - /health Status Checks]
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

**Dual-Database Architecture** for performance optimization:
- **Symbols Database** (`xpp-metadata.db`, ~2 GB without UnitTest models / ~3 GB with) — Fast symbol searches
- **Labels Database** (`xpp-metadata-labels.db`, ~500 MB for 4 languages, up to 8 GB for all 70 languages) — Isolated label storage

### Symbols Database

````mermaid
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

### Labels Database

````mermaid
erDiagram
    LABELS {
        integer id PK
        text label_id "Label ID (e.g., MyLabel)"
        text label_file_id "File ID (e.g., MyModel)"
        text model "Model name"
        text language "Language code (en-US, cs, sk, de)"
        text text "Translated text"
        text comment "Developer comment"
        text file_path "Source .label.txt file"
    }
    
    LABELS_FTS {
        text label_id "FTS5 indexed"
        text text "FTS5 indexed"
        text comment "FTS5 indexed"
    }
    
    LABELS ||--|| LABELS_FTS : "mirrored for FTS5"
```

**Why Separate Databases?**
- Symbol searches ignore label rows → **10-30× faster**
- Labels DB size depends on language selection (4 languages = ~500 MB, 70 languages = ~8 GB)
- Each database has its own SQLite cache and optimization settings

### Symbol Types

| Type | Description | Example |
|------|-------------|---------|
| `class` | X++ Class | `SalesFormLetter`, `CustPostInvoice` |
| `table` | AOT Table | `CustTable`, `InventTable` |
| `method` | Class/Table Method | `insert()`, `validateWrite()` |
| `field` | Table Field | `AccountNum`, `Name` |
| `enum` | Enumeration | `NoYes`, `TransactionType` |
| `edt` | Extended Data Type | `CustAccount`, `ItemId` |

Beyond these core fields, each symbol row carries enhanced metadata (description, semantic tags,
source snippet, complexity score, used types, extends chain, and more) to give Copilot richer
context during code generation. See the `symbols` table DDL in `src/database/symbolIndex.ts`
for the full schema.

---

## MCP Protocol Endpoints

````mermaid
graph LR
    subgraph "MCP Protocol Methods"
        INIT[initialize - Server Capabilities]
        NOTIFY[notifications/initialized - Handshake Complete]
        TOOLS_LIST[tools/list - 54 Available Tools]
        TOOLS_CALL[tools/call - Execute Tool]
        RES_LIST[resources/list - Empty]
        RES_TMPL[resources/templates/list - Empty]
        PROMPT_LIST[prompts/list - Code Review Prompt]
        PING[ping - Health Check]
    end

    INIT -.-> CAPS[Capabilities: tools, resources, prompts]
    TOOLS_LIST -.-> TOOL_DEFS["54 tools: search, batch_search, search_extensions, get_class_info, get_table_info, code_completion, get_method_signature, get_method_source, find_references, get_form_info, get_query_info, get_view_info, get_enum_info, get_edt_info, get_report_info, generate_code, analyze_code_patterns, suggest_method_implementation, analyze_class_completeness, get_api_usage_patterns, get_xpp_knowledge, get_d365fo_error_help, generate_d365fo_xml, create_d365fo_file, modify_d365fo_file, search_labels, get_label_info, create_label, rename_label, get_table_patterns, get_form_patterns, generate_smart_table, generate_smart_form, generate_smart_report, suggest_edt, get_security_artifact_info, get_security_coverage_for_object, get_menu_item_info, find_coc_extensions, find_event_handlers, get_table_extension_info, get_data_entity_info, analyze_extension_points, recommend_extension_strategy, validate_object_naming, get_workspace_info, verify_d365fo_project, update_symbol_index, build_d365fo_project, trigger_db_sync, run_bp_check, run_systest_class, review_workspace_changes, undo_last_modification"]
    TOOLS_CALL -.-> EXEC[Tool Execution: search DB, parse XML, return results]
    style INIT fill:#4CAF50,color:#fff
    style TOOLS_CALL fill:#2196F3,color:#fff
```

> For detailed tool parameters and example inputs/outputs, see [MCP_TOOLS.md](MCP_TOOLS.md).

### Local SDLC Execution

```mermaid
graph TD
    subgraph "IDE Layer"
        CP[Copilot Chat]
    end

    subgraph "MCP Server"
        SH[Tool Handlers]
    end

    subgraph "Local Execution (D365 Binaries)"
        MSB[MSBuild]
        SYNC[sync.exe]
        XPPBP[xppbp.exe]
        SYS[SysTestRunner.exe]
        GIT[Native Git CLI]
    end

    CP -->|Request| SH
    SH -->|build_d365fo_project| MSB
    SH -->|trigger_db_sync| SYNC
    SH -->|run_bp_check| XPPBP
    SH -->|sysTestRunner| SYS
    SH -->|review_workspace_changes| GIT
    SH -->|undo_last_modification| GIT
    
    MSB -->|Stdout| SH
    SYNC -->|XML Logs| SH
    XPPBP -->|Log file| SH
    SYS -->|Test Results| SH
    GIT -->|Diff/Status| SH
```

## Performance Optimizations

````mermaid
graph TD
    subgraph "Caching Strategy"
        L1[Request] --> L2{Redis Cache}
        L2 -->|Hit| L3[Return Cached]
        L2 -->|Miss| L4[Query Database]
        L4 --> L5[FTS5 Index Scan]
        L5 --> L6[Format Results]
        L6 --> L7[Store in Cache - TTL: 1h]
        L7 --> L3
    end

    subgraph "Rate Limiting"
        R1[Client Request] --> R2{Rate Check}
        R2 -->|OK| R3[Process Request]
        R2 -->|Exceeded| R4[429 Too Many Requests]
    end

    subgraph "Connection Pooling"
        C1[SQLite] --> C2[Single Connection - Read-Only Mode]
        C3[Redis] --> C4[Connection Pool - Max 10]
    end
    
    style L3 fill:#4CAF50,color:#fff
    style R4 fill:#DC382D,color:#fff
    style L5 fill:#2196F3,color:#fff
```

### Caching

- Default TTL: **1 hour** for search results, class/table info; **30 min** for completions
- Redis cache entries are **actively invalidated** on write operations (`create_d365fo_file`,
  `modify_d365fo_file`, `update_symbol_index`, `undo_last_modification`) — no stale data
- Write operations auto-invalidate: Redis keys + SQLite index + C# bridge state

### Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/mcp` | 500 requests | 15 minutes |
| `/health` | 1000 requests | 15 minutes |

---

## Security Architecture

````mermaid
graph TD
    subgraph "Authentication"
        A1[Client Request] --> A2[API Key / Bearer Token]
        A2 --> A3[apiKeyAuth Middleware]
    end

    subgraph "Authorization"
        B1[App Service] --> B2[Managed Identity]
        B2 --> B3[Azure Blob Access]
    end

    subgraph "Network Security"
        C1[HTTPS Only] --> C2[TLS 1.2+]
        C3[Rate Limiting] --> C4[Token-based + IP-based]
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

````mermaid
graph TD
    ERR([Error Occurs]) --> TYPE{Error Type?}
    
    TYPE -->|Network| NET[Network Error - Retry 3x]
    TYPE -->|Database| DB[Database Error - Log & Fallback]
    TYPE -->|Validation| VAL[Validation Error - 400 Bad Request]
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

````mermaid
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
        C1[Redis Cache] --> C2[Shared Cache Layer - Across Instances]
    end

    subgraph "Database"
        D1[SQLite Read-Only] --> D2[No Locking Issues - Concurrent Reads]
    end
    
    style H2 fill:#4CAF50,color:#fff
    style C2 fill:#DC382D,color:#fff
    style D2 fill:#2196F3,color:#fff
```

### Current Capacity

- **Storage:** ~2–3 GB symbols database (without/with UnitTest models) + ~500 MB labels database (4 languages) = ~2.5–3.5 GB total
- **Memory:** 1.75GB (P0v3) - ~800MB used
- **Throughput:** 500 req/15min per IP (configurable)
- **Latency:** 
  - Cache hit: <10ms
  - Cache miss: 50-200ms
  - Cold start: 15-30s (database download)

---

## Testing Architecture

````mermaid
graph TB
    subgraph "Test Pyramid"
        UNIT[Unit Tests - Tools, Utils, Metadata Parser]
        INT[Integration Tests - MCP Protocol, HTTP Transport]
        E2E[End-to-End Tests - Full MCP Protocol, User Scenarios]
    end

    subgraph "Test Infrastructure"
        VITEST[Vitest Test Runner]
        MOCKS[Mock Services - Cache, Parser, SymbolIndex]
        SUPER[Supertest - HTTP Integration Testing]
    end

    subgraph "CI/CD Testing"
        CI[GitHub Actions - Run on PR/Push]
        COV[Coverage Reports - v8 Provider]
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

````mermaid
graph TB
    subgraph "Runtime"
        NODE[Node.js 24 LTS]
        TS[TypeScript 6.0]
        DOTNET[.NET Framework 4.8 — Bridge, Windows only]
    end

    subgraph "Web Framework"
        EXPRESS[Express 5.2]
        RATE_LIM[express-rate-limit 8.3]
    end

    subgraph "MCP Protocol"
        SDK[MCP SDK 1.27 - modelcontextprotocol/sdk]
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
        REDIS[ioredis 5.10]
        FAST_XML[fast-xml-parser 5.4]
    end

    subgraph "Azure"
        BLOB[Azure Storage Blob - azure/storage-blob]
        IDENTITY[Azure Identity - azure/identity]
    end

    subgraph "Testing"
        VIT[Vitest 4.0]
        SUPER_T[Supertest 7.2]
    end

    style NODE fill:#68A063,color:#fff
    style DOTNET fill:#512BD4,color:#fff
    style SQLITE fill:#003B57,color:#fff
    style REDIS fill:#DC382D,color:#fff
    style VIT fill:#6E9F18,color:#fff
```

---

## Conclusion

This architecture provides:

✅ **High Performance** - FTS5 full-text search with Redis caching  
✅ **Live Metadata** - C# bridge provides always-fresh data on Windows D365FO VMs (see [BRIDGE.md](BRIDGE.md))  
✅ **Scalability** - Stateless design, horizontal scaling ready  
✅ **Reliability** - Error handling, rate limiting, health checks  
✅ **Security** - API Key auth, HTTPS, rate limiting  
✅ **Maintainability** - TypeScript, comprehensive tests, CI/CD  
✅ **Cost-Effective** - Serverless Azure App Service, efficient caching  

The modular design allows for easy extension and adaptation to different D365 F&O environments while maintaining compatibility with the MCP protocol standard.
