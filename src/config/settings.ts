/**
 * Setting registry — the single source of truth for every configurable value.
 *
 * One entry per setting describes, in one place:
 *   • where it lives in config/d365fo-mcp.json (`path`, dotted)
 *   • which environment variable the runtime actually reads (`env`)
 *   • how to serialise it to that variable (`type`)
 *   • what to ask the user and how to explain it (`label` / `description`)
 *   • whether the setup wizard asks for it up front (`tier`)
 *
 * Everything else — the wizard, the config loader, the doctor and the docs
 * table — is generated from this list, so a new setting only has to be added
 * here. Purely operational variables the user should never have to set
 * (NODE_ENV, WEBSITES_PORT, CI/TERM detection, ENV_FILE, MCP_STDIO_MODE) are
 * deliberately absent: they are runtime/platform inputs, not configuration.
 */

export type SettingType = 'string' | 'path' | 'boolean' | 'int' | 'list' | 'enum';

/** basic = asked during setup · advanced = asked only in the advanced pass · secret = stored in config/secrets.json */
export type SettingTier = 'basic' | 'advanced' | 'secret';

export type SectionId =
  | 'environment'
  | 'workspace'
  | 'naming'
  | 'index'
  | 'server'
  | 'bridge'
  | 'behavior'
  | 'azure';

export interface SettingChoice {
  value: string;
  hint: string;
}

export interface Setting {
  /** Dotted path inside the JSON config, e.g. "environment.packagePath". */
  path: string;
  /** Environment variable the server/scripts read at runtime. */
  env: string;
  section: SectionId;
  tier: SettingTier;
  type: SettingType;
  /** Question shown by the wizard. */
  label: string;
  /** Why this exists and what changes when you set it — shown as a hint and in the docs. */
  description: string;
  /** Effective default when the value is absent; documented, never written blindly. */
  default?: string | number | boolean | string[];
  choices?: SettingChoice[];
  placeholder?: string;
  /** Wizard refuses an empty answer. */
  required?: boolean;
}

export interface Section {
  id: SectionId;
  title: string;
  description: string;
}

export const SECTIONS: Section[] = [
  {
    id: 'environment',
    title: 'D365FO environment',
    description: 'Which developer box this is and where its X++ packages live.',
  },
  {
    id: 'workspace',
    title: 'Workspace',
    description: 'The model/project the server writes to. Auto-detected from the IDE when left empty.',
  },
  {
    id: 'naming',
    title: 'Naming convention',
    description: 'How generated objects, extensions and fields are named.',
  },
  {
    id: 'index',
    title: 'Metadata index',
    description: 'What gets extracted into the SQLite index and where it is stored.',
  },
  {
    id: 'server',
    title: 'Server runtime',
    description: 'Transport, timeouts and logging of the MCP server process.',
  },
  {
    id: 'bridge',
    title: 'C# bridge',
    description: 'The metadata-provider child process — the only write path to the AOT.',
  },
  {
    id: 'behavior',
    title: 'Quality gates',
    description: 'Rules that block writes when generated code is not grounded or violates a pattern.',
  },
  {
    id: 'azure',
    title: 'Azure blob index',
    description: 'Downloading a pre-built index from blob storage instead of building it locally.',
  },
];

export const SETTINGS: Setting[] = [
  // ── environment ──────────────────────────────────────────────────────────
  {
    path: 'environment.type',
    env: 'D365FO_DEV_ENVIRONMENT_TYPE',
    section: 'environment',
    tier: 'basic',
    type: 'enum',
    label: 'Development environment type',
    description:
      'Classic AOSService VM ("traditional") or Unified Developer Experience / Power Platform Tools ("ude"). ' +
      'The wizard preselects the one it detects — UDE when XPP config files exist in ' +
      '%LOCALAPPDATA%\\Microsoft\\Dynamics365\\XPPConfig. Left unset, the server falls back to that same detection.',
    choices: [
      { value: 'traditional', hint: 'classic AOSService VM with PackagesLocalDirectory' },
      { value: 'ude', hint: 'Unified Developer Experience / Power Platform Tools' },
    ],
  },
  {
    path: 'environment.packagePath',
    env: 'D365FO_PACKAGE_PATH',
    section: 'environment',
    tier: 'basic',
    type: 'path',
    label: 'Packages root (PackagesLocalDirectory)',
    description:
      'Root folder of all D365FO packages — the read-only reference the index is built from. ' +
      'Machine-wide on a traditional VM; UDE resolves it from the XPP config instead.',
    placeholder: 'C:\\AOSService\\PackagesLocalDirectory',
  },
  {
    path: 'environment.customModels',
    env: 'CUSTOM_MODELS',
    section: 'environment',
    tier: 'basic',
    type: 'list',
    label: 'Custom model names',
    description:
      'Your own (non-Microsoft) models, comma-separated. They are indexed with priority and treated as writable. ' +
      'Find them in VS → Dynamics 365 → Model Management → View models. UDE detects these automatically.',
    placeholder: 'ContosoRobotics,ContosoBank',
  },
  {
    path: 'environment.xppConfigName',
    env: 'XPP_CONFIG_NAME',
    section: 'environment',
    tier: 'basic',
    type: 'string',
    label: 'XPP config to pin (UDE)',
    description:
      'Name of a config file in %LOCALAPPDATA%\\Microsoft\\Dynamics365\\XPPConfig. Pinning one keeps the server on a ' +
      'specific environment/version; leave empty to always use the newest config.',
  },
  {
    path: 'environment.customPackagesPath',
    env: 'D365FO_CUSTOM_PACKAGES_PATH',
    section: 'environment',
    tier: 'advanced',
    type: 'path',
    label: 'Custom X++ root (UDE ModelStoreFolder)',
    description:
      'Where custom model XML is written and tracked by git. Normally read from the XPP config — override only when ' +
      'your working tree lives somewhere else.',
  },
  {
    path: 'environment.microsoftPackagesPath',
    env: 'D365FO_MICROSOFT_PACKAGES_PATH',
    section: 'environment',
    tier: 'advanced',
    type: 'path',
    label: 'Microsoft X++ root (UDE FrameworkDirectory)',
    description: 'Read-only Microsoft packages folder. Normally read from the XPP config.',
  },

  // ── workspace ────────────────────────────────────────────────────────────
  {
    path: 'workspace.modelName',
    env: 'D365FO_MODEL_NAME',
    section: 'workspace',
    tier: 'basic',
    type: 'string',
    label: 'Target model for code generation',
    description:
      'The model new objects are created in. Leave empty to let the server detect it from the IDE workspace or the ' +
      '.rnrproj file — set it explicitly when one server instance always serves one model.',
  },
  {
    path: 'workspace.path',
    env: 'D365FO_WORKSPACE_PATH',
    section: 'workspace',
    tier: 'basic',
    type: 'path',
    label: 'Workspace path (…\\PackagesLocalDirectory\\<Package>\\<Model>)',
    description:
      'Two-level AOT path of the model being worked on. Used to resolve the package root and the write target when ' +
      'the IDE does not report a workspace.',
    placeholder: 'K:\\AosService\\PackagesLocalDirectory\\YourPackage\\YourModel',
  },
  {
    path: 'workspace.solutionsPath',
    env: 'D365FO_SOLUTIONS_PATH',
    section: 'workspace',
    tier: 'basic',
    type: 'path',
    label: 'Folder scanned for .rnrproj projects',
    description:
      'Scanned once at startup so the server can switch model automatically when you open another solution or ' +
      'git branch. Optional, but it is what makes multi-project workspaces work without reconfiguring.',
    placeholder: 'K:\\repos\\MySolution\\projects',
  },
  {
    path: 'workspace.projectPath',
    env: 'D365FO_PROJECT_PATH',
    section: 'workspace',
    tier: 'advanced',
    type: 'path',
    label: 'Pinned .rnrproj file',
    description: 'Forces one specific project instead of auto-detection. Rarely needed outside CI.',
  },
  {
    path: 'workspace.solutionPath',
    env: 'D365FO_SOLUTION_PATH',
    section: 'workspace',
    tier: 'advanced',
    type: 'path',
    label: 'Pinned .sln file',
    description: 'Forces one specific solution instead of auto-detection. Rarely needed outside CI.',
  },

  // ── naming ───────────────────────────────────────────────────────────────
  {
    path: 'naming.prefix',
    env: 'EXTENSION_PREFIX',
    section: 'naming',
    tier: 'basic',
    type: 'string',
    label: 'Extension prefix for custom objects',
    description:
      'Your ISV/customer prefix. Prepended to every generated object, field and method name and enforced by the ' +
      'naming validator, so BP checks pass on the first build.',
    placeholder: 'ISV_',
    required: true,
  },
  {
    path: 'naming.suffix',
    env: 'EXTENSION_SUFFIX',
    section: 'naming',
    tier: 'advanced',
    type: 'string',
    label: 'Extension suffix',
    description:
      'Optional suffix appended to new object names (MyTableZZ with suffix "ZZ"). Most projects use only a prefix — ' +
      'leave empty unless your convention requires one.',
  },
  {
    path: 'naming.extensionStyle',
    env: 'EXTENSION_NAMING_STYLE',
    section: 'naming',
    tier: 'advanced',
    type: 'enum',
    label: 'How extension elements are named',
    description:
      'Whether extension classes/elements embed the prefix (per the Microsoft prefix guideline) or the model name ' +
      '(the Visual Studio default). Use model-name when your model name is long but your prefix is a short abbreviation.',
    default: 'prefix',
    choices: [
      { value: 'prefix', hint: 'CustTable.CrExtension — embeds the extension prefix' },
      { value: 'model-name', hint: 'CustTable.ContosoRobotics — embeds the model name (VS default)' },
    ],
  },

  // ── index ────────────────────────────────────────────────────────────────
  {
    path: 'index.extractMode',
    env: 'EXTRACT_MODE',
    section: 'index',
    tier: 'basic',
    type: 'enum',
    label: 'What to index',
    description:
      'Scope of the metadata extraction. "all" gives full cross-reference search over the standard application but ' +
      'takes 1–2 hours and produces a multi-GB database; "custom" indexes only your own models and finishes in minutes.',
    default: 'all',
    choices: [
      { value: 'all', hint: 'standard + custom — full search, 1–2 h build' },
      { value: 'custom', hint: 'custom models only — minutes' },
      { value: 'standard', hint: 'Microsoft models only' },
    ],
  },
  {
    path: 'index.includeLabels',
    env: 'INCLUDE_LABELS',
    section: 'index',
    tier: 'basic',
    type: 'boolean',
    label: 'Index label files',
    description:
      'Builds the labels database so labels(action="search") and label reuse work. Disabling it speeds up the build ' +
      'and shrinks the index, at the cost of label lookup.',
    default: true,
  },
  {
    path: 'index.labelLanguages',
    env: 'LABEL_LANGUAGES',
    section: 'index',
    tier: 'basic',
    type: 'list',
    label: 'Label languages to index',
    description:
      'Comma-separated language codes. Each extra language multiplies the label table — indexing only the languages ' +
      'you actually ship keeps the database small.',
    default: ['en-US'],
    placeholder: 'en-US,cs,de',
  },
  {
    path: 'index.dbPath',
    env: 'DB_PATH',
    section: 'index',
    tier: 'advanced',
    type: 'path',
    label: 'Metadata database file',
    description: 'SQLite file holding the indexed X++ metadata. Relative paths resolve from the config file directory.',
    default: './data/xpp-metadata.db',
  },
  {
    path: 'index.labelsDbPath',
    env: 'LABELS_DB_PATH',
    section: 'index',
    tier: 'advanced',
    type: 'path',
    label: 'Labels database file',
    description:
      'Second SQLite file for labels (dual-database architecture keeps label writes from locking metadata reads). ' +
      'Defaults to <dbPath>-labels.db.',
    default: './data/xpp-metadata-labels.db',
  },
  {
    path: 'index.metadataPath',
    env: 'METADATA_PATH',
    section: 'index',
    tier: 'advanced',
    type: 'path',
    label: 'Extracted XML folder',
    description: 'Working folder for the XML dumped during extraction, before it is loaded into the database.',
    default: './extracted-metadata',
  },
  {
    path: 'index.labelSortOrder',
    env: 'LABEL_SORT_ORDER',
    section: 'index',
    tier: 'advanced',
    type: 'enum',
    label: 'Where new labels are inserted',
    description:
      'Alphabetical keeps .label.txt files sorted (smaller diffs, matches most teams); append adds new labels at the ' +
      'end of the file (preserves manual grouping).',
    default: 'alphabetical',
    choices: [
      { value: 'alphabetical', hint: 'insert in sorted position' },
      { value: 'append', hint: 'add at the end of the file' },
    ],
  },
  {
    path: 'index.computeStats',
    env: 'COMPUTE_STATS',
    section: 'index',
    tier: 'advanced',
    type: 'boolean',
    label: 'Compute usage statistics during build',
    description: 'Adds per-object usage counts used for ranking. Noticeably slows down large builds.',
    default: false,
  },

  // ── server ───────────────────────────────────────────────────────────────
  {
    path: 'server.mode',
    env: 'MCP_SERVER_MODE',
    section: 'server',
    tier: 'advanced',
    type: 'enum',
    label: 'Server mode',
    description:
      'Which half of the toolset this process exposes. "full" is a single local server; the hybrid deployment splits ' +
      'into an Azure "read-only" instance plus a local "write-only" companion that owns the C# bridge.',
    default: 'full',
    choices: [
      { value: 'full', hint: 'all tools — single local server' },
      { value: 'read-only', hint: 'search/inspect only — Azure-hosted shared index' },
      { value: 'write-only', hint: 'create/modify/build only — local companion' },
    ],
  },
  {
    path: 'server.port',
    env: 'PORT',
    section: 'server',
    tier: 'basic',
    type: 'int',
    label: 'HTTP port',
    description:
      'Port for the HTTP transport. Only relevant when clients connect over http://localhost:<port>/mcp/ — an IDE that ' +
      'spawns the server itself uses stdio and ignores this.',
    default: 8080,
  },
  {
    path: 'server.debugLogging',
    env: 'DEBUG_LOGGING',
    section: 'server',
    tier: 'advanced',
    type: 'boolean',
    label: 'Verbose debug logging',
    description: 'Prints per-step diagnostics to stderr. Useful when a tool misbehaves; noisy otherwise.',
    default: false,
  },
  {
    path: 'server.logFile',
    env: 'LOG_FILE',
    section: 'server',
    tier: 'advanced',
    type: 'path',
    label: 'Mirror stderr to a log file',
    description:
      'Absolute path; the server appends everything it writes to stderr. The way to get logs out of an IDE that hides ' +
      'MCP subprocess output.',
  },
  {
    path: 'server.forceHttp',
    env: 'MCP_FORCE_HTTP',
    section: 'server',
    tier: 'advanced',
    type: 'boolean',
    label: 'Force HTTP transport',
    description:
      'The server picks stdio when its stdin is piped. Set this to keep HTTP anyway — e.g. when running under a ' +
      'process supervisor that pipes stdin.',
    default: false,
  },
  {
    path: 'server.toolTimeoutMs',
    env: 'MCP_TOOL_TIMEOUT_MS',
    section: 'server',
    tier: 'advanced',
    type: 'int',
    label: 'Default tool timeout (ms)',
    description: 'Upper bound for a single tool call before the server returns a timeout error.',
    default: 120000,
  },
  {
    path: 'server.toolTimeoutFastMs',
    env: 'MCP_TOOL_TIMEOUT_FAST_MS',
    section: 'server',
    tier: 'advanced',
    type: 'int',
    label: 'Fast-tool timeout (ms)',
    description: 'Timeout for lookups that should always be quick (minimum 5000).',
    default: 30000,
  },
  {
    path: 'server.toolTimeoutHeavyMs',
    env: 'MCP_TOOL_TIMEOUT_HEAVY_MS',
    section: 'server',
    tier: 'advanced',
    type: 'int',
    label: 'Heavy-tool timeout (ms)',
    description: 'Timeout for builds, DB sync and test runs (minimum 60000). Raise it on slow VMs.',
    default: 600000,
  },
  {
    path: 'server.readPoolSize',
    env: 'READ_POOL_SIZE',
    section: 'server',
    tier: 'advanced',
    type: 'int',
    label: 'SQLite read connections',
    description: 'Parallel read connections to the index (clamped 1–8). More helps concurrent searches on fast disks.',
    default: 3,
  },
  {
    path: 'server.operationLockTimeoutMs',
    env: 'OPERATION_LOCK_TIMEOUT_MS',
    section: 'server',
    tier: 'advanced',
    type: 'int',
    label: 'Wait for a conflicting operation (ms)',
    description: 'How long a build/sync waits for another one to finish before failing.',
    default: 900000,
  },
  {
    path: 'server.operationLockPollMs',
    env: 'OPERATION_LOCK_POLL_MS',
    section: 'server',
    tier: 'advanced',
    type: 'int',
    label: 'Lock poll interval (ms)',
    description: 'How often the waiting process re-checks the lock.',
    default: 250,
  },
  {
    path: 'server.operationLockStaleMs',
    env: 'OPERATION_LOCK_STALE_MS',
    section: 'server',
    tier: 'advanced',
    type: 'int',
    label: 'Lock considered abandoned after (ms)',
    description: 'A lock older than this is treated as left behind by a crashed process and broken.',
    default: 1200000,
  },

  // ── bridge ───────────────────────────────────────────────────────────────
  {
    path: 'bridge.readyTimeoutMs',
    env: 'BRIDGE_READY_TIMEOUT_MS',
    section: 'bridge',
    tier: 'advanced',
    type: 'int',
    label: 'Bridge startup timeout (ms)',
    description: 'Time allowed for the metadata provider to initialise. Raise it on large installations.',
    default: 30000,
  },
  {
    path: 'bridge.callTimeoutMs',
    env: 'BRIDGE_CALL_TIMEOUT_MS',
    section: 'bridge',
    tier: 'advanced',
    type: 'int',
    label: 'Bridge call timeout (ms)',
    description: 'Per-request timeout for a single bridge call. Big searches on slow VMs may need more.',
    default: 60000,
  },
  {
    path: 'bridge.maxRetries',
    env: 'BRIDGE_MAX_RETRIES',
    section: 'bridge',
    tier: 'advanced',
    type: 'int',
    label: 'Retries for read calls',
    description:
      'Read calls are retried after a health-checked restart of the child process. Writes are never retried — a ' +
      'timed-out write may already have been applied. 0 disables retries.',
    default: 2,
  },
  {
    path: 'bridge.healthcheckMs',
    env: 'BRIDGE_HEALTHCHECK_MS',
    section: 'bridge',
    tier: 'advanced',
    type: 'int',
    label: 'Idle ping interval (ms)',
    description: 'Proactively detects a wedged bridge while idle. 0 disables the ping.',
    default: 0,
  },
  {
    path: 'bridge.maxRestarts',
    env: 'BRIDGE_MAX_RESTARTS',
    section: 'bridge',
    tier: 'advanced',
    type: 'int',
    label: 'Max restarts per minute',
    description: 'Circuit breaker: after this many respawns within 60 s the server stops trying.',
    default: 3,
  },
  {
    path: 'bridge.exePath',
    env: 'D365FO_BRIDGE_EXE_PATH',
    section: 'bridge',
    tier: 'advanced',
    type: 'path',
    label: 'Bridge executable',
    description:
      'Absolute path to D365MetadataBridge.exe. Leave empty to auto-detect inside the installation — ' +
      'the setup wizard fills this in for an npm install, where the binary is built outside the package ' +
      'so that updating the package does not delete it.',
  },
  {
    path: 'bridge.logFile',
    env: 'D365FO_BRIDGE_LOG_FILE',
    section: 'bridge',
    tier: 'advanced',
    type: 'path',
    label: 'Bridge diagnostic log',
    description: 'Absolute path the C# bridge appends its own diagnostics to.',
  },
  {
    path: 'bridge.fsScanTimeoutMs',
    env: 'D365FO_FS_SCAN_TIMEOUT_MS',
    section: 'bridge',
    tier: 'advanced',
    type: 'int',
    label: 'Filesystem fallback scan timeout (ms)',
    description:
      'Budget for the filesystem scan used when the bridge cannot answer an extension lookup (minimum 500).',
    default: 3000,
  },
  {
    path: 'bridge.disableFsFallback',
    env: 'D365FO_DISABLE_FS_FALLBACK',
    section: 'bridge',
    tier: 'advanced',
    type: 'boolean',
    label: 'Disable the filesystem fallback',
    description:
      'Makes extension lookups bridge-only. Turn on to diagnose stale-index issues — results get stricter, not faster.',
    default: false,
  },

  // ── behavior ─────────────────────────────────────────────────────────────
  {
    path: 'behavior.formPatternEnforce',
    env: 'FORM_PATTERN_ENFORCE',
    section: 'behavior',
    tier: 'advanced',
    type: 'boolean',
    label: 'Block form writes that break the pattern',
    description:
      'Structural form-pattern violations (unknown pattern, missing container, wrong control order) block the write. ' +
      'Disable to log them as warnings instead.',
    default: true,
  },
  {
    path: 'behavior.groundingEnforce',
    env: 'GROUNDING_ENFORCE',
    section: 'behavior',
    tier: 'advanced',
    type: 'boolean',
    label: 'Require grounding tokens for writes',
    description:
      'Write tools only accept a token issued by prepare(), proving the model actually inspected the real object ' +
      'before generating code. Strongly recommended for agent use; adds one extra call per write.',
    default: false,
  },

  // ── azure ────────────────────────────────────────────────────────────────
  {
    path: 'azure.blobContainer',
    env: 'BLOB_CONTAINER_NAME',
    section: 'azure',
    tier: 'advanced',
    type: 'string',
    label: 'Blob container with the index',
    description: 'Container the pre-built database is downloaded from at startup.',
    default: 'xpp-metadata',
  },
  {
    path: 'azure.blobDatabase',
    env: 'BLOB_DATABASE_NAME',
    section: 'azure',
    tier: 'advanced',
    type: 'string',
    label: 'Blob name of the database',
    description: 'Path of the database blob inside the container.',
    default: 'databases/xpp-metadata-latest.db',
  },

  // ── secrets (config/secrets.json) ────────────────────────────────────────
  {
    path: 'azure.storageConnectionString',
    env: 'AZURE_STORAGE_CONNECTION_STRING',
    section: 'azure',
    tier: 'secret',
    type: 'string',
    label: 'Azure storage connection string',
    description:
      'Used to download the shared index (Azure Portal → Storage Account → Access keys). Stored in config/secrets.json.',
  },
  {
    path: 'server.apiKey',
    env: 'API_KEY',
    section: 'server',
    tier: 'secret',
    type: 'string',
    label: 'API key required from HTTP clients',
    description:
      'When set, every HTTP request must present this key. Leave empty for a localhost-only server; set it whenever ' +
      'the port is reachable from another machine.',
  },
  {
    path: 'behavior.groundingSecret',
    env: 'GROUNDING_SECRET',
    section: 'behavior',
    tier: 'secret',
    type: 'string',
    label: 'Shared secret for portable grounding tokens',
    description:
      'Set the SAME random string on both halves of a hybrid deployment (and on every scaled-out App Service ' +
      'instance) so tokens issued by one process validate in another. Without it, tokens are memory-local.',
  },
];

const BY_PATH = new Map(SETTINGS.map(s => [s.path, s]));
const BY_ENV = new Map(SETTINGS.map(s => [s.env, s]));

export function settingByPath(path: string): Setting | undefined {
  return BY_PATH.get(path);
}

export function settingByEnv(env: string): Setting | undefined {
  return BY_ENV.get(env);
}

export function settingsInSection(section: SectionId, tier?: SettingTier): Setting[] {
  return SETTINGS.filter(s => s.section === section && (tier === undefined || s.tier === tier));
}

/** Serialise a config value to the string form the runtime expects in process.env. */
export function serializeValue(setting: Setting, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  switch (setting.type) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'int':
      return String(value);
    case 'list':
      return Array.isArray(value) ? value.join(',') : String(value);
    default: {
      const s = String(value);
      return s.length > 0 ? s : null;
    }
  }
}

/** Parse a string (from a .env file or a prompt) into the typed config value. */
export function parseValue(setting: Setting, raw: string): unknown {
  const trimmed = raw.trim();
  switch (setting.type) {
    case 'boolean':
      return /^(true|1|yes|on)$/i.test(trimmed);
    case 'int': {
      const n = parseInt(trimmed, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'list':
      return trimmed ? trimmed.split(',').map(s => s.trim()).filter(Boolean) : [];
    default:
      return trimmed;
  }
}
