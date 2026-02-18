/**
 * MCP Configuration Manager
 * Loads and provides access to .mcp.json configuration
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { autoDetectD365Project, type D365ProjectInfo } from './workspaceDetector.js';
import { registerCustomModel } from './modelClassifier.js';

export interface McpContext {
  workspacePath?: string;
  packagePath?: string;
  projectPath?: string;
  solutionPath?: string;
}

export interface McpConfig {
  servers: {
    [key: string]: any;
    context?: McpContext;
  };
}

class ConfigManager {
  private config: McpConfig | null = null;
  private configPath: string;
  private runtimeContext: Partial<McpContext> = {};
  private autoDetectedProject: D365ProjectInfo | null = null;
  private autoDetectionAttempted: boolean = false;

  constructor(configPath?: string) {
    // Default to .mcp.json in current directory or parent directories
    this.configPath = configPath || this.findConfigFile();
  }

  /**
   * Auto-detect D365FO project from workspace
   * Called automatically when projectPath/solutionPath is requested but not configured
   */
  private async autoDetectProject(workspacePath?: string): Promise<void> {
    if (this.autoDetectionAttempted) {
      return; // Only attempt once
    }

    this.autoDetectionAttempted = true;
    console.error('[ConfigManager] Auto-detecting D365FO project from workspace...');

    // Try to detect from provided workspace path or current directory
    const detectedProject = await autoDetectD365Project(workspacePath);
    
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
   */
  setRuntimeContext(context: Partial<McpContext>): void {
    this.runtimeContext = { ...this.runtimeContext, ...context };
    console.error(
      `[ConfigManager] Runtime context updated:`,
      JSON.stringify(context)
    );
  }

  /**
   * Clear runtime context
   */
  clearRuntimeContext(): void {
    this.runtimeContext = {};
  }

  /**
   * Find .mcp.json file in current or parent directories
   */
  private findConfigFile(): string {
    let currentDir = process.cwd();
    const maxDepth = 5;
    let depth = 0;

    while (depth < maxDepth) {
      const configPath = path.join(currentDir, '.mcp.json');
      try {
        // Synchronous check for simplicity
        if (require('fs').existsSync(configPath)) {
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

    // Fallback to current directory
    return path.join(process.cwd(), '.mcp.json');
  }

  /**
   * Load configuration from .mcp.json file
   */
  async load(): Promise<McpConfig | null> {
    try {
      console.error(`[ConfigManager] Loading config from: ${this.configPath}`);
      const content = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(content);
      console.error('[ConfigManager] Config loaded successfully');
      return this.config;
    } catch (error) {
      console.error('[ConfigManager] Failed to load .mcp.json:', error);
      return null;
    }
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
      console.error(
        `[ConfigManager] Using explicit packagePath: ${context.packagePath}`
      );
      return context.packagePath;
    }

    // If workspacePath contains PackagesLocalDirectory, extract the base path
    if (context.workspacePath) {
      const normalized = path.normalize(context.workspacePath);
      
      // If workspacePath points to a specific model, extract base path
      // Example: K:\AOSService\PackagesLocalDirectory\AslCore
      // Should return: K:\AOSService\PackagesLocalDirectory
      const match = normalized.match(/^(.+[\\\/]PackagesLocalDirectory)(?:[\\\/]|$)/i);
      if (match) {
        console.error(
          `[ConfigManager] Extracted packagePath from workspacePath: ${match[1]}`
        );
        return match[1];
      }
    }

    // Fallback: check if auto-detection already ran and found packagePath
    if (this.autoDetectedProject?.packagePath) {
      return this.autoDetectedProject.packagePath;
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
   * Returns the model name discovered through auto-detection
   */
  async getAutoDetectedModelName(): Promise<string | null> {
    if (!this.autoDetectionAttempted) {
      const context = this.config?.servers.context;
      await this.autoDetectProject(this.runtimeContext.workspacePath || context?.workspacePath);
    }

    return this.autoDetectedProject?.modelName || null;
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
