/**
 * MCP Configuration Manager
 * Loads and provides access to .mcp.json configuration
 */

import * as fs from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { autoDetectD365Project, detectD365Project, type D365ProjectInfo } from './workspaceDetector.js';
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
  private autoDetectedProject: D365ProjectInfo | null = null;
  private autoDetectionAttempted: boolean = false;
  // Cache auto-detection results per workspace path (PERFORMANCE FIX)
  private autoDetectionCache = new Map<string, D365ProjectInfo | null>();
  private xppConfigProvider: XppConfigProvider | null = null;
  private xppConfig: XppEnvironmentConfig | null = null;
  private xppConfigLoaded: boolean = false;

  constructor(configPath?: string) {
    // Default to .mcp.json in current directory or parent directories
    this.configPath = configPath || this.findConfigFile();
  }

  /**
   * Auto-detect D365FO project from workspace
   * Called automatically when projectPath/solutionPath is requested but not configured
   * PERFORMANCE: Results are cached per workspace path
   */
  private async autoDetectProject(workspacePath?: string): Promise<void> {
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
    
    if (detectedProject) {
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
        console.error(
          `[ConfigManager] New workspace — will auto-detect: ${cacheKey}`
        );
      }
    }
  }

  /**
   * Clear runtime context
   */
  clearRuntimeContext(): void {
    this.runtimeContext = {};
  }

  /**
   * Find .mcp.json file in current or parent directories, then user home directory
   * Priority:
   * 1. Current directory and up to 5 parent directories (project-specific config)
   * 2. User home directory (global config)
   * 3. Current directory (fallback)
   */
  private findConfigFile(): string {
    // Step 0: Explicit override via MCP_CONFIG_PATH env var
    const envConfigPath = process.env.MCP_CONFIG_PATH;
    if (envConfigPath && existsSync(envConfigPath)) {
      console.error(`[ConfigManager] Using MCP_CONFIG_PATH: ${envConfigPath}`);
      return envConfigPath;
    }

    // Step 1: Search in current directory and parent directories
    let currentDir = process.cwd();
    const maxDepth = 5;
    let depth = 0;

    while (depth < maxDepth) {
      const configPath = path.join(currentDir, '.mcp.json');
      try {
        if (existsSync(configPath)) {
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

    // Step 2: User home directory — use os.homedir() which is reliable
    // even when USERPROFILE / HOME env vars are not set in the server process.
    const homeDir = os.homedir();
    if (homeDir) {
      const homeConfigPath = path.join(homeDir, '.mcp.json');
      try {
        if (existsSync(homeConfigPath)) {
          console.error(`[ConfigManager] Using global config from home directory: ${homeConfigPath}`);
          return homeConfigPath;
        }
      } catch {
        // Continue to fallback
      }
    }

    // Step 3: Fallback to current directory (file may not exist yet)
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
    
    // Merge file config with runtime context (runtime overrides file)
    if (!fileContext && Object.keys(this.runtimeContext).length === 0) {
      return null;
    }
    
    return {
      ...fileContext,
      ...this.runtimeContext,
    };
  }

  /**
   * Get workspace path from configuration
   * Returns the base PackagesLocalDirectory path if workspacePath contains it
   */
  getPackagePath(): string | null {
    const context = this.getContext();
    if (!context) {
      return null;
    }

    // If packagePath is explicitly set, use it
    if (context.packagePath) {
      const resolved = normalizePath(context.packagePath);
      console.error(
        `[ConfigManager] Using explicit packagePath: ${resolved}`
      );
      return resolved;
    }

    // If workspacePath contains PackagesLocalDirectory, extract the base path
    if (context.workspacePath) {
      const normalized = path.normalize(context.workspacePath);
      
      // If workspacePath points to a specific model, extract base path
      // Example: K:\AosService\PackagesLocalDirectory\MyPackage
      // Should return: K:\AosService\PackagesLocalDirectory
      const match = normalized.match(/^(.+[\\\/]PackagesLocalDirectory)(?:[\\\/]|$)/i);
      if (match) {
        const resolved = normalizePath(match[1]);
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
   * workspacePath like K:\AOSService\PackagesLocalDirectory\MyPackage → "MyPackage"
   * This allows automatic model detection on non-Windows (Azure) without D365FO_MODEL_NAME env var.
   * Note: package name usually equals model name, but not always.
   */
  getModelNameFromWorkspacePath(): string | null {
    const workspacePath = this.getContext()?.workspacePath;
    if (!workspacePath) return null;
    const segment = path.basename(path.normalize(workspacePath));
    return segment || null;
  }

  /**
   * Get model name from configuration.
   * Priority:
   *   1) Explicit modelName in mcp.json context
   *   2) Last segment of workspacePath (only when it looks like a D365FO package, i.e. no hyphens)
   *   3) D365FO_MODEL_NAME env var
   */
  getModelName(): string | null {
    const context = this.getContext();
    if (context?.modelName) {
      return context.modelName;
    }
    const fromWorkspace = this.getModelNameFromWorkspacePath();
    // Skip workspace-derived name when it clearly isn't a D365FO package
    // (D365FO package names use PascalCase/underscore, not kebab-case like repo names)
    if (fromWorkspace && !fromWorkspace.includes('-')) {
      return fromWorkspace;
    }
    return process.env.D365FO_MODEL_NAME || null;
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
