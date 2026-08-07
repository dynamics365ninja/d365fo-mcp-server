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
    expect(mcpServerToolNames).toHaveLength(26);
    expect(startupCatalogToolNames).toHaveLength(26);
  });

  it('keeps local-only tool set aligned with the published tool inventory', () => {
    const publishedTools = new Set(mcpServerToolNames);
    for (const toolName of LOCAL_TOOLS) {
      expect(publishedTools.has(toolName)).toBe(true);
    }

    expect(LOCAL_TOOLS.size).toBe(10);
    expect(mcpServerToolNames.filter(name => !LOCAL_TOOLS.has(name))).toHaveLength(16);
  });

  it('never tells the agent to call a tool that was retired by a consolidation', () => {
    // Guidance the agent copies verbatim — `nextSteps` in the strategy advisor,
    // the "call X next" tails on generators, the system prompt — outlived several
    // tool renames and kept naming `find_coc_extensions`, `generate_code`,
    // `get_xpp_knowledge`. Each such line costs a guaranteed Unknown-tool call
    // plus a retry, which is far more expensive than the line itself.
    //
    // Call form only (`name(`): the dispatchers legitimately pass legacy names as
    // sub-request STRINGS (`subRequest('find_coc_extensions', …)`), where the name
    // is followed by a quote, never by an open paren.
    const retired = [
      'create_d365fo_file', 'modify_d365fo_file', 'generate_code', 'generate_smart',
      'generate_d365fo_xml', 'find_coc_extensions', 'find_event_handlers',
      'analyze_extension_points', 'find_extension_points', 'prepare_change',
      'get_xpp_knowledge', 'validate_xpp', 'search_extensions', 'batch_search',
      'get_table_info', 'get_class_info', 'get_form_info',
    ];
    const pattern = new RegExp(String.raw`\b(${retired.join('|')})\(`, 'g');

    const sources = globSync('src/**/*.ts', { cwd: repoRoot });
    const offenders: string[] = [];
    for (const rel of sources) {
      const text = readRepoFile(rel);
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(pattern)) {
          offenders.push(`${rel}:${i + 1} → ${m[1]}(`);
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
      readRepoFile('src/tools/d365foFileOpSpecs.ts');
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
