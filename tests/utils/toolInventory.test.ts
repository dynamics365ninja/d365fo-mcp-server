import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOCAL_TOOLS } from '../../src/server/serverMode';
import { TOOL_ANNOTATIONS } from '../../src/server/toolAnnotations';

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
  const mcpServerSource = readRepoFile('src/server/mcpServer.ts');
  const startupCatalogSource = readRepoFile('src/index.ts');

  const mcpServerToolNames = extractSingleQuotedToolNames(mcpServerSource);
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

  it('advertises modify-operation params in the d365fo_file inputSchema', () => {
    // Regression guard: the advertised inputSchema is the only param surface the
    // model sees. If an operation's params are handled in modifyD365File.ts but not
    // exposed here, the model cannot pass them and the op fails with "returned null".
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
    for (const param of requiredModifyParams) {
      expect(
        new RegExp(`\\b${param}:\\s*\\{`).test(mcpServerSource),
        `d365fo_file inputSchema is missing advertised modify param '${param}'`,
      ).toBe(true);
    }
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
