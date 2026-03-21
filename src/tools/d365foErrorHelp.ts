/**
 * D365FO Error Help Tool
 * Diagnose X++ compilation errors, BP warnings, and runtime exceptions.
 * Returns a plain-language explanation and corrective action — no DB access needed.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// ─── Schema ──────────────────────────────────────────────────────────────────

const D365foErrorHelpArgsSchema = z.object({
  errorText: z.string().describe(
    'Full error or warning message text — paste from Error List, Output window, or infolog. ' +
    'Examples: "CSUV1 The field … cannot be assigned", "TTS level is not 0", ' +
    '"BPUpgradeCodeToday", "SYS10028 you must call next …"'
  ),
  errorCode: z.string().optional().describe(
    'Optional: error code prefix, e.g. "CSUV1", "SYS10028", "BPError", "BP". ' +
    'Improves matching accuracy.'
  ),
  context: z.string().optional().describe(
    'Optional: the X++ code snippet where the error occurs — helps produce a targeted suggestion.'
  ),
});

export const d365foErrorHelpToolDefinition = {
  name: 'get_d365fo_error_help',
  description:
    'Diagnose D365FO X++ compilation errors, BP warnings, and runtime exceptions. ' +
    'Returns a plain-language explanation and corrective action. ' +
    'Use when the compiler Output window, Error List, or runtime infolog shows an unfamiliar error. ' +
    'Covers: CSUV*/CSU*, SYS*, BP* warnings, TTS level errors, OCC (UpdateConflict), ' +
    'type-cast errors, "must call next", "not valid metadata element", and more.',
  inputSchema: D365foErrorHelpArgsSchema,
};

// ─── Error Entry Type ────────────────────────────────────────────────────────

interface ErrorEntry {
  /** Match patterns — checked against errorCode and errorText (case-insensitive) */
  patterns: string[];
  title: string;
  explanation: string;
  /** Corrective action(s) */
  fix: string[];
  /** Optional code example showing the correct pattern */
  example?: string;
  /** Related knowledge base topic IDs */
  related?: string[];
}

// ─── Error Database ──────────────────────────────────────────────────────────

const ERROR_DB: ErrorEntry[] = [
  // ── TTS / Transaction errors ──────────────────────────────────────────────
  {
    patterns: ['tts level', 'ttsbegin', 'tts is not 0', 'transaction level', 'unbalanced tts'],
    title: 'TTS Level Mismatch',
    explanation:
      'The transaction scope (ttsbegin/ttscommit) is unbalanced. ' +
      'Each ttsbegin must be paired with exactly one ttscommit (or ttsabort). ' +
      'This usually happens when an exception is thrown inside a tts block, or when ttsabort is called unnecessarily.',
    fix: [
      'Ensure every code path that enters ttsbegin also calls ttscommit (or handles exception correctly)',
      'Put try/catch OUTSIDE the ttsbegin...ttscommit block, NOT inside it',
      'Never call ttsabort() as normal flow — only use it in unrecoverable failure scenarios',
      'Use a boolean success flag: set to true inside tts before ttscommit, check after',
    ],
    example: `// ✅ Correct pattern
try
{
    ttsbegin;
    myTable.update();
    ttscommit;
}
catch (Exception::UpdateConflict)
{
    // tts already rolled back — retry or re-throw
    throw Exception::UpdateConflictNotRecovered;
}`,
    related: ['transactions'],
  },
  {
    patterns: ['updateconflict', 'update conflict', 'occ', 'optimistic concurrency', 'exception::updateconflict'],
    title: 'UpdateConflict (OCC — Optimistic Concurrency Control)',
    explanation:
      'Two transactions tried to update the same record simultaneously. ' +
      'D365FO uses OCC by default — the loser must retry the entire transaction.',
    fix: [
      'Wrap the tts block in a retry loop with a maximum retry count (e.g. 5)',
      'On UpdateConflict: increment retry counter, loop back to ttsbegin',
      'On exceeding max retries: throw Exception::UpdateConflictNotRecovered',
      'For high-contention tables (e.g. number sequences): use pessimisticlock keyword on select',
    ],
    example: `int retryCount = 0;
boolean done = false;

while (!done && retryCount < 5)
{
    try
    {
        ttsbegin;
        select forupdate myTable where myTable.RecId == recId;
        myTable.Field = newValue;
        myTable.update();
        ttscommit;
        done = true;
    }
    catch (Exception::UpdateConflict)
    {
        retryCount++;
        if (retryCount >= 5)
            throw Exception::UpdateConflictNotRecovered;
    }
}`,
    related: ['transactions'],
  },

  // ── Compilation errors ────────────────────────────────────────────────────
  {
    patterns: ['csuv1', 'cannot be assigned', 'cannot assign', 'type mismatch', 'illegal assignment'],
    title: 'CSUV1 — Illegal Assignment / Type Mismatch',
    explanation:
      'Assigning a value of an incompatible type to a variable. ' +
      'Common causes: assigning an integer to a string, assigning null to a non-nullable EDT, ' +
      'or assigning a RecId (Int64) to an Int field.',
    fix: [
      'Check the target variable\'s EDT or base type',
      'Use explicit type conversion: str2Int(), int642Int(), num2Str(), etc.',
      'For RecId fields: use Int64 / RecId EDT, not Int',
      'For enum values: use int2Enum(value, enumTypeId) for dynamic conversion',
    ],
    related: ['deprecated'],
  },
  {
    patterns: ['sys10028', 'must call next', 'call next', 'missing next'],
    title: 'SYS10028 — Missing "next" Call in CoC Extension',
    explanation:
      'A Chain of Command extension method is missing the required "next methodName()" call. ' +
      'Every CoC wrapper MUST call next to invoke the original method and maintain the extension chain.',
    fix: [
      'Add "next methodName(_params);" inside the CoC method — before, after, or replacing surrounding logic',
      'Store the return value: "ReturnType ret = next methodName(_params);"',
      'Only omit next in extremely rare cases where you intentionally replace (not extend) the method — document this explicitly',
      'Verify the exact method signature with get_method_signature() first',
    ],
    example: `[ExtensionOf(tableStr(CustTable))]
final class CustTable_MyModel_Extension
{
    public boolean validateWrite()
    {
        boolean ret = next validateWrite(); // ✅ required
        if (ret && this.CreditMax > 500000)
        {
            ret = checkFailed("Credit limit exceeded");
        }
        return ret;
    }
}`,
    related: ['coc'],
  },
  {
    patterns: ['not valid metadata element', 'invalid metadata', 'cannot open', 'cannot deserialize', 'metadata elements'],
    title: 'Not Valid Metadata Element / Cannot Deserialize XML',
    explanation:
      'D365FO cannot parse the XML file for a class, table, form, or other AOT object. ' +
      'This usually means: wrong file location, missing xmlns attribute on root element, ' +
      'CDATA section missing on <Declaration> or <Source>, or XML written with wrong encoding.',
    fix: [
      'Always use create_d365fo_file (never copy/paste raw files)',
      'Ensure the file has UTF-8 BOM (D365FO XML requires BOM)',
      'Verify root element has correct xmlns:i="http://www.w3.org/2001/XMLSchema-instance"',
      '<Declaration> and <Source> blocks MUST use <![CDATA[...]]> — not entity-encoded content',
      'File must be in the correct folder: AxClass\\, AxTable\\, AxForm\\, etc.',
      'Verify the file name exactly matches the <Name> element inside the XML',
    ],
    related: [],
  },
  {
    patterns: ['overlayering', 'overlay', 'overlayer', 'cannot overlay', 'modification not allowed'],
    title: 'Overlayering Not Allowed',
    explanation:
      'D365FO completely blocks overlayering (modifying Microsoft or ISV source code directly). ' +
      'Extensions must use Chain of Command, event handlers, or XML extensions.',
    fix: [
      'Use [ExtensionOf(classStr(Target))] for class/table/form CoC extensions',
      'Use [DataEventHandler(tableStr(X), DataEventType::Inserted)] for table data events',
      'Use [PreHandlerFor] / [PostHandlerFor] for pre/post method events',
      'For table fields: use table-extension (AxTableExtension) to add fields',
      'For form controls: use form-extension (AxFormExtension) to add controls',
      'NEVER modify Microsoft source files directly — create extension objects instead',
    ],
    related: ['coc', 'event-handlers'],
  },
  {
    patterns: ['bpupgradecodetoday', 'today()', 'bp upgrade code today'],
    title: 'BPUpgradeCodeToday — today() is Deprecated',
    explanation:
      'The today() function is deprecated in D365FO and triggers a BP (Best Practices) error. ' +
      'It does not account for user time zone and returns the server date.',
    fix: [
      'Replace today() with DateTimeUtil::getSystemDate(DateTimeUtil::getUserPreferredTimeZone())',
      'Assign to a variable BEFORE using in a WHERE condition',
    ],
    example: `// ❌ Wrong
TransDate today = today();

// ✅ Correct
TransDate systemDate = DateTimeUtil::getSystemDate(
    DateTimeUtil::getUserPreferredTimeZone());`,
    related: ['deprecated', 'query-patterns'],
  },
  {
    patterns: ['bpnestedloop', 'bp nested loop', 'nested while', 'nested loop in code', 'bpchecknested'],
    title: 'BPCheckNestedLoopInCode — Nested while-select',
    explanation:
      'A while-select loop is nested inside another while-select loop, causing N×M database round-trips. ' +
      'This is a critical performance anti-pattern in D365FO.',
    fix: [
      'Replace nested selects with a JOIN in a single select statement',
      'Use exists join (for filtering) or outer join (for optional data)',
      'If a join is not possible, use a Map/Set to batch-load the inner data first',
      'For bulk operations: use insert_recordset, update_recordset, delete_from',
    ],
    example: `// ❌ Nested loop (N×M queries)
while select custTable { while select custTrans where ... { } }

// ✅ Single select with join
while select custTable
    join custTrans
        where custTrans.AccountNum == custTable.AccountNum { }`,
    related: ['set-based', 'query-patterns'],
  },
  {
    patterns: ['forupdate', 'record not selected for update', 'cannot update', 'update without forupdate'],
    title: 'Update Without forupdate — Record Not Selected for Update',
    explanation:
      'Calling .update() on a record that was not selected with the forupdate keyword. ' +
      'D365FO enforces optimistic locking — you must declare intent to update at select time.',
    fix: [
      'Add the forupdate keyword to the select statement: "select forupdate myTable where ..."',
      'For tts blocks: always use forupdate inside ttsbegin...ttscommit',
      'For direct field update: also call myTable.skipEvents(true) / skipDataMethods(true) only when intentional',
    ],
    example: `ttsbegin;
select forupdate myTable // ✅ required
    where myTable.RecId == recId;
myTable.Field = newValue;
myTable.update();
ttscommit;`,
    related: ['transactions'],
  },
  {
    patterns: ['field does not exist', 'unknown field', 'no field', 'fieldnum error', 'field not found on table'],
    title: 'Field Does Not Exist on Table',
    explanation:
      'Referencing a field that does not exist on the table. ' +
      'Common when guessing field names or using AX2012 field names that were renamed in D365FO.',
    fix: [
      'Call get_table_info("TableName") to see the exact field list',
      'Search for the field: search("balance", types=["field"]) to find the exact name',
      'Use fieldNum(TableName, FieldName) only — it compiles to a constant at build time',
      'If the field is on an extension table: use get_table_extension_info() to check',
    ],
    related: [],
  },
  {
    patterns: ['label does not exist', 'label not found', '@sys', 'undefined label', 'label reference'],
    title: 'Label Does Not Exist',
    explanation:
      'A label reference (e.g. "@MyModel:LabelId") points to a label ID that does not exist in the label file. ' +
      'D365FO will show the raw label ID in the UI at runtime.',
    fix: [
      'Use search_labels("text") to find an existing label that fits',
      'Use create_label() to create a new label in the model\'s label file',
      'Verify the label file ID prefix matches (e.g. "@ContosoExt:LabelId" requires a ContosoExt.en-US.label.txt file)',
      'Never use hardcoded strings — always use label references in X++ attributes and XML properties',
    ],
    related: ['labels'],
  },
  {
    patterns: ['stack trace', 'clrerror', 'clr exception', '.net exception', 'system.nullreferenceexception', 'system.exception'],
    title: 'CLR / .NET Exception in X++',
    explanation:
      'A .NET (CLR) method threw an exception. In X++, this surfaces as Exception::CLRError. ' +
      'The infolog will contain the original .NET exception type and message.',
    fix: [
      'Catch with: catch (Exception::CLRError) { str msg = CLRInterop::getLastException()?.ToString(); }',
      'Inspect the full stack trace in the infolog or Application Insights',
      'Check for null references before calling .NET methods: if (obj != null)',
      'For COM objects: always check return values and use try/finally to release',
    ],
    example: `try
{
    // .NET call
    System.IO.File::ReadAllText(filePath);
}
catch (Exception::CLRError)
{
    System.Exception clrEx = CLRInterop::getLastException();
    error(clrEx.Message);
}`,
    related: ['error-handling'],
  },
  {
    patterns: ['record not found', 'empty record', 'select returned no rows', 'null record'],
    title: 'Record Not Found / Empty Buffer',
    explanation:
      'A select statement returned no record (the buffer is empty). ' +
      'In X++, a select always succeeds — you must check RecId > 0 (or another non-zero field) to detect empty results.',
    fix: [
      'Check: if (myTable.RecId) { ... } — RecId is 0 when no record was found',
      'For tables without RecId as key: check a mandatory field (e.g. if (myTable.ItemId))',
      'Use find() methods: CustTable custTable = CustTable::find(accountNum); if (custTable.RecId) { ... }',
      'Consider whether the missing record is an error or normal condition (optional lookup)',
    ],
    related: ['query-patterns'],
  },
  {
    patterns: ['number sequence', 'no number sequence', 'numberseqreference not found', 'sequence not set up'],
    title: 'Number Sequence Not Configured / Not Found',
    explanation:
      'The code tries to allocate a number from a number sequence that is not registered or not set up for the current company.',
    fix: [
      'Verify the number sequence reference is registered in loadModule() of your NumberSequenceModuleXxx class',
      'Verify the number sequence is set up in Organization administration → Number sequences',
      'Use NumberSeqFormHandler on the form to let users configure the sequence per company',
      'Check the scope matches the company context (DataArea vs Global)',
    ],
    related: ['number-sequences'],
  },
];

// ─── Scoring & Search ────────────────────────────────────────────────────────

function scoreError(entry: ErrorEntry, errorText: string, errorCode?: string): number {
  const lowerText = errorText.toLowerCase();
  const lowerCode = (errorCode ?? '').toLowerCase();
  let score = 0;

  for (const pattern of entry.patterns) {
    if (lowerCode && lowerCode.includes(pattern)) score += 20;
    if (lowerText.includes(pattern)) score += 10;
    // partial match — individual words
    const words = pattern.split(/\s+/);
    const matchedWords = words.filter(w => lowerText.includes(w) || lowerCode.includes(w));
    score += matchedWords.length * 2;
  }
  return score;
}

// ─── Formatter ───────────────────────────────────────────────────────────────

function formatEntry(entry: ErrorEntry, context?: string): string {
  const lines: string[] = [];
  lines.push(`## ${entry.title}\n`);
  lines.push(`**What happened:** ${entry.explanation}\n`);
  lines.push('**How to fix:**');
  for (const fix of entry.fix) {
    lines.push(`- ${fix}`);
  }
  if (entry.example) {
    lines.push('\n**Correct pattern:**');
    lines.push('```xpp');
    lines.push(entry.example);
    lines.push('```');
  }
  if (context) {
    lines.push('\n**Your code context:**');
    lines.push('```xpp');
    lines.push(context.trim());
    lines.push('```');
  }
  if (entry.related && entry.related.length > 0) {
    lines.push(`\n_Related topics (use get_xpp_knowledge): ${entry.related.join(', ')}_`);
  }
  return lines.join('\n');
}

// ─── Tool Handler ────────────────────────────────────────────────────────────

export function d365foErrorHelpTool(request: CallToolRequest) {
  try {
    const args = D365foErrorHelpArgsSchema.parse(request.params.arguments);
    const { errorText, errorCode, context } = args;

    // Score all entries
    const scored = ERROR_DB
      .map(entry => ({ entry, score: scoreError(entry, errorText, errorCode) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text:
            `❌ No matching error pattern found for:\n\n> ${errorText}\n\n` +
            `**Suggestions:**\n` +
            `- Try searching the error code in Microsoft docs: https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/\n` +
            `- Use get_xpp_knowledge() with the relevant topic (e.g. "transactions", "coc", "query-patterns")\n` +
            `- Check the full stack trace in the infolog for the root cause class/method`,
        }],
      };
    }

    // Return the top match (+ mention others if multiple scored)
    const top = scored[0].entry;
    let text = formatEntry(top, context);

    if (scored.length > 1) {
      const others = scored
        .slice(1, 4)
        .map(s => `- **${s.entry.title}**`)
        .join('\n');
      text += `\n\n---\n_Other possible matches:_\n${others}`;
    }

    return { content: [{ type: 'text' as const, text }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
