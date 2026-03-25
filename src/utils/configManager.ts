/**
 * MCP Configuration Manager
 * Loads and provides access to .mcp.json configuration
 */

import * as fs from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { autoDetectD365Project, detectD365Project, scanAllD365Projects, extractModelNameFromProject, detectGitBranch, isMicrosoftDemoModel, type D365ProjectInfo } from './workspaceDetector.js';
import { registerCustomModel } from './modelClassifier.js';
import { XppConfigProvider, type XppEnvironmentConfig } from './xppConfigProvider.js';

export interface McpContext {
  workspacePath?: string;
  packagePath?: string;
  modelName?: string;               // Explicit model name — overrides workspacePath-based detection
  customPackagesPath?: string;      // UDE: custom X++ root (ModelStoreFolder)
  microsoftPackagesPath?: string;   // UDE: Microsoft X++ root (FrameworkDirectory)
  projectPath?: string;
  solutionPath?: string;
  devEnvironmentType?: 'auto' | 'traditional' | 'ude';
}

export interface McpConfig {
  servers: {
    [key: string]: any;
    context?: McpContext;
  };
}

/**
 * Resolve the actual on-disk casing of a path.
 * On Windows the filesystem is case-insensitive but VS Code and Copilot compare
 * paths case-sensitively, causing "Couldn't find file" errors when casing in
 * .mcp.json / .rnrproj differs from the real directory name (e.g. AOSService vs AosService).
 * Falls back to the original string when the path does not exist yet.
 */
function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

class ConfigManager {
  private config: McpConfig | null = null;
  private configPath: string;
  private runtimeContext: Partial<McpContext> = {};
  /**
   * Per-request context storage — isolates each HTTP request's workspace path
   * from concurrent requests. Populated via runWithRequestContext() in transport.ts.
   * Takes priority over runtimeContext in getContext() so multi-user HTTP scenarios
   * never bleed workspace state between requests.
   */
  private requestContextStorage = new AsyncLocalStorage<Partial<McpContext>>();
  private autoDetectedProject: D365ProjectInfo | null = null;
  private autoDetectionAttempted: boolean = false;
  // Cache auto-detection results per workspace path (PERFORMANCE FIX)
  private autoDetectionCache = new Map<string, D365ProjectInfo | null>();
  // All projects found when D365FO_SOLUTIONS_PATH is configured
  private allDetectedProjects: D365ProjectInfo[] = [];
  // Monotonically-increasing counter — each new background detection call gets a unique ID.
  // Before writing autoDetectedProject, the call verifies its ID is still current.
  // This prevents a slower earlier scan (e.g. home-dir BFS) from overwriting a faster,
  // more specific scan (e.g. direct workspace path lookup) that finished first.
  private detectionGeneration = 0;
  // Promise that resolves once the D365FO_SOLUTIONS_PATH eager scan completes.
  // setRuntimeContextFromRoots awaits this before trying matchProjectForWorkspace,
  // eliminating the race where roots/list arrives before allDetectedProjects is populated.
  private allDetectedProjectsReady: Promise<void> | null = null;
  // Promise for the currently in-progress background autoDetectProject call.
  // getWorkspaceInfoDiagnostics awaits this when autoDetectedProject is still null,
  // fixing the "null on first call" race (autoDetectionAttempted is set immediately
  // at the start of autoDetectProject, so the !autoDetectionAttempted guard is
  // bypassed even though the async scan hasn't returned a result yet).
  private detectionInProgress: Promise<void> | null = null;
  private xppConfigProvider: XppConfigProvider | null = null;
  private xppConfig: XppEnvironmentConfig | null = null;
  private xppConfigLoaded: boolean = false;

  constructor(configPath?: string) {
    // Default to .mcp.json in current directory or parent directories
    this.configPath = configPath || this.findConfigFile();
  }

  /**
   * Start scanning D365FO_SOLUTIONS_PATH immediately at startup (fire-and-forget).
   * Stores a Promise so setRuntimeContextFromRoots can await it, guaranteeing
   * that allDetectedProjects is populated before the first roots/list notification
   * is processed — otherwise matchProjectForWorkspace always returns null because
   * the list is empty (roots/list often arrives within 1–2 s of startup).
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  initEagerScan(): void {
    const solutionsRoot = process.env.D365FO_SOLUTIONS_PATH;
    if (!solutionsRoot || this.allDetectedProjectsReady) return;

    console.error(`[ConfigManager] 🔍 Eager project scan starting: ${solutionsRoot}`);
    this.allDetectedProjectsReady = (async () => {
      try {
        const all = await scanAllD365Projects(solutionsRoot);
        if (all.length > 0) {
          this.allDetectedProjects = all;
          // Compact summary: group by model, then list counts + first project path per model
          const byModel = new Map<string, string[]>();
          for (const p of all) {
            const list = byModel.get(p.modelName) ?? [];
            if (p.projectPath) list.push(p.projectPath);
            byModel.set(p.modelName, list);
          }
          console.error(
            `[ConfigManager] 🔍 Eager scan complete: ${all.length} project(s) across ${byModel.size} model(s)`
          );
          for (const [model, paths] of byModel) {
            console.error(`   ${model}: ${paths.length} project(s)  (first: ${paths[0]})`);
          }
        } else {
          console.error(`[ConfigManager] 🔍 Eager scan: no projects found under ${solutionsRoot}`);
        }
      } catch (err) {
        console.error(`[ConfigManager] 🔍 Eager scan failed:`, err);
      }
    })();
  }

  /**
   * Auto-detect D365FO project from workspace
   * Called automatically when projectPath/solutionPath is requested but not configured
   * PERFORMANCE: Results are cached per workspace path
   */
  private async autoDetectProject(workspacePath?: string, generation?: number): Promise<void> {
    if (this.autoDetectionAttempted) {
      return; // Only attempt once per workspace
    }

    this.autoDetectionAttempted = true;

    // .rnrproj files only exist on Windows D365FO VMs — skip scan on Azure/Linux
    if (process.platform !== 'win32') {
      console.error('[ConfigManager] Non-Windows platform — skipping .rnrproj auto-detection');
      this.autoDetectionCache.set(workspacePath || 'default', null);
      return;
    }

    // Check cache first (PERFORMANCE FIX)
    const cacheKey = workspacePath || 'default';
    if (this.autoDetectionCache.has(cacheKey)) {
      this.autoDetectedProject = this.autoDetectionCache.get(cacheKey) || null;
      if (this.autoDetectedProject) {
        console.error(`[ConfigManager] ⚡ Using cached auto-detection for: ${cacheKey}`);
      }
      return;
    }

    console.error('[ConfigManager] Auto-detecting D365FO project from workspace...');

    // Try to detect from provided workspace path or current directory
    let detectedProject = await autoDetectD365Project(workspacePath);

    // Fallback: if no .rnrproj was found (workspace is the MCP server dir, not the D365FO solution),
    // scan the configured packagePath directly.
    // In standard D365FO layout the .rnrproj lives inside:
    //   PackagesLocalDirectory\<package>\<model>\<model>.rnrproj
    if (!detectedProject?.projectPath) {
      const packagePathHint =
        this.runtimeContext.packagePath ||
        this.config?.servers.context?.packagePath;

      if (packagePathHint) {
        console.error(`[ConfigManager] No .rnrproj in workspace — scanning packagePath: ${packagePathHint}`);
        const pkgScan = await detectD365Project(packagePathHint, 4);
        if (pkgScan?.projectPath) {
          detectedProject = {
            ...pkgScan,
            // Prefer model name already resolved via Priority 4 (from PackagesLocalDirectory regex)
            modelName: detectedProject?.modelName || pkgScan.modelName,
            packagePath: packagePathHint,
          };
          console.error(`[ConfigManager] ✅ Found .rnrproj via packagePath scan: ${pkgScan.projectPath}`);
        } else {
          console.error(`[ConfigManager] No .rnrproj found in packagePath either`);
        }
      }
    }

    // Store in cache (PERFORMANCE FIX)
    this.autoDetectionCache.set(cacheKey, detectedProject);

    // Guard: if a newer setRuntimeContext call has already started a fresher detection,
    // discard this (now stale) result so we never overwrite a more recent correct answer.
    const isStale = generation !== undefined && generation < this.detectionGeneration;
    if (isStale) {
      console.error(`[ConfigManager] ⚠️ Stale workspace detection (gen ${generation} < current ${this.detectionGeneration}) — skipping project assignment`);
      // Do NOT return early: D365FO_SOLUTIONS_PATH scan below must still run so
      // that allDetectedProjects is populated for future matchProjectForWorkspace calls.
    } else if (detectedProject) {
      this.autoDetectedProject = detectedProject;
      console.error('[ConfigManager] ✅ Auto-detection successful:');
      console.error(`   ProjectPath: ${detectedProject.projectPath}`);
      console.error(`   ModelName: ${detectedProject.modelName}`);
      console.error(`   SolutionPath: ${detectedProject.solutionPath}`);
      // ✨ Register the auto-detected model as custom
      registerCustomModel(detectedProject.modelName);
    } else {
      console.error('[ConfigManager] ⚠️ Auto-detection failed - no .rnrproj files found');
    }

    // Scan D365FO_SOLUTIONS_PATH for all available projects (for solution-switching support).
    // ALWAYS runs — even on stale scans — because allDetectedProjects must be ready for
    // matchProjectForWorkspace() which is called from setRuntimeContextFromRoots().
    const solutionsRoot = process.env.D365FO_SOLUTIONS_PATH;
    if (solutionsRoot) {
      // Skip re-scan if initEagerScan() already populated the list (avoids duplicate log output).
      const needsScan = this.allDetectedProjects.length === 0;
      if (needsScan) {
        const all = await scanAllD365Projects(solutionsRoot);
        if (all.length > 0) {
          this.allDetectedProjects = all;
          const byModel = new Map<string, number>();
          for (const p of all) byModel.set(p.modelName, (byModel.get(p.modelName) ?? 0) + 1);
          console.error(
            `[ConfigManager] Found ${all.length} project(s) across ${byModel.size} model(s) under D365FO_SOLUTIONS_PATH`
          );
        }
      }
      const all = this.allDetectedProjects;
      // Re-check staleness: time has passed since the initial check above.
      const isNowStale = generation !== undefined && generation < this.detectionGeneration;
      // Use first found as primary if workspace detection yielded nothing and scan is current.
      // Skip Microsoft demo/tutorial model names (e.g. FleetManagement) — these appear when
      // a developer creates a new VS project and leaves the default model name unchanged.
      // Prefer the first custom (non-demo) model; only fall back to demo models when that
      // is ALL that was found (unusual, but possible in purely tutorial repos).
      if (all.length > 0 && !this.autoDetectedProject && !isNowStale) {
        const primary = all.find(p => !isMicrosoftDemoModel(p.modelName)) ?? all[0];
        if (isMicrosoftDemoModel(primary.modelName)) {
          console.error(
            `[ConfigManager] ⚠️ All detected projects are Microsoft demo models — using "${primary.modelName}" as fallback.`,
            `This usually means the VS project wizard default model was not changed.`,
          );
        }
        this.autoDetectedProject = primary;
        registerCustomModel(primary.modelName);
        console.error(`[ConfigManager] ✅ Using first found project as primary: ${primary.modelName}`);
      }
    }
  }

  /**
   * Set runtime context (e.g., from GitHub Copilot workspace detection)
   * This allows dynamic context that overrides .mcp.json configuration
   * PERFORMANCE: Uses cache, only resets when workspace differs from cached value.
   */
  setRuntimeContext(context: Partial<McpContext>): void {
    const workspaceChanged = context.workspacePath &&
      context.workspacePath !== this.runtimeContext.workspacePath;
    const projectChanged = context.projectPath &&
      context.projectPath !== this.runtimeContext.projectPath;

    this.runtimeContext = { ...this.runtimeContext, ...context };

    // Only reset if workspace changed AND not in cache (PERFORMANCE FIX)
    if (workspaceChanged || projectChanged) {
      const cacheKey = context.workspacePath || context.projectPath || 'default';
      if (!this.autoDetectionCache.has(cacheKey)) {
        this.autoDetectionAttempted = false;
        this.autoDetectedProject = null;

        // Fast-path: try exact or close match against known projects.
        // Falls through to BFS only when nothing specific is found.
        if (this.allDetectedProjects.length > 0 && context.workspacePath) {
          const matched = this.matchProjectForWorkspace(context.workspacePath);
          if (matched) {
            // Increment generation so any in-flight BFS (started earlier) treats
            // its result as stale and will not overwrite this fast-path assignment.
            ++this.detectionGeneration;
            this.autoDetectedProject = matched;
            this.autoDetectionAttempted = true;
            this.autoDetectionCache.set(cacheKey, matched);
            console.error(`[ConfigManager] ⚡ Workspace matched known project: ${matched.modelName} (gen ${this.detectionGeneration})`);
            return;
          }
        }

        console.error(
          `[ConfigManager] New workspace — eager auto-detect starting: ${cacheKey}`
        );
        // Increment generation so any previous background scan that finishes later
        // will recognise its result as stale and discard it.
        const gen = ++this.detectionGeneration;
        // Eager: kick off detection immediately (background) so the result is
        // ready in cache before the first tool call arrives.
        // Store the promise so getWorkspaceInfoDiagnostics() can await it when
        // autoDetectedProject is still null (fixes "null on first call" race).
        this.detectionInProgress = this.autoDetectProject(context.workspacePath, gen);
        this.detectionInProgress.catch(() => {});
      } else {
        // Cache hit — recycle result without re-scanning disk
        this.autoDetectedProject = this.autoDetectionCache.get(cacheKey) || null;
        this.autoDetectionAttempted = true;
        if (this.autoDetectedProject) {
          console.error(`[ConfigManager] ⚡ Cache hit — recycled detection for: ${cacheKey}`);
        }
      }
    }
  }

  /**
   * Called by mcpServer when roots/list arrives (all roots from VS 2022 / VS Code).
   * Tries every root path to find an unambiguous project match.
   *
   * Detection order:
   *   1. Exact/contained path match (workspace IS or is INSIDE a project dir)
   *   2. Git branch name → project name substring match
   *      (handles VS 2022 sending solution root K:\repos\Contoso for ALL projects;
   *       branch feature/4105-ContosoBankPaymProposal → matches model "ContosoBank")
   *   3. BFS fallback
   */
  async setRuntimeContextFromRoots(rootPaths: string[]): Promise<void> {
    // Increment generation upfront so any in-flight BFS scan started earlier
    // will recognise its result as stale and discard it.
    const gen = ++this.detectionGeneration;

    // Await the eager D365FO_SOLUTIONS_PATH scan so allDetectedProjects is populated
    // before we try matchProjectForWorkspace (otherwise it always returns null).
    // Cap at 5 s — consistent with the timeout used in getAutoDetectedProject().
    if (this.allDetectedProjectsReady) {
      await Promise.race([
        this.allDetectedProjectsReady,
        new Promise<void>(resolve => setTimeout(resolve, 5_000)),
      ]);
    }

    // Priority 1: exact / unambiguous path match
    for (const rootPath of rootPaths) {
      const match = this.matchProjectForWorkspace(rootPath);
      if (match) {
        this.runtimeContext = { ...this.runtimeContext, workspacePath: rootPath };
        this.autoDetectedProject = match;
        this.autoDetectionAttempted = true;
        this.autoDetectionCache.set(rootPath, match);
        registerCustomModel(match.modelName);
        console.error(`[ConfigManager] ⚡ Root matched project: ${match.modelName} (gen ${gen}, ${match.projectPath})`);
        return;
      }
    }

    // Priority 2: git branch name → project name fuzzy match.
    // VS 2022 always sends the solution root (ancestor of ALL projects) so path
    // matching is always ambiguous. The git branch, however, usually encodes the
    // feature/project being worked on, e.g. "feature/4105-ContosoBankPaymProposal".
    if (this.allDetectedProjects.length > 0 && rootPaths.length > 0) {
      for (const rootPath of rootPaths) {
        const branch = await detectGitBranch(rootPath);
        if (branch) {
          const gitMatch = this.findProjectByBranchName(branch);
          if (gitMatch) {
            this.runtimeContext = { ...this.runtimeContext, workspacePath: rootPath };
            this.autoDetectedProject = gitMatch;
            this.autoDetectionAttempted = true;
            this.autoDetectionCache.set(rootPath, gitMatch);
            registerCustomModel(gitMatch.modelName);
            console.error(`[ConfigManager] 🌿 Git branch "${branch}" → project: ${gitMatch.modelName} (gen ${gen})`);
            return;
          }
          console.error(`[ConfigManager] 🌿 Git branch "${branch}" — no project name match (gen ${gen})`);
          break; // only try git on the first root that has a branch
        }
      }
    }

    // Priority 3: BFS fallback — only when no cached result exists.
    // We deliberately do NOT delete the cache here: if forceProject() stored a
    // specific project for this workspace path, we want to honour that choice
    // across roots/list notifications (e.g. git branch switch that produces no
    // project-name match). The user can always call get_workspace_info with
    // projectPath to explicitly override.
    if (rootPaths.length > 0) {
      const firstPath = rootPaths[0];
      const normalizedFirst = normalizePath(firstPath);
      if (this.autoDetectionCache.has(normalizedFirst)) {
        // Use the cached (possibly user-forced) result instead of running BFS.
        const cached = this.autoDetectionCache.get(normalizedFirst);
        this.runtimeContext = { ...this.runtimeContext, workspacePath: firstPath };
        this.autoDetectedProject = cached ?? null;
        this.autoDetectionAttempted = true;
        if (cached) {
          console.error(`[ConfigManager] ⚡ BFS skipped — cache hit for workspace: ${cached.modelName} (gen ${gen})`);
          registerCustomModel(cached.modelName);
        }
        return;
      }
      console.error(`[ConfigManager] Roots ambiguous (gen ${gen}) — BFS fallback on: ${firstPath}`);
      // If stored workspace already equals firstPath, setRuntimeContext sees
      // workspaceChanged=false and skips detection — prevent that.
      if (this.runtimeContext.workspacePath === firstPath) {
        this.runtimeContext = { ...this.runtimeContext, workspacePath: undefined };
      }
      this.autoDetectionAttempted = false;
      this.autoDetectedProject = null;
      this.setRuntimeContext({ workspacePath: firstPath });
    }
  }

  /**
   * Find the project whose model name appears as a substring of the git branch name.
   * Prefer the LONGEST match to avoid short-prefix false positives
   * (e.g. "Con" would match everything; "ContosoBank" is more specific than "Contoso").
   *
   * Examples:
   *   branch "feature/4105-ContosoBankPaymProposal"  → model "ContosoBank"  (prefix of "ContosoBankPaymProposal")
   *   branch "feature/ContosoEDS-cleanup"             → model "ContosoEDS"
   */
  private findProjectByBranchName(branchName: string): D365ProjectInfo | null {
    const lowerBranch = branchName.toLowerCase();
    let bestMatch: D365ProjectInfo | null = null;
    let bestMatchLength = 0;

    for (const project of this.allDetectedProjects) {
      const lowerModel = project.modelName.toLowerCase();
      // Require at least 4 characters to avoid accidental single-letter matches
      if (lowerModel.length >= 4 && lowerBranch.includes(lowerModel) && lowerModel.length > bestMatchLength) {
        bestMatch = project;
        bestMatchLength = lowerModel.length;
      }
    }

    if (bestMatch) {
      console.error(`[ConfigManager] 🌿 Branch "${branchName}" → longest model match: "${bestMatch.modelName}" (${bestMatchLength} chars)`);
    }
    return bestMatch;
  }

  /**
   * Find the single unambiguous project that corresponds to a workspace path.
   * Returns null when:
   *   - no known projects (allDetectedProjects is empty)
   *   - workspace is a BROAD ancestor that contains MULTIPLE projects (ambiguous)
   *
   * Only returns a project when the match is specific:
   *   a) workspace == project directory (exact)
   *   b) workspace is INSIDE the project directory (workspace is a sub-folder)
   *   c) workspace is DIRECT parent of EXACTLY ONE project (unambiguous ancestor)
   */
  private matchProjectForWorkspace(workspacePath: string): D365ProjectInfo | null {
    if (!this.allDetectedProjects.length) return null;

    const normalizedWp = path.normalize(workspacePath).toLowerCase();

    // Priority A: workspace IS or is INSIDE a project directory
    // (most specific — unambiguous by definition)
    for (const p of this.allDetectedProjects) {
      if (!p.projectPath) continue;
      const projectDir = path.normalize(path.dirname(p.projectPath)).toLowerCase();
      if (normalizedWp === projectDir || normalizedWp.startsWith(projectDir + path.sep)) {
        return p;
      }
    }

    // Priority B: workspace is an ancestor — but only if EXACTLY ONE project lives under it
    const children = this.allDetectedProjects.filter(p => {
      if (!p.projectPath) return false;
      const projectDir = path.normalize(path.dirname(p.projectPath)).toLowerCase();
      return projectDir.startsWith(normalizedWp + path.sep);
    });

    if (children.length === 1) {
      console.error(`[ConfigManager] Single project under workspace — using: ${children[0].modelName}`);
      return children[0];
    }

    if (children.length > 1) {
      // Priority C: D365FO convention — the "primary" project in a solution folder
      // usually has the SAME NAME as the solution folder itself.
      // e.g. VS 2022 sends root "ContosoCore - FeatureManagement/" which contains
      // ContosoReports - FeatureManagement/, ContosoCore - FeatureManagement/, …
      // → prefer the project whose own folder name matches the workspace base name.
      const wpBase = path.basename(workspacePath).toLowerCase();
      const nameMatch = children.find(p => {
        const projectFolderName = path.basename(path.dirname(p.projectPath!)).toLowerCase();
        return projectFolderName === wpBase;
      });
      if (nameMatch) {
        console.error(`[ConfigManager] ⚡ Solution-name match (${children.length} candidates): ${nameMatch.modelName}`);
        return nameMatch;
      }
      console.error(`[ConfigManager] Workspace is ancestor of ${children.length} projects — ambiguous, not switching`);
    }

    return null;
  }

  /**
   * Clear runtime context
   */
  clearRuntimeContext(): void {
    this.runtimeContext = {};
  }

  /**
   * Find .mcp.json file.
   * Priority:
   * 1. MCP_CONFIG_PATH env var (explicit override)
   * 2. User home directory — single canonical config location (~/.mcp.json)
   * 3. Current directory and up to 5 parent directories (project-specific override, rare)
   * 4. Current directory fallback (file may not exist yet)
   */
  private findConfigFile(): string {
    // Step 1: Explicit override via MCP_CONFIG_PATH env var
    const envConfigPath = process.env.MCP_CONFIG_PATH;
    if (envConfigPath && existsSync(envConfigPath)) {
      console.error(`[ConfigManager] Using MCP_CONFIG_PATH: ${envConfigPath}`);
      return envConfigPath;
    }

    // Step 2: User home directory — primary location, use os.homedir() which is reliable
    // even when USERPROFILE / HOME env vars are not set in the server process.
    const homeDir = os.homedir();
    if (homeDir) {
      const homeConfigPath = path.join(homeDir, '.mcp.json');
      try {
        if (existsSync(homeConfigPath)) {
          console.error(`[ConfigManager] Using config from home directory: ${homeConfigPath}`);
          return homeConfigPath;
        }
      } catch {
        // Continue searching
      }
    }

    // Step 3: Search in current directory and parent directories (project-specific override)
    let currentDir = process.cwd();
    const maxDepth = 5;
    let depth = 0;

    while (depth < maxDepth) {
      const configPath = path.join(currentDir, '.mcp.json');
      try {
        if (existsSync(configPath)) {
          console.error(`[ConfigManager] Using project config: ${configPath}`);
          return configPath;
        }
      } catch {
        // Continue searching
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Reached root
      }
      currentDir = parentDir;
      depth++;
    }

    // Step 4: Fallback to current directory (file may not exist yet)
    return path.join(process.cwd(), '.mcp.json');
  }

  /**
   * Load configuration from .mcp.json file.
   * Idempotent — skips re-reading if config is already loaded.
   * Call ensureLoaded() for lazy initialization.
   */
  async load(): Promise<McpConfig | null> {
    if (this.config) {
      return this.config; // Already loaded — skip
    }
    try {
      console.error(`[ConfigManager] Loading config from: ${this.configPath}`);
      const content = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(content);
      console.error('[ConfigManager] Config loaded successfully');
      return this.config;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        // .mcp.json is optional — not present on Azure/cloud deployments, only on local Windows VM.
        console.error(`[ConfigManager] .mcp.json not found at ${this.configPath} — running without local config (expected on Azure)`);
      } else {
        console.error('[ConfigManager] Failed to load .mcp.json:', error);
      }
      return null;
    }
  }

  /**
   * Ensure config is loaded — lazy initializer.
   * Safe to call multiple times; loads only once.
   */
  async ensureLoaded(): Promise<void> {
    await this.load();
  }

  /**
   * Get context configuration
   * Merges .mcp.json config with runtime context (runtime takes priority)
   */
  getContext(): McpContext | null {
    const fileContext = this.config?.servers.context || null;
    // Per-request context (AsyncLocalStorage) takes priority over the shared
    // runtimeContext singleton — this prevents workspace paths from bleeding
    // between concurrent HTTP requests from different users.
    const requestCtx = this.requestContextStorage.getStore() ?? {};
    const effectiveRuntime = Object.keys(requestCtx).length > 0
      ? { ...this.runtimeContext, ...requestCtx }
      : this.runtimeContext;

    if (!fileContext && Object.keys(effectiveRuntime).length === 0) {
      return null;
    }

    return {
      ...fileContext,
      ...effectiveRuntime,
    };
  }

  /**
   * Run fn inside an isolated per-request AsyncLocalStorage context.
   * All calls to getContext() within fn (and any awaited Promises it starts)
   * will see ctx merged over runtimeContext, without mutating shared state.
   */
  runWithRequestContext<T>(ctx: Partial<McpContext>, fn: () => Promise<T>): Promise<T> {
    return this.requestContextStorage.run(ctx, fn);
  }

  /**
   * Returns true when the current async call stack runs inside a request-scoped
   * AsyncLocalStorage context. HTTP transport uses this for per-request
   * isolation, so callers should avoid mutating the shared runtimeContext.
   */
  hasRequestContext(): boolean {
    return this.requestContextStorage.getStore() !== undefined;
  }

  /**
   * Get workspace path from configuration
   * Returns the base PackagesLocalDirectory path if workspacePath contains it
   */
  getPackagePath(): string | null {
    const context = this.getContext();

    // If packagePath is explicitly set, use it
    if (context?.packagePath) {
      const resolved = normalizePath(context.packagePath);
      console.error(
        `[ConfigManager] Using explicit packagePath: ${resolved}`
      );
      return resolved;
    }

    // If workspacePath contains PackagesLocalDirectory, extract the base path.
    // Supports both one-level and two-level paths:
    //   K:\AosService\PackagesLocalDirectory\MyPackage\MyModel → K:\AosService\PackagesLocalDirectory
    //   K:\AosService\PackagesLocalDirectory\MyModel           → K:\AosService\PackagesLocalDirectory
    if (context?.workspacePath) {
      const normalized = path.normalize(context.workspacePath);

      const match = normalized.match(/^(.+[\\\/]PackagesLocalDirectory)(?:[\\\/]|$)/i);
      if (match) {
        // Normalize path separators: D365FO paths are always Windows paths (backslashes)
        const extracted = match[1].replace(/\//g, '\\');
        const resolved = normalizePath(extracted);
        console.error(
          `[ConfigManager] Extracted packagePath from workspacePath: ${resolved}`
        );
        return resolved;
      }
    }

    // Fallback: check if auto-detection already ran and found packagePath
    if (this.autoDetectedProject?.packagePath) {
      return normalizePath(this.autoDetectedProject.packagePath);
    }

    // Last resort (Windows only): probe well-known PackagesLocalDirectory locations.
    // Covers the two standard D365FO installation scenarios without requiring .mcp.json config:
    //   C:\AosService\PackagesLocalDirectory  → VHD / local developer machine
    //   K:\AosService\PackagesLocalDirectory  → cloud-hosted VM (standard Azure Dev/Test image)
    if (process.platform === 'win32') {
      const wellKnownCandidates = [
        'C:\\AosService\\PackagesLocalDirectory',
        'J:\\AosService\\PackagesLocalDirectory',
        'K:\\AosService\\PackagesLocalDirectory',
      ];
      for (const candidate of wellKnownCandidates) {
        if (existsSync(candidate)) {
          if (!(this as any)._packagePathLoggedOnce) {
            console.error(`[ConfigManager] ✅ Auto-probed packagePath: ${candidate}`);
            (this as any)._packagePathLoggedOnce = true;
          }
          return candidate;
        }
      }
    }

    return null;
  }

  /**
   * Get workspace path (specific model path)
   */
  getWorkspacePath(): string | null {
    const context = this.getContext();
    return context?.workspacePath || null;
  }

  /**
   * Get model name from the last segment of workspacePath.
   * Supports both path formats:
   *   K:\AOSService\PackagesLocalDirectory\MyPackage\MyModel → "MyModel"
   *   K:\AOSService\PackagesLocalDirectory\MyModel           → "MyModel"
   * This allows automatic model detection on non-Windows (Azure) without D365FO_MODEL_NAME env var.
   */
  getModelNameFromWorkspacePath(): string | null {
    const workspacePath = this.getContext()?.workspacePath;
    if (!workspacePath) return null;
    // Handle Windows paths on non-Windows: normalize both slash types and strip trailing slashes
    const normalized = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const segment = normalized.split('/').pop() || null;
    return segment || null;
  }

  /**
   * Get package name from workspacePath when it follows the two-level format:
   *   K:\AOSService\PackagesLocalDirectory\YourPackageName\YourModelName → "YourPackageName"
   * Returns null for one-level paths or when workspacePath is not set.
   */
  getPackageNameFromWorkspacePath(): string | null {
    const workspacePath = this.getContext()?.workspacePath;
    if (!workspacePath) return null;
    const normalized = path.normalize(workspacePath);
    const twoLevel = normalized.match(
      /^.+[\\\/]PackagesLocalDirectory[\\\/]([^\\\/]+)[\\\/][^\\\/]+\\?\/?$/i
    );
    return twoLevel ? twoLevel[1] : null;
  }

  /**
   * Get model name from configuration.
   * Priority:
   *   1) Explicit modelName in mcp.json context
   *   2) Last segment of workspacePath — ONLY when path contains PackagesLocalDirectory
   *      (AOT paths like K:\AosService\PackagesLocalDirectory\MyModel).
   *      Skipped for solution/repo paths like K:\repos\Contoso — those would wrongly
   *      return "Contoso" instead of the real model name from the .rnrproj file.
   *   3) Auto-detected model name from .rnrproj scan
   *   4) D365FO_MODEL_NAME env var
   */
  getModelName(): string | null {
    const context = this.getContext();

    // 1. Explicit config always wins
    if (context?.modelName) return context.modelName;

    // 2. WorkspacePath derivation ONLY for AOT paths inside PackagesLocalDirectory
    const wp = context?.workspacePath;
    if (wp && /PackagesLocalDirectory/i.test(wp)) {
      const fromWp = this.getModelNameFromWorkspacePath();
      // Skip kebab-case names (repo slugs, not D365FO package names)
      if (fromWp && !fromWp.includes('-')) return fromWp;
    }

    // 3. Result from background auto-detection (.rnrproj scan)
    if (this.autoDetectedProject?.modelName) {
      return this.autoDetectedProject.modelName;
    }

    // 4. Env var fallback
    return process.env.D365FO_MODEL_NAME || null;
  }

  /**
   * Get model name together with its detection source for diagnostics.
   * Mirrors the exact priority chain of getModelName() but also returns
   * a human-readable source string for display in get_workspace_info.
   */
  getModelNameWithSource(): { modelName: string | null; source: string } {
    const context = this.getContext();

    if (context?.modelName) {
      return { modelName: context.modelName, source: '.mcp.json' };
    }

    const wp = context?.workspacePath;
    if (wp && /PackagesLocalDirectory/i.test(wp)) {
      const fromWp = this.getModelNameFromWorkspacePath();
      if (fromWp && !fromWp.includes('-')) {
        return { modelName: fromWp, source: 'workspacePath segment' };
      }
    }

    if (this.autoDetectedProject?.modelName) {
      return { modelName: this.autoDetectedProject.modelName, source: 'auto-detected from .rnrproj' };
    }

    const envVar = process.env.D365FO_MODEL_NAME || null;
    if (envVar) {
      return { modelName: envVar, source: 'D365FO_MODEL_NAME env var' };
    }

    return { modelName: null, source: '(not configured)' };
  }

  /**
   * Returns all workspace-info diagnostics in one async call, including
   * the human-readable source for each resolved value.
   * Used by the get_workspace_info tool to produce the Phase-5 diagnostics output.
   */
  async getWorkspaceInfoDiagnostics(): Promise<{
    modelName: string | null;
    modelSource: string;
    projectPath: string | null;
    projectSource: string;
    packagePath: string | null;
    packageSource: string;
  }> {
    // Ensure config is loaded and auto-detection has had a chance to run
    await this.ensureLoaded();

    // If the D365FO_SOLUTIONS_PATH eager scan is still running, wait for it
    // first — that scan populates allDetectedProjects which setRuntimeContextFromRoots
    // needs to do a path-match.  Cap at 5 s so we never block Copilot past its timeout.
    if (this.allDetectedProjectsReady) {
      await Promise.race([
        this.allDetectedProjectsReady,
        new Promise<void>(resolve => setTimeout(resolve, 5_000)),
      ]);
    }

    if (!this.autoDetectionAttempted) {
      const ctx = this.config?.servers.context;
      await this.autoDetectProject(this.runtimeContext.workspacePath || ctx?.workspacePath);
    } else if (!this.autoDetectedProject && this.detectionInProgress) {
      // autoDetectionAttempted was set immediately when background scan started,
      // but the scan hasn't finished yet — wait up to 5 s for the result.
      await Promise.race([
        this.detectionInProgress,
        new Promise<void>(resolve => setTimeout(resolve, 5_000)),
      ]);
      this.detectionInProgress = null;
    }

    // Model name
    const { modelName, source: modelSource } = this.getModelNameWithSource();

    // Project path
    let projectPath: string | null = null;
    let projectSource = '(not detected)';

    if (this.runtimeContext.projectPath) {
      projectPath = this.runtimeContext.projectPath;
      projectSource = 'runtime context (from VS Code)';
    } else if (this.config?.servers.context?.projectPath) {
      projectPath = this.config.servers.context.projectPath;
      projectSource = '.mcp.json';
    } else if (this.autoDetectedProject?.projectPath) {
      projectPath = this.autoDetectedProject.projectPath;
      projectSource = 'auto-detected from .rnrproj';
    }

    // Package path
    const packagePath = this.getPackagePath();
    let packageSource = '(not configured)';

    const context = this.getContext();
    if (context?.packagePath) {
      packageSource = '.mcp.json';
    } else if (context?.workspacePath && /PackagesLocalDirectory/i.test(context.workspacePath)) {
      packageSource = 'workspacePath';
    } else if (this.autoDetectedProject?.packagePath) {
      packageSource = 'auto-detected from .rnrproj';
    } else if (packagePath) {
      packageSource = 'well-known path probe';
    }

    return { modelName, modelSource, projectPath, projectSource, packagePath, packageSource };
  }

  /**
   * Returns all projects discovered by the D365FO_SOLUTIONS_PATH scan.
   * Used by get_workspace_info to list available projects for solution switching.
   */
  getAllDetectedProjects(): D365ProjectInfo[] {
    return this.allDetectedProjects;
  }

  /**
   * Explicitly force a specific .rnrproj as the active project.
   * Called when the user passes projectPath to get_workspace_info() to switch solutions.
   * Bypasses the auto-detection cache — takes effect immediately.
   */
  async forceProject(projectPath: string): Promise<D365ProjectInfo | null> {
    try {
      const normalizedPath = path.normalize(projectPath);
      const modelName = await extractModelNameFromProject(normalizedPath);
      if (!modelName) {
        console.error(`[ConfigManager] forceProject: could not read model name from ${projectPath}`);
        return null;
      }
      const project: D365ProjectInfo = {
        projectPath: normalizedPath,
        modelName,
        solutionPath: path.dirname(path.dirname(normalizedPath)),
      };
      this.autoDetectedProject = project;
      this.autoDetectionAttempted = true;
      // Cache under the project path key so direct lookups work.
      this.autoDetectionCache.set(normalizedPath, project);
      // ALSO cache under the current workspace path key.
      // setRuntimeContext() (called per HTTP request with the VS 2022 workspace path)
      // does a cache lookup by workspace path. Without this, it would overwrite
      // autoDetectedProject with the OLD cached value on the very next request.
      const currentWorkspace = this.runtimeContext.workspacePath;
      if (currentWorkspace) {
        this.autoDetectionCache.set(normalizePath(currentWorkspace), project);
      }
      // Persist projectPath in runtimeContext so getWorkspaceInfoDiagnostics()
      // displays the correct project path even if autoDetectedProject is later
      // overridden by automatic detection (git branch / roots/list).
      // NOTE: we intentionally do NOT pin modelName here — automatic detection
      // (setRuntimeContextFromRoots) should be able to override the model when
      // the user switches git branches or opens a different workspace.
      this.runtimeContext = { ...this.runtimeContext, projectPath: normalizedPath };
      registerCustomModel(modelName);
      console.error(`[ConfigManager] ✅ forceProject: switched to ${modelName} (${normalizedPath})`);
      return project;
    } catch (err) {
      console.error(`[ConfigManager] forceProject error:`, err);
      return null;
    }
  }

  /**
   * Get project path
   * Priority: 1) Runtime context 2) .mcp.json config 3) Auto-detection from workspace
   */
  async getProjectPath(): Promise<string | null> {
    // Priority 1: Runtime context
    if (this.runtimeContext.projectPath) {
      return this.runtimeContext.projectPath;
    }
    
    // Priority 2: Config file
    const context = this.config?.servers.context;
    if (context?.projectPath) {
      return context.projectPath;
    }

    // Priority 3: Auto-detection
    if (!this.autoDetectionAttempted) {
      await this.autoDetectProject(this.runtimeContext.workspacePath || context?.workspacePath);
    }

    return this.autoDetectedProject?.projectPath || null;
  }

  /**
   * Get solution path
   * Priority: 1) Runtime context 2) .mcp.json config 3) Auto-detection from workspace
   */
  async getSolutionPath(): Promise<string | null> {
    // Priority 1: Runtime context
    if (this.runtimeContext.solutionPath) {
      return this.runtimeContext.solutionPath;
    }
    
    // Priority 2: Config file
    const context = this.config?.servers.context;
    if (context?.solutionPath) {
      return context.solutionPath;
    }

    // Priority 3: Auto-detection
    if (!this.autoDetectionAttempted) {
      await this.autoDetectProject(this.runtimeContext.workspacePath || context?.workspacePath);
    }

    return this.autoDetectedProject?.solutionPath || null;
  }

  /**
   * Returns a snapshot of the currently detected project for diagnostic logging.
   * All fields are resolved synchronously from the in-memory state — no async I/O.
   */
  getDetectionSummary(): {
    modelName: string | null;
    source: string;
    projectPath: string | null;
    solutionPath: string | null;
    workspacePath: string | null;
  } {
    const { modelName, source } = this.getModelNameWithSource();
    return {
      modelName,
      source,
      projectPath:  this.runtimeContext.projectPath  ??
                    this.autoDetectedProject?.projectPath  ??
                    this.config?.servers.context?.projectPath  ?? null,
      solutionPath: this.runtimeContext.solutionPath ??
                    this.autoDetectedProject?.solutionPath ??
                    this.config?.servers.context?.solutionPath ?? null,
      workspacePath: this.runtimeContext.workspacePath ??
                     this.config?.servers.context?.workspacePath ?? null,
    };
  }

  /**
   * Returns ONLY the model name found by scanning .rnrproj files on disk,
   * ignoring whatever is written in .mcp.json / env vars.
   * Useful when the configured modelName is a placeholder and we want to suggest
   * the real model to the user.
   */
  async getRawAutoDetectedModelName(): Promise<string | null> {
    if (!this.autoDetectionAttempted) {
      const context = this.config?.servers.context;
      await this.autoDetectProject(this.runtimeContext.workspacePath || context?.workspacePath);
    }
    return this.autoDetectedProject?.modelName || null;
  }

  /**
   * Get auto-detected model name
   * Returns the model name discovered through auto-detection.
   * Skips the scan when modelName is already configured — avoids needless filesystem traversal.
   */
  async getAutoDetectedModelName(): Promise<string | null> {
    // Short-circuit: if .mcp.json / env already provides a model name, skip the disk scan entirely.
    const alreadyKnown = this.getModelName();
    if (alreadyKnown) {
      return alreadyKnown;
    }

    if (!this.autoDetectionAttempted) {
      const context = this.config?.servers.context;
      await this.autoDetectProject(this.runtimeContext.workspacePath || context?.workspacePath);
    }

    return this.autoDetectedProject?.modelName || null;
  }

  /**
   * Get the resolved dev environment type.
   * Priority: 1) Explicit env var 2) .mcp.json context 3) Auto-detect
   */
  async getDevEnvironmentType(): Promise<'traditional' | 'ude'> {
    const explicit = process.env.DEV_ENVIRONMENT_TYPE || this.getContext()?.devEnvironmentType;
    if (explicit === 'ude') return 'ude';
    if (explicit === 'traditional') return 'traditional';

    // Auto-detect: check if XPP configs exist
    await this.ensureXppConfig();
    return this.xppConfig ? 'ude' : 'traditional';
  }

  /**
   * Get the custom packages path (UDE: ModelStoreFolder).
   */
  async getCustomPackagesPath(): Promise<string | null> {
    // Priority 1: .mcp.json context
    const ctx = this.getContext();
    if (ctx?.customPackagesPath) return ctx.customPackagesPath;
    // Priority 2: XPP config auto-detection
    await this.ensureXppConfig();
    return this.xppConfig?.customPackagesPath || null;
  }

  /**
   * Get the Microsoft packages path (UDE: FrameworkDirectory).
   */
  async getMicrosoftPackagesPath(): Promise<string | null> {
    // Priority 1: .mcp.json context
    const ctx = this.getContext();
    if (ctx?.microsoftPackagesPath) return ctx.microsoftPackagesPath;
    // Priority 2: XPP config auto-detection
    await this.ensureXppConfig();
    return this.xppConfig?.microsoftPackagesPath || null;
  }

  private async ensureXppConfig(): Promise<void> {
    if (this.xppConfigLoaded) return;
    this.xppConfigLoaded = true;

    this.xppConfigProvider = new XppConfigProvider();
    const configName = process.env.XPP_CONFIG_NAME || undefined;
    this.xppConfig = await this.xppConfigProvider.getActiveConfig(configName);

    if (this.xppConfig) {
      console.error(`[ConfigManager] XPP config loaded: ${this.xppConfig.configName} v${this.xppConfig.version}`);
      console.error(`   Custom packages: ${this.xppConfig.customPackagesPath}`);
      console.error(`   Microsoft packages: ${this.xppConfig.microsoftPackagesPath}`);
    }
  }
}

// Singleton instance
let configManager: ConfigManager | null = null;

/**
 * Get or create ConfigManager instance
 */
export function getConfigManager(configPath?: string): ConfigManager {
  if (!configManager) {
    configManager = new ConfigManager(configPath);
  }
  return configManager;
}

/**
 * Initialize configuration (load from file)
 */
export async function initializeConfig(
  configPath?: string
): Promise<McpConfig | null> {
  const manager = getConfigManager(configPath);
  return await manager.load();
}

/**
 * Fallback package path when configManager.getPackagePath() returns null.
 * This only happens when no config is loaded AND none of the well-known
 * candidate paths (C:, J:, K:) exist on the filesystem.
 * The value is a safe sentinel — callers will get a clear 'file not found'
 * rather than silently defaulting to a specific drive letter.
 */
const FALLBACK_PACKAGE_PATH = 'C:\\AosService\\PackagesLocalDirectory';

export function fallbackPackagePath(): string {
  return FALLBACK_PACKAGE_PATH;
}

/**
 * Extract the package name from a D365FO file path.
 * Standard AOT layout: .../PackagesLocalDirectory/{Package}/{Model}/Ax{Type}/{Name}.xml
 * Returns the package name (first segment after PackagesLocalDirectory), or null.
 * The package name is what isStandardModel() checks against (e.g. ApplicationSuite).
 */
export function extractModelFromFilePath(filePath: string): string | null {
  const normalised = filePath.replace(/\\/g, '/');
  const match = normalised.match(/PackagesLocalDirectory\/([^/]+)\/[^/]+\/Ax[^/]+\//i);
  if (match) {
    return match[1]; // package name (first segment, e.g. ApplicationSuite)
  }
  return null;
}
