/**
 * Stable refusal codes.
 *
 * A refused write used to be told apart only by its wording, and the wording
 * changes between releases: an agent that matched "appears 2 times" stopped
 * recognising the refusal the day the sentence was improved. A code is the part
 * that does not change. It rides in the text, because the text is all a model
 * reads, in one fixed form:
 *
 *   ❌ [E_AMBIGUOUS_OLDCODE] directXmlReplaceCode: oldCode appears 2 times …
 *
 * that is `[E_…]` at the start of the first line, after the emoji the message
 * already opened with. The wording after it is unchanged, so the guidance a
 * message carries is still there. A code on a WARNING appended to a successful
 * reply (`E_IGNORED_PARAMS`, the project warnings of a create) opens that
 * warning's own first line instead, since the reply's first line is the ✅.
 *
 * Only conditions that call for a DIFFERENT next step have a code. Add one here
 * together with the site that applies it: tests/utils/toolError.test.ts
 * fails on a code nothing applies and on an `[E_…]` literal that is not listed.
 */

/** Every code, with the one-line meaning an agent acts on. */
export const TOOL_ERROR_CODES = {
  E_AMBIGUOUS_OLDCODE: 'oldCode matches more than one place. Extend it with surrounding lines, or scope the call with methodName.',
  E_OLDCODE_NOT_FOUND: 'oldCode is not in the source on disk. Re-read the object and copy the exact snippet.',
  E_NO_PROJECT: 'No Visual Studio project could be determined. Pass projectPath.',
  E_AMBIGUOUS_PROJECT: 'Several projects fit and none was picked. Pass projectPath, or the exact project name.',
  E_MODEL_NOT_WRITABLE: 'The target is in a standard model or in a model other than the one this workspace writes to. Create an extension in your own model.',
  E_UNSUPPORTED_PROPERTY: 'The property is not one this object type has, or not one the writer can set. Use a property the message lists.',
  E_UNSUPPORTED_OPERATION: 'The operation does not exist for this object type. Read the op-spec and pick another operation.',
  E_IGNORED_PARAMS: 'One or more parameters were not applied. Re-run with the parameter names the message gives.',
  E_OBJECT_NOT_FOUND: 'The object or its file could not be found. Check the name and model, or pass filePath.',
  E_AMBIGUOUS_MATCH: 'The name given matches more than one element. Narrow it with the parameter the message names.',
} as const;

export type ToolErrorCode = keyof typeof TOOL_ERROR_CODES;

/** `[E_SOMETHING]`, the only form a code is ever written in. */
const CODE_TOKEN = /\[(E_[A-Z0-9_]+)\]/g;

/** Leading blank lines, then the emoji an error or warning opens with, if any. */
const LEADING_MARK = /^\s*(?:(?:❌|⛔|⚠)️?[ \t]*)?/u;

function isToolErrorCode(value: string): value is ToolErrorCode {
  return Object.hasOwn(TOOL_ERROR_CODES, value);
}

/**
 * Put `code` on a message: `❌ text` becomes `❌ [CODE] text`, and a message
 * with no emoji becomes `[CODE] text`. A message that already carries a code
 * anywhere is returned with THAT code moved to the front instead, so the
 * innermost (most specific) site wins when a wrapper stamps again.
 */
export function withToolErrorCode(code: ToolErrorCode, message: string): string {
  if (extractToolErrorCode(message)) return hoistToolErrorCode(message);
  const mark = LEADING_MARK.exec(message)?.[0] ?? '';
  const sep = mark === '' || /\s$/.test(mark) ? '' : ' ';
  return `${mark}${sep}[${code}] ${message.slice(mark.length)}`;
}

/**
 * Move a code that ended up mid-text to the front.
 *
 * A refusal raised deep in a writer is wrapped on its way out
 * (`❌ Error modifying D365FO file: ❌ [E_…] directXmlReplaceCode: …`), which
 * would leave the code somewhere in the middle of the line. Wrappers call this on
 * the text they built. A text with no registered code is returned unchanged.
 */
export function hoistToolErrorCode(message: string): string {
  const code = extractToolErrorCode(message);
  if (!code) return message;
  const token = `[${code}]`;
  const mark = LEADING_MARK.exec(message)?.[0] ?? '';
  if (message.startsWith(token, mark.length)) return message;
  const at = message.indexOf(token);
  const rest = message.slice(at + token.length);
  const without = message.slice(0, at) + (rest.startsWith(' ') ? rest.slice(1) : rest);
  const sep = mark === '' || /\s$/.test(mark) ? '' : ' ';
  return `${mark}${sep}${token} ${without.slice(mark.length)}`;
}

/** Every registered code in a reply text, in the order they appear, each once. */
export function extractToolErrorCodes(text: string): ToolErrorCode[] {
  const found: ToolErrorCode[] = [];
  for (const m of text.matchAll(CODE_TOKEN)) {
    if (isToolErrorCode(m[1]) && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** The first registered code in a reply text, or undefined when it has none. */
export function extractToolErrorCode(text: string): ToolErrorCode | undefined {
  return extractToolErrorCodes(text)[0];
}

/**
 * The code for a refusal the C# bridge worded, or undefined.
 *
 * The bridge's messages cannot carry a code of their own, so the two that need
 * one are recognised here by the fixed part of their sentence. Anything else is
 * left without a code: a wrong code is worse than none.
 */
export function bridgeRefusalCode(bridgeMessage: string | undefined): ToolErrorCode | undefined {
  if (!bridgeMessage) return undefined;
  if (/^Unknown (?:\([^)]*\) )?Ax\w+ property '/.test(bridgeMessage)) return 'E_UNSUPPORTED_PROPERTY';
  if (/\bnot supported for (?:objectType )?'[^']*' via bridge/.test(bridgeMessage)) return 'E_UNSUPPORTED_OPERATION';
  return undefined;
}

/** `message` with the code of the bridge refusal it reports, or unchanged when that has none. */
export function withBridgeRefusalCode(message: string, bridgeMessage: string | undefined): string {
  const code = bridgeRefusalCode(bridgeMessage);
  return code ? withToolErrorCode(code, message) : message;
}

/** The compact list for the knowledge text: one `CODE meaning` line per code. */
export function renderToolErrorCodeList(): string {
  return (Object.keys(TOOL_ERROR_CODES) as ToolErrorCode[])
    .map(code => `  ${code}: ${TOOL_ERROR_CODES[code]}`)
    .join('\n');
}
