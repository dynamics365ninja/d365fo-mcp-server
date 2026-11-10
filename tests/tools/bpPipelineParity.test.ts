/**
 * Pipeline parity for run_bp_check (src/tools/sdlc/bpPipelineParity.ts).
 *
 * The expected monikers and messages are the Azure DevOps build's own, taken from
 * its xppbp logs: a local reproduction of these rules matched them 646 of 646 on a
 * nightly build and 820 of 820 on a pull request. A test that changes one of these
 * strings breaks that match.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import {
  checkPipelinePropertyRules,
  findLabelArtifacts,
  formatReproducedFindings,
  pipelineParitySections,
  propertyRuleFolderFor,
  readModelLabelIndex,
  renderLabelArtifacts,
  resetPropertyRuleCache,
  xppbpShipsPropertyRules,
  REPRODUCED_HEADER,
} from '../../src/tools/sdlc/bpPipelineParity.js';
import { parseBpFindings } from '../../src/tools/sdlc/runBpCheck.js';
import { summarizeBpOutput } from '../../src/tools/sdlc/buildProject.js';

const table = (name: string, props: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n\t<Name>${name}</Name>\n${props}\n\t<DeleteActions />\n\t<FieldGroups />\n\t<Fields>\n\t\t<AxTableField>\n\t\t\t<Name>Id</Name>\n\t\t</AxTableField>\n\t</Fields>\n</AxTable>\n`;
const menuItem = (root: 'AxMenuItemAction' | 'AxMenuItemDisplay', name: string, props: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<${root} xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n\t<Name>${name}</Name>\n${props}\n</${root}>\n`;
const sal = (rights: Record<string, string>) =>
  `\t<SubscriberAccessLevel>\n${Object.entries(rights).map(([k, v]) => `\t\t<${k}>${v}</${k}>`).join('\n')}\n\t</SubscriberAccessLevel>`;
const NO_ACCESS = { Correct: 'Deny', Create: 'Deny', Delete: 'Deny', Invoke: 'Deny', Read: 'Deny', Update: 'Deny' };

const keys = (fs: Array<{ moniker: string; message: string }>) => fs.map(f => `${f.moniker}: ${f.message}`);

describe('checkPipelinePropertyRules — tables', () => {
  it('a per-company table with neither property gets the four pipeline warnings', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'ConTicket', xml: table('ConTicket', '') }]);
    expect(keys(out)).toEqual([
      'BPCheckTableOperationalDomainPropertyNotSpecified: The OperationalDomain property is not set.',
      'BPCheckTableOperationalDomainPropertyUnexpected: The Expected value for OperationalDomain property is Company, because the value for property SaveDataPerCompany is Yes.',
      'BPCheckTableSubscriberAccessLevelPropertyNotSpecified: The SubscriberAccessLevel property is not set.',
      'BPCheckTableSubscriberAccessLevelPropertyUnexpected: The Expected value for SubscriberAccessLevel property is Read, because the value for property SubscriberAccessLevel is Unset.',
    ]);
    expect(out.every(f => f.path === 'dynamics://Table/ConTicket' && f.elementType === 'AxTable' && f.severity === 'Warning')).toBe(true);
  });

  it('a shared table set to Company is told Shared', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'ConShared', xml: table('ConShared',
      `\t<OperationalDomain>Company</OperationalDomain>\n\t<SaveDataPerCompany>No</SaveDataPerCompany>\n${sal({ Read: 'Allow' })}`) }]);
    expect(keys(out)).toEqual([
      'BPCheckTableOperationalDomainPropertyUnexpected: The Expected value for OperationalDomain property is Shared, because the value for property SaveDataPerCompany is No.',
    ]);
  });

  it('a TempDB table must be Local with No Access', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'ConTmp', xml: table('ConTmp',
      `\t<OperationalDomain>Local</OperationalDomain>\n${sal({ Read: 'Allow' })}\n\t<TableType>TempDB</TableType>`) }]);
    expect(keys(out)).toEqual([
      'BPCheckTableSubscriberAccessLevelPropertyUnexpected: The Expected value for SubscriberAccessLevel property is No Access, because the value for property TableType is TempDB.',
    ]);
  });

  it('a staging table is Local even when SaveDataPerCompany is No', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'ConStaging', xml: table('ConStaging',
      `\t<OperationalDomain>Shared</OperationalDomain>\n\t<SaveDataPerCompany>No</SaveDataPerCompany>\n${sal(NO_ACCESS)}\n\t<TableGroup>Staging</TableGroup>`) }]);
    expect(keys(out)).toEqual([
      'BPCheckTableOperationalDomainPropertyUnexpected: The Expected value for OperationalDomain property is Local, because the value for property TableGroup is Staging.',
    ]);
  });

  it('a correct table and a derived table get nothing', async () => {
    const out = await checkPipelinePropertyRules([
      { fileName: 'ConOk', xml: table('ConOk', `\t<OperationalDomain>Company</OperationalDomain>\n${sal({ Read: 'Allow' })}`) },
      { fileName: 'ConDerived', xml: table('ConDerived', '\t<Extends>ConOk</Extends>') },
    ]);
    expect(out).toEqual([]);
  });

  it('reads the table Name, not a field Name further down', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'file', xml: table('ConNamed', '') }]);
    expect(out[0].path).toBe('dynamics://Table/ConNamed');
  });
});

describe('checkPipelinePropertyRules — menu items', () => {
  it('a bare action menu item on a class gets NotSpecified twice and No Access', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'ConRun', xml: menuItem('AxMenuItemAction', 'ConRun',
      '\t<Object>ConRunner</Object>\n\t<ObjectType>Class</ObjectType>') }]);
    expect(keys(out)).toEqual([
      'BPCheckMenuItemOperationalDomainPropertyNotSpecified: The OperationalDomain property is not set.',
      'BPCheckMenuItemSubscriberAccessLevelPropertyNotSpecified: The SubscriberAccessLevel property is not set.',
      'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected: The Expected value for SubscriberAccessLevel property is No Access, because the menu item type is Action and ObjectType is Class.',
    ]);
    expect(out[0].path).toBe('dynamics://MenuItemAction/ConRun');
  });

  it('a display menu item on a class passes with any right, and is told all six when unset', async () => {
    const withRight = await checkPipelinePropertyRules([{ fileName: 'A', xml: menuItem('AxMenuItemDisplay', 'A',
      `\t<Object>ConDialog</Object>\n\t<ObjectType>Class</ObjectType>\n\t<OperationalDomain>Shared</OperationalDomain>\n${sal({ Read: 'Allow' })}`) }]);
    expect(withRight).toEqual([]);
    const unset = await checkPipelinePropertyRules([{ fileName: 'B', xml: menuItem('AxMenuItemDisplay', 'B',
      '\t<Object>ConDialog</Object>\n\t<ObjectType>Class</ObjectType>\n\t<OperationalDomain>Shared</OperationalDomain>\n\t<SubscriberAccessLevel />') }]);
    expect(keys(unset)).toEqual([
      'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected: The Expected value for SubscriberAccessLevel property is Read/Update/Create/Correct/Delete/Invoke, because the menu item type is Display and ObjectType is Class.',
    ]);
  });

  it('reads rights written with an empty namespace, as Visual Studio saves them', async () => {
    const vs = (root: 'AxMenuItemAction' | 'AxMenuItemDisplay', right: string) => menuItem(root, 'X',
      `\t<Object>ConRunner</Object>\n\t<ObjectType>Class</ObjectType>\n\t<OperationalDomain>Local</OperationalDomain>\n` +
      `\t<SubscriberAccessLevel>\n${['Correct', 'Create', 'Delete', 'Invoke', 'Read', 'Update'].map(p => `\t\t<${p} xmlns="">${right}</${p}>`).join('\n')}\n\t</SubscriberAccessLevel>`);
    expect(await checkPipelinePropertyRules([{ fileName: 'X', xml: vs('AxMenuItemDisplay', 'Allow') }])).toEqual([]);
    expect(await checkPipelinePropertyRules([{ fileName: 'X', xml: vs('AxMenuItemAction', 'Deny') }])).toEqual([]);
  });

  it('a display menu item on a form over Local tables must be Local with No Access', async () => {
    const xml = menuItem('AxMenuItemDisplay', 'ConTmpView',
      `\t<Object>ConTmpForm</Object>\n\t<OperationalDomain>Shared</OperationalDomain>\n${sal({ Read: 'Allow' })}`);
    const out = await checkPipelinePropertyRules([{ fileName: 'ConTmpView', xml }], async f => f === 'ConTmpForm');
    expect(out.map(f => f.moniker)).toEqual([
      'BPCheckMenuItemOperationalDomainPropertyUnexpected',
      'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected',
    ]);
    expect(out[0].message).toBe('The Expected value for OperationalDomain property is Local, because the OperationalDomain property on all data sources is Local.');
    // Unknown or not all Local: the usual rules only, which this item passes.
    expect(await checkPipelinePropertyRules([{ fileName: 'x', xml }], async () => undefined)).toEqual([]);
    expect(await checkPipelinePropertyRules([{ fileName: 'x', xml }], async () => false)).toEqual([]);
  });

  it('ignores other documents', async () => {
    expect(await checkPipelinePropertyRules([{ fileName: 'C', xml: '<AxClass><Name>C</Name></AxClass>' }])).toEqual([]);
  });
});

describe('formatReproducedFindings', () => {
  it('writes xppbp detail lines that parseBpFindings reads back with path and message', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'ConTicket', xml: table('ConTicket', '') }]);
    const parsed = parseBpFindings(formatReproducedFindings(out));
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({
      moniker: 'BPCheckTableOperationalDomainPropertyNotSpecified',
      severity: 'Warning', elementType: 'AxTable', path: 'dynamics://Table/ConTicket',
      message: 'The OperationalDomain property is not set.',
    });
  });

  it('maps element types to folders', () => {
    expect(propertyRuleFolderFor('table')).toBe('AxTable');
    expect(propertyRuleFolderFor('menu-item-action')).toBe('AxMenuItemAction');
    expect(propertyRuleFolderFor('MenuItemDisplay')).toBe('AxMenuItemDisplay');
    expect(propertyRuleFolderFor('class')).toBeUndefined();
  });
});

describe('labels', () => {
  const labels = new Map([['@con:greeting', 'Hello %1'], ['@con:title', 'Title']]);
  const findings = [
    { moniker: 'BPErrorUnknownLabel', path: 'dynamics://Class/ConA/Method/run', message: "The label '@Con:Greeting' is unknown." },
    { moniker: 'BPErrorUnknownLabel', path: 'dynamics://Class/ConA/Method/run', message: "The label '@Con:Missing' is unknown." },
    { moniker: 'BPUnusedStrFmtArgument', path: 'dynamics://Class/ConA/Method/run', message: "The placeholder '%1' to strFmt is not used in the format string." },
    { moniker: 'BPUnusedStrFmtArgument', path: 'dynamics://Class/ConA/Method/run', message: "The placeholder '%2' to strFmt is not used in the format string." },
    { moniker: 'BPUnusedStrFmtArgument', path: 'dynamics://Class/ConB/Method/run', message: "The placeholder '%1' to strFmt is not used in the format string." },
  ];

  it('marks only labels that exist, and strFmt warnings whose placeholder such a label has', () => {
    const a = findLabelArtifacts(findings, labels);
    expect(a).toEqual([
      { moniker: 'BPErrorUnknownLabel', path: 'dynamics://Class/ConA/Method/run', label: '@Con:Greeting' },
      { moniker: 'BPUnusedStrFmtArgument', path: 'dynamics://Class/ConA/Method/run', label: '@Con:Greeting' },
    ]);
    const note = renderLabelArtifacts(a, true);
    expect(note).toContain('Likely label false positives: 1 BPErrorUnknownLabel and 1 BPUnusedStrFmtArgument');
    expect(note).toContain('Do not create these labels again');
    expect(renderLabelArtifacts([], true)).toBe('');
  });

  describe('readModelLabelIndex', () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'bpparity-labels-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('reads every label file of the package, en-US first', async () => {
      const dir = path.join(root, 'Con', 'Con', 'AxLabelFile', 'LabelResources');
      mkdirSync(path.join(dir, 'en-US'), { recursive: true });
      mkdirSync(path.join(dir, 'de'), { recursive: true });
      writeFileSync(path.join(dir, 'de', 'Con.de.label.txt'), 'Greeting=Hallo %1\nOnlyDe=Nur\n');
      writeFileSync(path.join(dir, 'en-US', 'Con.en-US.label.txt'), '﻿Greeting=Hello %1\n ;comment\nTitle=Title\n');
      const index = await readModelLabelIndex(path.join(root, 'Con'));
      expect(index.get('@con:greeting')).toBe('Hello %1');
      expect(index.get('@con:title')).toBe('Title');
      expect(index.get('@con:onlyde')).toBe('Nur');
    });
  });
});

describe('pipelineParitySections', () => {
  let store: string;
  let framework: string;
  const model = 'Con';
  beforeEach(() => {
    resetPropertyRuleCache();
    store = mkdtempSync(path.join(os.tmpdir(), 'bpparity-store-'));
    framework = mkdtempSync(path.join(os.tmpdir(), 'bpparity-fw-'));
    const m = path.join(store, model, model);
    mkdirSync(path.join(m, 'AxTable'), { recursive: true });
    mkdirSync(path.join(m, 'AxMenuItemDisplay'), { recursive: true });
    mkdirSync(path.join(m, 'AxForm'), { recursive: true });
    writeFileSync(path.join(m, 'AxTable', 'ConTicket.xml'), table('ConTicket', ''));
    writeFileSync(path.join(m, 'AxTable', 'ConTmp.xml'), table('ConTmp',
      `\t<OperationalDomain>Local</OperationalDomain>\n${sal(NO_ACCESS)}\n\t<TableType>TempDB</TableType>`));
    writeFileSync(path.join(m, 'AxForm', 'ConTmpForm.xml'),
      '<AxForm>\n\t<Name>ConTmpForm</Name>\n\t<DataSources>\n\t\t<AxFormDataSource xmlns="">\n\t\t\t<Name>ConTmp</Name>\n\t\t\t<Table>ConTmp</Table>\n\t\t\t<Fields />\n\t\t</AxFormDataSource>\n\t</DataSources>\n</AxForm>\n');
    writeFileSync(path.join(m, 'AxMenuItemDisplay', 'ConTmpView.xml'), menuItem('AxMenuItemDisplay', 'ConTmpView',
      `\t<Object>ConTmpForm</Object>\n\t<OperationalDomain>Shared</OperationalDomain>\n${sal({ Read: 'Allow' })}`));
    mkdirSync(path.join(framework, 'bin', 'BPExtensions'), { recursive: true });
    writeFileSync(path.join(framework, 'bin', 'BPExtensions', 'Rules.dll'), Buffer.from('MZ some other rules'));
  });
  afterEach(() => {
    rmSync(store, { recursive: true, force: true });
    rmSync(framework, { recursive: true, force: true });
  });

  const run = (outputs: string[], targets: Array<{ name: string; elementType: string } | null> = [null]) =>
    pipelineParitySections({
      frameworkPath: framework, metadataPath: store, modelName: model, targets, outputs,
      skip: outputs.map(() => false), labelsCompiled: true, parse: parseBpFindings,
    });

  it('adds the reproduced rules to a whole-model run, reading forms from disk', async () => {
    const { appended } = await run(['Warnings: 0']);
    expect(appended[0]).toContain(REPRODUCED_HEADER);
    const parsed = parseBpFindings(appended[0]);
    expect(parsed.filter(f => f.path === 'dynamics://Table/ConTicket')).toHaveLength(4);
    expect(parsed.filter(f => f.path === 'dynamics://MenuItemDisplay/ConTmpView').map(f => f.moniker)).toEqual([
      'BPCheckMenuItemOperationalDomainPropertyUnexpected',
      'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected',
    ]);
  });

  it('checks only the requested table, and nothing for a class', async () => {
    const { appended } = await run(['', ''], [{ name: 'contmp', elementType: 'table' }, { name: 'ConA', elementType: 'class' }]);
    expect(appended).toEqual(['', '']);
    const ticket = await run([''], [{ name: 'ConTicket', elementType: 'table' }]);
    expect(parseBpFindings(ticket.appended[0])).toHaveLength(4);
  });

  it('adds nothing when xppbp reported one of the rules itself', async () => {
    const { appended } = await run(['BestPractices Warning: AxTable dynamics://Table/X: BPCheckTableOperationalDomainPropertyNotSpecified: The OperationalDomain property is not set.']);
    expect(appended[0]).toBe('');
  });

  it('adds nothing when the installed rule assemblies contain the rules', async () => {
    writeFileSync(path.join(framework, 'bin', 'BPExtensions', 'Newer.dll'), Buffer.from('BPCheckTableOperationalDomainPropertyNotSpecified', 'utf16le'));
    expect(await xppbpShipsPropertyRules(framework)).toBe(true);
    const { appended } = await run(['Warnings: 0']);
    expect(appended[0]).toBe('');
  });

  it('adds nothing to a run that did not execute', async () => {
    const r = await pipelineParitySections({
      frameworkPath: framework, metadataPath: store, modelName: model, targets: [null], outputs: [''],
      skip: [true], labelsCompiled: true, parse: parseBpFindings,
    });
    expect(r.appended[0]).toBe('');
  });

  it('notes label false positives from the model label files', async () => {
    const dir = path.join(store, model, model, 'AxLabelFile', 'LabelResources', 'en-US');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Con.en-US.label.txt'), 'Greeting=Hello %1\n');
    const out = "BestPractices Warning: AxClass dynamics://Class/ConA/Method/run: [(3,1),(3,9)]: BPErrorUnknownLabel: The label '@Con:Greeting' is unknown.";
    const { notes } = await run([out]);
    expect(notes[0]).toContain('Likely label false positives: 1 BPErrorUnknownLabel and 0 BPUnusedStrFmtArgument');
  });
});

describe('summarizeBpOutput keeps the parity notes', () => {
  it('counts reproduced findings and label artefacts', async () => {
    const out = await checkPipelinePropertyRules([{ fileName: 'ConTicket', xml: table('ConTicket', '') }]);
    const text = `⚠️ BP Check completed with issues\n\nModel: Con\n\n${REPRODUCED_HEADER}\n${formatReproducedFindings(out)}` +
      '\n\nLikely label false positives: 3 BPErrorUnknownLabel and 2 BPUnusedStrFmtArgument finding(s) name labels…';
    const summary = summarizeBpOutput(text, parseBpFindings(text));
    expect(summary).toContain('4 finding(s) are reproduced pipeline rules');
    expect(summary).toContain('5 BPErrorUnknownLabel/BPUnusedStrFmtArgument finding(s) name labels that exist');
  });
});
