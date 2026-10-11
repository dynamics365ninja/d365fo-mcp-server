#!/usr/bin/env node
/**
 * The build command a benchmark cell is given, with or without MCP:
 *
 *   node <repo>/scripts/benchmarkSandboxBuild.mjs <sandbox package folder>
 *
 * Compiles the model's labels, then runs the same full xppc build the runner
 * scores with, and prints every error line. Both variants get it so that the
 * only difference between them is the MCP server — a plain agent that cannot
 * build finishes fast with output it never checked.
 *
 * Runs from dist/ (npm run build first; `benchmark run` warns when dist is stale).
 * Exit code 1 on a failed build, so the host marks the call as an error.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: node scripts/benchmarkSandboxBuild.mjs <sandbox package folder>');
  process.exit(2);
}

const sandbox = await import(new URL('file:///' + path.join(repo, 'dist', 'benchmark', 'sandbox.js').replace(/\\/g, '/')).href);
const info = sandbox.describeSandbox(pkg);
const workDir = path.join(repo, 'eval', 'benchmark', '.work');
fs.mkdirSync(workDir, { recursive: true });
const logFile = path.join(workDir, `agent-build-${info.packageName}.log`);

const labelError = await sandbox.compileSandboxLabels(info);
if (labelError) console.log(`Label compile: ${labelError}`);

console.log(`Building ${info.packageName} (labels + xppc full build)…`);
const result = await sandbox.buildSandbox(info, logFile, 15 * 60 * 1000);
let lines = result.errors;
try { lines = sandbox.xppcErrorLines(fs.readFileSync(logFile, 'utf8')); } catch { /* the result's own lines */ }
if (result.ok) {
  console.log(`Build succeeded in ${Math.round(result.durationMs / 1000)} s — 0 errors.`);
  process.exit(0);
}
console.log(`Build FAILED — ${lines.length} error(s) in ${Math.round(result.durationMs / 1000)} s:`);
for (const l of lines.slice(0, 60)) console.log(`  ${l}`);
if (lines.length > 60) console.log(`  … ${lines.length - 60} more`);
process.exit(1);
