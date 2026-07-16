/**
 * XppMetadataParser method-declaration extraction.
 *
 * Regression: the parser's own regex extractors stopped at the first ')' —
 * `\b<name>\s*\(([^)]*)\)` — so any declaration with a defaulted parameter
 * (`= classStr(FormletterService)`) was truncated mid-parameter and surfaced
 * as garbage through get_object_info's class rendering. `static` was likewise
 * matched anywhere in the method body. Both now go through the shared
 * declaration parser (src/metadata/xppDeclaration.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppMetadataParser } from '../../src/metadata/xmlParser';

let tmpDir: string;

const writeClass = async (name: string, methods: Array<{ name: string; source: string }>) => {
  const methodXml = methods
    .map(m => `      <Method>\n        <Name>${m.name}</Name>\n        <Source><![CDATA[${m.source}]]></Source>\n      </Method>`)
    .join('\n');
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Name>${name}</Name>`,
    '  <SourceCode>',
    '    <Methods>',
    methodXml,
    '    </Methods>',
    '  </SourceCode>',
    '</AxClass>',
  ].join('\n');
  const file = path.join(tmpDir, `${name}.xml`);
  await fs.writeFile(file, xml, 'utf-8');
  return file;
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmlparser-params-test-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('XppMetadataParser method declarations', () => {
  it('keeps every parameter of a multi-line declaration with intrinsic defaults', async () => {
    const source = [
      'public static PurchFormLetter_Invoice construct(',
      '    IdentifierName _className = classStr(FormletterService),',
      '    IdentifierName _methodName = methodStr(FormletterService, postPurchaseOrderInvoice),',
      '    SysOperationExecutionMode _executionMode = SysOperationExecutionMode::Synchronous)',
      '{',
      '    return new PurchFormLetter_Invoice(_className, _methodName, _executionMode);',
      '}',
    ].join('\n');
    const file = await writeClass('PurchFormLetter_Invoice', [{ name: 'construct', source }]);

    const result = await new XppMetadataParser().parseClassFile(file, 'TestModel');

    expect(result.success).toBe(true);
    const method = result.data!.methods.find(m => m.name === 'construct')!;
    expect(method.returnType).toBe('PurchFormLetter_Invoice');
    expect(method.isStatic).toBe(true);
    expect(method.parameters).toEqual([
      { type: 'IdentifierName', name: '_className' },
      { type: 'IdentifierName', name: '_methodName' },
      { type: 'SysOperationExecutionMode', name: '_executionMode' },
    ]);
  });

  it('does not report a method as static because its body mentions static', async () => {
    const source = [
      'public void run()',
      '{',
      '    // the static factory is preferred here',
      '    info("static");',
      '}',
    ].join('\n');
    const file = await writeClass('RunnerClass', [{ name: 'run', source }]);

    const result = await new XppMetadataParser().parseClassFile(file, 'TestModel');

    expect(result.success).toBe(true);
    const method = result.data!.methods.find(m => m.name === 'run')!;
    expect(method.isStatic).toBe(false);
    expect(method.returnType).toBe('void');
    expect(method.parameters).toEqual([]);
  });
});
