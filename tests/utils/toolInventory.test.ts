import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CORE_TOOLS, LOCAL_TOOLS } from '../../src/server/serverMode';
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
    // 20 since the 2026-08-25 audit's Phase C folded three more tools into the
    // tools that already owned their subject: undo_last_modification ->
    // d365fo_file(action="undo"), review_workspace_changes ->
    // get_workspace_info(changes=true), trigger_db_sync ->
    // build_d365fo_project(dbSync). Before that, get_method and suggest_edt were
    // unpublished into get_object_info(options.method) and prepare(fieldsHint).
    // Every one of those handlers stays routable under its old name.
    expect(mcpServerToolNames).toHaveLength(20);
    expect(startupCatalogToolNames).toHaveLength(20);
  });

  it('never states a tool count that disagrees with the published inventory', () => {
    // The count is written out in prose in five places, and every one of them
    // drifted: retiring get_method and suggest_edt took the catalogue 25 -> 23,
    // but only the enum HINT next to the setting was updated. Its own
    // description still said "publishes all 25", and since
    // docs/CONFIGURATION.md is GENERATED from that description, the
    // `config:docs --check` CI gate compared a wrong number against the same
    // wrong number and passed — the doc even contradicted itself on one line
    // ("all 25 … Values: full — all 23 tools"). No existing gate could see it,
    // hence this one, which compares the prose against the real inventory.
    const published = mcpServerToolNames.length;
    const core = mcpServerToolNames.filter(n => CORE_TOOLS.has(n)).length;
    const sources = [
      'src/config/settings.ts',
      'docs/ARCHITECTURE.md',
      'docs/MCP_CONFIG.md',
      'docs/MCP_TOOLS.md',
      'docs/CONFIGURATION.md',
      'README.md',
    ];
    // Two shapes: "23 tools" / "18-tool loop", and a bare "all 23" that ends the
    // clause ("publishes all 23.", "(all 23)"). Two digits with word boundaries,
    // so "~100 tools" (the VS Code catalogue limit) and "39 AOT object types"
    // stay out. The bare-"all" shape is then re-checked against a window that
    // must mention tools, which is what keeps "8 GB (all 70)" — the label
    // languages — from reading as a tool count.
    // Two more shapes were added after the first version of this gate shipped,
    // because it still passed a README whose FIRST LINE said "25 AI tools":
    //  • "instead of 25" — the second number in a comparison carries no "tools"
    //    of its own and does not end the clause;
    //  • "25 AI tools" / "25 specialized MCP tools" — the count and the noun are
    //    separated by adjectives, which the adjacency shape above cannot bridge.
    // The second one allows up to three intervening words, which is what keeps
    // "~57 built-in VS Code browser / Python / notebook / dotnet tools" (a
    // measured VS Code catalogue, not a claim about this server) out.
    const COUNT_CLAIM =
      /\b(\d{2})(?:[ -][A-Za-z][\w-]*){0,3}[ -]tools?\b|\ball (\d{2})\b(?=[.)])|\binstead of (\d{2})\b/g;
    for (const rel of sources) {
      const text = readRepoFile(rel);
      for (const m of text.matchAll(COUNT_CLAIM)) {
        const window = text.slice(Math.max(0, m.index - 90), m.index + 90);
        if (!/tool/i.test(window)) continue;
        const n = Number(m[1] ?? m[2] ?? m[3]);
        expect(
          n === published || n === core,
          `${rel}: claims "${m[0].trim()}" but the server publishes ${published} tools ` +
          `(core profile: ${core}). Update the prose, not this test.`,
        ).toBe(true);
      }
    }
  });

  it('does not name an unpublished tool as a core-profile exclusion', () => {
    // The same description listed get_method and suggest_edt among the tools
    // `core` leaves out, months after both stopped being published at all.
    const description = readRepoFile('src/config/settings.ts')
      .split('MCP_TOOL_PROFILE')[1]
      .slice(0, 1200);
    for (const name of ['get_method', 'suggest_edt']) {
      expect(
        description.includes(name),
        `settings.ts still offers '${name}' as a core-profile exclusion, but it is not published`,
      ).toBe(false);
    }
  });

  it('never tells a reader or an agent to call an unpublished tool', () => {
    // The gate above only ever read settings.ts, and the src/**/*.ts gate below
    // cannot list get_method/suggest_edt at all — their handlers are deliberately
    // still routable, so the name is legitimate inside src. That left the files a
    // human or an agent actually reads ungated, and every one of them had drifted:
    // README offered `MCP_EXTRA_TOOLS=security_info,get_method` and listed both
    // retired names as core-profile exclusions, SETUP promised the companion
    // exposes `get_method`, MCP_CONFIG used it as the MCP_EXTRA_TOOLS example, and
    // copilot-instructions.md — the file the agent is handed verbatim — taught
    // `get_method(include="signature")` as THE route to a CoC signature.
    //
    // MCP_TOOLS.md and CHANGELOG.md are excluded on purpose: they are where the
    // retirement is documented, so naming the old tool there is the point.
    const retiredButRoutable = [
      'get_method', 'suggest_edt', 'batch_get_info',
      // Phase C of the 2026-08-25 audit — folded into d365fo_file(action="undo"),
      // get_workspace_info(changes=true) and build_d365fo_project(dbSync).
      'undo_last_modification', 'review_workspace_changes', 'trigger_db_sync',
    ];
    const readerFacing = [
      'README.md',
      '.github/copilot-instructions.md',
      'docs/SETUP.md',
      'docs/QUICK_START.md',
      'docs/MCP_CONFIG.md',
      'docs/CONFIGURATION.md',
      'docs/ARCHITECTURE.md',
      'src/config/settings.ts',
    ];
    const offenders: string[] = [];
    for (const rel of readerFacing) {
      readRepoFile(rel).split('\n').forEach((line, i) => {
        for (const name of retiredButRoutable) {
          if (new RegExp(String.raw`\b${name}\b`).test(line)) {
            offenders.push(`${rel}:${i + 1} → ${name}  |  ${line.trim().slice(0, 110)}`);
          }
        }
      });
    }
    expect(
      offenders,
      `unpublished tool names in reader-facing text (they route, but nothing should ` +
      `send anyone to them):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps local-only tool set aligned with the published tool inventory', () => {
    const publishedTools = new Set(mcpServerToolNames);
    for (const toolName of LOCAL_TOOLS) {
      expect(publishedTools.has(toolName)).toBe(true);
    }

    // 6, not 9: review_workspace_changes and undo_last_modification and
    // trigger_db_sync left the published surface, and each fold landed in a tool
    // whose locality already covered it (get_workspace_info and
    // build_d365fo_project are LOCAL; d365fo_file is in ALWAYS_TOOLS).
    expect(LOCAL_TOOLS.size).toBe(6);
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
      // readOnlyHint is asserted by MEANING, not by presence. A hint equal to
      // its MCP spec default (`readOnlyHint: false`) says exactly what its
      // absence says, and the ListTools payload is re-sent on every request
      // against a 45,000-char ratchet — so the default-valued ones were dropped
      // to pay for the report-design operation. What must stay true is that a
      // read tool CLAIMS to be read-only; a write tool simply must not.
      expect([true, undefined], `'${toolName}' readOnlyHint must be true or absent`)
        .toContain(a.readOnlyHint);
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
      'd365fo_file', 'labels', 'generate_object',
      'update_symbol_index', 'build_d365fo_project',
      'run_systest_class',
    ];
    for (const toolName of writeTools) {
      // `false` and absent both mean "not read-only" — absent because that IS
      // the MCP default. What must never happen is a write tool claiming true,
      // which is what makes a client skip its write-confirmation dialog.
      expect(TOOL_ANNOTATIONS[toolName]?.readOnlyHint, `'${toolName}' must not be read-only`)
        .not.toBe(true);
      // …and each one still declares whether it is destructive, explicitly.
      // That hint is ALSO its own spec default (`true`), and it is kept anyway:
      // a client that reads absence as "unknown" gets more cautious about a
      // missing readOnlyHint and less cautious about a missing destructiveHint,
      // and only the first direction is safe to take for free bytes.
      expect(typeof TOOL_ANNOTATIONS[toolName]?.destructiveHint,
        `'${toolName}' must state destructiveHint explicitly`).toBe('boolean');
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
    expect(projectName).toMatch(/reads span every model already/i);
  });

  it('tells the agent projectName selects a project, not a model', () => {
    // A model is built by many projects — fifteen share one model in the
    // solution where this surfaced — so a model name selects none of them. The
    // parameter used to say "just the model name", the resolver took the first
    // match, and every write after that landed in a project nobody chose.
    const workspaceInfo = toolSchemas.find(t => t.name === 'get_workspace_info')!;
    const projectName = (workspaceInfo.inputSchema as any).properties.projectName.description as string;

    expect(projectName).toMatch(/PROJECT file name/i);
    expect(projectName).toMatch(/not a model name/i);
    expect(projectName).not.toMatch(/just the model name/i);
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
