import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOCAL_TOOLS } from '../../src/server/serverMode';
import { TOOL_ANNOTATIONS } from '../../src/server/toolAnnotations';
import { toolSchemas } from '../../src/server/toolSchemas/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function extractSingleQuotedToolNames(source: string): string[] {
  const names = [...source.matchAll(/name:\s*'([^']+)'/g)].map(match => match[1]);
  return [...new Set(names)];
}

describe('tool inventory contract', () => {
  const startupCatalogSource = readRepoFile('src/index.ts');

  const mcpServerToolNames = [...new Set(toolSchemas.map(t => t.name))];
  const startupCatalogToolNames = extractSingleQuotedToolNames(startupCatalogSource);

  it('keeps mcpServer tools and startup catalog in sync', () => {
    expect(new Set(startupCatalogToolNames)).toEqual(new Set(mcpServerToolNames));
  });

  it('exposes the expected total tool count', () => {
    // 23 since get_method and suggest_edt were unpublished: their contracts moved
    // into get_object_info(options.method) and prepare(fieldsHint), both of which
    // already had the object in hand. Their handlers stay routable.
    expect(mcpServerToolNames).toHaveLength(23);
    expect(startupCatalogToolNames).toHaveLength(23);
  });

  it('keeps local-only tool set aligned with the published tool inventory', () => {
    const publishedTools = new Set(mcpServerToolNames);
    for (const toolName of LOCAL_TOOLS) {
      expect(publishedTools.has(toolName)).toBe(true);
    }

    expect(LOCAL_TOOLS.size).toBe(9);
    expect(mcpServerToolNames.filter(name => !LOCAL_TOOLS.has(name))).toHaveLength(14);
  });

  it('never tells the agent to call a tool that was retired by a consolidation', () => {
    // Guidance the agent copies verbatim — `nextSteps` in the strategy advisor,
    // the "call X next" tails on generators, the system prompt — outlived several
    // tool renames and kept naming `find_coc_extensions`, `generate_code`,
    // `get_xpp_knowledge`. Each such line costs a guaranteed Unknown-tool call
    // plus a retry, which is far more expensive than the line itself.
    //
    // The matcher used to require a trailing `(`. That anchor was too narrow and
    // let the whole class through: `validate_xpp` and `batch_search` were already
    // in this list while `✅ validate_xpp: no violations found` and
    // "`search` / `batch_search` for X" shipped to the model untouched, because
    // neither is followed by a paren. Match the bare NAME instead.
    //
    // Two legitimate uses of a legacy name survive, and are excluded by line
    // rather than by regex shape:
    //  • sub-request routing — `subRequest('find_coc_extensions', …)` — internal
    //    dispatch, never rendered to the model;
    //  • this test's own `retired` list.
    const retired = [
      'create_d365fo_file', 'modify_d365fo_file', 'generate_code', 'generate_smart',
      'generate_d365fo_xml', 'find_coc_extensions', 'find_event_handlers',
      'analyze_extension_points', 'find_extension_points', 'prepare_change',
      'get_xpp_knowledge', 'validate_xpp', 'search_extensions', 'batch_search',
      'get_table_info', 'get_class_info', 'get_form_info', 'batch_get_info',
      'resolve_references', 'form_pattern', 'prepare_create', 'get_method_signature',
      'get_enum_info', 'get_edt_info', 'get_data_entity_info', 'get_query_info',
      'get_view_info', 'get_report_info', 'code_completion',
    ];
    const pattern = new RegExp(String.raw`\b(${retired.join('|')})\b`, 'g');

    // A retired name is a defect where the MODEL can see it, i.e. inside a string
    // that ends up in a tool response. Scoping to string literals is what makes
    // the bare-name match usable: comments describing history ("merged from
    // generate_code") and stderr log prefixes are documentation, not instructions.
    const STRING_LITERAL = /`[^`]*`|'[^']*'|"[^"]*"/g;
    // `subRequest('get_xpp_knowledge', …)` is internal dispatch — the legacy name
    // is the routing key of a handler that still exists, not advice to the model.
    const INTERNAL_DISPATCH = /\b(subRequest|from|import)\b/;
    // console.* goes to stderr; the MCP client never renders it.
    const STDERR_LOG = /\bconsole\.(error|warn|log|info|debug)\b/;
    // `name: 'get_class_info'` / `toolName: 'get_view_info'` — the internal
    // routing table of a unified tool. The legacy name is the key of a handler
    // that still exists behind the merged tool, not advice to call it.
    const ROUTING_KEY = /\b(toolName|name)\s*:\s*['"]/;
    // `[create_d365fo_file] …` — an stderr log prefix. console.* is often two
    // lines up, so the STDERR_LOG guard alone misses these.
    const isLogPrefix = (literal: string, name: string) =>
      literal.replace(/^[`'"]/, '').startsWith(`[${name}]`);
    // "Replaces the former get_<type>_info, code_completion and batch_get_info
    // tools." — a deliberate migration note in a published tool description. It
    // names the old tools to STOP the model reaching for them, which is the
    // opposite of the defect this test guards.
    const MIGRATION_NOTE = /\b(former|replaces|retired|renamed|merged from)\b/i;

    const sources = globSync('src/**/*.ts', { cwd: repoRoot });
    const offenders: string[] = [];
    for (const rel of sources) {
      const text = readRepoFile(rel);
      text.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (INTERNAL_DISPATCH.test(line) || STDERR_LOG.test(line) || ROUTING_KEY.test(line)) return;
        for (const literal of line.match(STRING_LITERAL) ?? []) {
          if (MIGRATION_NOTE.test(literal)) continue;
          for (const m of literal.matchAll(pattern)) {
            if (isLogPrefix(literal, m[1])) continue;
            offenders.push(`${rel}:${i + 1} → ${m[1]}  |  ${trimmed.slice(0, 120)}`);
          }
        }
      });
    }

    expect(offenders, `retired tool names in agent-facing text:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('has a tool annotation (title + hints) for every published tool', () => {
    const annotated = new Set(Object.keys(TOOL_ANNOTATIONS));
    for (const toolName of mcpServerToolNames) {
      expect(annotated.has(toolName), `missing TOOL_ANNOTATIONS entry for '${toolName}'`).toBe(true);
      const a = TOOL_ANNOTATIONS[toolName];
      expect(a.title.length, `empty title for '${toolName}'`).toBeGreaterThan(0);
      expect(typeof a.readOnlyHint).toBe('boolean');
      expect(a.openWorldHint).toBe(false);
    }
    // No orphan annotations for tools that no longer exist
    const published = new Set(mcpServerToolNames);
    for (const name of annotated) {
      expect(published.has(name), `orphan TOOL_ANNOTATIONS entry '${name}'`).toBe(true);
    }
  });

  it('marks write tools as non-read-only in annotations', () => {
    const writeTools = [
      'd365fo_file', 'labels',
      'undo_last_modification', 'generate_object',
      'update_symbol_index', 'build_d365fo_project',
      'trigger_db_sync', 'run_systest_class',
    ];
    for (const toolName of writeTools) {
      expect(TOOL_ANNOTATIONS[toolName]?.readOnlyHint, `'${toolName}' must not be read-only`).toBe(false);
    }
  });

  it('surfaces every modify-operation param via schema or op-spec registry', () => {
    // Regression guard: the model discovers op params either flat in the published
    // d365fo_file inputSchema (core params) or through error-driven guidance backed
    // by the central op-spec registry (op-specific params). A param handled in
    // modifyD365File.ts but missing from BOTH surfaces is invisible to the model
    // and the op fails with "returned null" and no usable guidance.
    const requiredModifyParams = [
      // add-table-method / add-display-method
      'tableMethodType', 'tableKeyField', 'displayMethodReturnEdt',
      // add-index / remove-index
      'indexName', 'indexFields', 'indexAllowDuplicates', 'indexAlternateKey',
      // add-relation
      'relationName', 'relatedTable', 'relationConstraints',
      // field groups
      'fieldGroupName', 'fieldGroupFields', 'extendBaseFieldGroup',
      // add-data-source
      'dataSourceName', 'dataSourceTable', 'joinSource', 'linkType',
      // modify-field extras
      'fieldHelpText', 'fieldEnumType', 'fieldStringSize',
      // add-control label
      'controlLabel',
      // enum values
      'enumValueName', 'enumValueLabel', 'enumValueInt', 'enumValueCountryRegionCodes',
      // add-menu-item-to-menu
      'menuItemToAdd', 'menuItemToAddType',
      // aliases / lookup
      'methodCode', 'sourceCode', 'baseFormName', 'filePath',
    ];
    const paramSurface =
      readRepoFile('src/server/toolSchemas/d365foFile.ts') +
      readRepoFile('src/tools/specs/d365foFileOpSpecs.ts');
    for (const param of requiredModifyParams) {
      expect(
        new RegExp(`\\b${param}:\\s*\\{`).test(paramSurface),
        `modify param '${param}' is surfaced neither in the d365fo_file inputSchema nor in d365foFileOpSpecs`,
      ).toBe(true);
    }
  });

  it('does not offer a project switch as a way to read another model', () => {
    // The switch changes which project is ACTIVE — nothing more. Reads never
    // consulted the active model (get_object_info, search, find_references and
    // the rest query the index across every model), so describing the parameter
    // as "how to get at another project" is what taught the agent to switch when
    // a write was refused: switch, then write, no refusal. The schema text is
    // the instruction the agent actually reads, so it is pinned here.
    const workspaceInfo = toolSchemas.find(t => t.name === 'get_workspace_info')!;
    const projectName = (workspaceInfo.inputSchema as any).properties.projectName.description as string;

    expect(projectName).toContain('USER');
    expect(projectName).toContain('NOT a way to reach another model');
    expect(projectName).toContain('reads span every model already');
  });

  it('does not advertise update_symbol_index as a follow-up to create/modify', () => {
    // #830: the old description opened with "Call this after
    // d365fo_file(action=create)", so the agent did — four times in one audited
    // session, each as the only tool call in its turn, for a DiskProvider rebuild
    // the create had already done. The tool stays (external edits are real), but
    // the text the agent reads has to say so, and is pinned here.
    const updateIndex = toolSchemas.find(t => t.name === 'update_symbol_index')!;

    expect(updateIndex.description).toContain('OUTSIDE this server');
    expect(updateIndex.description).toContain('Do NOT call after d365fo_file create/modify');
    expect(updateIndex.description).not.toMatch(/Call this after d365fo_file/);
  });

  it('includes critical diagnostics and SDLC tools in both inventories', () => {
    const criticalTools = [
      'get_workspace_info',
      'get_knowledge',
      'update_symbol_index',
      'build_d365fo_project',
      'run_bp_check',
      'run_systest_class',
    ];

    for (const toolName of criticalTools) {
      expect(mcpServerToolNames).toContain(toolName);
      expect(startupCatalogToolNames).toContain(toolName);
    }
  });
});
