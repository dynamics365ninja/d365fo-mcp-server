/**
 * Stable refusal codes: the helper that stamps one, the one that moves it to the
 * front of a wrapped message, the extractor, and the registry guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, globSync } from 'fs';
import {
  TOOL_ERROR_CODES, withToolErrorCode, hoistToolErrorCode, extractToolErrorCode,
  extractToolErrorCodes, bridgeRefusalCode, withBridgeRefusalCode, renderToolErrorCodeList, type ToolErrorCode,
} from '../../src/utils/toolError';

describe('withToolErrorCode', () => {
  it('puts the code after the emoji the message opens with', () => {
    expect(withToolErrorCode('E_AMBIGUOUS_OLDCODE', '❌ oldCode appears 2 times'))
      .toBe('❌ [E_AMBIGUOUS_OLDCODE] oldCode appears 2 times');
    expect(withToolErrorCode('E_MODEL_NOT_WRITABLE', '⛔ Refusing to modify "CustTable"'))
      .toBe('⛔ [E_MODEL_NOT_WRITABLE] Refusing to modify "CustTable"');
    expect(withToolErrorCode('E_IGNORED_PARAMS', '⚠️ 1 parameter(s) did not reach the written XML:'))
      .toBe('⚠️ [E_IGNORED_PARAMS] 1 parameter(s) did not reach the written XML:');
  });

  it('opens a message that has no emoji', () => {
    expect(withToolErrorCode('E_OBJECT_NOT_FOUND', 'File not found for table "ContosoRentEquipmentTable".'))
      .toBe('[E_OBJECT_NOT_FOUND] File not found for table "ContosoRentEquipmentTable".');
  });

  it('keeps leading blank lines in front, since an appended warning starts with one', () => {
    expect(withToolErrorCode('E_NO_PROJECT', '\n⚠️ addToProject=true but no projectPath could be resolved.\n'))
      .toBe('\n⚠️ [E_NO_PROJECT] addToProject=true but no projectPath could be resolved.\n');
  });

  it('leaves the rest of the wording, later lines included, exactly as it was', () => {
    const message = '⛔ refused — 2 matches.\nExtend oldCode until it identifies one site.';
    const stamped = withToolErrorCode('E_AMBIGUOUS_OLDCODE', message);
    expect(stamped.replace('[E_AMBIGUOUS_OLDCODE] ', '')).toBe(message);
  });

  it('does not stack a second code: the one already on the message wins', () => {
    const inner = withToolErrorCode('E_OLDCODE_NOT_FOUND', "Bridge operation 'replace-code' failed");
    expect(withToolErrorCode('E_UNSUPPORTED_OPERATION', inner)).toBe(inner);
  });
});

describe('hoistToolErrorCode', () => {
  it('moves a code a wrapper pushed into the middle of the line to the front', () => {
    const inner = withToolErrorCode('E_AMBIGUOUS_OLDCODE', '❌ directXmlReplaceCode: oldCode appears 2 times');
    expect(hoistToolErrorCode(`❌ Error modifying D365FO file: ${inner}`))
      .toBe('❌ [E_AMBIGUOUS_OLDCODE] Error modifying D365FO file: ❌ directXmlReplaceCode: oldCode appears 2 times');
  });

  it('reaches a code that sits on a later line of the wrapped text', () => {
    const inner = withToolErrorCode('E_MODEL_NOT_WRITABLE', '⛔ Refusing to create "ContosoThing"');
    const hoisted = hoistToolErrorCode(`❌ Error creating D365FO file:\n\n${inner}`);
    expect(hoisted.split('\n')[0]).toBe('❌ [E_MODEL_NOT_WRITABLE] Error creating D365FO file:');
    expect(extractToolErrorCodes(hoisted)).toEqual(['E_MODEL_NOT_WRITABLE']);
  });

  it('returns a message already in the fixed form unchanged', () => {
    const stamped = withToolErrorCode('E_NO_PROJECT', '❌ no active project');
    expect(hoistToolErrorCode(stamped)).toBe(stamped);
  });

  it('returns a message with no code, or with an unregistered one, unchanged', () => {
    expect(hoistToolErrorCode('❌ something else failed')).toBe('❌ something else failed');
    expect(hoistToolErrorCode('❌ failed: [E_NOT_A_REAL_CODE] text')).toBe('❌ failed: [E_NOT_A_REAL_CODE] text');
  });
});

describe('extractToolErrorCode', () => {
  it('reads the code back from a stamped reply', () => {
    for (const code of Object.keys(TOOL_ERROR_CODES) as ToolErrorCode[]) {
      expect(extractToolErrorCode(withToolErrorCode(code, '❌ refused'))).toBe(code);
    }
  });

  it('finds the code of a warning appended to a successful reply', () => {
    const reply = '✅ Field added.\n\n' + withToolErrorCode('E_IGNORED_PARAMS', '⚠️ 1 parameter(s) did not reach the written XML:');
    expect(extractToolErrorCode(reply)).toBe('E_IGNORED_PARAMS');
  });

  it('answers undefined for a reply without a code and ignores unregistered tokens', () => {
    expect(extractToolErrorCode('✅ done')).toBeUndefined();
    expect(extractToolErrorCode('❌ [E_NOT_A_REAL_CODE] nope')).toBeUndefined();
    expect(extractToolErrorCode('❌ E_NO_PROJECT without brackets')).toBeUndefined();
  });

  it('lists every code once, in order', () => {
    expect(extractToolErrorCodes('[E_NO_PROJECT] a [E_IGNORED_PARAMS] b [E_NO_PROJECT] c'))
      .toEqual(['E_NO_PROJECT', 'E_IGNORED_PARAMS']);
  });
});

describe('bridgeRefusalCode', () => {
  it('recognises the two refusals the bridge words itself', () => {
    expect(bridgeRefusalCode("Unknown AxTable property 'Colour' — nothing was written. Supported: label."))
      .toBe('E_UNSUPPORTED_PROPERTY');
    expect(bridgeRefusalCode("Unknown (or unsupported) AxMenuItem property 'Colour' — nothing was written."))
      .toBe('E_UNSUPPORTED_PROPERTY');
    expect(bridgeRefusalCode("modify-property not supported for objectType 'report' via bridge"))
      .toBe('E_UNSUPPORTED_OPERATION');
  });

  it('gives no code to anything else', () => {
    expect(bridgeRefusalCode("Index 'NameIdx' already exists")).toBeUndefined();
    expect(bridgeRefusalCode("'Fooo' is not a valid CacheLookup")).toBeUndefined();
    expect(bridgeRefusalCode(undefined)).toBeUndefined();
  });

  it('stamps the wrapper message only when the bridge refusal has a code', () => {
    expect(withBridgeRefusalCode("Bridge operation 'modify-property' failed: x", "Unknown AxEnum property 'Colour' — nothing was written."))
      .toBe("[E_UNSUPPORTED_PROPERTY] Bridge operation 'modify-property' failed: x");
    const plain = "Bridge operation 'add-index' failed: Index 'NameIdx' already exists";
    expect(withBridgeRefusalCode(plain, "Index 'NameIdx' already exists")).toBe(plain);
  });
});

describe('the registry', () => {
  const sources = globSync('src/**/*.ts')
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => f !== 'src/utils/toolError.ts')
    .map(f => ({ file: f, text: readFileSync(f, 'utf8') }));

  it('names every code E_UPPER_SNAKE and gives each a one-line meaning', () => {
    for (const [code, meaning] of Object.entries(TOOL_ERROR_CODES)) {
      expect(code).toMatch(/^E_[A-Z0-9]+(?:_[A-Z0-9]+)*$/);
      expect(meaning.trim().length).toBeGreaterThan(10);
      expect(meaning).not.toContain('\n');
    }
  });

  it('has no code that nothing applies', () => {
    const unused = Object.keys(TOOL_ERROR_CODES).filter(code =>
      !sources.some(s => s.text.includes(`withToolErrorCode('${code}'`)));
    expect(unused, `registered but never stamped: ${unused.join(', ')}`).toEqual([]);
  });

  it('has no [E_…] literal or stamped code in src/ that is not registered', () => {
    const unknown: string[] = [];
    for (const s of sources) {
      const used = [
        ...[...s.text.matchAll(/\[(E_[A-Z0-9_]+)\]/g)].map(m => m[1]),
        ...[...s.text.matchAll(/withToolErrorCode\('([^']+)'/g)].map(m => m[1]),
      ];
      for (const code of used) {
        if (!(code in TOOL_ERROR_CODES)) unknown.push(`${s.file}: ${code}`);
      }
    }
    expect(unknown, `not in TOOL_ERROR_CODES:\n${unknown.join('\n')}`).toEqual([]);
  });

  it('renders one line per code for the knowledge text', () => {
    const lines = renderToolErrorCodeList().split('\n');
    expect(lines).toHaveLength(Object.keys(TOOL_ERROR_CODES).length);
    for (const code of Object.keys(TOOL_ERROR_CODES)) {
      expect(lines.some(l => l.startsWith(`  ${code}: `))).toBe(true);
    }
  });
});
