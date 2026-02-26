# D365 Finance & Operations X++ Development

This workspace contains D365FO code. **Always use the specialized MCP tools**  pre-indexed symbol database with 584,799+ D365FO objects.

---

> ##  MANDATORY RULE  EDITING D365FO FILES
>
> **After analysis, you MUST use `modify_d365fo_file()` to apply any changes.**
>
>  **NEVER** edit D365FO objects with built-in tools:
> - `replace_string_in_file` / `multi_replace_string_in_file` / `edit_file` / `apply_patch`
> - PowerShell scripts (`Set-Content`, `Add-Content`, any shell-based file write)
> - `create_file` on an existing object
>
>  **ALWAYS** use:
> - `modify_d365fo_file()`  edit existing classes, tables, forms (add-method, add-field, modify-property)
> - `create_d365fo_file()`  create new objects
>
> **Pattern:**
> ```
> 1. get_class_info("MyClass")                       analyze (compact=true by default)
> 2. get_method_signature(class, method)             only if you need a body
> 3. modify_d365fo_file()                            apply
>    NOT: replace_string_in_file                       FORBIDDEN
>    NOT: PowerShell script                            FORBIDDEN
> ```

> ## ⚡ TOKEN BUDGET — READ BEFORE EVERY CALL
>
> - `get_class_info` returns **signatures only** by default (`compact=true`) — do NOT pass `compact=false` unless you need to read a body
> - **NEVER call `get_class_info` more than 2× per turn** — use `get_method_signature(class, method)` for individual method bodies
> - `search_extensions` can return large results — use at most once per turn

---

## START HERE

For any D365FO request, **start with MCP tools  never** `code_search`, `grep_search`, `semantic_search`, `get_file`, `read_file` on .xml/.xpp.

| Request | MCP Tools |
|---------|-----------|
| Fix bug / review | `get_class_info`  `suggest_method_implementation`  `find_references` |
| Refactor / improve | `get_class_info`  `analyze_class_completeness`  `analyze_code_patterns` |
| Find best practice | `analyze_code_patterns`  `get_api_usage_patterns` |
| Optimize query | `get_table_info`  `analyze_code_patterns` |
| Where is X used? | `find_references(targetName)` |
| How does X work? | `get_class_info` / `get_table_info` / `get_form_info` |

## Critical Rules

### Forbidden built-in tools on D365FO files

|  Built-in |  MCP Tool |
|-------------|------------|
| `code_search`, `file_search`, `grep_search` | `search()`, `batch_search()` |
| `get_file`, `read_file` on .xml/.xpp | `get_class_info()`, `get_table_info()`, `get_form_info()` |
| `edit_file`, `apply_patch`, `replace_string_in_file` | `modify_d365fo_file()` |
| `create_file` for D365FO objects | `create_d365fo_file()` |

### Non-Negotiable Rules

1. **NEVER** use built-in file/edit tools on D365FO .xml or .xpp files
2. **NEVER** guess method signatures  call `get_method_signature(className, methodName)` before CoC extensions
3. **NEVER** use `create_file` for D365FO objects  use `create_d365fo_file()`
4. **NEVER** call `create_d365fo_file` without `projectPath` or `solutionPath`  model auto-detected from `.rnrproj`; without it file may land in Microsoft standard model!
5. **NEVER** edit `.label.txt` files directly  use `create_label()`; always run `search_labels()` first
6. **ALWAYS** pass `fieldsHint` when user describes table fields  without it table will be INCOMPLETE
7. **ALWAYS** pass `primaryKeyFields` for composite PKs (2+ fields)
8. **ALWAYS** pass `methods=["find","exist"]` to `generate_smart_table()` when user requests those methods  never add them via `modify_d365fo_file` afterwards
9. **NEVER** include model prefix in `name` param of `generate_smart_table`/`generate_smart_form`  prefix is applied automatically (causes double-prefix)
10. **NEVER** use `get_enum_info()` for EDTs  use `get_edt_info()` instead
11. **NEVER** infer the target model from search results or object names — the `model` field in search/get_table_info results is the SOURCE model of that existing object, NOT where you should create new objects. The target model for ALL create/modify operations is ALWAYS from `.mcp.json` (projectPath/modelName). Example of WRONG reasoning: task involves a report → search returns objects from "AslReports" → ❌ DO NOT use "AslReports". Use the configured model.

### generate_smart_table / generate_smart_form  TWO success cases

**Case A  Azure/Linux** (response contains `ℹ MCP server is running on Azure/Linux`):
- Tool returned XML  call `create_d365fo_file(xmlContent="<XML>", addToProject=true)` immediately  STOP
-  NEVER use `create_file`, PowerShell, or `modify_d365fo_file` instead

**Case B  Windows direct-write** (response contains ` DO NOT call create_d365fo_file`):
- File already written to disk  STOP, tell user to reload VS project
-  NEVER call `create_d365fo_file` again

### ⚠️ NEVER bypass create_d365fo_file to "work around" prefix handling

The `create_d365fo_file` tool derives the object name prefix from the `modelName` parameter — it is NOT hardcoded to any value (not "Asl", not anything else). If modelName is "MyModel", the prefix is "MyModel".
- Pass the base name WITHOUT prefix: `objectName="InventoryByZones"`, `modelName="MyModel"` → tool creates `MyModelInventoryByZones`
- Double-prefix is prevented automatically: `objectName="MyModelInventoryByZones"` + `modelName="MyModel"` → tool detects prefix already present → uses name as-is
- ❌ NEVER write XML files directly with `create_file` or PowerShell because you think the prefix logic is wrong
- ❌ NEVER edit .rnrproj manually — `create_d365fo_file` with `addToProject=true` handles it

## Available MCP Tools

### Search & Discovery
| Tool | Use for |
|------|---------|
| `search(query, type?)` | Find any D365FO symbol (class, table, method, field, enum, edt, form, query) |
| `batch_search(queries[])` | Multiple searches in parallel |
| `search_extensions(query)` | Custom/ISV code only |
| `get_class_info(className, compact?, methodOffset?)` | Class signatures (`compact=true` default, 15/page). Set `compact=false` + `methodOffset` only to read bodies |
| `get_table_info(tableName)` | Fields, indexes, relations, methods |
| `get_enum_info(enumName)` | Enum values (NOT for EDTs) |
| `get_edt_info(edtName)` | EDT definition, base type, constraints |
| `code_completion(symbolName)` | IntelliSense-like method/field listing |

### Object Info
| Tool | Use for |
|------|---------|
| `get_form_info(formName)` | Datasources, controls, methods |
| `get_query_info(queryName)` | Datasources, joins, ranges |
| `get_view_info(viewName)` | View / data entity structure |
| `get_method_signature(className, methodName, includeCocTemplate?)` | **Preferred way to get a full method body** — required before CoC. Pass `includeCocTemplate: true` only when writing a CoC extension |
| `find_references(targetName, targetType?)` | Where-used analysis |

### Code Generation & Analysis
| Tool | Use for |
|------|---------|
| `analyze_code_patterns(scenario)` | Find patterns before generating code |
| `suggest_method_implementation(className, methodName)` | Real implementation examples |
| `analyze_class_completeness(className)` | Missing standard methods |
| `get_api_usage_patterns(apiName)` | Typical initialization & usage |
| `generate_code(pattern, name)` | Boilerplate: `class`, `runnable`, `form-handler`, `data-entity`, `batch-job`, `table-extension` |

### Smart Object Generation
| Tool | Use for |
|------|---------|
| `get_table_patterns(tableGroup?, similarTo?)` | Analyze patterns before creating table |
| `get_form_patterns(formPattern?, tableName?)` | Analyze patterns before creating form |
| `suggest_edt(fieldName, context?)` | Suggest correct EDT for field |
| `generate_smart_table(name, fieldsHint?, primaryKeyFields?, methods?, ...)` | AI table generation |
| `generate_smart_form(name, dataSource?, formPattern?, ...)` | AI form generation |

### File Operations
| Tool | Use for |
|------|---------|
| `generate_d365fo_xml(objectType, objectName)` | Preview XML before creating |
| `create_d365fo_file(objectType, objectName, modelName, projectPath?, xmlContent?, addToProject?)` | Create new D365FO file |
| `modify_d365fo_file(objectType, objectName, operation, ...)` | Edit existing (add-method, add-field, modify-property, remove-method, remove-field) |

### Labels
| Tool | Use for |
|------|---------|
| `search_labels(query)` | **Always call first** before creating labels |
| `get_label_info(labelId?, model?)` | Get translations, list label files |
| `create_label(labelId, labelFileId, model, translations[])` | Create new label |

## File Paths & Model Name

AOT path: `C:\AOSService\PackagesLocalDirectory\{Model}\{Model}\Ax{Type}\{Name}.xml`

- Always provide `projectPath` in `create_d365fo_file`  auto-extracts `ModelName` from `.rnrproj`
- Without `projectPath`: `modelName` used AS-IS  risk of landing in Microsoft standard model!

`.mcp.json` in **MCP server directory** (next to `package.json`):
```json
{
  "servers": {
    "context": {
      "modelName": "MyModel",
      "packagePath": "C:\\AOSService\\PackagesLocalDirectory",
      "projectPath": "C:\\repos\\MySolution\\MyProject\\MyProject.rnrproj"
    }
  }
}
```

XML formatting: TABs for indentation (never spaces); CDATA for X++ source: `<![CDATA[ ... ]]>`
