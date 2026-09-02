/**
 * The demand oracle — what callers actually ask this server for, mined from
 * GitHub Copilot Chat debug logs on the machine it runs on.
 *
 * Every coverage round so far has been steered by this measurement, and twice it
 * overturned the plan: `generate_object` looked like a headline feature and is 5
 * calls in 1,600; the single most-asked X++ question is the table `validateWrite`
 * Chain of Command contract, which had no red-first test path at all until 1.16.0.
 * A knowledge base is a token budget where every entry competes for attention, so
 * "what do people ask" is not colour — it is the ordering function.
 *
 * ── REDACTION IS THE POINT ─────────────────────────────────────────────────────
 * These logs hold real customer object names and the user's own prompts. This
 * script therefore reports **only values the server itself defines** — tool
 * names, `action`/`mode`/`operation`/`objectType`/`pattern` discriminators, and
 * knowledge topics that resolve against `KNOWLEDGE_BASE` or the op-spec registry.
 * Anything else is counted as `<unresolved>` and its text is discarded before it
 * reaches an output string, so the digest is safe to commit and to paste into an
 * issue. A free-text `topic` is a fragment of a user prompt; a `objectName` is a
 * customer's table. Neither is ever printed, and `--json` is subject to the same
 * rule — there is no flag that turns redaction off.
 *
 * The counterpart command `npm run cli -- session <log>` answers a different
 * question (round-trip COST for one session). This answers demand ACROSS
 * sessions, and reuses that reader's line format rather than its analysis.
 *
 * Usage:
 *   npm run oracle:demand                       # every log under %APPDATA%
 *   npm run oracle:demand -- --logs <dir>       # a directory to search instead
 *   npm run oracle:demand -- --top 25
 *   npm run oracle:demand -- --json demand.json # the same redacted digest
 */
import * as fs from 'fs';
import * as path from 'path';
import { d365foFileTool } from '../src/server/toolSchemas/d365foFile.js';
import { KNOWLEDGE_BASE } from '../src/tools/knowledge/xppKnowledge.js';
import { D365FO_FILE_CREATE_PROPERTY_SPECS, D365FO_FILE_OP_SPECS } from '../src/tools/specs/d365foFileOpSpecs.js';
import { GENERATE_OBJECT_MODE_SPECS } from '../src/tools/specs/generateObjectOpSpecs.js';
import { CODE_GEN_PATTERNS } from '../src/tools/smart/codeGen.js';
import { parseArgs } from './oracles/aotSource.js';

/** Placeholder that replaces any value the server does not define. Never a substring of one. */
const UNRESOLVED = '<unresolved>';

/**
 * The published `objectType` enum, read off the wire schema rather than
 * re-listed. Hand-listing it here is exactly how the first run of this script
 * redacted `class-extension` and `form-extension` — 46 of 195 writes and the two
 * most-created extension kinds — into `<unresolved>`, which would have read as
 * "nobody creates extensions".
 */
function publishedObjectTypes(): string[] {
  const schema = d365foFileTool.inputSchema as {
    properties?: { objectType?: { enum?: string[] } };
  };
  const values = schema.properties?.objectType?.enum;
  if (!values?.length) throw new Error('d365fo_file schema has no objectType enum — the reader is out of date.');
  return values;
}

/**
 * Closed vocabularies, read from the code so they cannot drift from what the
 * server publishes. A value outside them is redacted, which means a newly added
 * operation shows up as `<unresolved>` until the source it comes from is
 * included here — the safe direction to fail.
 */
function vocabularies() {
  const objectTypes = publishedObjectTypes();
  return {
    objectTypes: new Set(objectTypes.map(k => k.toLowerCase())),
    knowledgeTopics: new Set(KNOWLEDGE_BASE.map(e => e.id.toLowerCase())),
    opSpecTopics: new Set([
      ...Object.keys(D365FO_FILE_OP_SPECS),
      ...Object.keys(D365FO_FILE_CREATE_PROPERTY_SPECS),
      ...Object.keys(GENERATE_OBJECT_MODE_SPECS),
      // Every objectType answers an op-spec lookup, whether or not it carries a
      // `properties` contract (`renderCreatePropertySpec` falls back).
      ...objectTypes,
      'labels', 'delete', 'sdlc-overrides', 'naming', 'prefix',
    ].map(k => k.toLowerCase())),
    patterns: new Set(CODE_GEN_PATTERNS.map(p => String(p).toLowerCase())),
  };
}

type Counter = Map<string, number>;
const bump = (c: Counter, k: string) => c.set(k, (c.get(k) ?? 0) + 1);

interface Digest {
  minedAt: string;
  logs: number;
  mcpCalls: number;
  tools: Record<string, number>;
  prepareModes: Record<string, number>;
  knowledgeKinds: Record<string, number>;
  knowledgeTopics: Record<string, number>;
  opSpecTopics: Record<string, number>;
  generateModes: Record<string, number>;
  writeShapes: Record<string, number>;
  operations: Record<string, number>;
  objectTypes: Record<string, number>;
}

/** Default search root: where VS Code keeps Copilot Chat's debug logs on Windows. */
function defaultLogRoots(): string[] {
  const appData = process.env.APPDATA;
  return appData ? [path.join(appData, 'Code', 'User', 'workspaceStorage')] : [];
}

function findLogs(roots: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'main.jsonl') out.push(p);
      else if (e.isDirectory()) visit(p, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  return out;
}

export function mine(logFiles: string[]): Digest {
  const vocab = vocabularies();
  const tools: Counter = new Map();
  const prepareModes: Counter = new Map();
  const knowledgeKinds: Counter = new Map();
  const knowledgeTopics: Counter = new Map();
  const opSpecTopics: Counter = new Map();
  const generateModes: Counter = new Map();
  const writeShapes: Counter = new Map();
  const operations: Counter = new Map();
  const objectTypes: Counter = new Map();
  let mcpCalls = 0;

  /** Resolve against a vocabulary or redact. The raw value never escapes this function. */
  const resolve = (raw: unknown, vocabulary: Set<string>): string => {
    if (typeof raw !== 'string') return UNRESOLVED;
    return vocabulary.has(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : UNRESOLVED;
  };

  for (const file of logFiles) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('"tool_call"')) continue;
      let span: { type?: string; name?: string; attrs?: { args?: string } };
      try {
        span = JSON.parse(line);
      } catch {
        continue;
      }
      if (span.type !== 'tool_call' || typeof span.name !== 'string') continue;
      if (!span.name.startsWith('mcp_')) continue;

      // `mcp_<server>_<tool>` — the server segment is the user's own MCP config
      // name, so only the tool half is kept.
      const tool = span.name.replace(/^mcp_[^_]+_/, '');
      mcpCalls++;
      bump(tools, tool);

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(span.attrs?.args ?? '{}');
      } catch {
        // A malformed args blob is a host artefact, not a signal.
      }

      switch (tool) {
        case 'prepare':
          bump(prepareModes, resolve(args.mode, new Set(['change', 'create', 'test'])));
          break;
        case 'get_knowledge': {
          const kind = resolve(args.kind, new Set(['knowledge', 'error', 'op-spec', 'bp-moniker']));
          // `kind` is optional and inferred by the tool; mirror that inference so
          // the counts match what the handler did.
          const effective = kind === UNRESOLVED ? (args.errorText || args.errorCode ? 'error' : 'knowledge') : kind;
          bump(knowledgeKinds, effective);
          const topics = Array.isArray(args.topics) ? args.topics : [args.topic];
          for (const raw of topics) {
            if (effective === 'op-spec') bump(opSpecTopics, resolve(raw, vocab.opSpecTopics));
            else if (effective === 'knowledge') bump(knowledgeTopics, resolve(raw, vocab.knowledgeTopics));
          }
          break;
        }
        case 'generate_object': {
          const mode = resolve(args.mode, new Set(Object.keys(GENERATE_OBJECT_MODE_SPECS).concat('pattern', 'scaffold')));
          const detail = args.pattern
            ? resolve(args.pattern, vocab.patterns)
            : resolve(args.objectType, new Set(['table', 'form', 'report']));
          bump(generateModes, `${mode}:${detail}`);
          break;
        }
        case 'd365fo_file': {
          const action = resolve(args.action, new Set(['create', 'modify', 'delete', 'undo', 'generate']));
          const objectType = resolve(args.objectType, vocab.objectTypes);
          bump(objectTypes, `${action}:${objectType}`);
          const ops: unknown[] = Array.isArray(args.operations)
            ? args.operations.map(o => (o as { operation?: unknown })?.operation)
            : [args.operation];
          const named = ops
            .map(o => resolve(o, new Set(Object.keys(D365FO_FILE_OP_SPECS))))
            .filter(o => o !== UNRESOLVED);
          for (const op of named) bump(operations, op);
          if (action === 'modify' && named.length) {
            bump(writeShapes, `modify:${objectType}:${[...named].sort().join('+')}`);
          } else if (action !== UNRESOLVED) {
            bump(writeShapes, `${action}:${objectType}`);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const sorted = (c: Counter): Record<string, number> =>
    Object.fromEntries([...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

  return {
    minedAt: new Date().toISOString(),
    logs: logFiles.length,
    mcpCalls,
    tools: sorted(tools),
    prepareModes: sorted(prepareModes),
    knowledgeKinds: sorted(knowledgeKinds),
    knowledgeTopics: sorted(knowledgeTopics),
    opSpecTopics: sorted(opSpecTopics),
    generateModes: sorted(generateModes),
    writeShapes: sorted(writeShapes),
    operations: sorted(operations),
    objectTypes: sorted(objectTypes),
  };
}

function table(title: string, counts: Record<string, number>, top: number): void {
  const rows = Object.entries(counts).slice(0, top);
  if (!rows.length) return;
  console.log(`\n## ${title}`);
  for (const [k, v] of rows) console.log(`  ${String(v).padStart(5)}  ${k}`);
  const rest = Object.keys(counts).length - rows.length;
  if (rest > 0) console.log(`        …${rest} more`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const roots = typeof args.logs === 'string' ? [args.logs] : defaultLogRoots();
  if (!roots.length) {
    console.error('No log root. Set APPDATA, or pass --logs <dir>.');
    process.exit(2);
  }
  const logFiles = findLogs(roots);
  if (!logFiles.length) {
    console.error(
      `No main.jsonl under ${roots.join(', ')}.\n` +
      'Copilot Chat writes it only while chat debug logging is on.',
    );
    process.exit(2);
  }

  const digest = mine(logFiles);
  const top = typeof args.top === 'string' ? Number(args.top) : 30;
  console.log(`mined ${digest.mcpCalls} MCP calls from ${digest.logs} session log(s)`);
  console.log(`values outside the server's own vocabularies are redacted to ${UNRESOLVED}`);
  table('tools', digest.tools, top);
  table('prepare modes', digest.prepareModes, top);
  table('get_knowledge kinds', digest.knowledgeKinds, top);
  table('knowledge topics', digest.knowledgeTopics, top);
  table('op-spec topics', digest.opSpecTopics, top);
  table('generate_object', digest.generateModes, top);
  table('write shapes', digest.writeShapes, top);
  table('modify operations', digest.operations, top);

  if (typeof args.json === 'string') {
    fs.writeFileSync(args.json, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');
    console.log(`\n→ ${args.json}`);
  }
}

if (process.argv[1] && /mine-copilot-demand\.ts$/.test(process.argv[1])) main();
