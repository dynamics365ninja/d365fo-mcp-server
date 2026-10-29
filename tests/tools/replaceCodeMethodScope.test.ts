/**
 * Regression: replace-code ignored methodName before the bridge ran.
 *
 * The bridge (ReplaceInMethods) scopes by methodName, but the file-level
 * preflight and the direct-XML fallback counted oldCode over the whole file. An
 * oldCode that also occurred in another method was refused with "matches 2
 * times … or scope the call with methodName" although the caller had passed
 * methodName — advice that could not help. Seen on real classes where two
 * methods share a line such as `ttsbegin;` or `select firstonly … where …`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { preflightReplaceCode } from '../../src/tools/write/modifyD365File';
import { directXmlReplaceCode } from '../../src/tools/write/directXmlWriters';
import { methodSourceSpans } from '../../src/utils/methodSourceSpans';

const CLASS_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>ContosoPostingService</Name>
	<SourceCode>
		<Declaration><![CDATA[
public class ContosoPostingService
{
    boolean ret = true;
}
]]></Declaration>
		<Methods>
			<Method>
				<Name>post</Name>
				<Source><![CDATA[
    public void post()
    {
        ttsbegin;
        this.write();
        ttscommit;
    }

]]></Source>
			</Method>
			<Method>
				<Name>reverse</Name>
				<Source><![CDATA[
    public void reverse()
    {
        ttsbegin;
        this.undo();
        ttscommit;
    }

]]></Source>
			</Method>
		</Methods>
	</SourceCode>
</AxClass>
`;

const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
	<Name>ContosoForm</Name>
	<SourceCode>
		<DataControls xmlns="">
			<Control>
				<Name>PostButton</Name>
				<Type>Button</Type>
				<Methods>
					<Method>
						<Name>clicked</Name>
						<Source><![CDATA[
        public void clicked()
        {
            element.refresh();
            super();
        }

]]></Source>
					</Method>
				</Methods>
			</Control>
			<Control>
				<Name>ReverseButton</Name>
				<Type>Button</Type>
				<Methods>
					<Method>
						<Name>clicked</Name>
						<Source><![CDATA[
        public void clicked()
        {
            element.refresh();
            super();
        }

]]></Source>
					</Method>
				</Methods>
			</Control>
		</DataControls>
	</SourceCode>
</AxForm>
`;

describe('methodSourceSpans', () => {
  it('is undefined without methodName, so the whole file stays in scope', () => {
    expect(methodSourceSpans(CLASS_XML)).toBeUndefined();
    expect(methodSourceSpans(CLASS_XML, '  ')).toBeUndefined();
  });

  it('finds the named method body only, case-insensitively', () => {
    const spans = methodSourceSpans(CLASS_XML, 'Reverse')!;
    expect(spans).toHaveLength(1);
    const body = CLASS_XML.slice(spans[0].start, spans[0].end);
    expect(body).toContain('this.undo();');
    expect(body).not.toContain('this.write();');
  });

  it('maps classDeclaration to the declaration', () => {
    const [span] = methodSourceSpans(CLASS_XML, 'classDeclaration')!;
    expect(CLASS_XML.slice(span.start, span.end)).toContain('boolean ret = true;');
  });

  it('scopes Owner.method to that control', () => {
    const spans = methodSourceSpans(FORM_XML, 'ReverseButton.clicked')!;
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBeGreaterThan(FORM_XML.indexOf('<Name>ReverseButton</Name>'));
  });

  it('is empty when the method is not in the file', () => {
    expect(methodSourceSpans(CLASS_XML, 'validate')).toEqual([]);
  });
});

describe('replace-code preflight honours methodName', () => {
  it('lets through an oldCode that occurs once in the named method', () => {
    expect(preflightReplaceCode(CLASS_XML, 'ttsbegin;', 'ttsbegin;\n        this.lock();', 'reverse')).toBeNull();
  });

  it('still refuses without methodName, and still suggests it', () => {
    const verdict = preflightReplaceCode(CLASS_XML, 'ttsbegin;', 'ttsbegin;\n        this.lock();');
    expect(verdict?.kind).toBe('refuse');
    expect(verdict?.message).toContain('matches 2 times');
    expect(verdict?.message).toContain('methodName=');
  });

  it('refuses a repeat inside the named method without suggesting methodName again', () => {
    const verdict = preflightReplaceCode(FORM_XML, 'element.refresh();', 'element.reread();', 'clicked');
    expect(verdict?.kind).toBe('refuse');
    expect(verdict?.message).toContain('exactly one site inside clicked.');
    expect(verdict?.message).not.toContain('methodName=');
  });

  it('lets through a control override scoped by Owner.method', () => {
    expect(preflightReplaceCode(FORM_XML, 'element.refresh();', 'element.reread();', 'PostButton.clicked')).toBeNull();
  });
});

describe('directXmlReplaceCode honours methodName', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function fileWith(xml: string): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-scope-'));
    const file = path.join(dir, 'Object.xml');
    await fs.writeFile(file, xml.replace(/\n/g, '\r\n'), 'utf-8');
    return file;
  }

  const read = async (file: string) => (await fs.readFile(file, 'utf-8')).replace(/\r\n/g, '\n');

  it('edits only the named method', async () => {
    const file = await fileWith(CLASS_XML);
    const result = await directXmlReplaceCode(
      file,
      'ttscommit;',
      'ttscommit;\n        info("done");',
      'test',
      'reverse',
    );
    expect(result?.success).toBe(true);

    const after = await read(file);
    const reverse = after.slice(after.indexOf('<Name>reverse</Name>'));
    const post = after.slice(after.indexOf('<Name>post</Name>'), after.indexOf('<Name>reverse</Name>'));
    expect(reverse).toContain('info("done");');
    expect(post).not.toContain('info("done");');
  });

  it('edits only the named control override', async () => {
    const file = await fileWith(FORM_XML);
    const result = await directXmlReplaceCode(
      file,
      'element.refresh();',
      'element.reread();',
      'test',
      'ReverseButton.clicked',
    );
    expect(result?.success).toBe(true);

    const after = await read(file);
    expect(after.split('element.reread();')).toHaveLength(2);
    expect(after.indexOf('element.reread();')).toBeGreaterThan(after.indexOf('<Name>ReverseButton</Name>'));
  });

  it('does not fall back to another method when the named one lacks oldCode', async () => {
    const file = await fileWith(CLASS_XML);
    expect(await directXmlReplaceCode(file, 'this.write();', 'this.insert();', 'test', 'reverse')).toBeNull();
    expect(await read(file)).toContain('this.write();');
  });

  it('keeps the whole-file rule without methodName', async () => {
    const file = await fileWith(CLASS_XML);
    const result = await directXmlReplaceCode(file, 'ttsbegin;', 'ttsbegin; // x', 'test');
    expect(result?.success).toBe(false);
    expect(result?.message).toContain('appears 2 times');
  });
});
