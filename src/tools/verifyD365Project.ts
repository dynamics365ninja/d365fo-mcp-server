/**
 * D365FO Project Verification Tool
 * Checks whether D365FO objects exist on disk and are referenced in the VS project file.
 * Use this instead of PowerShell to verify that create_d365fo_file placed files correctly.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Parser } from '../utils/xml.js';
import type { XppServerContext } from '../types/context.js';
import { getConfigManager } from '../utils/configManager.js';
import { defaultPackagesRoot } from '../utils/packagesRoot.js';
import { PackageResolver } from '../utils/packageResolver.js';

const OBJECT_TYPES = [
  'class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
  'edt', 'edt-extension',
  'table-extension', 'form-extension', 'data-entity-extension', 'enum-extension',
  'menu-item-display', 'menu-item-action', 'menu-item-output',
  'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
  'menu', 'menu-extension',
  'security-privilege', 'security-duty', 'security-role',
  'security-duty-extension', 'security-role-extension',
] as const;

const objectFolderMap: Record<string, string> = {
  class:                          'AxClass',
  table:                          'AxTable',
  enum:                           'AxEnum',
  form:                           'AxForm',
  query:                          'AxQuery',
  view:                           'AxView',
  'data-entity':                  'AxDataEntityView',
  report:                         'AxReport',
  edt:                            'AxEdt',
  'edt-extension':                'AxEdtExtension',
  'table-extension':              'AxTableExtension',
  'form-extension':               'AxFormExtension',
  'data-entity-extension':        'AxDataEntityViewExtension',
  'enum-extension':               'AxEnumExtension',
  'menu-item-display':            'AxMenuItemDisplay',
  'menu-item-action':             'AxMenuItemAction',
  'menu-item-output':             'AxMenuItemOutput',
  'menu-item-display-extension':  'AxMenuItemDisplayExtension',
  'menu-item-action-extension':   'AxMenuItemActionExtension',
  'menu-item-output-extension':   'AxMenuItemOutputExtension',
  menu:                           'AxMenu',
  'menu-extension':               'AxMenuExtension',
  'security-privilege':           'AxSecurityPrivilege',
  'security-duty':                'AxSecurityDuty',
  'security-role':                'AxSecurityRole',
  'security-duty-extension':      'AxSecurityDutyExtension',
  'security-role-extension':      'AxSecurityRoleExtension',
};

// Reverse of objectFolderMap: AOT folder name (lowercased) → object type. Used to
// derive objects from a project's Content Includes in verify-all mode.
const folderToObjectType: Record<string, string> = Object.fromEntries(
  Object.entries(objectFolderMap).map(([type, folder]) => [folder.toLowerCase(), type])
);

const VerifyD365ProjectArgsSchema = z.object({
  objects: z
    .array(
      z.object({
        objectType: z.enum(OBJECT_TYPES).describe('Type of D365FO object'),
        objectName: z.string().describe('Name of the object'),
      })
    )
    .optional()
    .describe('List of objects to verify. Omit to verify every object referenced in the project.'),
  projectPath: z
    .string()
    .optional()
    .describe(
      'Absolute path to the .rnrproj file. Required for project-reference check. ' +
      'Example: K:\\AosService\\PackagesLocalDirectory\\MyPkg\\MyPkg.rnrproj'
    ),
  modelName: z
    .string()
    .optional()
    .describe('Model name (e.g., ContosoExt). Auto-detected from mcp.json if omitted.'),
  packageName: z
    .string()
    .optional()
    .describe('Package name. Auto-resolved from model name if omitted.'),
  packagePath: z
    .string()
    .optional()
    .describe('Base package path (default: auto-detected PackagesLocalDirectory)'),
});

/** Read all Content Include values from a .rnrproj XML file. */
async function readProjectIncludes(projectPath: string): Promise<Set<string>> {
  const parser = new Parser({ explicitArray: true });
  const xml = await fs.readFile(projectPath, 'utf-8');
  const parsed = await parser.parseStringPromise(xml);

  const includes = new Set<string>();
  const itemGroups: any[] = parsed?.Project?.ItemGroup ?? [];
  for (const group of itemGroups) {
    const contents: any[] = Array.isArray(group.Content) ? group.Content : [];
    for (const c of contents) {
      const inc: string | undefined = c?.$?.Include;
      if (inc) includes.add(inc);
    }
  }
  return includes;
}

export async function verifyD365ProjectTool(
  request: CallToolRequest,
  _context: XppServerContext
) {
  try {
    const args = VerifyD365ProjectArgsSchema.parse(request.params.arguments);

    const configManager = getConfigManager();
    const configPackagePath = configManager.getPackagePath();
    const envType = await configManager.getDevEnvironmentType();
    const configModelName = configManager.getModelName();
    // Resolve a project path from args or config — needed for the project-reference
    // check, for model-name derivation, and (in verify-all mode) to enumerate objects.
    const resolvedProjectPath =
      args.projectPath || (await configManager.getProjectPath()) || undefined;

    // Derive model name — priority:
    //   1) Explicit args.modelName
    //   2) .mcp.json / env var (configModelName)
    //   3) Stem of the .rnrproj filename  (structure: <base>\<pkg>\<model>\<model>.rnrproj)
    const actualModelName: string =
      args.modelName ||
      configModelName ||
      (resolvedProjectPath ? path.basename(resolvedProjectPath, path.extname(resolvedProjectPath)) : '') ||
      'UnknownModel';
    const modelDetectedFrom =
      args.modelName          ? 'argument'    :
      configModelName         ? 'mcp.json'    :
      resolvedProjectPath     ? 'projectPath' :
                                'none';

    let basePath: string;
    let resolvedPackageName: string;

    if (args.packageName) {
      resolvedPackageName = args.packageName;
      if (envType === 'ude') {
        const customPath = await configManager.getCustomPackagesPath();
        basePath = customPath || args.packagePath || configPackagePath || defaultPackagesRoot();
      } else {
        basePath = args.packagePath || configPackagePath || defaultPackagesRoot();
      }
    } else if (envType === 'ude') {
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];
      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(actualModelName);
      if (resolved) {
        resolvedPackageName = resolved.packageName;
        basePath = resolved.rootPath;
      } else {
        resolvedPackageName = actualModelName;
        basePath = customPath || args.packagePath || configPackagePath || defaultPackagesRoot();
      }
    } else {
      resolvedPackageName = actualModelName;
      basePath = args.packagePath || configPackagePath || defaultPackagesRoot();
    }

    let projectIncludes: Set<string> | null = null;
    let projectLoadError: string | null = null;
    if (resolvedProjectPath) {
      try {
        projectIncludes = await readProjectIncludes(resolvedProjectPath);
      } catch (e: any) {
        projectLoadError = e.message;
      }
    }

    // verify-all mode: when no objects are supplied, derive them from the project's
    // Content Includes (e.g. "AxClass\MyClass" → { class, MyClass }).
    type VerifyObject = { objectType: (typeof OBJECT_TYPES)[number]; objectName: string };
    const objectsToVerify: VerifyObject[] = args.objects ? [...args.objects] : [];
    if (objectsToVerify.length === 0) {
      if (!projectIncludes) {
        return {
          content: [{
            type: 'text',
            text:
              '❌ No `objects` supplied and no project could be read to verify them all.\n\n' +
              'Either pass `objects` explicitly, or provide `projectPath` (or configure projectPath ' +
              'in .mcp.json / auto-detect) so every object referenced in the .rnrproj can be checked.' +
              (projectLoadError ? `\n\n⚠️ Project read error: ${projectLoadError}` : ''),
          }],
          isError: true,
        };
      }
      for (const inc of projectIncludes) {
        const sep = inc.includes('\\') ? '\\' : '/';
        const parts = inc.split(sep);
        if (parts.length < 2) continue;
        const folder = parts[0];
        const name = parts[parts.length - 1].replace(/\.xml$/i, '');
        const objType = folderToObjectType[folder.toLowerCase()];
        if (objType && name) {
          objectsToVerify.push({ objectType: objType as (typeof OBJECT_TYPES)[number], objectName: name });
        }
      }
      if (objectsToVerify.length === 0) {
        return {
          content: [{
            type: 'text',
            text:
              `ℹ️ The project at \`${resolvedProjectPath}\` has no recognizable object references to verify ` +
              `(no Content Includes mapped to a known AOT folder).`,
          }],
        };
      }
    }

    type ObjectResult = {
      objectName: string;
      objectType: string;
      axFolder: string;
      filePath: string;
      diskStatus: 'ok' | 'missing' | 'error';
      diskError?: string;
      projectStatus: 'ok' | 'missing' | 'no-project';
    };

    const results: ObjectResult[] = [];

    for (const obj of objectsToVerify) {
      const axFolder = objectFolderMap[obj.objectType] ?? 'AxClass';
      const filePath = path.join(basePath, resolvedPackageName, actualModelName, axFolder, `${obj.objectName}.xml`);

      // Disk check
      let diskStatus: ObjectResult['diskStatus'] = 'missing';
      let diskError: string | undefined;
      try {
        await fs.access(filePath);
        diskStatus = 'ok';
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          diskStatus = 'missing';
        } else {
          diskStatus = 'error';
          diskError = e.message;
        }
      }

      // Project check
      let projectStatus: ObjectResult['projectStatus'] = 'no-project';
      if (projectIncludes !== null) {
        // Content Include uses backslash, no .xml extension: "AxClass\MyClass"
        const includeKey = `${axFolder}\\${obj.objectName}`;
        projectStatus = projectIncludes.has(includeKey) ? 'ok' : 'missing';
      }

      results.push({
        objectName: obj.objectName,
        objectType: obj.objectType,
        axFolder,
        filePath,
        diskStatus,
        diskError,
        projectStatus,
      });
    }

    const hasProject = projectIncludes !== null;
    const header = hasProject
      ? '| Object | Type | Disk | Project |'
      : '| Object | Type | Disk |';
    const separator = hasProject
      ? '|--------|------|------|---------|'
      : '|--------|------|------|';

    const rows = results.map((r) => {
      const diskCell =
        r.diskStatus === 'ok'
          ? `✅ \`${r.filePath}\``
          : r.diskStatus === 'missing'
          ? `❌ Missing — expected: \`${r.filePath}\``
          : `⚠️ Error: ${r.diskError}`;

      const projCell =
        r.projectStatus === 'ok'
          ? '✅'
          : r.projectStatus === 'missing'
          ? `❌ Not in project (\`${r.axFolder}\\${r.objectName}\`)`
          : '⚠️ No project path';

      return hasProject
        ? `| ${r.objectName} | ${r.objectType} | ${diskCell} | ${projCell} |`
        : `| ${r.objectName} | ${r.objectType} | ${diskCell} |`;
    });

    const diskOk      = results.filter((r) => r.diskStatus === 'ok').length;
    const diskMissing = results.filter((r) => r.diskStatus !== 'ok').length;
    const projOk      = results.filter((r) => r.projectStatus === 'ok').length;
    const projMissing = results.filter((r) => r.projectStatus === 'missing').length;

    const summaryLines = [
      `- Checked: ${results.length}`,
      `- On disk ✅: ${diskOk}   Missing from disk ❌: ${diskMissing}`,
    ];
    if (hasProject) {
      summaryLines.push(`- In project ✅: ${projOk}   Missing from project ❌: ${projMissing}`);
    }
    if (projectLoadError) {
      summaryLines.push(`- ⚠️ Could not read project file: ${projectLoadError}`);
    }

    const lines = [
      `## Verification Results — ${actualModelName}`,
      `> Model: \`${actualModelName}\`  (detected from: ${modelDetectedFrom})  Package: \`${resolvedPackageName}\`  Base: \`${basePath}\``,
      ...(modelDetectedFrom === 'none' ? [
        '',
        '> ⚠️ **Model name could not be auto-detected.** Paths below are likely wrong.',
        '> Pass `modelName` explicitly, or configure it in `.mcp.json` under `servers.context.modelName`,',
        '> or provide `projectPath` pointing to your `.rnrproj` file so the model name can be derived.',
      ] : []),
      '',
      header,
      separator,
      ...rows,
      '',
      '### Summary',
      ...summaryLines,
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
