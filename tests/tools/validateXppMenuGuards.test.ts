import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';
import { validateCodeTool } from '../../src/tools/analysis/validateCode';

const main = (body: string) => `public static void main(Args _args)\n{\n${body}\n}`;
const findings = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'UI001');

describe('UI001 — possible action-menu guard exception', () => {
  it('warns at the actual throw without claiming a compile error or proven menu binding', () => {
    const code = main('    if (!_args.record())\n    {\n        throw error("@MyModel:MissingRecord");\n    }');
    const result = findings(code);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ severity: 'warning', line: 5 });
    expect(result[0].fix).toContain('If this main(Args) is an action menu-item entry point');
    expect(result[0].fix).toContain('Unable to open menu item');
    expect(result[0].fix).toContain('expected');
    expect(result[0].fix).toContain('warning');
    expect(result[0].fix).toContain('return');
    for (const caveat of ['rollback', 'security', 'batch', 'before writes', 'menu-item-guards']) {
      expect(result[0].fix).toContain(caveat);
    }
  });

  it('handles qualified calls, mixed case and multiline declarations', () => {
    expect(
      findings(
        'class MyAction { public STATIC void MAIN(\nARGS _args\n) { if (!_args) THROW Global::ERROR("@MyModel:Missing"); } }',
      ),
    ).toHaveLength(1);
  });

  it.each([
    main(
      '// throw error("@MyModel:Missing");\n/* throw Global::error("ignored"); */\nstr text = "throw error(ignored)";',
    ),
    '// public static void main(Args _args) { throw error("ignored"); }',
    'public static void helper(Args _args) { throw error("@MyModel:Missing"); }',
    'public void main(Args _args) { throw error("@MyModel:Missing"); }',
    'public static void main(str _text) { throw error("@MyModel:Missing"); }',
    'throw error("@MyModel:Missing");',
    main('if (!_args) { warning("@MyModel:Missing"); return; }'),
    main('error("@MyModel:Missing");'),
    main('throw Exception::Error;'),
    main('try { throw error("@MyModel:Missing"); } catch (Exception::Error) { warning("@MyModel:Handled"); }'),
    main('try { throw error("@MyModel:Missing"); } catch { warning("@MyModel:Handled"); }'),
    main('ttsbegin; throw error("@MyModel:Rollback"); ttscommit;'),
    main('ttsbegin; ttscommit; throw error("@MyModel:AfterWrite");'),
    main('MyTable.insert(); throw error("@MyModel:AfterWrite");'),
    main('update_recordset myTable setting Value = 1; throw error("@MyModel:AfterWrite");'),
    main('void helper() { throw error("@MyModel:Helper"); } helper();'),
  ])('does not turn unrelated or uncertain exception semantics into guard advice: %s', code => {
    expect(findings(code)).toEqual([]);
  });

  it('isolates main from helpers, handlers and transactions in other methods', () => {
    const code = `class MyAction {
      public static void helper() { ttsbegin; ttscommit; throw error("@MyModel:Helper"); }
      ${main('if (!_args) throw error("@MyModel:Missing");')}
      public void after() { try { throw error("@MyModel:Helper"); } catch { } }
    }`;
    expect(findings(code)).toHaveLength(1);
  });

  it('does not let braces or handler keywords in strings change method boundaries', () => {
    expect(
      findings(main('str text = "} try catch ttsbegin";\nif (!_args) throw error("@MyModel:Missing");')),
    ).toHaveLength(1);
  });

  it('surfaces through validate_code as a non-blocking warning', async () => {
    const result = await validateCodeTool(
      {
        method: 'tools/call',
        params: {
          name: 'validate_code',
          arguments: { mode: 'syntax', code: main('if (!_args) throw error("@MyModel:Missing");') },
        },
      },
      {} as never,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('[UI001]');
    expect(result.content[0].text).toContain('0 error(s), 1 warning(s)');
  });
});
