/**
 * Session-scoped ledger of files that d365fo_file(action="create") wrote to disk
 * for the FIRST time in this MCP server process.
 *
 * Why this exists: undo_last_modification is git-based. It reverts tracked files
 * with `git checkout` and deletes git-untracked files after proving they are
 * untracked. But the D365FO sandbox (K:\AosService\PackagesLocalDirectory) is NOT
 * a git repository, so `git rev-parse --show-toplevel` fails and undo cannot roll
 * back anything there — the exact per-run rollback the eval loop mandates.
 *
 * This ledger is undo's authoritative, safe answer for the non-git case: undo may
 * delete a file ONLY when the create tool recorded creating it here this session.
 * It is deliberately in-memory (a module singleton shared by every tool in the
 * process) and records ONLY genuinely-new files (the create path gates recording
 * on "the file did not already exist on disk"), so undo can never delete a file
 * the tool merely overwrote or a pre-existing/unrelated file.
 *
 * Corpus evidence: eval/corpus/runs/2026-07-21T__L3-custom-service-basic__a2a4131.json
 * (finding A — undo returns "File is not inside a git repository" for every sandbox
 * write).
 */

export interface CreatedArtifact {
  /** Absolute path of the created XML file, as written to disk. */
  filePath: string;
  /** AOT object type (e.g. "class", "service") — used to clean the .rnrproj. */
  objectType?: string;
  /** Resolved AOT object name — used to locate the .rnrproj <Content Include>. */
  objectName?: string;
  /** Absolute path of the .rnrproj the file was added to, when known. */
  projectPath?: string;
}

/**
 * Normalize a path to a case-insensitive, separator-agnostic key.
 *
 * We deliberately do NOT use path.resolve(): the created paths are already
 * absolute Windows paths, and resolve() would prepend a drive letter to
 * POSIX-style inputs when the server runs off-Windows (same reasoning as
 * undoLastModification's own path handling).
 */
export function ledgerKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const ledger = new Map<string, CreatedArtifact>();

/** Record a genuinely-new file the create tool just wrote. */
export function recordCreatedArtifact(entry: CreatedArtifact): void {
  if (!entry.filePath) return;
  ledger.set(ledgerKey(entry.filePath), { ...entry });
}

/** Look up whether THIS session created `filePath`; undefined if not recorded. */
export function lookupCreatedArtifact(filePath: string): CreatedArtifact | undefined {
  if (!filePath) return undefined;
  return ledger.get(ledgerKey(filePath));
}

/**
 * Did THIS session create an object of this name?
 *
 * A second consumer beyond undo, and a different question: undo asks about a
 * FILE it is about to delete, `run_systest_class` asks about a CLASS it is about
 * to report on. The distinction matters for the red-first loop — "every method
 * passed" is ordinary news for a test that has existed for weeks and a red flag
 * for one written minutes ago, because a test that passes the first time it runs
 * has proven nothing about its assertion.
 *
 * Deliberately a session-scoped heuristic and nothing more. It cannot see a test
 * created before the server started, so it under-reports rather than over-reports
 * — the safe direction for a warning.
 */
export function wasCreatedThisSession(objectName: string): boolean {
  if (!objectName) return false;
  const wanted = objectName.trim().toLowerCase();
  if (!wanted) return false;
  for (const entry of ledger.values()) {
    if (entry.objectName?.toLowerCase() === wanted) return true;
  }
  return false;
}

/** Drop a ledger entry once it has been undone (or is no longer relevant). */
export function forgetCreatedArtifact(filePath: string): void {
  if (!filePath) return;
  ledger.delete(ledgerKey(filePath));
}

/**
 * Companion ledger for the `<Folder Include="Tables\"/>` entries addToProject adds.
 *
 * removeFromProject used to prune a folder entry whenever no Content of that AOT
 * type remained — a test that cannot tell a folder THIS session added from one that
 * was already in the .rnrproj. A project carrying orphan folder entries (no Content
 * of that type) therefore lost them on every undo, so a run that should have been
 * byte-neutral silently shrank the file. Measured on
 * eval/corpus/runs/2026-07-30T11__L3-dualwrite-entity-mapping__174ac13.json: three
 * pre-existing orphans (Tables\, Data Entities\, Security Privileges\) were dropped,
 * 3384 B → 3268 B.
 *
 * Same lifetime and rationale as the file ledger above: undo may only reverse what
 * this process is recorded as having done.
 */
const createdFolderEntries = new Set<string>();

function folderKey(projectPath: string, displayFolderName: string): string {
  return `${ledgerKey(projectPath)}\0${displayFolderName.toLowerCase()}`;
}

/** addToProject added the `<Folder Include>` entry itself (it was absent). */
export function recordCreatedProjectFolder(projectPath: string, displayFolderName: string): void {
  if (!projectPath || !displayFolderName) return;
  createdFolderEntries.add(folderKey(projectPath, displayFolderName));
}

/** True only when this session added that folder entry; consumes the record. */
export function takeCreatedProjectFolder(projectPath: string, displayFolderName: string): boolean {
  if (!projectPath || !displayFolderName) return false;
  return createdFolderEntries.delete(folderKey(projectPath, displayFolderName));
}

/** Test-only: reset the module singletons between cases. */
export function _clearCreatedArtifactLedger(): void {
  ledger.clear();
  createdFolderEntries.clear();
}
