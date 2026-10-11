/**
 * The sandbox reset: what a cell wrote is found, scored by path, and taken out
 * again byte for byte — or the run stops. Plain temp folders stand in for a
 * package; nothing here needs a D365FO VM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_SANDBOX_FILES,
  authoredChanges,
  describeSandbox,
  diffSandbox,
  isBuildOutput,
  isEmptyDiff,
  restoreSandbox,
  snapshotDamage,
  snapshotSandbox,
  xppcErrorLines,
} from '../../src/benchmark/sandbox.js';

let root: string;
let pkg: string;

function put(rel: string, text: string): void {
  const file = path.join(pkg, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-sandbox-'));
  pkg = path.join(root, 'PackagesLocalDirectory', 'fm-mcp');
  put('Descriptor/fm-mcp.xml', '<AxModelInfo/>');
  put('fm-mcp/AxTable/ConDemoNoteHeader.xml', '<AxTable><Name>ConDemoNoteHeader</Name></AxTable>');
  put('fm-mcp/AxLabelFile/LabelResources/en-US/fm-mcp.en-US.label.txt', 'Hello=Hello\n');
  put('bin/Dynamics.AX.fm-mcp.dll', 'v1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('describeSandbox', () => {
  it('derives the model folder and packages root from a package folder', () => {
    const info = describeSandbox(pkg);
    expect(info.packageName).toBe('fm-mcp');
    expect(info.model).toBe('fm-mcp');
    expect(info.modelDir).toBe(path.join(pkg, 'fm-mcp'));
    expect(info.packagesRoot).toBe(path.join(root, 'PackagesLocalDirectory'));
  });

  it('refuses a folder that is not a package, a missing model folder, and anything big', () => {
    expect(() => describeSandbox(path.join(root, 'PackagesLocalDirectory'))).toThrow(/not a D365FO package folder/);
    expect(() => describeSandbox(pkg, 'OtherModel')).toThrow(/OtherModel.*does not exist/);
    expect(() => describeSandbox(path.join(root, 'missing'))).toThrow(/does not exist/);
    for (let i = 0; i <= MAX_SANDBOX_FILES; i++) put(`fm-mcp/AxClass/C${i}.xml`, 'x');
    expect(() => describeSandbox(pkg)).toThrow(/not a sandbox model/);
  });
});

describe('snapshot → diff → restore', () => {
  it('finds what a cell added, changed and deleted, and lists only authored files as artifacts', () => {
    const snap = snapshotSandbox(pkg, path.join(root, 'snap'));
    expect(isEmptyDiff(diffSandbox(pkg, snap))).toBe(true);

    put('fm-mcp/AxTable/ConVendCertificate.xml', '<AxTable/>');
    put('fm-mcp/AxLabelFile/LabelResources/en-US/fm-mcp.en-US.label.txt', 'Hello=Hello\nConCert=Certificate\n');
    put('bin/Dynamics.AX.fm-mcp.dll', 'v2');
    put('BuildModelResult.log', 'built');
    fs.rmSync(path.join(pkg, 'fm-mcp', 'AxTable', 'ConDemoNoteHeader.xml'));

    const diff = diffSandbox(pkg, snap);
    expect(diff.added).toEqual(['BuildModelResult.log', 'fm-mcp/AxTable/ConVendCertificate.xml']);
    expect(diff.modified).toEqual(['bin/Dynamics.AX.fm-mcp.dll', 'fm-mcp/AxLabelFile/LabelResources/en-US/fm-mcp.en-US.label.txt']);
    expect(diff.deleted).toEqual(['fm-mcp/AxTable/ConDemoNoteHeader.xml']);
    expect(authoredChanges(diff)).toEqual([
      'fm-mcp/AxLabelFile/LabelResources/en-US/fm-mcp.en-US.label.txt',
      'fm-mcp/AxTable/ConVendCertificate.xml',
    ]);
  });

  it('restores every byte, removes added files and the folders they needed, and proves it', () => {
    const snap = snapshotSandbox(pkg, path.join(root, 'snap'));
    put('fm-mcp/AxReport/ConCustOverdueReport.xml', '<AxReport/>');
    put('fm-mcp/AxTable/ConDemoNoteHeader.xml', 'overwritten');
    put('Descriptor/fm-mcp.xml', '<AxModelInfo><ModuleReferences/></AxModelInfo>');
    put('bin/Dynamics.AX.fm-mcp.dll', 'v2');

    restoreSandbox(pkg, snap);

    expect(isEmptyDiff(diffSandbox(pkg, snap))).toBe(true);
    expect(fs.existsSync(path.join(pkg, 'fm-mcp', 'AxReport'))).toBe(false);
    expect(fs.readFileSync(path.join(pkg, 'fm-mcp', 'AxTable', 'ConDemoNoteHeader.xml'), 'utf8')).toContain('<Name>ConDemoNoteHeader</Name>');
    expect(fs.readFileSync(path.join(pkg, 'Descriptor', 'fm-mcp.xml'), 'utf8')).toBe('<AxModelInfo/>');
    expect(fs.readFileSync(path.join(pkg, 'bin', 'Dynamics.AX.fm-mcp.dll'), 'utf8')).toBe('v1');
  });

  it('keeps a folder the snapshot had even when the cell emptied it', () => {
    put('fm-mcp/AxEnum/.keep', '');
    const snap = snapshotSandbox(pkg, path.join(root, 'snap'));
    fs.rmSync(path.join(pkg, 'fm-mcp', 'AxEnum', '.keep'));
    put('fm-mcp/AxEnum/ConCreditHoldReason.xml', '<AxEnum/>');
    restoreSandbox(pkg, snap);
    expect(fs.existsSync(path.join(pkg, 'fm-mcp', 'AxEnum', '.keep'))).toBe(true);
    expect(isEmptyDiff(diffSandbox(pkg, snap))).toBe(true);
  });

  it('keeps an EMPTY folder the package already had (fm-mcp ships AxEnum/Delta empty)', () => {
    fs.mkdirSync(path.join(pkg, 'fm-mcp', 'AxForm'), { recursive: true });
    const snap = snapshotSandbox(pkg, path.join(root, 'snap'));
    put('fm-mcp/AxForm/ConVendCertificate.xml', '<AxForm/>');
    put('fm-mcp/AxMenuExtension/ProcurementAndSourcing.Con.xml', '<AxMenuExtension/>');
    restoreSandbox(pkg, snap);
    expect(fs.existsSync(path.join(pkg, 'fm-mcp', 'AxForm'))).toBe(true);
    expect(fs.readdirSync(path.join(pkg, 'fm-mcp', 'AxForm'))).toEqual([]);
    expect(fs.existsSync(path.join(pkg, 'fm-mcp', 'AxMenuExtension'))).toBe(false);
  });

  it('refuses to snapshot over an existing folder', () => {
    fs.mkdirSync(path.join(root, 'snap'));
    expect(() => snapshotSandbox(pkg, path.join(root, 'snap'))).toThrow(/already exists/);
  });

  it('refuses a damaged snapshot before touching the sandbox', () => {
    // Seen on the VM: the snapshot lost Descriptor/ and the model folder mid-run.
    const snap = snapshotSandbox(pkg, path.join(root, 'snap'));
    put('fm-mcp/AxClass/ConCellOutput.xml', '<AxClass/>');
    fs.rmSync(path.join(snap.dir, 'Descriptor'), { recursive: true, force: true });
    fs.rmSync(path.join(snap.dir, 'fm-mcp'), { recursive: true, force: true });
    expect(snapshotDamage(snap).sort()).toEqual([
      'missing Descriptor/fm-mcp.xml',
      'missing fm-mcp/AxLabelFile/LabelResources/en-US/fm-mcp.en-US.label.txt',
      'missing fm-mcp/AxTable/ConDemoNoteHeader.xml',
    ]);
    expect(() => restoreSandbox(pkg, snap)).toThrow(/no longer matches.*without touching the sandbox/s);
    // The sandbox still holds the cell's output and every original file.
    expect(fs.existsSync(path.join(pkg, 'fm-mcp', 'AxClass', 'ConCellOutput.xml'))).toBe(true);
    expect(fs.existsSync(path.join(pkg, 'Descriptor', 'fm-mcp.xml'))).toBe(true);
  });

  it('stops with the snapshot location when the restore cannot be proven', () => {
    const snap = snapshotSandbox(pkg, path.join(root, 'snap'));
    put('fm-mcp/AxClass/ConX.xml', 'x');
    // A snapshot whose copy lost a file cannot put it back.
    fs.rmSync(path.join(snap.dir, 'fm-mcp', 'AxTable', 'ConDemoNoteHeader.xml'));
    fs.rmSync(path.join(pkg, 'fm-mcp', 'AxTable', 'ConDemoNoteHeader.xml'));
    expect(() => restoreSandbox(pkg, snap)).toThrow(/no longer matches|could not be restored/);
  });
});

describe('build output and xppc log', () => {
  it('treats compiler output as build output, not as something the agent wrote', () => {
    for (const rel of ['bin/x.dll', 'XppMetadata/fm-mcp/AxClass/X.xml', 'Resources/en-US/fm-mcp.resources.dll', 'BuildModelResult.xml', 'BuildModelResult.log', 'xppc.log']) {
      expect(isBuildOutput(rel)).toBe(true);
    }
    for (const rel of ['Descriptor/fm-mcp.xml', 'fm-mcp/AxClass/X.xml', 'fm-mcp/AxLabelFile/LabelResources/en-US/fm-mcp.en-US.label.txt']) {
      expect(isBuildOutput(rel)).toBe(false);
    }
  });

  it('keeps only the lines that fail a build', () => {
    const log = [
      'Compiling module fm-mcp',
      'Compile Error: dynamics://Class/ConX/Method/run:(3,5): Variable foo is not declared.',
      'Warning: BPErrorLabelIsText',
      'Metadata Error: Table ConY has no primary index',
      'Table Validation Error: Field group Overview does not exist',
    ].join('\r\n');
    expect(xppcErrorLines(log)).toEqual([
      'Compile Error: dynamics://Class/ConX/Method/run:(3,5): Variable foo is not declared.',
      'Metadata Error: Table ConY has no primary index',
      'Table Validation Error: Field group Overview does not exist',
    ]);
  });
});
