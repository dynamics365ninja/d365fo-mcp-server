/**
 * MCP tool definition for `get_knowledge` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const getKnowledgeTool = {
    name: 'get_knowledge',
    description:
      'X++ knowledge lookup. Choose a `kind`:\n' +
      '• knowledge → queryable X++ rulebook: verified patterns, BP rules, AX2012→D365FO migration. Use BEFORE generating code. Topics incl.: select-statement, coc-authoring, bp-rules, sysoperation, event-handlers, workflow, number-sequences, security, sysda, form patterns.\n' +
      '• error → diagnose a D365FO/X++ compiler or runtime error: structured root cause + step-by-step fix + corrected X++ example (TTS mismatch, UpdateConflict, CSUV1, SYS10028 missing next, overlayering, BP errors, …). Call this instead of guessing — X++ error semantics differ from C#/.NET.\n' +
      '• op-spec → the parameter contract for ONE d365fo_file operation/objectType or ONE generate_object mode (topic = "add-index", "table", "scaffold:form", …). Those two tools deliberately do not ship their parameters inline; call this after picking the operation, before the call. Omit topic for the index of available topics.\n' +
      '• bp-moniker → validate an exact BP-check moniker, search by scenario when you have no moniker yet, or render a _BPSuppressions.xml <Diagnostic> block. Backed by names/text extracted from a real D365FO install — never invents a moniker.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['knowledge', 'error', 'op-spec', 'bp-moniker'],
          description: 'knowledge = look up an X++ topic/rule; error = diagnose an error message; op-spec = parameter contract for a d365fo_file operation/objectType or generate_object mode; bp-moniker = validate/search a BP-check moniker or render a suppression.',
        },
        // kind=knowledge (also carries the op-spec key for kind=op-spec)
        topic: {
          type: 'string',
          description:
            '[knowledge] REQUIRED. Topic to query — e.g. "batch job", "ttsbegin", "RunBase vs SysOperation", ' +
            '"set-based operations", "CoC", "data entities", "number sequences", "security", ' +
            '"temp tables", "today() deprecated", "query patterns", "form patterns". ' +
            '[op-spec] The operation / objectType / mode to look up.',
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 10,
          description: '[knowledge|op-spec] Look up SEVERAL topics in one call instead of one call each. Replaces topic.',
        },
        format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          default: 'concise',
          description: '[knowledge] concise = quick reference (default), detailed = full explanation with code examples',
        },
        // kind=error
        errorText: {
          type: 'string',
          description: '[error] REQUIRED. Full error message text as displayed in the X++ compiler or event log',
        },
        errorCode: {
          type: 'string',
          description: '[error] Optional error code (e.g. SYS10028, CSUV1, BPUpgradeCodeToday)',
        },
        // kind=bp-moniker
        action: {
          type: 'string',
          enum: ['validate', 'search', 'suppress'],
          description: '[bp-moniker] REQUIRED. validate = confirm an exact moniker is real; search = free-text scenario query; suppress = render a <Diagnostic> block.',
        },
        moniker: {
          type: 'string',
          description: '[bp-moniker validate/suppress] REQUIRED. Exact moniker, e.g. "BPErrorPrivilegeNotCoveredByDuty".',
        },
        // elementType/elementName are accepted too (see bpMonikerHelp.ts) but
        // are not republished here: the finding already hands you `path`, and
        // that is the only form that can address a control/field/method.
        path: {
          type: 'string',
          description: '[bp-moniker suppress] REQUIRED. dynamics:// path, verbatim from the finding.',
        },
        justification: {
          type: 'string',
          description: '[bp-moniker suppress] REQUIRED. Why the warning is ignored; 95% of real entries carry one.',
        },
      },
      // kind is optional: inferred from topic (→ knowledge) or errorText (→ error).
      required: [],
    },
  };
