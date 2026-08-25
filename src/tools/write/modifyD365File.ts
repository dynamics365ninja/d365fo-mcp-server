/**
 * Modify D365FO File Tool
 * Edit existing D365FO XML files (AxClass, AxTable, AxForm, etc.)
 * Supports atomic operations: add method, add field, modify property
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import * as fs from 'fs/promises';
// Taken from node:fs rather than fs/promises: the value is the same, but the
// promises namespace is routinely replaced wholesale by test mocks that only
// stub the functions, and reading .constants off such a mock is a TypeError.
import { constants as FS_CONSTANTS } from 'fs';
import { execFile } from 'child_process';
import util from 'util';

import path from 'path';
import { parseStringPromise } from '../../utils/xml.js';
import { sayOncePerSession, resetRepeatedNoteMemory } from '../../utils/repeatedNotes.js';
import { getConfigManager, extractModelFromFilePath } from '../../utils/configManager.js';
import { isStandardModel, resolveRegularObjectPrefixToken, resolveObjectPrefix, deriveExtensionInfix } from '../../utils/modelClassifier.js';
import { normalizeObjectName } from '../../utils/objectNaming.js';
import { findBaseObjectXml, findBaseFormXml } from '../../utils/baseObjectXml.js';
import { assertWritePathAllowed } from '../../utils/pathContainment.js';
import { withFileLock, writeFileAtomic } from '../../utils/atomicFileWrite.js';
import {
  bridgeValidateAfterWrite, canBridgeModify,
  bridgeAddMethod, bridgeRemoveMethod, bridgeAddField, bridgeSetProperty, bridgeReplaceCode,
  bridgeModifyField, bridgeRenameField, bridgeRemoveField, bridgeReplaceAllFields,
  bridgeAddIndex, bridgeRemoveIndex, bridgeAddRelation, bridgeRemoveRelation,
  bridgeAddFullTextIndex, bridgeRemoveFullTextIndex,
  bridgeAddTableMapping, bridgeRemoveTableMapping,
  bridgeAddFieldGroup, bridgeRemoveFieldGroup, bridgeAddFieldToFieldGroup,
  bridgeAddEnumValue, bridgeModifyEnumValue, bridgeRemoveEnumValue,
  bridgeAddControl, bridgeAddDataSource,
  bridgeAddFieldModification, bridgeAddMenuItemToMenu,
  bridgeRefreshProvider,
} from '../../bridge/index.js';
import * as debouncedRefresh from '../../bridge/debouncedRefresh.js';
import { ProjectFileFinder, registerFileInActiveProject } from '../../workspace/projectFile.js';
import { heuristicEdtBaseType, resolveEdtBaseType, isEnumName, resolveEdtEnumType } from '../smart/generateSmartTable.js';
import { normalizeD365Xml } from '../../utils/d365XmlNormalizer.js';
import { insertFormExtensionControl } from '../../utils/formExtensionControlXml.js';
import {
  upsertFormExtensionControlProperty, resolveControlPropertyTarget,
} from '../../utils/formExtensionControlModifications.js';
import { removeFormControl } from '../../utils/formControlRemoval.js';
import { addSecurityEntryPoint, removeSecurityEntryPoint } from '../xml/securityPrivilegeXml.js';
import {
  removeDiagnosticSuppression, addDiagnosticSuppression, emptySuppressionListXml,
} from '../../utils/ignoreDiagnosticListXml.js';
import { buildSuppressionXml } from '../../knowledge/bpMonikers/index.js';
import {
  upsertAxTableProperty,
  AX_TABLE_NON_EXISTENT_PROPERTIES,
} from '../../utils/axTablePropertyOrder.js';
import { upsertAxFormDesignProperty } from '../../utils/axFormDesignProperties.js';
import { buildAxDataEntityViewFieldXml } from '../xml/dataEntityViewExtensionXml.js';
import { enforceGrounding } from '../../utils/provenanceStore.js';
import { gateOnReferenceErrors } from './resolveReferences.js';
import {
  checkAddControlAgainstParentPattern,
  checkAddControlAgainstDataGroup,
  findDataGroupRenderers,
  listDataGroupRenderers,
  isFormPatternEnforceEnabled,
} from '../analysis/validateFormPattern.js';
import { validateEdtExtensionChange } from '../../utils/edtExtensionValidator.js';
import { upsertWrittenFileIntoIndex } from './inlineIndexUpsert.js';
import { verifyWrittenFile, renderWriteVerification, runInlineBpCheck, membershipOf, renderBatchEditHint } from './inlineWriteVerification.js';
import { lintXppSelect } from '../../utils/xppSelectLint.js';
import { validateWrittenXpp } from './inlineXppValidation.js';
import { createPhaseTimer } from '../../utils/phaseTimer.js';
import {
  getRequiredParams, renderOpSpec, OP_PARAM_ALIASES,
  findIgnoredParams, renderIgnoredParamsWarning, findMissingMutationParams,
  paramCorrectionCandidates, canonicalParamForAlias, D365FO_FILE_OP_SPECS,
} from '../specs/d365foFileOpSpecs.js';
import { lookupSymbolNocase } from '../../utils/symbolLookup.js';
import { decodeXmlEntitiesFromXppSource, escapeXml } from '../../utils/xmlEscape.js';
import { findD365FileOnDisk, expectedD365FilePath } from '../../utils/objectFileLookup.js';
import {
  crossModelWriteRefusal, standDownNotice, baseObjectOf, type ExistingExtension,
} from '../../utils/crossModelWriteGuard.js';
import { resolveAnchorModel } from './writeAnchorGuard.js';
import { resolveOrCreateLabelRef, type AutoLabelTarget } from './createLabel.js';
import { isRawLabelText } from '../../utils/labelReference.js';


/**
 * Reject an X++ source payload that smuggles XML/CDATA structure.
 *
 * Method source written through the bridge is handed verbatim to the D365FO SDK
 * serializer, which wraps it in `<![CDATA[ … ]]>` and emits the surrounding
 * `<Method>…</Method>` markup itself. If the caller's source already contains
 * the CDATA terminator `]]>` or closing metadata tags, the serializer writes
 * them inside the CDATA block unchanged — producing structurally invalid XML:
 * a premature/doubled `]]>` and a stray `<Method>` that drops the enclosing
 * `</Method>` (exactly the corruption D365FO refuses to deserialize). The
 * direct-XML replace fallback has the same exposure: a literal string replace
 * that injects `]]>` into an existing CDATA block corrupts it too.
 *
 * This always means the AI passed a slice of the .xml file where clean X++ was
 * expected. Reject it here — before it reaches disk — with an actionable
 * message, rather than silently escaping and hiding the mistake.
 *
 * X++ legitimately uses `<`/`>` (generics, comparisons, doc comments), so we
 * only flag the CDATA terminator and the specific opening/closing metadata
 * tokens, never bare angle brackets.
 */
export function assertCleanXppSource(source: string | undefined, paramName: string): void {
  if (!source) return;

  if (source.includes(']]>')) {
    throw new Error(
      `⛔ ${paramName} contains the CDATA terminator "]]>" — that is XML, not clean X++ source.\n\n` +
      `Method source is wrapped in <![CDATA[ … ]]> by the metadata serializer, so a "]]>" inside it ` +
      `breaks the CDATA block and yields invalid XML (doubled "]]>" plus a dropped </Method>), which ` +
      `D365FO refuses to load.\n\n` +
      `Pass ONLY the X++ code — no <Source>, <![CDATA[, ]]> or </Method> markup. The tool adds the wrapping itself.`
    );
  }

  const structuralTag = source.match(/<\/(?:Source|Methods?)>|<Method>|<!\[CDATA\[/);
  if (structuralTag) {
    throw new Error(
      `⛔ ${paramName} contains the XML metadata token "${structuralTag[0]}" — that is XML, not clean X++ source.\n\n` +
      `You pasted a slice of the .xml file. Pass ONLY the X++ code — the tool emits the ` +
      `<Method>, <Source> and <![CDATA[ … ]]> wrapping itself.`
    );
  }
}

/** Strip X++ line/block/doc comments and string literals so their braces/parens
 *  don't skew structural scans. Returns a same-ish-length cleaned string. */
function stripXppCommentsAndStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const two = s.slice(i, i + 2);
    if (two === '//') {                       // line comment (incl. /// doc comments)
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (two === '/*') {                        // block comment
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (s[i] === '"') {                         // string literal
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
      i++;
      out += '""';
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/** Count top-level X++ method bodies: a `{` opened at brace-depth 0 immediately
 *  after a `)` (a method signature). Nested blocks (if/for/switch) are inside the
 *  body (depth > 0) and a class wrapper opens after an identifier, so neither is
 *  miscounted. */
export function countTopLevelMethodBodies(source: string): number {
  const cleaned = stripXppCommentsAndStrings(source);
  let depth = 0;
  let count = 0;
  let prevSignificant = '';
  for (const ch of cleaned) {
    if (ch === '{') {
      if (depth === 0 && prevSignificant === ')') count++;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
  }
  return count;
}

/** Split a source string containing one or more top-level X++ methods into the
 *  individual method sources (each including any leading doc comments / attributes
 *  and its full body). Mirrors countTopLevelMethodBodies' brace/comment/string
 *  handling. Used to let add-method accept several methods in one call and add them
 *  one <Method> at a time. */
export function splitTopLevelMethodBodies(source: string): string[] {
  const s = source;
  const methods: string[] = [];
  let depth = 0;
  let methodStart = -1;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // Start a method slice at the first significant char (incl. leading /// doc
    // comments and [Attribute] blocks) after the previous method closed.
    if (methodStart === -1 && !/\s/.test(ch)) methodStart = i;

    const two = s.slice(i, i + 2);
    if (two === '//') { const nl = s.indexOf('\n', i); i = nl === -1 ? s.length : nl; continue; }
    if (two === '/*') { const end = s.indexOf('*/', i + 2); i = end === -1 ? s.length : end + 2; continue; }
    if (ch === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } i++; continue; }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && methodStart !== -1) {
        methods.push(s.slice(methodStart, i + 1).trim());
        methodStart = -1;
      }
    }
    i++;
  }
  // Trailing brace-less content (e.g. an interface/abstract method declaration).
  if (methodStart !== -1) {
    const tail = s.slice(methodStart).trim();
    if (tail) methods.push(tail);
  }
  return methods.filter(Boolean);
}

/**
 * Reject an add-method payload that contains more than one method. Each add-method
 * call emits a single <Method>; passing two methods drops the second outside the
 * class scope and yields invalid X++ ("Unexpected token 'public' specified outside
 * the scope of any class or model element"). Splitting into separate calls is the fix.
 */
export function assertSingleMethodSource(source: string | undefined): void {
  if (!source) return;
  const count = countTopLevelMethodBodies(source);
  if (count > 1) {
    throw new Error(
      `⛔ add-method expects exactly ONE method, but ${count} method bodies were detected in the source.\n\n` +
      `Each add-method call adds a single <Method> element. Passing multiple methods puts all but ` +
      `the first OUTSIDE the class scope, producing invalid X++ ("Unexpected token 'public' specified ` +
      `outside the scope of any class or model element").\n\n` +
      `Add each method with its own add-method call — one method per call.`
    );
  }
}

/**
 * Derive the method name from a full X++ method source: the identifier immediately
 * before the first '(' of the signature, after stripping comments, strings and
 * attribute blocks (e.g. [ExtensionOf(...)]). Lets add-method callers omit methodName
 * when they already pass the complete source (e.g. "public static X find(...)").
 * Returns null when no signature can be found.
 */
export function extractMethodNameFromSource(source: string | undefined): string | null {
  if (!source) return null;
  const cleaned = stripXppCommentsAndStrings(source).replace(/\[[^\]]*\]/g, ' ');
  const m = cleaned.match(/\b([A-Za-z_]\w*)\s*\(/);
  return m ? m[1] : null;
}

/**
 * Why the bridge path did not apply, in the caller's own words.
 *
 * The direct-XML fallbacks used to announce "bridge was unavailable" unconditionally,
 * which is the true reason in only one of the four ways the bridge path can decline:
 * it can also be a type outside BRIDGE_MODIFY_TYPES, an SDK that cannot reach the
 * member (form control overrides), or a thrown error. Reporting the wrong cause sent
 * agents off to restart a bridge that was healthy — and hid genuine outages behind a
 * green result, since the write still succeeded (see the #4 sweep finding: two calls
 * "fell back" while a third seconds later went through Update just fine).
 */
export function describeBridgeFallbackReason(
  bridge: { isReady?: boolean; metadataAvailable?: boolean } | undefined,
  objectType: string,
  operation: string,
  bridgeResult: { success: boolean; message: string } | null,
): string {
  if (!bridge?.isReady || !bridge.metadataAvailable) {
    return 'the bridge was unavailable';
  }
  if (!canBridgeModify(objectType, operation)) {
    return `the bridge does not support ${operation} for objectType="${objectType}"`;
  }
  if (bridgeResult && !bridgeResult.success) {
    return `the bridge was reachable but declined: ${bridgeResult.message}`;
  }
  return 'the bridge was reachable but did not handle this call';
}

/**
 * Serializes a direct-XML editor on the file it edits.
 *
 * Each of these functions reads the whole file, patches the string and writes it
 * back. Two that overlap on one file both read the same original, so the second
 * write silently drops whatever element the first one added — and modify calls do
 * arrive concurrently, since `d365fo_file` is excluded from the in-flight call dedup
 * (writes must never be coalesced). The lock is per-path and in-process; see
 * utils/atomicFileWrite.ts for what it does and does not cover.
 */
function serializedOnFile<A extends unknown[], R>(
  fn: (filePath: string, ...args: A) => Promise<R>,
): (filePath: string, ...args: A) => Promise<R> {
  return (filePath, ...args) => withFileLock(filePath, () => fn(filePath, ...args));
}

/** File content, CRLF- and BOM-normalised, for matching caller-supplied X++ against. */
async function readForMatching(filePath: string): Promise<string | null> {
  try {
    return (await fs.readFile(filePath, 'utf-8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/** 1-based line numbers at which `needle` occurs in `content`. */
function occurrenceLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) return lines;
    lines.push(content.slice(0, at).split('\n').length);
    from = at + Math.max(needle.length, 1);
  }
}

/**
 * Refuse a replace-code that cannot mean what the caller intends.
 *
 * The bridge edits with .NET `String.Replace` (MetadataWriteService.ReplaceIn
 * Methods) — replace-ALL, no count, no echo. Two failure modes are decidable
 * from the file first: oldCode matching more than once, and an edit whose
 * newCode is already present and contains oldCode (oldCode="checkFailed",
 * newCode="this.checkFailed" over `this.checkFailed` yields
 * `this.this.checkFailed`).
 *
 * Returns null to proceed, `noop` when the file is already in the requested
 * state, `refuse` when the call is ambiguous.
 */
export interface ReplaceCodeVerdict {
  kind: 'noop' | 'refuse';
  message: string;
}

export function preflightReplaceCode(
  content: string,
  oldCode: string,
  newCode: string,
): ReplaceCodeVerdict | null {
  const normOld = oldCode.replace(/\r\n/g, '\n');
  const normNew = newCode.replace(/\r\n/g, '\n');
  if (normOld.length === 0) return null;

  const hits = occurrenceLines(content, normOld);

  if (hits.length === 0) {
    // Not an error here — the bridge may still reach source this file-level view
    // cannot (form control overrides). But if the intended result is already
    // present, say THAT instead of letting "oldCode not found" imply the opposite.
    if (normNew.length > 0 && content.includes(normNew)) {
      return {
        kind: 'noop',
        message:
          `Nothing to do — the file already contains newCode ` +
          `(line ${occurrenceLines(content, normNew)[0]}), and oldCode is not present. ` +
          `This edit has already been applied; do not retry it.`,
      };
    }
    return null;
  }

  if (normNew.includes(normOld) && content.includes(normNew)) {
    return {
      kind: 'noop',
      message:
        `Nothing to do — this edit is already applied, and repeating it would nest the text.\n` +
        `   oldCode  : ${JSON.stringify(normOld)}\n` +
        `   newCode  : ${JSON.stringify(normNew)}\n` +
        `newCode is already in the file at line ${occurrenceLines(content, normNew)[0]}, and oldCode is a ` +
        `substring of it — so the ${hits.length} "match(es)" found ARE the newCode occurrence(s). ` +
        `Applying it would produce ${JSON.stringify(normNew.replace(normOld, normNew))}.\n` +
        `If you meant a different edit, pass a full-line oldCode with enough surrounding text to be unambiguous.`,
    };
  }

  if (hits.length > 1) {
    return {
      kind: 'refuse',
      message:
        `⛔ replace-code refused — oldCode matches ${hits.length} times (lines ${hits.join(', ')}).\n` +
        `The bridge replaces EVERY occurrence, so this would edit all ${hits.length} of them. ` +
        `Extend oldCode with surrounding lines until it identifies exactly one site, or scope the call ` +
        `with methodName="<method>".`,
    };
  }

  return null;
}

/**
 * The lines a write changed, with context, so seeing the result costs no
 * read_file round trip.
 */
export function renderChangedLines(before: string, after: string, context = 3): string {
  if (before === after) return '';
  const b = before.split('\n');
  const a = after.split('\n');

  let head = 0;
  while (head < b.length && head < a.length && b[head] === a[head]) head++;
  let tail = 0;
  while (
    tail < b.length - head &&
    tail < a.length - head &&
    b[b.length - 1 - tail] === a[a.length - 1 - tail]
  ) tail++;

  const from = Math.max(0, head - context);
  const to = Math.min(a.length, a.length - tail + context);
  const shown = a.slice(from, to)
    .map((line, i) => {
      const no = from + i + 1;
      const changed = no > head && no <= a.length - tail;
      return `${changed ? '›' : ' '} ${String(no).padStart(4)} | ${line}`;
    })
    .join('\n');

  return `\n\n**Result on disk** (› = changed):\n\`\`\`\n${shown}\n\`\`\``;
}

/**
 * Direct XML file-level replace-code fallback, used when the C# bridge can't
 * reach a method (e.g. form/form-extension control overrides not exposed via
 * the Methods API). Last resort — the bridge is always preferred.
 *
 * `reason` comes from describeBridgeFallbackReason so the success message names the
 * cause that actually applied instead of asserting an outage that may not exist.
 */
const directXmlReplaceCode = serializedOnFile(async (
  filePath: string,
  oldCode: string,
  newCode: string,
  reason: string,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    // Files on disk are CRLF; oldCode from get_method_source is typically LF-only.
    // Normalize both to LF for matching, then normalizeD365Xml restores CRLF on write.
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const normOld = oldCode.replace(/\r\n/g, '\n');
    const normNew = newCode.replace(/\r\n/g, '\n');

    if (!content.includes(normOld)) {
      return null; // oldCode not found in file at all
    }

    // Without /g, String.replace() only replaces the first occurrence, so require
    // exactly one match to avoid silently picking the wrong one.
    const occurrences = content.split(normOld).length - 1;
    if (occurrences > 1) {
      return {
        success: false,
        message: `❌ directXmlReplaceCode: oldCode appears ${occurrences} times in ${filePath} — replacement is ambiguous. Provide a more specific oldCode snippet.`,
      };
    }

    const updated = content.replace(normOld, normNew);
    if (updated === content) {
      return null; // no change made
    }

    await writeFileAtomic(filePath, normalizeD365Xml(updated));

    // Read back before claiming it. The bridge declining is normal here (a class
    // DECLARATION is not a method, so its Methods API never finds the snippet),
    // but a message that led with that error and only then said ✅ read as a
    // failure — the caller re-did the same edit by hand with a plain text tool,
    // which is the AOT-XML bypass this server exists to remove. Confirming the
    // new code is on disk lets the message lead with the fact instead.
    const after = (await fs.readFile(filePath, 'utf-8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
    if (!after.includes(normNew)) {
      return {
        success: false,
        message: `❌ directXmlReplaceCode: wrote ${filePath} but newCode is not in the file afterwards — ` +
          `the write did not take effect. Re-read the file and retry; do not assume the change landed.`,
      };
    }

    console.error(`[modify_d365fo_file] ✅ directXmlReplaceCode fallback (${reason}): replaced in ${filePath}`);
    return {
      success: true,
      message: `✅ Code replaced and verified on disk — newCode is present in ${filePath}. ` +
        `No further edit is needed; do NOT re-apply it with a text editor.\n` +
        `   (Written by this server's XML writer rather than the bridge — ${reason})`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlReplaceCode failed: ${err}`);
    return null;
  }
});

/**
 * Direct XML fallback for modify-property, used when the bridge rejects
 * modify-property for an object type (e.g. AxForm) even though the property
 * is a plain text element (e.g. <Caption>) editable by string replacement.
 * Only used when the bridge itself reports failure.
 *
 * `propertyPath` is a bare element name (no XPath/dotted-path support).
 * Refuses to act if the element is missing (returns null so the caller
 * surfaces the original bridge error), ambiguous (appears more than once),
 * or is not a leaf — string replacement can only express a text value, and
 * writing one over an element that has children produces malformed XML.
 */
const directXmlModifyProperty = serializedOnFile(async (
  filePath: string,
  propertyPath: string,
  propertyValue: string,
  reason: string,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '');
    const escapedValue = String(propertyValue)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const tagName = propertyPath.split(/[./]/).pop()!;

    // tagName is interpolated into RegExp source below. Anything that is not a
    // plain XML element name has no meaning here anyway, and letting it through
    // either throws on an unbalanced metacharacter (caught, surfacing a
    // misleading "bridge error") or silently matches the wrong elements.
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(tagName)) {
      return {
        success: false,
        message:
          `❌ directXmlModifyProperty: '${propertyPath}' does not name a plain XML element ` +
          `(resolved to "${tagName}") — nothing was written.`,
      };
    }
    const tagRe = tagName.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

    // Forms first: the bridge refuses modify-property for AxForm entirely, and the
    // generic path below cannot serve Design properties either — Caption/Style also
    // occur on controls, so it sees several matches and refuses (#37).
    const formPatched = upsertAxFormDesignProperty(content, tagName, escapedValue);
    if (formPatched) {
      await writeFileAtomic(filePath, normalizeD365Xml(formPatched));
      return {
        success: true,
        message: `✅ Form Design property '${tagName}'='${propertyValue}' set via direct XML (the bridge does not support modify-property for forms). File: ${filePath}`,
      };
    }

    const openTagRe = new RegExp(`<${tagRe}\\b[^>]*>[\\s\\S]*?</${tagRe}>`, 'g');
    const selfClosingRe = new RegExp(`<${tagRe}\\b([^>]*)/>`, 'g');
    const openTagOnlyRe = new RegExp(`^<${tagRe}\\b[^>]*>`);

    const openMatches = content.match(openTagRe) ?? [];
    const selfClosingMatches = content.match(selfClosingRe) ?? [];
    const totalMatches = openMatches.length + selfClosingMatches.length;

    if (totalMatches === 0) {
      // The element does not exist yet. For an AxTable we know the canonical
      // element order, so it can be INSERTED in the right place instead of failing.
      // This is what makes properties the C# bridge refuses outright reachable at
      // all — notably FormRef, whose absence is the very BPErrorTableMissingFormRef
      // the agent is trying to fix (docs/eval-sweep-findings-2026-07-21.md #37).
      // Order matters: a property written in the wrong position is dropped without
      // a word (#13), which is why this goes through upsertAxTableProperty.
      const nonExistent = AX_TABLE_NON_EXISTENT_PROPERTIES[tagName];
      if (nonExistent && /<AxTable[\s>]/.test(content)) {
        return {
          success: false,
          message: `❌ '${tagName}' is not an AxTable property — nothing was written. ${nonExistent}`,
        };
      }
      const inserted = upsertAxTableProperty(content, tagName, escapedValue);
      if (!inserted) {
        return null; // not a table / unknown property — surface the original bridge error
      }
      await writeFileAtomic(filePath, normalizeD365Xml(inserted));
      console.error(`[modify_d365fo_file] ✅ directXmlModifyProperty fallback: inserted <${tagName}> in ${filePath}`);
      return {
        success: true,
        message:
          `✅ Property '${propertyPath}'='${propertyValue}' added via direct XML fallback ` +
          `(the element did not exist; inserted in canonical AxTable element order). File: ${filePath}`,
      };
    }
    if (totalMatches > 1) {
      return {
        success: false,
        message: `❌ directXmlModifyProperty: <${tagName}> appears ${totalMatches} times in ${filePath} — ambiguous, refusing to guess which one.`,
      };
    }

    // Leaf guard. The replacement below can only express a text value, so an
    // element that has children must be refused: the old `>[\s\S]*?<` rewrite
    // stopped at the FIRST child tag and produced `<Tag>NewValue<Child>…`,
    // i.e. structurally broken XML written to disk and reported as success.
    // Counting matches (above) does not catch this — one match can still be a
    // container.
    if (openMatches.length === 1) {
      const inner = openMatches[0]
        .replace(openTagOnlyRe, '')
        .replace(new RegExp(`</${tagRe}>$`), '');
      if (inner.includes('<')) {
        return {
          success: false,
          message:
            `❌ directXmlModifyProperty: <${tagName}> in ${filePath} contains child elements — ` +
            `it holds structure, not a text value. Refusing to overwrite it (nothing was written).`,
        };
      }
    }

    // Function replacers throughout: `escapedValue` escapes XML metacharacters
    // but not `$`, which a string replacement would read as a capture reference.
    const updated = openMatches.length === 1
      ? content.replace(openTagRe, m => `${openTagOnlyRe.exec(m)![0]}${escapedValue}</${tagName}>`)
      : content.replace(selfClosingRe, (_m, attrs) => `<${tagName}${attrs}>${escapedValue}</${tagName}>`);

    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(`[modify_d365fo_file] ✅ directXmlModifyProperty fallback: set <${tagName}> in ${filePath}`);
    return {
      success: true,
      message: `✅ Property '${propertyPath}' set via direct XML fallback (${reason}). File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlModifyProperty failed: ${err}`);
    return null;
  }
});

/**
 * Direct XML fallback for add-menu-item-to-menu.
 * The C# bridge can only modify menus it has loaded from its startup roots;
 * newly created menus trigger a NullRef because they aren't in the bridge's
 * in-memory model yet (even after update_symbol_index). This function edits
 * the XML file directly as a last-resort fallback.
 */
const directXmlAddMenuItemToMenu = serializedOnFile(async (
  filePath: string,
  menuItemToAdd: string,
  menuItemToAddType: string,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    const typeMap: Record<string, string> = { display: 'Display', action: 'Action', output: 'Output' };
    const menuItemType = typeMap[menuItemToAddType?.toLowerCase()] ?? 'Display';

    // An AxMenu's <Elements> holds AxMenuElement entries discriminated by i:type —
    // `AxMenuElementMenuItem` for a menu-item reference. `AxMenuFunctionItem` is not
    // a type in the metadata model at all (zero of the 73 shipped AxMenu files use
    // it), so the element deserializes into nothing and the menu comes out empty:
    // docs/eval-sweep-findings-2026-07-21.md #30. `MenuItemType` is omitted for
    // MenuItemType stays explicit (Display is the model default and the shipped
    // files omit it, but writing it costs nothing and keeps display/action/output
    // unambiguous).
    const newElement =
      `\t\t<AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">\n` +
      `\t\t\t<Name>${menuItemToAdd}</Name>\n` +
      `\t\t\t<MenuItemName>${menuItemToAdd}</MenuItemName>\n` +
      `\t\t\t<MenuItemType>${menuItemType}</MenuItemType>\n` +
      `\t\t</AxMenuElement>`;

    let updated: string;
    if (content.includes('<Elements />')) {
      updated = content.replace('<Elements />', `<Elements>\n${newElement}\n\t</Elements>`);
    } else if (content.includes('</Elements>')) {
      updated = content.replace('</Elements>', `${newElement}\n\t</Elements>`);
    } else {
      return null;
    }

    if (updated === content) return null;

    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(`[modify_d365fo_file] ✅ directXmlAddMenuItemToMenu: added '${menuItemToAdd}' to ${filePath}`);
    return {
      success: true,
      message: `✅ Menu item '${menuItemToAdd}' (${menuItemType}) added via direct XML fallback. File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlAddMenuItemToMenu failed: ${err}`);
    return null;
  }
});

/**
 * controlType (as passed to add-control) → the form control element emitted inside
 * a form-extension's <FormControl>, together with its <Type> value. Verified against
 * shipped standard form extensions (e.g. InventItemSampling.AdvancedQualityManagement).
 * NOTE: an integer control is `AxFormIntegerControl` (Type=Integer) — NOT
 * `AxFormIntControl`. Unknown types fall back to String, which is always valid.
 */
const CONTROL_TYPE_TO_FORM_CONTROL: Record<string, { iType: string; typeValue: string }> = {
  string:      { iType: 'AxFormStringControl',   typeValue: 'String' },
  integer:     { iType: 'AxFormIntegerControl',  typeValue: 'Integer' },
  int:         { iType: 'AxFormIntegerControl',  typeValue: 'Integer' },
  int64:       { iType: 'AxFormInt64Control',    typeValue: 'Int64' },
  real:        { iType: 'AxFormRealControl',     typeValue: 'Real' },
  date:        { iType: 'AxFormDateControl',     typeValue: 'Date' },
  datetime:    { iType: 'AxFormDateTimeControl', typeValue: 'DateTime' },
  utcdatetime: { iType: 'AxFormDateTimeControl', typeValue: 'DateTime' },
  time:        { iType: 'AxFormTimeControl',     typeValue: 'Time' },
  guid:        { iType: 'AxFormGuidControl',     typeValue: 'Guid' },
  checkbox:    { iType: 'AxFormCheckBoxControl', typeValue: 'CheckBox' },
  combobox:    { iType: 'AxFormComboBoxControl', typeValue: 'ComboBox' },
  // An enum binds to a ComboBox. Spelled out because "Enum" is what the EDT
  // resolver and the op-spec both call it, and an unmapped type silently
  // becomes a String control over enum data.
  enum:        { iType: 'AxFormComboBoxControl', typeValue: 'ComboBox' },
  button:      { iType: 'AxFormButtonControl',   typeValue: 'Button' },
  group:       { iType: 'AxFormGroupControl',    typeValue: 'Group' },
};
const DEFAULT_FORM_CONTROL = { iType: 'AxFormStringControl', typeValue: 'String' };

/**
 * Mark a write result as having come from this server's XML writer rather than
 * the bridge, so the success banner can name the path that actually did the work.
 *
 * The headline used to read "applied via IMetadataProvider.Update()"
 * unconditionally, while the line below it said "via direct XML fallback" — the
 * reply named an API that never ran. That matters beyond tidiness: a reader who
 * believes the metadata API performed the write also believes the write was
 * validated by it, which is exactly the assumption that let a silently-discarded
 * control read as a success.
 */
function viaXmlFallback<T extends { success: boolean; message: string } | null>(result: T): T {
  return (result ? { ...result, viaXmlFallback: true } : result) as T;
}

/** Random 9-char lowercase-alphanumeric suffix, matching the SDK's
 *  `FormExtensionControl<rand>` wrapper-name convention (e.g. "fh5riowy1"). */
function formExtensionControlName(): string {
  let s = '';
  while (s.length < 9) s += Math.random().toString(36).slice(2);
  return `FormExtensionControl${s.slice(0, 9)}`;
}

/**
 * Direct XML fallback for add-control on a form-extension.
 *
 * The C# bridge's AddControl resolves its target via _provider.Forms.Read(name),
 * which can NEVER find a form EXTENSION (named "BaseForm.Suffix") — it always
 * reports 'Form "<ext>" not found'. add-control on a form-extension therefore has
 * no working bridge path at all (independent of metadata-root freshness). This
 * edits the file on disk, so it is unaffected by what the bridge has loaded.
 *
 * The shape and the insertion point both come from where `parentControl` lives:
 * an <AxFormExtensionControl> envelope in the extension's ROOT <Controls> for a
 * base-form parent, a bare <AxFormControl> in the parent's NESTED <Controls>
 * when the extension defines that parent itself. See formExtensionControlXml.ts
 * — the placement logic lives there, pure and unit-tested, because getting it
 * wrong writes structurally invalid metadata under a ✅.
 */
const directXmlAddControl = serializedOnFile(async (
  filePath: string,
  controlName: string,
  parentControl: string,
  controlType: string,
  dataSource?: string,
  dataField?: string,
  label?: string,
  previousSibling?: string,
  positionType?: string,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    const { iType, typeValue } = CONTROL_TYPE_TO_FORM_CONTROL[(controlType || 'String').toLowerCase()] ?? DEFAULT_FORM_CONTROL;

    const outcome = insertFormExtensionControl(content, {
      controlName, parentControl, iType, typeValue,
      dataSource, dataField, label,
      wrapperName: formExtensionControlName(),
      previousSibling, positionType,
    });

    switch (outcome.kind) {
      case 'unsupported':
        return null; // not a form-extension shape we recognise — caller falls through
      case 'exists':
        return {
          success: true,
          message: `✅ Control '${controlName}' already present in ${filePath} — skipped (idempotent).`,
        };
      case 'refused':
        return { success: false, message: outcome.message };
    }

    await writeFileAtomic(filePath, normalizeD365Xml(outcome.xml));
    console.error(`[modify_d365fo_file] ✅ directXmlAddControl: added '${controlName}' (${iType}) to ${filePath}`);

    const shape = outcome.representation === 'nested'
      ? `nested <AxFormControl> under extension-owned parent`
      : `<AxFormExtensionControl> in the extension's root <Controls>`;
    const notes = outcome.notes.length
      ? '\n' + outcome.notes.map(n => `⚠️ ${n}`).join('\n')
      : '';
    return {
      success: true,
      message:
        `✅ Control '${controlName}' (${iType}) added to '${parentControl}' via direct XML fallback ` +
        `as a ${shape}. File: ${filePath}${notes}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlAddControl failed: ${err}`);
    return null;
  }
});

/**
 * Normalises a NoYes-shaped flag to a boolean.
 *
 * The wire type is boolean, but the value these params end up as in AxTable XML
 * is `No`/`Yes`, so callers legitimately pass the string spelling (corpus #27:
 * indexAllowDuplicates="No" was rejected with a bare "expected boolean").
 * Anything unrecognised returns undefined so the op's own default applies.
 */
export function coerceNoYesFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'yes' || v === 'true' || v === '1') return true;
    if (v === 'no' || v === 'false' || v === '0') return false;
  }
  return undefined;
}

/**
 * Direct XML fallback for add-index on a TABLE.
 *
 * The C# bridge's AddIndex resolves its target via _provider.Tables.Read(name),
 * whose DiskProvider metadata roots are fixed at bridge startup. A table CREATED
 * THIS SESSION is therefore reported "Table '<name>' not found" — even after
 * update_symbol_index and even when an explicit filePath was supplied (filePath
 * only steers the TS-side file lookup, never the bridge's own name resolution).
 * Corpus evidence: 2026-07-21T19__L2-error-handling-infolog (add-index on
 * ConDemoTicket failed 3×) and 2026-07-21T20__L3-workflow-document-submit.
 * With no working grounded path the only way to land the index was
 * d365fo_file(action="create", overwrite=true) — the whole-file escape hatch the
 * eval loop forbids.
 *
 * This writes an <AxTableIndex> element straight into the table's <Indexes>
 * collection, in the shape the D365FO SDK serialises: <Name>, <AllowDuplicates>,
 * optional <AlternateKey>, then <Fields> of <AxTableIndexField><DataField>.
 * <Indexes> is a collection sibling, NOT part of the order-sensitive top-level
 * property block, so appending to it is safe. Unlike the bridge it edits the file
 * on disk, so it is unaffected by what the provider loaded at startup — and it
 * carries allowDuplicates/alternateKey, which the whole-file overwrite workaround
 * dropped (cluster #35).
 */
const directXmlAddIndex = serializedOnFile(async (
  filePath: string,
  indexName: string,
  fields: string[] | undefined,
  allowDuplicates: boolean | undefined,
  alternateKey: boolean | undefined,
): Promise<{ success: boolean; message: string } | null> => {
  // The bridge refuses an index with no fields (it writes <Fields /> — an index that
  // compiles, warns about nothing and indexes nothing). This fallback runs precisely
  // when the bridge call failed, so without the same gate it would catch the refusal
  // and land the empty index anyway, under a ✅.
  const namedFields = (fields ?? []).filter(f => typeof f === 'string' && f.trim() !== '');
  if (namedFields.length === 0) {
    return {
      success: false,
      message:
        `Index '${indexName}' has no fields — pass indexFields as [{ fieldName: "<field>" }]. ` +
        `An index with an empty <Fields /> collection compiles clean and indexes nothing.`,
    };
  }

  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    // Only tables and table-extensions carry an <Indexes> collection — bail on any
    // other shape so a mis-typed objectType never corrupts an unrelated file.
    //
    // AxTableExtension is included deliberately: the bridge gained a table-extension
    // path for AddIndex (#799), but its provider still resolves against metadata roots
    // fixed at startup, so an extension CREATED THIS SESSION is unresolvable there —
    // the very hole this fallback exists to close. The extension's <Indexes> collection
    // holds the same <AxTableIndex> element as a table's, so the patch below is
    // shape-identical. Note `\b` does NOT match `<AxTableExtension` (E is a word char),
    // which is why the extension needs its own alternative rather than a looser pattern.
    if (!/<AxTable\b/.test(content) && !/<AxTableExtension\b/.test(content)) return null;

    // Idempotent: if an index with this name already exists, report success
    // rather than writing a duplicate (mirrors directXmlAddControl).
    if (new RegExp(`<AxTableIndex>\\s*<Name>${indexName}</Name>`).test(content)) {
      return {
        success: true,
        message: `✅ Index '${indexName}' already present in ${filePath} — skipped (idempotent).`,
      };
    }

    const fieldElements = namedFields
      .map(f =>
        `\t\t\t\t<AxTableIndexField>\n` +
        `\t\t\t\t\t<DataField>${f}</DataField>\n` +
        `\t\t\t\t</AxTableIndexField>`)
      .join('\n');

    const newElement =
      `\t\t<AxTableIndex>\n` +
      `\t\t\t<Name>${indexName}</Name>\n` +
      `\t\t\t<AllowDuplicates>${allowDuplicates ? 'Yes' : 'No'}</AllowDuplicates>\n` +
      (alternateKey ? `\t\t\t<AlternateKey>Yes</AlternateKey>\n` : '') +
      `\t\t\t<Fields>\n${fieldElements}\n\t\t\t</Fields>\n` +
      `\t\t</AxTableIndex>`;

    let updated: string;
    if (content.includes('<Indexes />')) {
      updated = content.replace('<Indexes />', `<Indexes>\n${newElement}\n\t</Indexes>`);
    } else if (content.includes('</Indexes>')) {
      updated = content.replace('</Indexes>', `${newElement}\n\t</Indexes>`);
    } else {
      // No <Indexes> collection at all — not a shape we can safely patch.
      return null;
    }

    if (updated === content) return null;

    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(`[modify_d365fo_file] ✅ directXmlAddIndex: added '${indexName}' to ${filePath}`);
    return {
      success: true,
      message: `✅ Index '${indexName}' added via direct XML fallback (bridge could not resolve the same-session table). File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlAddIndex failed: ${err}`);
    return null;
  }
});

/**
 * The two element names a data source can carry inside a query's <DataSources>:
 * the root of the query, and a joined child. A child is NOT a nested
 * <AxQuerySimpleRootDataSource> — that element never nests — so both names have
 * to be scanned, or every joined data source is unreachable.
 */
const QUERY_DATASOURCE_TAGS: readonly string[] = [
  'AxQuerySimpleRootDataSource',
  'AxQuerySimpleEmbeddedDataSource',
];

/** One data source inside <ViewMetadata>: its own block bounds, element and <Name>. */
interface QueryDataSourceBlock {
  start: number;
  end: number;
  tag: string;
  name: string;
}

/** A direct child element located inside a parent block, with its content bounds. */
type DirectChild =
  | { selfClosing: true; start: number; end: number }
  | { selfClosing: false; start: number; end: number; innerStart: number; innerEnd: number };

/** The tag grammar every scan below shares. Cloned per use — /g carries lastIndex. */
const XML_TAG_SOURCE = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/.source;

/**
 * Blanks CDATA sections and comments while preserving every offset, so a tag scan
 * cannot be derailed by markup-looking text inside them: a <ViewMetadata> always
 * carries a <SourceCode> CDATA block ahead of its <DataSources>. Offsets from a
 * masked scan index the original string unchanged.
 */
function maskXmlNonMarkup(content: string): string {
  return content.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, m => ' '.repeat(m.length));
}

/**
 * Offsets of the FIRST DIRECT child element named `childName` inside `block`,
 * where `block` starts with its parent's opening tag and ends with the matching
 * close.
 *
 * Depth-counted, so a same-named element inside a NESTED child never matches.
 * <Ranges> needs this more than any other collection: a joined data source has a
 * <Ranges> of its own and it comes FIRST in document order, so
 * `block.replace('<Ranges />', …)` writes the range onto the joined table instead
 * of the one that was asked for — valid XML, different query.
 */
function findDirectChild(block: string, childName: string): DirectChild | null {
  const openTag = new RegExp(`^<[A-Za-z_][\\w.-]*(?:"[^"]*"|'[^']*'|[^>"'])*?>`).exec(block);
  if (!openTag) return null;

  const tagRe = new RegExp(XML_TAG_SOURCE, 'g');
  tagRe.lastIndex = openTag[0].length;
  let depth = 0;
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(block)) !== null) {
    const [full, closing, name, , selfClosing] = m;
    if (selfClosing) {
      if (depth === 0 && name === childName) {
        return { selfClosing: true, start: m.index, end: m.index + full.length };
      }
      continue;
    }
    if (closing) {
      if (depth === 0) return null;   // the parent's own closing tag — child absent
      depth--;
      continue;
    }
    if (depth === 0 && name === childName) {
      const innerStart = m.index + full.length;
      let inner = 1;
      const innerRe = new RegExp(XML_TAG_SOURCE, 'g');
      innerRe.lastIndex = innerStart;
      let im: RegExpExecArray | null;
      while ((im = innerRe.exec(block)) !== null) {
        if (im[4]) continue;          // self-closing: no depth change
        if (im[1]) {
          inner--;
          if (inner === 0) {
            return { selfClosing: false, start: m.index, end: im.index + im[0].length, innerStart, innerEnd: im.index };
          }
        } else {
          inner++;
        }
      }
      return null;
    }
    depth++;
  }
  return null;
}

/**
 * Every data source in `maskedContent`, root and joined alike, with the block
 * bounds and the <Name> each one carries.
 */
function findQueryDataSourceBlocks(content: string, maskedContent: string): QueryDataSourceBlock[] {
  const tagRe = new RegExp(XML_TAG_SOURCE, 'g');
  const open: Array<{ tag: string; start: number }> = [];
  const found: QueryDataSourceBlock[] = [];
  let m: RegExpExecArray | null;

  while ((m = tagRe.exec(maskedContent)) !== null) {
    const [full, closing, tag, , selfClosing] = m;
    if (selfClosing || !QUERY_DATASOURCE_TAGS.includes(tag)) continue;
    if (!closing) {
      open.push({ tag, start: m.index });
      continue;
    }
    const started = open.pop();
    // Unbalanced markup — stop rather than pair the wrong tags up.
    if (!started || started.tag !== tag) return found;
    const end = m.index + full.length;
    const block = maskedContent.slice(started.start, end);
    const nameChild = findDirectChild(block, 'Name');
    found.push({
      start: started.start,
      end,
      tag: started.tag,
      name: nameChild && !nameChild.selfClosing
        ? content.slice(started.start + nameChild.innerStart, started.start + nameChild.innerEnd)
        : '',
    });
  }
  return found;
}

/** The leading tabs/spaces of the line `offset` sits on ('' when it is not indented). */
function lineIndentAt(content: string, offset: number): string {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const lead = content.slice(lineStart, offset);
  return /^[\t ]*$/.test(lead) ? lead : '';
}

/** Resolution of `dataSourceName` to exactly one data source and its OWN <Ranges>. */
type QueryRangesTarget =
  | { ok: true; ds: QueryDataSourceBlock; ranges: DirectChild; indent: string }
  | { ok: false; reason: 'not-found'; known: string[] }
  | { ok: false; reason: 'ambiguous' }
  | { ok: false; reason: 'no-ranges' };

/**
 * Resolves the named data source and locates the <Ranges> collection that data
 * source OWNS — never a joined child's, and never a parent's.
 *
 * Refuses to guess when two data sources share the name, per the rule every XML
 * writer here follows: an ambiguous target is an error, not a coin flip.
 */
function resolveQueryRanges(
  content: string,
  maskedContent: string,
  dataSourceName: string,
): QueryRangesTarget {
  const blocks = findQueryDataSourceBlocks(content, maskedContent);
  const matches = blocks.filter(b => b.name === dataSourceName);
  if (matches.length === 0) {
    return { ok: false, reason: 'not-found', known: blocks.map(b => b.name).filter(Boolean) };
  }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };

  const ds = matches[0];
  const ranges = findDirectChild(maskedContent.slice(ds.start, ds.end), 'Ranges');
  if (!ranges) return { ok: false, reason: 'no-ranges' };

  return { ok: true, ds, ranges, indent: lineIndentAt(content, ds.start + ranges.start) };
}

/** Every <AxQuerySimpleDataSourceRange> element inside a <Ranges> body, with its own <Name>. */
function queryRangeElements(rangesInner: string): Array<{ start: number; end: number; name: string }> {
  const re = /[\t ]*<AxQuerySimpleDataSourceRange>[\s\S]*?<\/AxQuerySimpleDataSourceRange>\n?/g;
  const out: Array<{ start: number; end: number; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rangesInner)) !== null) {
    // <Name> is FIRST in every one of the 1192 ranges Microsoft ships, but the
    // deserializer does not care about order, so neither does this.
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(m[0]);
    out.push({ start: m.index, end: m.index + m[0].length, name: name ? name[1] : '' });
  }
  return out;
}

/** AOT names are identifiers — 9275 shipped query data sources and every range agree. */
function nonIdentifierName(value: string): boolean {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** Renders the resolution failure the same way for both query-range writers. */
function queryRangeTargetError(
  op: string,
  target: Exclude<QueryRangesTarget, { ok: true }>,
  dataSourceName: string,
  filePath: string,
): { success: false; message: string } {
  if (target.reason === 'ambiguous') {
    return {
      success: false,
      message:
        `❌ ${op}: '${dataSourceName}' names more than one data source in the ViewMetadata of '${filePath}' — ` +
        `refusing to guess which one to write. Rename one of them, or edit this entity in Visual Studio.`,
    };
  }
  if (target.reason === 'no-ranges') {
    return {
      success: false,
      message:
        `❌ ${op}: data source '${dataSourceName}' in '${filePath}' has no <Ranges> collection of its own. ` +
        `The ViewMetadata structure may not follow the expected layout.`,
    };
  }
  const known = target.known.length > 0 ? target.known.join(', ') : '(none)';
  return {
    success: false,
    message:
      `❌ ${op}: data source '${dataSourceName}' not found in ViewMetadata of '${filePath}'. ` +
      `Data sources in this entity: ${known}. ` +
      `Pass the <Name> of the root data source (usually the primary table) or of a joined data source.`,
  };
}

/**
 * Direct XML writer for add-query-range on an AxDataEntityView.
 *
 * Inserts an <AxQuerySimpleDataSourceRange> into the <Ranges> the named data
 * source OWNS, inside <ViewMetadata>. There is no bridge API for this operation —
 * the C# bridge does not expose AddQueryRange on entities — so this direct writer
 * is the only path.
 *
 * Idempotent: a RANGE (not merely some element) with the same Name already in that
 * collection is left unchanged and success is returned.
 */
const directXmlAddQueryRange = serializedOnFile(async (
  filePath: string,
  dataSourceName: string,
  rangeField: string,
  rangeName: string,
  rangeValue: string,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    if (!/<AxDataEntityView\b/.test(content)) {
      return {
        success: false,
        message:
          `❌ add-query-range: '${filePath}' is not an AxDataEntityView — nothing was written. ` +
          `Use objectType="data-entity".`,
      };
    }

    const badName = [
      ['dataSourceName', dataSourceName], ['rangeField', rangeField], ['rangeName', rangeName],
    ].find(([, v]) => nonIdentifierName(v));
    if (badName) {
      return {
        success: false,
        message:
          `❌ add-query-range: ${badName[0]} '${badName[1]}' is not a valid AOT name — ` +
          `letters, digits and underscore only, not starting with a digit.`,
      };
    }

    // A range with no value filters nothing, and NONE of the 1192 ranges Microsoft
    // ships omits <Value> — so an omitted value is a mistake worth naming, not a
    // shape to invent. The empty-string filter is the two-character value "".
    if (rangeValue === '') {
      return {
        success: false,
        message:
          `❌ add-query-range: rangeValue is required — a range with no value filters nothing. ` +
          `Pass the value to filter on (e.g. "1" for a NoYes field, "Sales" for an enum), ` +
          `or the two characters "" for the empty-string filter, which is how D365FO stores it.`,
      };
    }

    const masked = maskXmlNonMarkup(content);
    const target = resolveQueryRanges(content, masked, dataSourceName);
    if (!target.ok) return queryRangeTargetError('add-query-range', target, dataSourceName, filePath);

    const { ds, ranges, indent } = target;
    const rangesInner = ranges.selfClosing
      ? ''
      : content.slice(ds.start + ranges.innerStart, ds.start + ranges.innerEnd);

    // Idempotent — scoped to THIS collection and anchored on the range element, so
    // a mapped field, a relation or the data source's own <Name> never reads as a
    // range that is already there (which silently skipped the write it was meant
    // to guard).
    if (queryRangeElements(rangesInner).some(r => r.name === rangeName)) {
      return {
        success: true,
        message:
          `✅ Range '${rangeName}' already present in datasource '${dataSourceName}' — skipped (idempotent).`,
      };
    }

    // Canonical shape and order — <Name>, <Field>, <Value> — indented off the
    // <Ranges> that was actually found, so a joined data source nests correctly.
    const rangeElement =
      `${indent}\t<AxQuerySimpleDataSourceRange>\n` +
      `${indent}\t\t<Name>${escapeXml(rangeName)}</Name>\n` +
      `${indent}\t\t<Field>${escapeXml(rangeField)}</Field>\n` +
      `${indent}\t\t<Value>${escapeXml(rangeValue)}</Value>\n` +
      `${indent}\t</AxQuerySimpleDataSourceRange>`;

    // Existing entries stay verbatim; only the newline + indent that sat in front
    // of </Ranges> is rebuilt around the new element.
    const existing = rangesInner.replace(/\s*$/, '');
    const newRanges = `<Ranges>${existing}\n${rangeElement}\n${indent}</Ranges>`;

    const updated =
      content.slice(0, ds.start + ranges.start) + newRanges + content.slice(ds.start + ranges.end);
    if (updated === content) return null;

    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(
      `[modify_d365fo_file] ✅ directXmlAddQueryRange: added range '${rangeName}' ` +
      `(${rangeField}=${rangeValue}) to '${dataSourceName}' in ${filePath}`,
    );
    return {
      success: true,
      message:
        `✅ Query range '${rangeName}' (${rangeField} = '${rangeValue}') added to datasource '${dataSourceName}'. ` +
        `File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlAddQueryRange failed: ${err}`);
    return null;
  }
});

/**
 * Direct XML writer for remove-query-range on an AxDataEntityView.
 *
 * Removes the <AxQuerySimpleDataSourceRange> whose <Name> equals `rangeName` from
 * the <Ranges> the named data source OWNS — a same-named range on a joined data
 * source is left alone. Collapses <Ranges>…</Ranges> to <Ranges /> when the
 * collection becomes empty. Idempotent: not-found is reported as success.
 */
const directXmlRemoveQueryRange = serializedOnFile(async (
  filePath: string,
  dataSourceName: string,
  rangeName: string,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    if (!/<AxDataEntityView\b/.test(content)) {
      return {
        success: false,
        message:
          `❌ remove-query-range: '${filePath}' is not an AxDataEntityView — nothing was written. ` +
          `Use objectType="data-entity".`,
      };
    }

    const badName = [['dataSourceName', dataSourceName], ['rangeName', rangeName]]
      .find(([, v]) => nonIdentifierName(v));
    if (badName) {
      return {
        success: false,
        message:
          `❌ remove-query-range: ${badName[0]} '${badName[1]}' is not a valid AOT name — ` +
          `letters, digits and underscore only, not starting with a digit.`,
      };
    }

    const masked = maskXmlNonMarkup(content);
    const target = resolveQueryRanges(content, masked, dataSourceName);
    if (!target.ok) return queryRangeTargetError('remove-query-range', target, dataSourceName, filePath);

    const { ds, ranges } = target;
    if (ranges.selfClosing) {
      return {
        success: true,
        message:
          `✅ Range '${rangeName}' not present in datasource '${dataSourceName}' — nothing to remove.`,
      };
    }

    const rangesInner = content.slice(ds.start + ranges.innerStart, ds.start + ranges.innerEnd);
    const elements = queryRangeElements(rangesInner);
    const doomed = elements.find(r => r.name === rangeName);
    if (!doomed) {
      return {
        success: true,
        message:
          `✅ Range '${rangeName}' not present in datasource '${dataSourceName}' — nothing to remove.`,
      };
    }

    const remainingInner = rangesInner.slice(0, doomed.start) + rangesInner.slice(doomed.end);
    const newRanges = elements.length === 1
      ? '<Ranges />'
      : `<Ranges>${remainingInner}</Ranges>`;

    const updated =
      content.slice(0, ds.start + ranges.start) + newRanges + content.slice(ds.start + ranges.end);
    if (updated === content) return null;

    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(
      `[modify_d365fo_file] ✅ directXmlRemoveQueryRange: removed range '${rangeName}' ` +
      `from '${dataSourceName}' in ${filePath}`,
    );
    return {
      success: true,
      message:
        `✅ Query range '${rangeName}' removed from datasource '${dataSourceName}'. File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlRemoveQueryRange failed: ${err}`);
    return null;
  }
});

/**
 * Locates ONE top-level collection element inside a root element's body, e.g.
 * `<Fields>` directly under `<AxDataEntityViewExtension>`.
 *
 * A plain `content.replace('</Fields>', …)` is wrong here and silently so: an
 * AxDataEntityViewExtension carries `<FieldGroupExtensions>` BEFORE `<Fields>`, and
 * each `<AxTableFieldGroupExtension>` inside it has a nested `<Fields>` of its own.
 * The first `</Fields>` in the file therefore closes the field GROUP, and the new
 * element lands in a collection the deserializer will not read it from.
 *
 * Depth-counts from the root's opening tag so only a DIRECT child matches.
 * Returns the insertion offset (just before the collection's closing tag), or a
 * `selfClosingAt` range when the collection is `<Fields />` and must be expanded.
 */
export function findTopLevelCollection(
  content: string,
  rootElement: string,
  collection: string,
): { insertAt: number } | { selfClosingAt: [number, number] } | null {
  const rootOpen = new RegExp(`<${rootElement}\\b[^>]*>`).exec(content);
  if (!rootOpen) return null;

  const pos = rootOpen.index + rootOpen[0].length;
  let depth = 0;
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  tagRe.lastIndex = pos;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(content)) !== null) {
    const [full, closing, name, , selfClosing] = m;
    if (closing) {
      if (name === rootElement && depth === 0) return null;
      depth--;
      continue;
    }
    if (selfClosing) {
      if (depth === 0 && name === collection) {
        return { selfClosingAt: [m.index, m.index + full.length] };
      }
      continue;
    }
    if (depth === 0 && name === collection) {
      // Walk to this element's matching close tag at the same depth.
      let inner = 1;
      const innerRe = new RegExp(tagRe.source, 'g');
      innerRe.lastIndex = m.index + full.length;
      let im: RegExpExecArray | null;
      while ((im = innerRe.exec(content)) !== null) {
        if (im[4]) continue;            // self-closing: no depth change
        if (im[1]) {
          inner--;
          if (inner === 0) return { insertAt: im.index };
        } else {
          inner++;
        }
      }
      return null;
    }
    depth++;
  }
  return null;
}

/**
 * Appends `fieldName` to a base-entity field group inside <FieldGroupExtensions>,
 * creating the <AxTableFieldGroupExtension> entry when the group is not there yet.
 *
 * <FieldGroups> (groups the extension OWNS) and <FieldGroupExtensions> (appending to a
 * group the BASE entity owns) are not interchangeable — picking the wrong one is silent,
 * the field lands in the file and never surfaces. This only ever touches the latter.
 */
function upsertDataEntityFieldGroupExtension(
  content: string,
  groupName: string,
  fieldName: string,
): string | null {
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${fieldName}</DataField>\n\t\t\t\t</AxTableFieldGroupField>`;

  // Scope every probe to THIS group's own block. Searching the whole file for
  // <DataField>{fieldName}</DataField> also finds the mapped field just written into
  // <Fields> — the group would then look "already registered" and silently stay empty.
  const blockRe = new RegExp(
    `<AxTableFieldGroupExtension>\\s*<Name>${escapeRe(groupName)}</Name>[\\s\\S]*?</AxTableFieldGroupExtension>`,
  );
  const block = blockRe.exec(content);
  if (block) {
    if (new RegExp(`<DataField>${escapeRe(fieldName)}</DataField>`).test(block[0])) {
      return content; // already registered in this group
    }
    const updatedBlock = block[0].includes('<Fields />')
      ? block[0].replace('<Fields />', `<Fields>\n${entry}\n\t\t\t</Fields>`)
      : block[0].replace('</Fields>', `${entry}\n\t\t\t</Fields>`);
    return content.slice(0, block.index) + updatedBlock + content.slice(block.index + block[0].length);
  }

  const newGroup =
    `\t\t<AxTableFieldGroupExtension>\n` +
    `\t\t\t<Name>${groupName}</Name>\n` +
    `\t\t\t<Fields>\n${entry}\n\t\t\t</Fields>\n` +
    `\t\t</AxTableFieldGroupExtension>`;

  const target = findTopLevelCollection(content, 'AxDataEntityViewExtension', 'FieldGroupExtensions');
  if (!target) return null;
  if ('selfClosingAt' in target) {
    const [from, to] = target.selfClosingAt;
    return `${content.slice(0, from)}<FieldGroupExtensions>\n${newGroup}\n\t</FieldGroupExtensions>${content.slice(to)}`;
  }
  return `${content.slice(0, target.insertAt)}${newGroup}\n\t${content.slice(target.insertAt)}`;
}

/**
 * Direct XML fallback for add-field on a DATA-ENTITY-EXTENSION.
 *
 * The bridge handles this via IMetaDataEntityViewExtensionProvider; this is the
 * same-session escape hatch that add-index and add-control already have — the
 * provider resolves against metadata roots fixed at startup, so an extension
 * created THIS session is invisible to it.
 *
 * The element itself comes from the shared builder (dataEntityViewExtensionXml.ts)
 * so the modify path cannot drift from the create path: sub-element ORDER is not
 * cosmetic, the deserializer drops children it meets out of order, and Label must
 * precede the DataField/DataSource binding pair.
 */
const directXmlAddDataEntityExtensionField = serializedOnFile(async (
  filePath: string,
  fieldName: string,
  dataField: string,
  dataSource: string,
  label?: string,
  fieldGroupName?: string,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    // Only data-entity extensions carry a <Fields> collection of mapped fields
    // shaped like this — bail on any other file shape.
    if (!/<AxDataEntityViewExtension\b/.test(content)) return null;

    // Idempotency: scoped to the mapped-field elements. Matching a bare
    // <Name>…</Name> anywhere in the file also hits the extension's own name, every
    // field-group name and every AxPropertyModification — a false hit there answers
    // "already present" and writes nothing.
    const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`<AxDataEntityViewField\\b[^>]*>\\s*<Name>${escapedName}</Name>`).test(content)) {
      return {
        success: true,
        message: `✅ Field '${fieldName}' already present in ${filePath} — skipped (idempotent).`,
      };
    }

    const newElement = buildAxDataEntityViewFieldXml({ name: fieldName, dataField, dataSource, label });

    const target = findTopLevelCollection(content, 'AxDataEntityViewExtension', 'Fields');
    if (!target) return null;

    let updated: string;
    if ('selfClosingAt' in target) {
      const [from, to] = target.selfClosingAt;
      updated = `${content.slice(0, from)}<Fields>\n${newElement}\n\t</Fields>${content.slice(to)}`;
    } else {
      updated = `${content.slice(0, target.insertAt)}${newElement}\n\t${content.slice(target.insertAt)}`;
    }

    if (fieldGroupName) {
      updated = upsertDataEntityFieldGroupExtension(updated, fieldGroupName, fieldName) ?? updated;
    }

    if (updated === content) return null;

    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(`[modify_d365fo_file] ✅ directXmlAddDataEntityExtensionField: added '${fieldName}' to ${filePath}`);
    return {
      success: true,
      message:
        `✅ Mapped field '${fieldName}' (${dataSource}.${dataField}) added via direct XML fallback ` +
        `(the bridge could not resolve the same-session extension)` +
        (fieldGroupName ? ` and registered in field group '${fieldGroupName}'` : '') +
        `. File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlAddDataEntityExtensionField failed: ${err}`);
    return null;
  }
});

/** DeleteAction values accepted by the AxTable serialiser. */
export const DELETE_ACTION_TYPES = ['None', 'Restricted', 'Cascade', 'CascadeRestricted'] as const;

/**
 * add-delete-action / remove-delete-action on a TABLE, written straight to the XML.
 *
 * There is no bridge operation for DeleteActions at all (finding #36), so a
 * cascading delete action was inexpressible through the modify surface — the only
 * route was the forbidden whole-file overwrite. <DeleteActions> is a collection
 * sibling, not part of the order-sensitive top-level property block, so patching
 * it in place is safe. Shape matches MetadataWriteService.cs: Name, Table,
 * DeleteAction.
 */
const directXmlDeleteAction = serializedOnFile(async (
  filePath: string,
  mode: 'add' | 'remove',
  name: string,
  table: string | undefined,
  deleteAction: string | undefined,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    // Only tables carry <DeleteActions> — bail on any other shape so a mis-typed
    // objectType never corrupts a non-table file.
    if (!/<AxTable\b/.test(content)) return null;

    const blockRe = new RegExp(
      `[\\t ]*<AxTableDeleteAction>\\s*<Name>${escapeRegExp(name)}</Name>[\\s\\S]*?</AxTableDeleteAction>\\n?`,
    );
    const existing = blockRe.exec(content);

    if (mode === 'remove') {
      if (!existing) {
        return { success: true, message: `✅ Delete action '${name}' not present in ${filePath} — nothing to remove.` };
      }
      const updated = content.replace(blockRe, '');
      await writeFileAtomic(filePath, normalizeD365Xml(updated));
      return { success: true, message: `✅ Delete action '${name}' removed. File: ${filePath}` };
    }

    if (existing) {
      return { success: true, message: `✅ Delete action '${name}' already present in ${filePath} — skipped (idempotent).` };
    }

    const newElement =
      `\t\t<AxTableDeleteAction>\n` +
      `\t\t\t<Name>${name}</Name>\n` +
      `\t\t\t<Table>${table ?? name}</Table>\n` +
      `\t\t\t<DeleteAction>${deleteAction ?? 'Restricted'}</DeleteAction>\n` +
      `\t\t</AxTableDeleteAction>`;

    let updated: string;
    if (content.includes('<DeleteActions />')) {
      updated = content.replace('<DeleteActions />', `<DeleteActions>\n${newElement}\n\t</DeleteActions>`);
    } else if (content.includes('</DeleteActions>')) {
      updated = content.replace('</DeleteActions>', `${newElement}\n\t</DeleteActions>`);
    } else {
      // No <DeleteActions> collection at all — not a shape we can safely patch.
      return null;
    }
    if (updated === content) return null;

    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    return {
      success: true,
      message: `✅ Delete action '${name}' (${deleteAction ?? 'Restricted'} on ${table ?? name}) added. File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlDeleteAction failed: ${err}`);
    return null;
  }
});

/**
 * remove-control on a FORM or FORM-EXTENSION, written straight to the XML.
 *
 * add-control has a bridge path for a plain form (AddControl) and a direct-XML
 * path for an extension; removal has neither — MetadataWriteService exposes no
 * RemoveControl at all — so this is the only grounded route, exactly as with
 * directXmlDeleteAction. Without it, taking a button off a form meant
 * d365fo_file(action="create", overwrite=true), the whole-file escape hatch the
 * eval loop forbids.
 *
 * The tree walk, the two form-extension shapes and the separator rule all live
 * in formControlRemoval.ts — pure and unit-tested, because a `<Name>` substring
 * replace here would cut the wrong element and report a ✅ for it.
 */
const directXmlRemoveControl = serializedOnFile(async (
  filePath: string,
  controlName: string,
  removeSeparator: boolean | undefined,
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    const outcome = removeFormControl(content, { controlName, removeSeparator });

    switch (outcome.kind) {
      case 'unsupported':
        // Returned as a REFUSAL rather than null. A null here means "the bridge
        // never ran", which routes into the provider-refresh retry and then into
        // an unresolved-object error about metadata roots — none of which applies:
        // there is no bridge path for this op, and no refresh turns a non-form
        // file into a form.
        return {
          success: false,
          message:
            `${filePath} is not an AxForm or AxFormExtension (or its XML is unbalanced), so no ` +
            `control could be removed from it. Check objectType and the resolved file — ` +
            `remove-control only applies to objectType="form" and "form-extension".`,
        };
      case 'not-found':
        // NOT reported as success. An absent control is the case where a caller
        // most needs to know it named the wrong thing: the button is still on the
        // form, and a ✅ would send it to build_d365fo_project instead.
        return {
          success: false,
          message:
            `Control '${controlName}' is not defined in ${filePath} — nothing was removed.\n` +
            (outcome.present.length > 0
              ? `Controls in this file: ${outcome.present.join(', ')}.`
              : `This file defines no controls at all.`) +
            `\nA control shown on the form but absent here belongs to the BASE form — remove it there, ` +
            `or hide it with modify-property on a form extension.`,
        };
    }

    await writeFileAtomic(filePath, normalizeD365Xml(outcome.xml));
    console.error(`[modify_d365fo_file] ✅ directXmlRemoveControl: removed '${controlName}' from ${filePath}`);

    const notes = outcome.notes.length ? '\n' + outcome.notes.map(n => `ℹ️ ${n}`).join('\n') : '';
    return {
      success: true,
      message:
        `✅ Removed ${outcome.removed.length} control element(s) — ${outcome.removed.join(', ')}. ` +
        `File: ${filePath}${notes}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlRemoveControl failed: ${err}`);
    return null;
  }
});

/**
 * add-entry-point on an AxSecurityPrivilege, written straight to the XML.
 *
 * The missing half of the pair. `create` takes ONE entry point, as the scalar
 * `properties.targetObject`, so a privilege granting two menu items could only
 * be produced by `create(overwrite=true, xmlContent=…)` — hand-authored XML that
 * bypasses the generator. That also left remove-entry-point's ambiguity refusal
 * unreachable through supported parameters and therefore untested against a real
 * privilege (eval case L2-object-delete-and-entry-point-cleanup, 2026-08-23).
 *
 * Same structural reason as its inverse for being XML-only: security objects
 * have no bridge write path — the generic `properties: Dictionary<string,string>`
 * channel cannot carry <EntryPoints>, which is why security-privilege is
 * excluded from BRIDGE_CREATE_TYPES.
 */
const directXmlAddEntryPoint = serializedOnFile(async (
  filePath: string,
  spec: { objectName: string; objectType: string; name?: string; accessLevel?: string },
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    const outcome = addSecurityEntryPoint(content, spec);

    switch (outcome.kind) {
      case 'unsupported':
        // A refusal, not null — null would be read as a bridge-resolution
        // failure and send the caller after the wrong cause.
        return {
          success: false,
          message:
            `${filePath} is not an AxSecurityPrivilege, so it has no entry points. ` +
            `add-entry-point applies to objectType="security-privilege" only — a DUTY references ` +
            `privileges, not entry points, and a ROLE references duties.`,
        };
      case 'bad-object-type':
        return {
          success: false,
          message:
            `entryPointObjectType "${outcome.given}" is not an EntryPointType — nothing was written. ` +
            `Use MenuItemDisplay | MenuItemAction | MenuItemOutput | ServiceOperation | None. ` +
            `An unknown value deserializes to nothing, so the privilege would build clean, pass BP ` +
            `and grant access to no object at all.`,
        };
      case 'no-collection':
        return {
          success: false,
          message:
            `${filePath} has no <EntryPoints> collection to add to — nothing was written. ` +
            `A privilege written by this tool always has one; a hand-edited file may not.`,
        };
      case 'already-present': {
        const e = outcome.existing;
        return {
          success: true,
          message:
            `ℹ️ Entry point '${e.name}' (${e.objectName}, ${e.objectType}) is already on the privilege — ` +
            `nothing written (idempotent). File: ${filePath}`,
        };
      }
    }

    await writeFileAtomic(filePath, normalizeD365Xml(outcome.xml));
    const { name, objectName, objectType } = outcome.added;
    console.error(`[modify_d365fo_file] ✅ directXmlAddEntryPoint: added '${name}' to ${filePath}`);
    return {
      success: true,
      message:
        `✅ Entry point '${name}' (${objectName}, ${objectType}) added to the privilege. ` +
        `File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlAddEntryPoint failed: ${err}`);
    return null;
  }
});

/**
 * remove-entry-point on an AxSecurityPrivilege, written straight to the XML.
 *
 * Security objects have no bridge write path at all: the generic
 * `properties: Dictionary<string,string>` channel cannot carry <EntryPoints>,
 * which is why security-privilege is excluded from BRIDGE_CREATE_TYPES. So this
 * mirrors remove-relation / remove-field-group in shape while being, like the
 * delete-action pair, XML-only by necessity.
 *
 * The matching and the collapse of an emptied <EntryPoints> live in
 * securityPrivilegeXml.ts, next to the builder that writes the element — the two
 * halves of one shape drifting apart is how an entry point becomes unremovable.
 */
const directXmlRemoveEntryPoint = serializedOnFile(async (
  filePath: string,
  criteria: { name?: string; objectName?: string; objectType?: string },
): Promise<{ success: boolean; message: string } | null> => {
  const asked = criteria.name ?? criteria.objectName ?? '(unnamed)';
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    const outcome = removeSecurityEntryPoint(content, criteria);

    switch (outcome.kind) {
      case 'unsupported':
        // A refusal, not null — see directXmlRemoveControl for why null would be
        // read as a bridge-resolution failure and sent after the wrong cause.
        return {
          success: false,
          message:
            `${filePath} is not an AxSecurityPrivilege, so it has no entry points to remove. ` +
            `remove-entry-point applies to objectType="security-privilege" only — a DUTY references ` +
            `privileges, not entry points, and a ROLE references duties.`,
        };
      case 'not-found':
        return {
          success: false,
          message:
            `Entry point '${asked}' is not on the privilege in ${filePath} — nothing was removed.\n` +
            (outcome.present.length > 0
              ? `Entry points on this privilege: ` +
                outcome.present.map(e => `${e.name} (${e.objectName}, ${e.objectType})`).join('; ') + '.'
              : `This privilege has no entry points.`),
        };
      case 'ambiguous':
        return {
          success: false,
          message:
            `'${asked}' matches ${outcome.matches.length} entry points — refusing to guess which to ` +
            `remove, since removing the wrong one revokes access to a different object and still builds ` +
            `clean.\nMatches: ` +
            outcome.matches.map(e => `${e.name} (${e.objectName}, ${e.objectType})`).join('; ') +
            `.\nNarrow it with entryPointName, or entryPointObjectName + entryPointObjectType.`,
        };
    }

    await writeFileAtomic(filePath, normalizeD365Xml(outcome.xml));
    const { name, objectName, objectType } = outcome.removed;
    console.error(`[modify_d365fo_file] ✅ directXmlRemoveEntryPoint: removed '${name}' from ${filePath}`);
    return {
      success: true,
      message:
        `✅ Entry point '${name}' (${objectName}, ${objectType}) removed from the privilege. ` +
        `File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlRemoveEntryPoint failed: ${err}`);
    return null;
  }
});

/**
 * remove-diagnostic-suppression on an AxIgnoreDiagnosticList, written straight
 * to the XML.
 *
 * Not an AOT object at all — MetadataWriteService has no notion of a
 * suppression list — so this is XML-only for the same structural reason as
 * remove-entry-point. The matching and the collapse of an emptied <Items> live
 * in ignoreDiagnosticListXml.ts, next to the bulk-removal helper delete uses
 * to strip suppressions for an object it just deleted.
 */
const directXmlRemoveDiagnosticSuppression = serializedOnFile(async (
  filePath: string,
  criteria: { path: string; moniker?: string },
): Promise<{ success: boolean; message: string } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    const outcome = removeDiagnosticSuppression(content, criteria);

    switch (outcome.kind) {
      case 'unsupported':
        return {
          success: false,
          message:
            `${filePath} is not a suppression list (no <IgnoreDiagnostics> root), so it has no <Diagnostic> ` +
            `entries to remove. remove-diagnostic-suppression applies to objectType="ignore-diagnostic-list" only.`,
        };
      case 'not-found':
        return {
          success: false,
          message:
            `No <Diagnostic> with <Path> '${criteria.path}'` +
            (criteria.moniker ? ` and <Moniker> '${criteria.moniker}'` : '') +
            ` was found in ${filePath} — nothing was removed.\n` +
            (outcome.present.length > 0
              ? `Suppressions in this file: ` +
                outcome.present.map(e => `${e.path} (${e.moniker})`).join('; ') + '.'
              : `This file defines no suppressions at all.`),
        };
      case 'ambiguous':
        return {
          success: false,
          message:
            `'${criteria.path}' matches ${outcome.matches.length} suppressions — refusing to guess which ` +
            `to remove, since removing the wrong one leaves a live BP finding silenced.\nMatches: ` +
            outcome.matches.map(e => `${e.path} (${e.moniker})`).join('; ') +
            `.\nNarrow it with diagnosticMoniker.`,
        };
    }

    await writeFileAtomic(filePath, normalizeD365Xml(outcome.xml));
    const { path: removedPath, moniker } = outcome.removed;
    console.error(`[modify_d365fo_file] ✅ directXmlRemoveDiagnosticSuppression: removed '${removedPath}' (${moniker}) from ${filePath}`);
    return {
      success: true,
      message: `✅ Suppression '${removedPath}' (${moniker}) removed. File: ${filePath}`,
    };
  } catch (err) {
    // Real error, not null — see directXmlAddDiagnosticSuppression's catch for
    // why a null here reads as a bridge-resolution failure it cannot be.
    console.error(`[modify_d365fo_file] directXmlRemoveDiagnosticSuppression failed: ${err}`);
    return {
      success: false,
      message:
        `❌ Could not remove the suppression from ${filePath}: ${err instanceof Error ? err.message : err}`,
    };
  }
});

/**
 * add-diagnostic-suppression on an AxIgnoreDiagnosticList, written straight to
 * the XML.
 *
 * The <Diagnostic> block itself is built by buildSuppressionXml
 * (bpMonikers/index.ts) — the SAME function get_knowledge(kind="bp-moniker",
 * action="suppress") uses to render one for a human to paste by hand, so the
 * two paths cannot describe two different shapes of suppression. This is only
 * the "place it in the file" half.
 *
 * When the model's suppression file does not exist yet, a fresh one is created
 * — skeleton and all, measured against a shipped PackagesLocalDirectory (see
 * emptySuppressionListXml). Creating it means creating its FOLDER too:
 * AxIgnoreDiagnosticList exists only in models that have suppressed something,
 * which is by definition not the model this branch runs for, and writeFileAtomic
 * does no mkdir — so without this the one path that advertises "creates the file
 * for you" failed with ENOENT on the directory, and the caller was told the C#
 * bridge could not resolve the object.
 */
const directXmlAddDiagnosticSuppression = serializedOnFile(async (
  filePath: string,
  input: {
    moniker: string;
    path?: string;
    elementType?: string;
    elementName?: string;
    justification?: string;
    message?: string;
    severity?: 'Error' | 'Warning';
    itemSpecific?: boolean;
  },
): Promise<{ success: boolean; message: string } | null> => {
  try {
    let content: string;
    let createdFresh = false;
    try {
      const rawContent = await fs.readFile(filePath, 'utf-8');
      content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');
    } catch (readErr: any) {
      if (readErr?.code !== 'ENOENT') throw readErr;
      content = emptySuppressionListXml(path.win32.basename(filePath, '.xml'));
      createdFresh = true;
    }

    const built = buildSuppressionXml(input as any);
    if (built.errors.length > 0) {
      return { success: false, message: `❌ ${built.errors.join('\n❌ ')}` };
    }

    const outcome = addDiagnosticSuppression(content, built.xml);
    switch (outcome.kind) {
      case 'unsupported':
        return {
          success: false,
          message:
            `${filePath} is not a suppression list (no <IgnoreDiagnostics> root). ` +
            `add-diagnostic-suppression applies to objectType="ignore-diagnostic-list" only.`,
        };
      case 'duplicate':
        return {
          success: false,
          message:
            `A <Diagnostic> suppressing '${outcome.existing.moniker}' on '${outcome.existing.path}' is ` +
            `already in ${filePath} — nothing was added. Nothing needs re-suppressing; if the finding is ` +
            `still firing, the existing entry's <Path> may not match what BP-check now reports.`,
        };
      case 'no-items':
        return {
          success: false,
          message:
            `${filePath} has an <IgnoreDiagnostics> root but no <Items> collection, so there is nowhere ` +
            `to put the <Diagnostic> — nothing was written. Every real suppression list carries <Items> ` +
            `(empty ones as <Items /> or <Items></Items>); add it by hand and retry, or delete the file ` +
            `and let this operation write a fresh one.`,
        };
    }

    // The folder exists for every model that has ever suppressed anything — and
    // for no other, which is exactly the model this branch serves.
    if (createdFresh) {
      await fs.mkdir(path.win32.dirname(filePath), { recursive: true });
    }
    await writeFileAtomic(filePath, normalizeD365Xml(outcome.xml));
    console.error(`[modify_d365fo_file] ✅ directXmlAddDiagnosticSuppression: added '${built.xml.match(/<Path>([\s\S]*?)<\/Path>/)?.[1] ?? '?'}' to ${filePath}`);

    const warningText = built.warnings.length ? built.warnings.map(w => `⚠️ ${w}`).join('\n') + '\n' : '';
    const freshFileNote = createdFresh
      ? `\nℹ️ ${filePath} did not exist — created it, and its AxIgnoreDiagnosticList folder. ` +
        `Add it to the model's .rnrproj if Visual Studio does not pick it up automatically.`
      : '';
    return {
      success: true,
      message: `${warningText}✅ Suppression added. File: ${filePath}${freshFileNote}`,
    };
  } catch (err) {
    // Returning null here would send an I/O failure — ENOENT on the folder,
    // EACCES, a file Visual Studio holds open — through the "bridge returned
    // null" path, which retries a provider refresh and then blames the C#
    // bridge's metadata roots for an operation that never touched the bridge.
    // The real error is the only actionable thing there is.
    console.error(`[modify_d365fo_file] directXmlAddDiagnosticSuppression failed: ${err}`);
    return {
      success: false,
      message:
        `❌ Could not write the suppression to ${filePath}: ${err instanceof Error ? err.message : err}`,
    };
  }
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Writes the relation properties the bridge drops into an <AxTableRelation>.
 *
 * add-relation documents relationCardinality / relatedTableCardinality /
 * relationshipType WITH defaults, but neither bridgeClient.addRelation nor the
 * C# MetadataWriteService.AddRelation carries them: AddRelation only sets Name,
 * RelatedTable and the constraints. The result was a relation that reports
 * "✅ Relation 'X' added" and then fails BP with
 * BPErrorTableRelationshipPropertiesCompleteness naming exactly those three
 * properties — with no repair path, because modify-property rejects
 * Relations/<name>/RelationshipType (corpus findings #5 / #35).
 *
 * The C# side cannot be fixed or tested without the VM's metadata assemblies, so
 * the properties are written on disk after the relation lands. Element order is
 * the one both in-repo generators emit (createD365File.ts / generateTableRelation.ts,
 * matching the SDK serialiser): Name, Cardinality, RelatedTable,
 * RelatedTableCardinality, RelationshipType, Constraints. Order matters — AxTable
 * XML silently drops misordered properties (#13) — so nothing is guessed here:
 * each element is anchored to the sibling it must follow, and the function is a
 * no-op if the anchor is absent or the property is already present.
 */
export const directXmlEnsureRelationProperties = serializedOnFile(async (
  filePath: string,
  relationName: string,
  cardinality: string,
  relatedTableCardinality: string,
  relationshipType: string,
): Promise<{ applied: string[] } | null> => {
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');

    // Locate the <AxTableRelation> block that carries this <Name>.
    const relRegex = /<AxTableRelation>[\s\S]*?<\/AxTableRelation>/g;
    let block: string | undefined;
    for (const m of content.matchAll(relRegex)) {
      if (new RegExp(`<Name>${relationName}</Name>`).test(m[0])) { block = m[0]; break; }
    }
    if (!block) return null;

    const indent = /\n(\s*)<Name>/.exec(block)?.[1] ?? '\t\t\t';
    let patched = block;
    const applied: string[] = [];

    // <Cardinality> goes directly after <Name>.
    if (!/<Cardinality>/.test(patched)) {
      patched = patched.replace(
        new RegExp(`(<Name>${relationName}</Name>)`),
        `$1\n${indent}<Cardinality>${cardinality}</Cardinality>`,
      );
      applied.push(`Cardinality=${cardinality}`);
    }
    // <RelatedTableCardinality> and <RelationshipType> go after <RelatedTable>,
    // in that order.
    const relatedTableMatch = /<RelatedTable>[^<]*<\/RelatedTable>/.exec(patched);
    if (relatedTableMatch) {
      let insertion = '';
      if (!/<RelatedTableCardinality>/.test(patched)) {
        insertion += `\n${indent}<RelatedTableCardinality>${relatedTableCardinality}</RelatedTableCardinality>`;
        applied.push(`RelatedTableCardinality=${relatedTableCardinality}`);
      }
      if (!/<RelationshipType>/.test(patched)) {
        insertion += `\n${indent}<RelationshipType>${relationshipType}</RelationshipType>`;
        applied.push(`RelationshipType=${relationshipType}`);
      }
      if (insertion) {
        patched = patched.replace(relatedTableMatch[0], `${relatedTableMatch[0]}${insertion}`);
      }
    }

    if (applied.length === 0 || patched === block) return { applied: [] };

    const updated = content.replace(block, patched);
    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(
      `[modify_d365fo_file] ✅ directXmlEnsureRelationProperties: ${applied.join(', ')} on '${relationName}' in ${filePath}`,
    );
    return { applied };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlEnsureRelationProperties failed: ${err}`);
    return null;
  }
});

/**
 * Heuristic: does a bridge failure message indicate the C# provider could not
 * resolve the target object (vs. a genuine operation error like "index already
 * exists")? An unresolved object is the one failure worth a refresh+retry,
 * because an object created this session may not be in the provider's
 * startup-fixed metadata roots yet.
 */
export function isUnresolvedObjectError(message: string | undefined): boolean {
  if (!message) return false;
  // Content/operation failures that merely contain "not found" are NOT object
  // resolution and must not trigger the refresh+retry or the "could not resolve"
  // guidance: replace-code's "oldCode not found in <obj>.<method>", a missing
  // method/field/index, etc. The object was resolved — only the snippet/member wasn't.
  //
  // `control` / `data source` are in this list because the bridge's add-control
  // failure reads "Parent control 'X' not found in form 'Y'" — the form WAS read
  // successfully. Misclassifying it as unresolved produced the factually wrong
  // "the C# metadata bridge could not find '<form>' in its metadata model"
  // (corpus: 2026-07-21T18__L2-form-modify-controls__c262b19).
  if (/\b(oldcode|new ?code|code|snippet|method|field|index|relation|element|control|data ?source|value)\b[^.]*\bnot found/i.test(message)) {
    return false;
  }
  // Genuine object-resolution failures: a quoted object name "'X' not found",
  // or the explicit resolve/model phrases the bridge emits.
  return /'[^']+'\s+not found|could not resolve|does not exist|not in (the )?(metadata )?model|cannot determine model/i.test(message);
}

/**
 * Build the actionable "object could not be resolved" error for a modify
 * operation. When `bridgeReported` is supplied it is included verbatim so the
 * caller sees exactly what the C# bridge said rather than a generic guess.
 */
function unresolvedObjectError(
  operation: string,
  objectType: string,
  objectName: string,
  actualFilePath?: string,
  bridgeReported?: string,
): string {
  return (
    `Bridge operation '${operation}' could not resolve ${objectType} '${objectName}'.\n` +
    (bridgeReported ? `Bridge reported: ${bridgeReported}\n` : '') +
    `Most likely cause: the C# metadata bridge could not find '${objectName}' in its metadata model.\n` +
    `This is typical right after creating an object in the same session — the bridge's metadata ` +
    `roots are fixed at startup, so a file written this session may not be in its model.\n` +
    `Auto-refresh was already attempted once and still failed.\n\n` +
    // Deliberately NOT suggesting `d365fo_file(action="create", overwrite=true,
    // xmlContent=...)` here: rewriting a whole object from hand-authored XML is the
    // exact escape hatch that loses metadata the provider would have written, and it
    // is never the right remedy for a *modify* failure. Fix the resolution instead.
    `Try in order:\n` +
    `  1. update_symbol_index({ filePath: "<path to ${objectName}.xml>" })\n` +
    `  2. Check D365FO_CUSTOM_PACKAGES_PATH points to the correct metadata folder.\n` +
    `  3. Confirm ${objectName}.xml actually exists on disk.\n` +
    (actualFilePath ? `Resolved file path: ${actualFilePath}\n` : '') +
    `If none of these apply, the object may simply not exist or its name may be misspelled.`
  );
}

export const ModifyD365FileArgsSchema = z.object({
  objectType: z.enum([
    'class', 'table', 'form', 'enum', 'query', 'view', 'edt', 'data-entity', 'report',
    'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
    'data-entity-extension',
    'menu-item-display', 'menu-item-action', 'menu-item-output',
    'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
    'menu', 'menu-extension',
    'security-privilege', 'security-duty', 'security-role',
    'ignore-diagnostic-list',
  ]).describe('Type of D365FO object'),
  objectName: z.string().optional().describe(
    'Name of the object to modify. Optional when filePath is provided — it is then ' +
    'derived from the file basename (the bridge resolves objects by name, which the ' +
    'file path already determines).'
  ),
  operation: z.enum([
    'add-method', 'remove-method', 'replace-code',
    'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
    'add-index', 'remove-index',
    'add-full-text-index', 'remove-full-text-index',
    'add-table-mapping', 'remove-table-mapping',
    'add-relation', 'remove-relation',
    'add-delete-action', 'remove-delete-action',
    'add-field-group', 'remove-field-group', 'add-field-to-field-group',
    'add-field-modification',
    'add-data-source',
    'modify-property',
    'add-control', 'remove-control',
    'add-entry-point', 'remove-entry-point',
    'remove-diagnostic-suppression', 'add-diagnostic-suppression',
    'add-enum-value', 'modify-enum-value', 'remove-enum-value',
    'add-display-method', 'add-table-method', 'add-menu-item-to-menu',
    'add-query-range', 'remove-query-range',
  ]).describe(
    'Operation to perform. ' +
    'replace-code REQUIRES parameters: oldCode (exact code to find) + newCode (replacement). ' +
    'add-method REQUIRES: methodName + sourceCode. ' +
    'add-table-method: pass tableMethodType (find/exist/findByRecId/validateWrite/validateDelete/initValue) ' +
    '(+ tableKeyField for find/exist) to auto-generate the method, OR methodName + sourceCode for a custom one. ' +
    'add-display-method: pass methodName + displayMethodReturnEdt to auto-generate a stub, OR methodName + sourceCode. ' +
    'For form control override methods with replace-code, use methodName="ControlName.methodName" (e.g. "PostButton.clicked").'
  ),

  // For add-enum-value / modify-enum-value / remove-enum-value
  enumValueName: z.string().optional().describe(
    'Enum value name for add-enum-value / modify-enum-value / remove-enum-value. ' +
    'E.g. "Approved", "Pending", "Rejected". For modify-enum-value this is the EXISTING ' +
    'name used to locate the value — see enumValueNewName to rename it.'
  ),
  enumValueNewName: z.string().optional().describe(
    'modify-enum-value ONLY: renames the enum value (its Name/identifier) from ' +
    'enumValueName to this. Numeric value and label are unaffected unless ' +
    'enumValueInt/enumValueLabel are also given.'
  ),
  enumValueLabel: z.string().optional().describe(
    'Label reference for the enum value (e.g. "@MyModel:Approved"). ' +
    'Used with add-enum-value and modify-enum-value.'
  ),
  enumValueHelpText: z.string().optional().describe(
    'Help text reference for the enum value (e.g. "@MyModel:ApprovedHelp"). Optional.'
  ),
  enumValueInt: z.number().optional().describe(
    'Explicit integer value for the enum value. ' +
    'If omitted for add-enum-value, the next available value is assigned automatically. ' +
    'Use with modify-enum-value to change the integer value (rare — may break existing data).'
  ),
  enumValueCountryRegionCodes: z.string().optional().describe(
    'ISO country/region codes for the enum value, comma-separated (e.g. "CZ", "CZ,SK"). ' +
    'Used with add-enum-value to restrict the value to specific locales.'
  ),

  // For add-display-method
  displayMethodReturnEdt: z.string().optional().describe(
    'EDT or type name the display method returns, e.g. "Name", "AmountMST", "SalesStatus". ' +
    'Used with add-display-method to set the return type automatically.'
  ),

  // For add-table-method
  tableMethodType: z.enum(['find', 'exist', 'findByRecId', 'validateWrite', 'validateDelete', 'initValue']).optional().describe(
    'Standard table method pattern to generate. Used with add-table-method. ' +
    'find: returns a single record by key field. exist: returns true/false. ' +
    'findByRecId: returns record by RecId. validateWrite/validateDelete/initValue: standard overrides.'
  ),
  tableKeyField: z.string().optional().describe(
    'Name of the primary key field for find/exist patterns (e.g. "ItemId", "SalesId"). ' +
    'Used with add-table-method when tableMethodType is find or exist.'
  ),

  // For add-menu-item-to-menu
  menuItemToAdd: z.string().optional().describe(
    'Name of the menu item to add (e.g. "MyCustomForm"). Used with add-menu-item-to-menu.'
  ),
  menuItemToAddType: z.enum(['display', 'action', 'output']).optional().describe(
    'Type of menu item to add: display (form), action (class), output (report). ' +
    'Used with add-menu-item-to-menu. Defaults to display.'
  ),

  // For add-control (form-extension only)
  controlName: z.string().optional().describe(
    'Name of the new form control to add inside the form extension. ' +
    'e.g. "MyCustPriorityTier". Used as <Name> inside <FormControl>.'
  ),
  parentControl: z.string().optional().describe(
    'Name of the existing parent control/tab/group to insert into. ' +
    'e.g. "TabGeneral", "HeaderGroup", "TabPageSales". ' +
    'On objectType="form", pass "Design" to add the control at the TOP LEVEL of the form ' +
    'design (required for the first control on a form whose design is still empty). ' +
    'On objectType="form-extension" it becomes the <Parent> element of the ' +
    'AxFormExtensionControl wrapper.'
  ),
  controlDataSource: z.string().optional().describe(
    'Data source name for the new control binding (e.g. "CustTable"). ' +
    'Required when controlDataField is provided.'
  ),
  controlDataField: z.string().optional().describe(
    'Data field name for the new control binding (e.g. "MyCustPriorityTier"). ' +
    'The field must already exist in the table (extension) before adding the UI control.'
  ),
  controlType: z.string().optional().describe(
    'Form control type (default: String). Determines i:type and <Type> in the XML. ' +
    'Supported values: String, Integer, Real, CheckBox, ComboBox, Date, DateTime, Int64, Group, Button, CommandButton, MenuFunctionButton. ' +
    'Use CheckBox for NoYes/boolean fields. Use ComboBox for enum fields. ' +
    'If omitted the tool auto-picks based on the EDT base type if controlDataField is provided.'
  ),
  controlLabel: z.string().optional().describe(
    'Optional label for the new control (add-control). Becomes the control <Label>.'
  ),
  positionType: z.string().optional().describe(
    'Optional positioning: AfterItem (needs previousSibling) | Begin | End. Omit to append at the ' +
    'end of the parent. Other values are refused — these are the ones D365FO metadata carries.'
  ),
  previousSibling: z.string().optional().describe(
    'Name of the sibling control to position after. Implies positionType=AfterItem when that is omitted.'
  ),
  baseFormName: z.string().optional().describe(
    'Base form name used for auto-resolving parentControl when the extension name does not contain it. ' +
    'E.g. if objectName="SalesOrder.MyExt" the base form is auto-detected as "SalesOrder". ' +
    'Pass this only when auto-detection fails (e.g. the extension has a non-standard name).'
  ),
  
  // For add-method
  methodName: z.string().optional().describe('Name of method to add/remove'),
  methodCode: z.string().optional().describe(
    'X++ code for the method — either the FULL source (access modifiers + return type + name + params + body) ' +
    'or just the method body. When the full source is provided (first real code line contains an access ' +
    'modifier and the method name followed by "("), it is used as-is. When only a body is provided, ' +
    'the signature is assembled from methodModifiers, methodReturnType, methodName, and methodParameters. ' +
    'Alias: sourceCode (preferred when passing a complete CoC skeleton or full method source).'
  ),
  sourceCode: z.string().optional().describe(
    'Alias for methodCode — pass the FULL X++ method source including access modifiers, return type, ' +
    'method name, parameters, attributes (e.g. [ExtensionOf(...)]), and body. ' +
    'This is the preferred parameter when passing a complete CoC skeleton. ' +
    'Either methodCode or sourceCode may be used; sourceCode takes precedence if both are supplied.'
  ),
  // For replace-code (REQUIRED for operation="replace-code" — do NOT use sourceCode for this)
  oldCode: z.string().optional().describe(
    'REQUIRED for replace-code. Exact existing X++ code snippet to find and replace. ' +
    'Must match the source text exactly (leading/trailing whitespace is trimmed for matching). ' +
    'If methodName is also provided the search is scoped to that method\'s Source block only. ' +
    'For form control override methods, use methodName="ControlName.methodName" (e.g. "PostButton.clicked").'
  ),
  newCode: z.string().optional().describe(
    'REQUIRED for replace-code. Replacement X++ code snippet. ' +
    'Replaces the first occurrence of oldCode in the target source block. ' +
    'Pass empty string "" to delete the matched oldCode snippet.'
  ),
  methodModifiers: z.string().optional().describe('Method modifiers (e.g., "public static")'),
  methodReturnType: z.string().optional().describe('Return type of method'),
  methodParameters: z.string().optional().describe('Method parameters (e.g., "str _param1, int _param2")'),  
  
  // For add-field / modify-field (tables)
  fieldName: z.string().optional().describe('Name of field to add/remove/modify/rename'),
  fieldNewName: z.string().optional().describe('New name for the field (required for rename-field operation)'),
  fieldType: z.string().optional().describe('EDT name for the field (for add-field: required — pass the EDT name, e.g. "InventQty", "WHSZoneId"). For modify-field: new EDT to set.'),
  fieldBaseType: z.string().optional().describe(
    'Base type that determines the XML element for add-field: String | Integer | Real | Date | DateTime | Int64 | GUID | Enum. ' +
    'REQUIRED when fieldType is an EDT — pass the EDT base type so the correct AxTableFieldReal/AxTableFieldDate/… is used. ' +
    'Examples: fieldType="InventQty" fieldBaseType="Real"; fieldType="TransDate" fieldBaseType="Date"; fieldType="ItemId" fieldBaseType="String". ' +
    'Without this, all EDT fields default to AxTableFieldString which is WRONG for numeric/date types.'
  ),
  fieldMandatory: z.boolean().optional().describe('Is field mandatory'),
  fieldLabel: z.string().optional().describe('Field label'),
  fieldHelpText: z.string().optional().describe('Field help text (modify-field).'),
  fieldEnumType: z.string().optional().describe('Enum name for an enum-typed field. On add-field this replaces fieldType entirely — it writes AxTableFieldEnum + EnumType and needs no EDT. Also settable later with modify-field.'),
  fieldStringSize: z.string().optional().describe('String size to set on the field (modify-field, for string-typed fields).'),
  fields: z.array(z.object({
    name: z.string(),
    edt: z.string().optional(),
    type: z.string().optional().describe('Base type for the XML element: String|Real|Integer|Date|DateTime|Int64|GUID|Enum. REQUIRED when edt is an EDT name — without it defaults to AxTableFieldString!'),
    mandatory: z.boolean().optional(),
    label: z.string().optional(),
  })).optional().describe(
    'Full list of fields for replace-all-fields operation. Each item: { name, edt?, type?, mandatory?, label? }. ' +
    'IMPORTANT: always pass type= the base type (String/Real/Integer/Date/DateTime/Int64/GUID) alongside edt= so the correct XML element is used. ' +
    'Example: { name: "TransQty", edt: "InventQty", type: "Real" }. ' +
    'All existing fields are replaced atomically.'
  ),

  // For add-index / remove-index (table, table-extension)
  indexName: z.string().optional().describe('Index name for add-index / remove-index.'),
  indexFields: z.array(z.object({
    fieldName: z.string(),
    direction: z.enum(['Asc', 'Desc']).optional(),
  })).optional().describe('Fields that make up the index. Required for add-index.'),
  // Accept the XML spelling too: the AxTable element value is No/Yes, so callers
  // naturally pass "Yes"/"No" and used to get a bare "expected boolean" (#27).
  indexAllowDuplicates: z.union([z.boolean(), z.string()]).optional().describe(
    'Whether index allows duplicates (default: false = unique). Accepts true/false or the XML spelling "Yes"/"No".'
  ),
  indexAlternateKey: z.union([z.boolean(), z.string()]).optional().describe(
    'Whether index is an alternate key. Accepts true/false or the XML spelling "Yes"/"No".'
  ),
  indexEnabled: z.union([z.boolean(), z.string()]).optional().describe(
    'Whether index is enabled (default: true). Accepts true/false or the XML spelling "Yes"/"No".'
  ),

  // For add-table-mapping / remove-table-mapping (table, table-extension).
  // <Mappings> records which AxMap the table takes part in — a different collection and a
  // different element type from <Relations>, so add-relation cannot express it.
  mapName: z.string().optional().describe('Name of the AxMap this table takes part in (add-table-mapping / remove-table-mapping).'),
  mappingTable: z.string().optional().describe('Mapped table name for add-table-mapping. Defaults to mapName.'),
  mappingConnections: z.array(z.object({
    mapField: z.string().describe('Field name on the MAP.'),
    mapFieldTo: z.string().describe('Field name on THIS table.'),
  })).optional().describe('Field pairings for add-table-mapping. Both sides are required per connection.'),

  // For add-relation / remove-relation (table, table-extension)
  relationName: z.string().optional().describe('Relation name for add-relation / remove-relation.'),
  relatedTable: z.string().optional().describe('Name of the related (foreign key) table.'),
  relationConstraints: z.array(z.object({
    fieldName: z.string().describe('Local field name.'),
    relatedFieldName: z.string().describe('Field name in the related table.'),
  })).optional().describe('Field constraints for the relation (field = relatedField pairs).'),
  relationCardinality: z.string().optional().describe('Cardinality on local side: ZeroMore | ZeroOne | ExactlyOne (default: ZeroMore).'),
  relatedTableCardinality: z.string().optional().describe('Cardinality on related side: ZeroMore | ZeroOne | ExactlyOne (default: ExactlyOne).'),
  relationshipType: z.string().optional().describe('Relationship type: Association | Composition | Aggregation | Link | Specialization (default: Association).'),

  // For add-delete-action / remove-delete-action (table)
  deleteActionTable: z.string().optional().describe(
    'Related table the delete action applies to (e.g. "SalesLine"). Defaults to deleteActionName.'
  ),
  deleteActionName: z.string().optional().describe(
    'Delete action name — conventionally the related table name. Required for both add- and remove-delete-action.'
  ),
  deleteActionType: z.enum(DELETE_ACTION_TYPES).optional().describe(
    'None | Restricted (default) | Cascade | CascadeRestricted.'
  ),

  // For add-field-group / remove-field-group / add-field-to-field-group (table, table-extension)
  fieldGroupName: z.string().optional().describe('Field group name. For add-field-to-field-group in a table-extension: name of the group (new or existing base-table group).'),
  fieldGroupFields: z.array(z.string()).optional().describe('Initial field names for add-field-group. Can be empty — add fields later with add-field-to-field-group.'),
  fieldGroupLabel: z.string().optional().describe('Label for add-field-group (optional).'),
  extendBaseFieldGroup: z.boolean().optional().describe(
    'Only for table-extension add-field-to-field-group: when true, adds the field to <FieldGroupExtensions> ' +
    '(extending an existing base-table field group). When false/omitted, adds to <FieldGroups> (a new group defined in the extension).'
  ),

  // For remove-control (form, form-extension). controlName is shared with
  // add-control; removeSeparator is removal-only.
  removeSeparator: z.boolean().optional().describe(
    'remove-control: also delete the adjacent AxFormButtonSeparatorControl sibling (the one after the ' +
    'control, else the one before it). Removing a toolbar button usually orphans its separator.'
  ),

  // For add-entry-point / remove-entry-point (security-privilege). Deliberately NOT named
  // objectName/objectType: those two identify the PRIVILEGE being modified, and
  // reusing them for the entry point's target would make the call unreadable and
  // the args unroutable.
  entryPointName: z.string().optional().describe(
    'add-entry-point / remove-entry-point: <Name> of the AxSecurityEntryPointReference (conventionally ' +
    'equal to the menu item name; on add it DEFAULTS to entryPointObjectName).'
  ),
  entryPointObjectName: z.string().optional().describe(
    'add-entry-point (REQUIRED) / remove-entry-point: <ObjectName> of the entry point — the menu item or ' +
    'service operation it grants. On remove, use instead of entryPointName when the entry point was ' +
    'named differently from its target.'
  ),
  entryPointObjectType: z.string().optional().describe(
    'add-entry-point (REQUIRED) / remove-entry-point: <ObjectType> (EntryPointType) — MenuItemDisplay | ' +
    'MenuItemAction | MenuItemOutput | ServiceOperation | None. On remove, only needed to disambiguate ' +
    'the same ObjectName referenced through two entry-point types.'
  ),
  // Declared here because Zod STRIPS what it does not declare. This parameter was
  // in the op-spec, read by the dispatcher and honoured by the writer — and absent
  // from this schema, so `args.accessLevel` was always undefined and every entry
  // point add-entry-point ever wrote fell back to `?? 'view'`: Read only, under a
  // ✅, for a caller who asked for maintain. Caught live by eval case
  // L2-object-delete-and-entry-point-cleanup, 2026-08-23.
  accessLevel: z.string().optional().describe(
    'add-entry-point: permissions the <Grant> carries. "view"/"read" grant Read; "maintain" grants ' +
    'Correct+Create+Delete+Read+Update (plus Invoke on a ServiceOperation). Defaults to "view".'
  ),

  // For remove-diagnostic-suppression (ignore-diagnostic-list).
  diagnosticPath: z.string().optional().describe(
    'remove-diagnostic-suppression: exact <Path> of the <Diagnostic> to remove (e.g. "dynamics://Form/MyForm").'
  ),
  diagnosticMoniker: z.string().optional().describe(
    'remove-diagnostic-suppression: <Moniker> of the suppression to remove. Only needed when the same ' +
    'diagnosticPath carries more than one <Diagnostic>. add-diagnostic-suppression: REQUIRED — the BP ' +
    'moniker being suppressed (e.g. "BPErrorPrivilegeNotCoveredByDuty"), validated against the known catalog.'
  ),
  diagnosticElementType: z.string().optional().describe(
    'add-diagnostic-suppression: top-level AOT element type of the object the finding was raised against ' +
    '(e.g. "AxForm", "AxSecurityPrivilege") — used with diagnosticElementName to DERIVE diagnosticPath when ' +
    'it is not given. Ignored for sub-elements (a control, a field, a method, an enum value): those need ' +
    'diagnosticPath verbatim from the finding, since there is no way to derive a path that drills in.'
  ),
  diagnosticElementName: z.string().optional().describe(
    'add-diagnostic-suppression: name of the object the finding was raised against, paired with ' +
    'diagnosticElementType to derive diagnosticPath.'
  ),
  diagnosticJustification: z.string().optional().describe(
    'add-diagnostic-suppression: why this warning is being ignored. Omitting it writes an obvious TODO ' +
    'and a warning — a suppression with no reason is what a reviewer rejects.'
  ),
  diagnosticMessage: z.string().optional().describe(
    'add-diagnostic-suppression: the real message text from the BP-check finding, if known. Never invented ' +
    'when omitted — <Message> is simply left off, which is normal (57% of real entries have none).'
  ),
  diagnosticSeverity: z.enum(['Error', 'Warning']).optional().describe(
    'add-diagnostic-suppression: <Severity> of the diagnostic being suppressed. Default: Warning.'
  ),
  diagnosticItemSpecific: z.boolean().optional().describe(
    'add-diagnostic-suppression: emit the <ItemSpecific> block (rare — ~9% of real entries). Requires ' +
    'diagnosticElementName.'
  ),

  // For add-field-modification (table-extension only)
  // uses fieldName, fieldLabel, fieldMandatory (already defined above)

  // For add-data-source (form-extension) and add/remove-query-range (data-entity)
  dataSourceName: z.string().optional().describe(
    'Data source name. ' +
    'add-data-source: reference name for the new form-extension data source (e.g. "MyTable_1"). ' +
    'add/remove-query-range: <Name> of the data source inside ViewMetadata — the root one ' +
    '(usually the primary table) or a joined one; each keeps its own <Ranges>.'
  ),
  dataSourceTable: z.string().optional().describe('Base table name for add-data-source (e.g. "MyTable").'),
  rangeField: z.string().optional().describe(
    'add-query-range: field name to filter on (e.g. "IsActive"). Becomes <Field> in the range object.'
  ),
  rangeName: z.string().optional().describe(
    'add/remove-query-range: name of the range object (<Name>). add-query-range defaults it to ' +
    'rangeField; matched only against ranges of the SAME data source.'
  ),
  rangeValue: z.string().optional().describe(
    'add-query-range: filter value, REQUIRED (e.g. "1" for NoYes, "Sales" for an enum, "1..99" for an ' +
    'interval). Pass the two characters "" for the empty-string filter — a range with no value at all ' +
    'filters nothing and is not a shape D365FO ships.'
  ),
  joinSource: z.string().optional().describe(
    'Optional name of an existing data source on the form to join the new data source to (add-data-source).'
  ),
  linkType: z.string().optional().describe(
    'Optional join/link type when joinSource is set (add-data-source): InnerJoin | OuterJoin | ExistJoin | NotExistJoin | Delayed | Active | Passive.'
  ),

  // For add-field on data-entity-extension: the mapped field's source binding.
  // fieldName (already defined above) is the entity-facing field name.
  dataField: z.string().optional().describe(
    'Source table field name for add-field on a data-entity-extension (e.g. "MyField"). Required alongside dataSource.'
  ),
  dataSource: z.string().optional().describe(
    'Source data-source/table name on the entity for add-field on a data-entity-extension (e.g. "MyTable"). Required alongside dataField.'
  ),

  // For modify-property
  propertyPath: z.string().optional().describe(
    'Property name to set. ' +
    'For tables (AxTable): TableGroup, TitleField1, TitleField2, TableType (TempDB/RegularTable/InMemory), ' +
    'CacheLookup, ClusteredIndex, PrimaryIndex, SaveDataPerCompany, Label, HelpText, Extends, SystemTable. ' +
    'For table-extensions (AxTableExtension): properties are stored inside <PropertyModifications> as ' +
    '<AxPropertyModification> entries. Supported: Label, HelpText, TableGroup, CacheLookup, TitleField1, TitleField2, ' +
    'ClusteredIndex, PrimaryIndex, SaveDataPerCompany, TableType, SystemTable, ' +
    'ModifiedDateTime (Yes/No), CreatedDateTime (Yes/No), ModifiedBy (Yes/No), CreatedBy (Yes/No), ' +
    'CountryRegionCodes (comma-separated, e.g. "CZ,SK"). ' +
    'For EDTs: Extends, StringSize, Label, HelpText, ReferenceTable, ReferenceField. ' +
    'For classes: Extends, Abstract, Final, Label. ' +
    'For nested properties use dot notation, e.g. "Fields.AxTableField.Name" (rare). ' +
    'Examples: propertyPath="TableGroup" propertyValue="Group"; propertyPath="TitleField1" propertyValue="ItemId"; ' +
    'propertyPath="TableType" propertyValue="TempDB"; propertyPath="Extends" propertyValue="WHSZoneId"; ' +
    'propertyPath="ModifiedDateTime" propertyValue="Yes" (table-extension); ' +
    'propertyPath="CountryRegionCodes" propertyValue="CZ,SK" (table-extension)'
  ),
  propertyValue: z.string().optional().describe('New property value'),
  
  // Options
  autoCorrect: z.boolean().optional().default(true).describe(
    'Apply a correction the server has already fully determined (exactly one valid reading, derivable ' +
    'from state the server holds) instead of failing the call — reported as a "Note:" line in the result. ' +
    'Set false for strict behaviour: every such case becomes an error again (eval harness / deterministic callers).'
  ),
  createBackup: z.boolean().optional().default(false).describe('Create a .bak backup of the file before modifying it (default: false). Changes can also be reverted with d365fo_file(action="undo") (git checkout) without a backup. When the file is NOT inside a git repository, a backup is created automatically even with false, since that undo would not work there.'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided). Pass this if the file was just created and is not yet indexed.'),
  packageName: z.string().optional().describe('Package name. Auto-resolved if omitted.'),
  packagePath: z.string().optional().describe(
    'Root packages path to search when the object lives outside the default PackagesLocalDirectory ' +
    '(e.g. a repo metadata checkout like "K:\\\\repos\\\\…\\\\metadata"). Used to locate the file for ' +
    'backup and the direct-XML fallback. NOTE: bridge-backed operations (add-method, add-field, etc.) ' +
    'resolve objects via the C# bridge, which is configured with fixed roots at startup — if the model ' +
    'is not under the bridge\'s roots, set context.customPackagesPath / D365FO_CUSTOM_PACKAGES_PATH so ' +
    'the bridge picks it up, or pass an explicit filePath.'
  ),
  workspacePath: z.string().optional().describe('Path to workspace for finding file'),
  filePath: z.string().optional().describe(
    'Absolute path to the XML file. Use this when the object was just created and the path is already known ' +
    '(e.g. from d365fo_file(action="create") output). Bypasses symbol DB lookup entirely.'
  ),
  // Defaulted TRUE to match the wire schema, which advertises
  // `addToProject: { default: true }` for the whole d365fo_file tool and tells
  // the caller to "keep the default". This defaulted false, so an agent that
  // followed that instruction — by omitting the parameter — silently got the
  // opposite. Editing an existing object that was on disk but absent from the
  // .rnrproj therefore never registered it, no matter how many times it was
  // edited. Registration is idempotent (ProjectFileManager skips an entry that
  // is already there) and targets the ACTIVE project: an element may be
  // referenced by several projects of a model, and the one being edited in has
  // to contain it.
  addToProject: z.boolean().optional().default(true).describe(
    'Add the modified file to the active .rnrproj when it is not already listed there. ' +
    'Keep the default — a project that does not contain the object cannot build or hand over the change. ' +
    'Set false to skip. Requires projectPath or solutionPath (explicit or via .mcp.json).'
  ),
  projectPath: z.string().optional().describe(
    'Path to .rnrproj file. Required for addToProject to work. Auto-detected from .mcp.json if omitted.'
  ),
  solutionPath: z.string().optional().describe(
    'Path to VS solution directory. Used to find .rnrproj when projectPath is not given.'
  ),
  groundingToken: z.string().optional().describe(
    'Provenance token returned by prepare(mode="change"). Proves the change was grounded in the indexed codebase. ' +
    'Required for *-extension objectTypes when GROUNDING_ENFORCE=true on the server.'
  ),

  // INTERNAL — set by runModifyBatch, absent from the published wire schema.
  //
  // Each entry of operations[] runs as its own modify call, so an operation
  // cannot see the ones travelling with it. That is fine for the writes, which
  // are independent, and wrong for the advisory notes, which are about the task:
  // add-field told the caller "send the group entry in the SAME call next time"
  // in a call that already contained the group entry. Advice that fires when it
  // has already been followed is how a response teaches an agent to stop reading
  // its warnings.
  peerOperations: z.array(z.string()).optional().describe(
    'Internal: the operation names travelling in the same operations[] batch.'
  ),

  // INTERNAL — set by runModifyBatch, absent from the published wire schema.
  //
  // The decisions only the BATCH can make. peerOperations says WHAT else travels
  // in the call; this says what this entry should therefore print. A batch adding
  // three fields repeated the identical 350-char BPErrorTableFieldNotInFieldGroup
  // paragraph three times, because an entry can only ever see itself.
  batchAdvice: z.object({
    suppressFieldGroupNote: z.boolean().optional(),
    fieldGroupNoteFields: z.array(z.string()).optional(),
  }).optional().describe('Internal: batch-level rendering decisions.'),
});

// ── Argument normalisation (pre-validation) ───────────────────────────
//
// Everything here runs on the RAW arguments, before the schema above sees them,
// and exists for one measured reason: a call the server can read in exactly one
// way must not cost a round trip. Every retry re-bills the whole cached context
// and drags the ~3,000-char parameter spec into it permanently.
//
// Each transformation is derived from the schema itself or from the op-spec's
// own alias/suggestion tables — never hard-coded per operation — so a new
// parameter is covered the day it is declared, and the key written is by
// construction the key the writer below reads.

/** Peel ZodOptional/ZodDefault/… wrappers off to the schema carrying the type. */
function unwrapZodType(schema: any): any {
  let inner = schema;
  while (inner?.def?.innerType) inner = inner.def.innerType;
  return inner;
}

/** Memoised: schema introspection is pure and the schema is a module constant. */
const arrayElementKeyCache = new Map<string, string | null>();

/**
 * The ONE required key of an array parameter's object element, or null.
 *
 * `indexFields` is declared as `[{ fieldName, direction? }]`, so `["ProbeId"]`
 * has exactly one sensible reading and the server already knows it — yet it
 * answered `indexFields.0: Invalid input: expected object, received string`
 * (reproduced live against the VM, as was the same failure on `fields`).
 *
 * TWO required keys means there is NO single reading: `relationConstraints`
 * ({fieldName, relatedFieldName}) and `mappingConnections` ({mapField,
 * mapFieldTo}) are deliberately left to error. Half a constraint is worse than a
 * refused call — the C# side writes the missing half as null, and it compiles.
 *
 * Read off the args schema rather than a per-operation table so the key produced
 * is the key the writer downstream reads. That is not hypothetical: a bridge
 * contract once read {type, edt} while the tool wrote {fieldType,
 * extendedDataType}, and the fields vanished under a ✅.
 */
function arrayElementSoleRequiredKey(param: string): string | null {
  const cached = arrayElementKeyCache.get(param);
  if (cached !== undefined) return cached;

  let answer: string | null = null;
  const field = (ModifyD365FileArgsSchema.shape as Record<string, any>)[param];
  const arr = unwrapZodType(field);
  if (arr?.def?.type === 'array') {
    const element = unwrapZodType(arr.def.element);
    if (element?.def?.type === 'object' && element.shape) {
      const required = Object.entries(element.shape as Record<string, any>)
        .filter(([, member]) => member?.safeParse?.(undefined).success !== true)
        .map(([name]) => name);
      if (required.length === 1) answer = required[0];
    }
  }
  arrayElementKeyCache.set(param, answer);
  return answer;
}

/** `["A","B"]` -> `[{ key: "A" }, { key: "B" }]`; the same array back when nothing applies. */
function coerceArrayElements(param: string, value: unknown): unknown {
  if (!Array.isArray(value) || !value.some(v => typeof v === 'string')) return value;
  const key = arrayElementSoleRequiredKey(param);
  if (!key) return value;
  return value.map(v => (typeof v === 'string' ? { [key]: v } : v));
}

/** Would this value survive validation as `param`? Guards every rename below. */
function fitsParamSchema(param: string, value: unknown): boolean {
  const field = (ModifyD365FileArgsSchema.shape as Record<string, any>)[param];
  return field ? field.safeParse(value).success === true : false;
}

/**
 * The one parameter an unrecognised key can be corrected to, or undefined.
 *
 * Unambiguous means either a single candidate, or a single REQUIRED candidate
 * among several — `name` on add-field matches both `fieldName` and
 * `fieldGroupName`, and only one of those is the parameter the operation cannot
 * run without. On add-field-to-field-group BOTH are required, so `name` stays
 * ambiguous there and the call keeps returning the full spec, which is correct.
 */
function soleCorrectionCandidate(operation: string, key: string): string | undefined {
  const candidates = paramCorrectionCandidates(operation, key);
  if (candidates.length === 1) return candidates[0];
  const required = D365FO_FILE_OP_SPECS[operation]?.required ?? [];
  const requiredCandidates = candidates.filter(c => required.includes(c));
  return requiredCandidates.length === 1 ? requiredCandidates[0] : undefined;
}

export interface ModifyArgNormalization {
  /** Arguments to validate, with aliases resolved and corrections applied. */
  args: Record<string, unknown>;
  /** Corrections to report as "Note:" lines in the successful result. */
  notes: string[];
}

/**
 * Resolve aliases and apply the corrections the server has already computed.
 *
 * Order matters and is not arbitrary: a key is renamed to the parameter it means
 * BEFORE its value is reshaped, because the target parameter is what decides the
 * shape — `add-field-group {fields:["A","B"]}` becomes `fieldGroupFields`
 * (array of string, nothing to reshape), while `add-index {indexFields:["A"]}`
 * keeps its name and gains the objects.
 *
 * autoCorrect=false keeps every correction off, so the eval harness and
 * deterministic callers see exactly the errors they see today. Alias resolution
 * is NOT a correction — it is the published contract (OP_PARAM_ALIASES, rendered
 * in every op spec) — so it applies either way and is not reported.
 */
export function normalizeModifyArgs(raw: Record<string, unknown>): ModifyArgNormalization {
  const operation = typeof raw.operation === 'string' ? raw.operation : '';
  const args: Record<string, unknown> = { ...raw };
  const notes: string[] = [];
  if (!D365FO_FILE_OP_SPECS[operation]) return { args, notes };

  const schemaKeys = ModifyD365FileArgsSchema.shape as Record<string, unknown>;

  // 1. Documented alias -> canonical spelling. A key the schema declares itself is
  //    never treated as an alias (methodCode is both an alias of sourceCode and a
  //    real parameter with its own precedence rule).
  for (const key of Object.keys(args)) {
    if (args[key] === undefined || key in schemaKeys) continue;
    const canonical = canonicalParamForAlias(operation, key);
    if (!canonical || args[canonical] !== undefined) continue;
    args[canonical] = args[key];
    delete args[key];
  }

  const autoCorrect = args.autoCorrect !== false;
  if (!autoCorrect) return { args, notes };

  // 2. The "did you mean" the server already computes, applied instead of
  //    printed. Live: add-field {name:"Note2", edt:"Notes"} answered
  //    "name: IGNORED … did you mean 'fieldName'?" and wrote nothing at all.
  const providedKeys = () => Object.keys(args).filter(k => args[k] !== undefined);
  for (const ignored of findIgnoredParams(operation, providedKeys())) {
    if (ignored.reason === 'not-honoured') continue;
    const target = soleCorrectionCandidate(operation, ignored.name);
    // Only when the target is free: a caller who sent BOTH spellings meant
    // something by it, and silently overwriting one with the other is a guess.
    if (!target || args[target] !== undefined) continue;
    const value = coerceArrayElements(target, args[ignored.name]);
    // A key wrong in NAME and in SHAPE is not one reading — let it error with the
    // full spec, which is the answer that call actually needs.
    if (!fitsParamSchema(target, value)) continue;
    args[target] = value;
    delete args[ignored.name];
    notes.push(
      `'${ignored.name}' is not a parameter of '${operation}' — applied as '${target}', ` +
      `its only candidate here.`,
    );
  }

  // 3. Array-of-object parameters sent as a plain list of names.
  for (const key of Object.keys(args)) {
    const coerced = coerceArrayElements(key, args[key]);
    if (coerced === args[key]) continue;
    args[key] = coerced;
    notes.push(
      `${key} was sent as a list of names — read as ` +
      `[{ ${arrayElementSoleRequiredKey(key)}: … }], the shape ${key} declares.`,
    );
  }

  return { args, notes };
}

/**
 * What the caller needs to know about a write that has already been reported.
 *
 * runModifyBatch uses it to do the per-FILE work once for the whole batch
 * instead of once per operation — see the trailer suppression at the end of this
 * function. Mirrors CreateOutcome, which exists for the same reason.
 */
export interface ModifyOutcome {
  /** Absolute path of the file the operation wrote. */
  filePath?: string;
  /** Identity AFTER name resolution, for the shared verification. */
  objectType?: string;
  objectName?: string;
  modelName?: string;
  /**
   * The extension this modify names does not exist yet, its BASE object does,
   * and creating it is the one action that turns the call into a success.
   *
   * Reported rather than performed: createD365File must not be imported here
   * (layer direction is pinned by tests/utils/layering.test.ts, because the two
   * largest files in the codebase importing each other is what made four
   * read-only tools load the write path), and the dispatcher in d365foFile.ts
   * already composes create -> operations[]. Going through the ordinary create
   * path is the point — path containment, prefixing, .rnrproj registration, the
   * model guards and the direct-XML fallbacks all still apply.
   */
  createExtensionFirst?: { objectType: string; objectName: string };
}

export async function modifyD365FileTool(
  request: CallToolRequest,
  context: XppServerContext,
  outcome?: ModifyOutcome,
) {
  const timer = createPhaseTimer();
  try {
    // Aliases resolved and single-reading corrections applied BEFORE validation:
    // every one of these used to be a hard error whose only content was the
    // 3,000-char spec of the operation the caller had already named.
    const normalized = normalizeModifyArgs((request.params.arguments ?? {}) as Record<string, unknown>);
    const args = ModifyD365FileArgsSchema.parse(normalized.args);

    // ── Silent-parameter-drop guard (corpus cluster #35, #6) ─────────────────
    // The published schema advertises a free-form `params` object and the Zod
    // schema STRIPS unknown keys, so a misspelled or misplaced parameter used to
    // disappear without a trace while the op still answered "✅ … modified".
    // Account for every key: either the operation consumes it, or the caller is
    // told it was dropped. Measured on the NORMALISED keys, so a key that has
    // just been corrected is not also reported as ignored.
    const rawArgs = normalized.args;
    const providedKeys = Object.keys(rawArgs).filter(k => rawArgs[k] !== undefined);
    const ignoredParams = findIgnoredParams(String(args.operation), providedKeys);
    const ignoredParamsWarning = renderIgnoredParamsWarning(String(args.operation), ignoredParams);

    // A call that carries none of the params that would mutate anything must not
    // report success: `modify-field {fieldName, mandatory:true}` (wrong key —
    // it is fieldMandatory) wrote nothing and still answered
    // "✅ Field 'Description' modified via IMetaTableProvider.Update".
    const missingMutation = findMissingMutationParams(String(args.operation), providedKeys);
    if (missingMutation.length > 0) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ '${args.operation}' was called with no parameter that changes anything — nothing would be written.\n` +
            `Pass at least one of: ${missingMutation.join(', ')}.\n` +
            (ignoredParamsWarning ? `\n${ignoredParamsWarning}\n` : '') +
            `\n${renderOpSpec(String(args.operation))}`,
        }],
        isError: true,
      };
    }

    // Decode XML entities in X++ payloads. An AI that copied entity-encoded code (an
    // SSRS <Text> block, or escaped doc comments like "/// &lt;summary&gt;") sends
    // &lt;/&gt;/&amp;/&quot;/&apos;; the serializer would otherwise write them literally
    // into the source. No-op for clean X++ — literal <, >, && and " are not entities.
    if (args.sourceCode) args.sourceCode = decodeXmlEntitiesFromXppSource(args.sourceCode);
    if ((args as any).methodCode) (args as any).methodCode = decodeXmlEntitiesFromXppSource((args as any).methodCode);
    if (args.newCode) args.newCode = decodeXmlEntitiesFromXppSource(args.newCode);
    if (args.oldCode) args.oldCode = decodeXmlEntitiesFromXppSource(args.oldCode);

    // objectName is optional when filePath is given — derive it from the file
    // basename using path.win32.basename (handles Windows backslash paths on
    // all platforms — path.posix.basename treats '\\' as a regular character).
    if (!args.objectName) {
      if (args.filePath) {
        (args as any).objectName = path.win32.basename(args.filePath, '.xml');
      } else {
        return {
          content: [{
            type: 'text',
            text: "❌ Provide 'objectName' — or 'filePath', from which the object name is derived.",
          }],
          isError: true,
        };
      }
    }

    // Grounding enforcement: modifying an extension changes the behaviour of an
    // existing base object — when GROUNDING_ENFORCE=true the model must prove
    // (via prepare_change) that it inspected the real object first.
    if (args.objectType.endsWith('-extension')) {
      const groundingError = enforceGrounding(
        args.groundingToken,
        `d365fo_file(action="modify", objectType="${args.objectType}", objectName="${args.objectName}", operation="${args.operation}")`,
        args.objectName,
      );
      if (groundingError) return groundingError;
    }

    // Semantic reference gate: when GROUNDING_ENFORCE=true, every identifier in
    // X++ source about to be written must be proven against the symbol index.
    const xppToWrite = args.sourceCode ?? args.methodCode ?? args.newCode;
    const referenceError = gateOnReferenceErrors(
      xppToWrite,
      context.symbolIndex,
      `d365fo_file(action="modify", objectType="${args.objectType}", objectName="${args.objectName}", operation="${args.operation}")`,
    );
    if (referenceError) return referenceError;

    // CDATA-corruption guard: any X++ payload that will be CDATA-wrapped by the
    // serializer (add-method's source) or spliced into an existing CDATA block
    // (replace-code's newCode) must be clean X++ — never a slice of .xml markup.
    // A "]]>" or stray <Method>/<Source> in the payload otherwise survives into
    // the file and produces the invalid doubled-"]]>" / dropped-</Method> shape.
    assertCleanXppSource(args.sourceCode, 'sourceCode');
    assertCleanXppSource((args as any).methodCode, 'methodCode');
    assertCleanXppSource(args.newCode, 'newCode');

    // add-method emits exactly one <Method>; reject a payload carrying multiple
    // methods (the extras would land outside the class → invalid X++). Only for the
    // method-adding operations — replace-code's newCode is a snippet, not a method.
    if (['add-method', 'add-display-method', 'add-table-method'].includes(args.operation)) {
      const methodSrc = args.sourceCode ?? (args as any).methodCode;
      // add-method may carry several methods — they are split and added one <Method>
      // at a time below. add-display-method / add-table-method generate a single
      // method, so multiple bodies there are still a mistake.
      if (args.operation !== 'add-method') {
        assertSingleMethodSource(methodSrc);
      }
      // Derive methodName from the source signature when omitted — the full method
      // source already contains the name (e.g. "public static X find(...)" → "find").
      // Skip derivation when the payload holds multiple methods (handled per-method).
      if (!args.methodName && countTopLevelMethodBodies(methodSrc ?? '') <= 1) {
        const derived = extractMethodNameFromSource(methodSrc);
        if (derived) {
          args.methodName = derived;
          console.error(`[modify_d365fo_file] methodName omitted — derived '${derived}' from the source signature`);
        }
      }
    }

    const { symbolIndex } = context;
    const {
      objectType,
      operation,
      createBackup,
      modelName,
      workspacePath,
      filePath: explicitFilePath,
    } = args;
    // objectName guaranteed non-null by the derivation block above.
    // Declared as `let` so it can be corrected from the resolved file basename below.
    let objectName = args.objectName!;

    // ── Auto-resolve parentControl for add-control on form-extension ─────────
    // When `parentControl` is a fuzzy / lowercase string (e.g. "general"), look
    // up the base form XML, walk the control tree, and resolve to the exact name.
    // This makes add-control seamless — no prior get_object_info(form) call required.
    let addControlNote = '';
    let generationNote = '';

    // Corrections applied instead of a refusal (see AUTO-CORRECT below). Rendered
    // into the success payload so the agent still learns the right call, and so the
    // behaviour stays auditable.
    const autoCorrect = args.autoCorrect !== false;
    const autoCorrectNotes: string[] = [];
    // Corrections made before validation (aliases, wrong key names, list-of-names
    // arrays) report through the same channel as the ones made below.
    for (const note of normalized.notes) noteAutoCorrection(autoCorrectNotes, note);

    if (operation === 'add-control' && objectType === 'form-extension' && args.parentControl) {
      const resolution = await resolveParentControl(
        objectName,
        args.parentControl,
        symbolIndex,
        (args as any).baseFormName,
      );

      if (resolution && 'multiple' in resolution) {
        const candidateList = resolution.multiple
          .slice(0, 20)
          .map(c =>
            `  • \`${c.name}\`` +
            (c.parentName ? ` (parent: \`${c.parentName}\`)` : '') +
            ` — path: ${c.pathStr}`
          )
          .join('\n');
        return {
          content: [{
            type: 'text',
            text:
              `⚠️ **Ambiguous parentControl** — "${args.parentControl}" matches multiple controls in the base form.\n\n` +
              `**Candidates** (${resolution.multiple.length}):\n${candidateList}\n\n` +
              `Re-call \`add-control\` with the exact \`parentControl\` name from the list above.`,
          }],
          isError: true,
        };
      }

      if (resolution && 'resolved' in resolution) {
        if (resolution.resolved !== args.parentControl) {
          addControlNote = `\n\n> 🔍 **parentControl** auto-resolved: \`"${args.parentControl}"\` → \`"${resolution.resolved}"\` (${resolution.pathStr})`;
        } else {
          addControlNote = `\n\n> ✅ **parentControl** \`"${resolution.resolved}"\` confirmed in base form (${resolution.pathStr})`;
        }
        (args as any).parentControl = resolution.resolved;
      }
      // null → form not found or no match; proceed with original value (compiler will catch it)
    }

    // ── DataGroup pre-flight for add-control ──────────────────────────────────
    // A parent carrying <DataGroup> is filled by the compiler from that table
    // field group. A hand-added bound control there duplicates the generated
    // one — an error that exists only after compilation, so it cannot be found
    // by inspecting the XML on disk.
    if (
      operation === 'add-control' &&
      (objectType === 'form' || objectType === 'form-extension') &&
      args.parentControl &&
      (args as any).controlDataField
    ) {
      const baseFormName =
        objectType === 'form'
          ? objectName
          : ((args as any).baseFormName || objectName.split('.')[0]);
      const baseXml = await findBaseFormXml(baseFormName, symbolIndex);
      if (baseXml) {
        const dgVerdict = await checkAddControlAgainstDataGroup(
          baseXml,
          args.parentControl,
          (args as any).controlDataField,
          (args as any).controlName,
        );
        if (dgVerdict) {
          const field = (args as any).controlDataField;
          const onTable = dgVerdict.dataSource ? ` on \`${dgVerdict.dataSource}\`` : '';
          if (isFormPatternEnforceEnabled()) {
            return {
              content: [{
                type: 'text',
                text:
                  `⛔ add-control blocked — parent control "${args.parentControl}" renders field group ` +
                  `**${dgVerdict.dataGroup}**${onTable} via \`<DataGroup>\`.\n\n` +
                  `The compiler generates one control per member of that field group, named ` +
                  `\`${dgVerdict.generatedName}\`. Adding \`${field}\` to the field group AND an explicit ` +
                  `control for it fails the build with "The duplicate name '${dgVerdict.generatedName}' ` +
                  `was detected"` +
                  (dgVerdict.exactNameCollision
                    ? ` — and your \`controlName\` is exactly that generated name, so this is certain.\n\n`
                    : `.\n\n`) +
                  `That duplicate is NOT visible in the XML on disk — only one of the two controls is ` +
                  `ever written to a file.\n\n` +
                  `Do this instead:\n` +
                  `  1. Add the field to the field group only — d365fo_file(action="modify", ` +
                  `objectType="table-extension", operations=[{operation:"add-field-to-field-group", ` +
                  `fieldGroupName:"${dgVerdict.dataGroup}", fieldName:"${field}", extendBaseFieldGroup:true}]). ` +
                  `The control appears on the form by itself; no form extension is needed.\n` +
                  `  2. Only if you need a different position, type or properties: keep this add-control, ` +
                  `but remove ${field} from field group ${dgVerdict.dataGroup} first.\n` +
                  `  3. Set FORM_PATTERN_ENFORCE=false to bypass this check.`,
              }],
              isError: true,
            };
          }
          addControlNote +=
            `\n\n> ⚠️ DataGroup warning: parent "${args.parentControl}" renders field group ` +
            `${dgVerdict.dataGroup} via <DataGroup>, which generates \`${dgVerdict.generatedName}\`. ` +
            `If ${field} is also in that field group the build fails with a duplicate-name error. ` +
            `FORM_PATTERN_ENFORCE is disabled — proceeding anyway.`;
        }
      }
    }

    // ── Form-pattern pre-flight for add-control ───────────────────────────────
    // When the parent container declares a sub-pattern (e.g. FieldsFieldGroups),
    // verify the new control's type is allowed there. Blocking when
    // FORM_PATTERN_ENFORCE is enabled (default); advisory note otherwise.
    if (
      operation === 'add-control' &&
      (objectType === 'form' || objectType === 'form-extension') &&
      args.parentControl &&
      (args as any).controlType
    ) {
      const baseFormName =
        objectType === 'form'
          ? objectName
          : ((args as any).baseFormName || objectName.split('.')[0]);
      const baseXml = await findBaseFormXml(baseFormName, symbolIndex);
      if (baseXml) {
        const verdict = await checkAddControlAgainstParentPattern(
          baseXml,
          args.parentControl,
          (args as any).controlType,
        );
        if (verdict && !verdict.allowed) {
          const allowedList = verdict.allowedTypes === 'any' ? 'any' : verdict.allowedTypes.join(', ');
          if (isFormPatternEnforceEnabled()) {
            return {
              content: [{
                type: 'text',
                text:
                  `⛔ add-control blocked — parent control "${args.parentControl}" follows sub-pattern ` +
                  `**${verdict.parentPattern}**, which does not allow a "${(args as any).controlType}" child.\n\n` +
                  `Allowed control types here: ${allowedList}.\n\n` +
                  `Options:\n` +
                  `  1. Use an allowed control type (e.g. controlType="String" for a bound field).\n` +
                  `  2. Target a different parent container (use get_object_info(objectType="form", name=...) to inspect the hierarchy).\n` +
                  `  3. Set FORM_PATTERN_ENFORCE=false to bypass pattern enforcement.`,
              }],
              isError: true,
            };
          }
          addControlNote +=
            `\n\n> ⚠️ Pattern warning: parent "${args.parentControl}" follows ${verdict.parentPattern}, ` +
            `which does not allow "${(args as any).controlType}" children (allowed: ${allowedList}). ` +
            `FORM_PATTERN_ENFORCE is disabled — proceeding anyway.`;
        }
      }
    }

    // add-diagnostic-suppression is the one operation allowed to target a file
    // that does not exist yet: a model that has never suppressed anything before
    // has no {Model}_BPSuppressions.xml on disk at all, and this operation is
    // what writes the first one. Every other operation edits an object `create`
    // already wrote, so a missing file there is a real resolution failure.
    const targetMayNotExistYet =
      objectType === 'ignore-diagnostic-list' && operation === 'add-diagnostic-suppression';

    // 1. Find the file
    let filePath = await findD365File(symbolIndex, objectType, objectName, modelName, workspacePath, explicitFilePath, args.packagePath);

    // Lookup gates every candidate on existence, so for that one operation a miss
    // is the ordinary first-suppression case rather than a failure. Fall back to
    // where the file WOULD be — the same layout the lookup searched — instead of
    // answering with "not found, re-run action=create", which cannot create this
    // type at all (it is absent from create's own objectType enum).
    if (!filePath && targetMayNotExistYet) {
      filePath = await expectedD365FilePath(objectType, objectName, modelName, args.packagePath);
      if (filePath) {
        console.error(
          `[modify_d365fo_file] '${objectName}' does not exist yet — add-diagnostic-suppression will create it at ${filePath}`,
        );
      }
    }

    // ── A not-yet-created extension is a create, not a dead end ──────────────
    // The old answer offered four retry options and not one of them was "create
    // it", although the extension name had already been normalised and its path
    // computed. The logs show the consequence: the same modify re-sent against
    // the same *_Extension object, failing identically every time.
    //
    // The extension is created through the ORDINARY create path, so path
    // containment, prefixing, .rnrproj registration, the model guards and the
    // direct-XML fallbacks all still apply — nothing here writes a file itself.
    if (!filePath && objectType.endsWith('-extension')) {
      const verdict = await timer.time('missing-extension check', () =>
        missingExtensionVerdict(args as Record<string, unknown>, objectType, objectName, operation, symbolIndex));
      if (verdict.refusal) {
        return { content: [{ type: 'text', text: verdict.refusal }], isError: true };
      }
      if (verdict.createFirst && autoCorrect && outcome) {
        // The dispatcher creates it and re-runs this call. The error below is
        // still what a DIRECT caller of this function gets, and it now names the
        // one call that works instead of four lookup options that cannot.
        outcome.createExtensionFirst = verdict.createFirst;
      }
      if (verdict.createFirst) {
        throw new Error(
          `${objectType} "${objectName}" does not exist yet (its base object does).\n\n` +
          `Create it and apply the same edit in ONE call:\n  ` +
          renderCreateWithOperations(objectType, objectName, operation, args as Record<string, unknown>),
        );
      }
    }

    if (!filePath) {
      throw new Error(
        `File not found for ${objectType} "${objectName}".\n\n` +
        `Retry options (do NOT use PowerShell — this tool can handle it):\n` +
        `  1. Pass modelName="<YourModel>" — triggers filesystem lookup by path.\n` +
        `  2. Pass packagePath="<root that contains the model>" if the metadata lives outside the default PackagesLocalDirectory (e.g. a repo checkout).\n` +
        `  3. Pass filePath="K:\\\\AosService\\\\PackagesLocalDirectory\\\\<pkg>\\\\<model>\\\\${objectName}.xml" — bypasses all lookup.\n` +
        `  4. If the object was just created, re-run d365fo_file(action="create") first and use the returned path as filePath.\n\n` +
        `If the file exists but bridge operations still fail to resolve the object, the C# bridge's metadata roots ` +
        `(fixed at startup) likely don't include this model — set context.customPackagesPath / D365FO_CUSTOM_PACKAGES_PATH and restart the server.`
      );
    }

    // 1a. Path containment guard — every write target must live under a configured
    //     <PackagesLocalDirectory>/<Package>/<Model>/Ax<Type>/<File>.xml layout.
    //     Refuses path traversal via explicit filePath or JSON sourcePath (security-critical).
    //     A caller-supplied packagePath (metadata outside PLD, e.g. a repo checkout) is
    //     honored as an allowed root — findD365File already resolves against it, so the
    //     containment list must include it too or valid writes get wrongly rejected.
    const extraRoots = args.packagePath ? [args.packagePath] : undefined;
    const containment = await assertWritePathAllowed(filePath, modelName, { extraRoots });
    if (!containment.ok) {
      throw new Error(containment.reason || 'Path containment check failed');
    }

    // 1b. Model-ownership guard: refuse to modify objects in standard Microsoft models.
    // This prevents accidental writes to ApplicationSuite, ApplicationFoundation, etc.
    const resolvedModelFromPath = extractModelFromFilePath(filePath);
    if (resolvedModelFromPath && isStandardModel(resolvedModelFromPath)) {
      const configManager = getConfigManager();
      const configuredModel = modelName || configManager.getModelName();
      // Only block if the resolved model differs from the user's explicitly configured model.
      // If user explicitly set modelName=ApplicationSuite, they know what they're doing.
      if (!modelName || modelName !== resolvedModelFromPath) {
        throw new Error(
          `⛔ Refusing to modify "${objectName}" — the resolved file belongs to standard Microsoft model "${resolvedModelFromPath}".\n\n` +
          `Your configured model is "${configuredModel || '(not set)'}".\n` +
          `Modifying standard objects is not permitted — it can corrupt the base application.\n\n` +
          `To extend a standard object, create an extension instead:\n` +
          `  • Table: d365fo_file(action="create", objectType="table-extension", objectName="${objectName}.${configuredModel || 'YourModel'}Extension")\n` +
          `  • Class: d365fo_file(action="create", objectType="class-extension", objectName="${objectName}_Extension")\n` +
          `  • Form:  d365fo_file(action="create", objectType="form-extension", objectName="${objectName}.${configuredModel || 'YourModel'}Extension")`
        );
      }
    }

    // 1c. Cross-model guard: the object is custom, but owned by a DIFFERENT custom
    // model than the one this workspace targets (shared "Core" model vs. the country
    // model that extends it). Editing it in place silently changes code the active
    // model only consumes — the wanted change is an extension in the active model.
    // Ownership comes from the path's <Model> segment, not the <Package> segment
    // used above: one package can carry several models.
    const owningModel = containment.modelSegment ?? null;
    // The write ANCHOR, not the active model: a get_workspace_info project switch
    // moves reads, and must not move what this guard measures writes against.
    // Resolved, not read synchronously: where the model comes only from the
    // background .rnrproj scan, the sync getter can still be null here — and a
    // null anchor makes the guard stand down.
    const activeModel = await resolveAnchorModel(getConfigManager());
    const crossModelCheck = {
      objectName,
      objectType,
      owningModel,
      owningPackage: containment.packageSegment ?? resolvedModelFromPath,
      activeModel,
      toolSwitchedModel: getConfigManager().getToolProjectSwitch()?.forcedModel ?? null,
      action: 'modify' as const,
      existingExtensions: findExtensionsInModel(
        symbolIndex,
        baseObjectOf(objectName, objectType),
        activeModel,
      ),
    };
    const crossModelRefusal = crossModelWriteRefusal(crossModelCheck);
    if (crossModelRefusal) {
      throw new Error(crossModelRefusal);
    }
    // Allowed, but possibly not into this model — see standDownNotice.
    const crossModelNotice = standDownNotice(crossModelCheck);

    // 2. Resolve actual XML file path (DB may store JSON metadata with sourcePath)
    let actualFilePath = filePath;
    let targetFileExists = true;
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const trimmed = fileContent.trimStart();
      if (trimmed.startsWith('{')) {
        const data = JSON.parse(fileContent);
        if (data.sourcePath) {
          // Re-validate the indirect path: sourcePath also comes from user-influenced data.
          const srcContainment = await assertWritePathAllowed(data.sourcePath, modelName, { extraRoots });
          if (!srcContainment.ok) {
            throw new Error(`sourcePath rejected: ${srcContainment.reason}`);
          }
          actualFilePath = srcContainment.canonicalPath || data.sourcePath;
        } else {
          throw new Error(`Metadata file has no sourcePath: ${filePath}`);
        }
      }
    } catch (readError) {
      if (readError instanceof SyntaxError || (readError instanceof Error && readError.message.includes('sourcePath'))) {
        throw readError;
      }
      if (targetMayNotExistYet && (readError as NodeJS.ErrnoException)?.code === 'ENOENT') {
        targetFileExists = false;
      } else {
        const isRelative = !path.isAbsolute(filePath);
        const hint = isRelative
          ? ' The path is relative — the symbol DB returned a build-agent path. ' +
            'Pass filePath="<absolute path>" or modelName="<YourModel>" so the tool can locate the file on disk.'
          : '';
        throw new Error(`Cannot read file: ${filePath}${hint}`);
      }
    }

    // 3. Create backup of the actual XML file. When the target is NOT inside a
    //    git work tree, the documented undo path (undo_last_modification →
    //    git checkout) cannot revert the change — force a backup even with
    //    createBackup=false so a bad modify is never unrecoverable. Skipped
    //    outright when the file does not exist yet: there is nothing to back up.
    const backupNote = targetFileExists ? await ensureRecoverableModification(actualFilePath, createBackup) : '';

    // 3b. Derive the authoritative object name from the resolved file path.
    //     The caller may pass objectName="RentEquipment" while the file on disk
    //     is ContosoRentEquipment.xml (auto-prefixed at create time). The C# bridge
    //     resolves objects by name from its metadata model — if the name doesn't
    //     match the file it will always return null, regardless of refreshes.
    //     Use path.win32.basename so Windows backslash paths are handled correctly
    //     on all platforms (path.posix.basename treats '\\' as a regular character).
    const fileBaseName = path.win32.basename(actualFilePath, '.xml');
    const bridgeObjectName = fileBaseName !== objectName ? fileBaseName : objectName;
    if (bridgeObjectName !== objectName) {
      console.error(
        `[modify_d365fo_file] ℹ️  objectName "${objectName}" → resolved to "${bridgeObjectName}" from file basename`,
      );
      objectName = bridgeObjectName;
    }

    // ── Bridge-only modify via IMetadataProvider.Update() ────────────────────
    // ALL modify operations go through the C# bridge. The bridge reads, modifies,
    // and writes via the official D365FO metadata API — no xml2js needed.
    // If the bridge is unavailable or fails, we throw an error (no fallback).
    if (!context?.bridge) {
      throw new Error(
        'C# metadata bridge is not available. The bridge is required for all modify operations.\n' +
        'Start the bridge by building the D365MetadataBridge project and restarting the MCP server.'
      );
    }
    if (!canBridgeModify(objectType, operation)) {
      throw new Error(`Operation '${operation}' on object type '${objectType}' is not supported by the bridge.`);
    }

    // The field name as the caller spelled it, before the prefix below rewrites it:
    // the enum-name derivation in add-field matches against the UNPREFIXED name
    // (a field named after its enum is prefixed, the enum it names is not).
    const preprefixFieldName = typeof args.fieldName === 'string' ? args.fieldName : undefined;

    // Members added INSIDE an extension must carry the model's prefix — an
    // extension lives in your model but its host object is Microsoft's, so an
    // unprefixed field/index/enum value collides with anything Microsoft or
    // another ISV adds to the same host later. Microsoft's naming guideline
    // spells this out ("Fields in extensions → {Prefix}{FieldName}") and BP
    // rejects the unprefixed form. This is applied once, here, so every writer
    // below (bridge op and direct-XML fallback alike) sees the final name.
    const memberPrefixNote = applyExtensionMemberPrefix(
      args,
      objectType,
      operation,
      // The MODEL segment, not the package: members added to an extension must
      // carry the prefix of the model that owns the extension file (ContosoFinanceSK
      // → ContosoSK_), and a package can hold a model whose prefix differs.
      containment.modelSegment || resolvedModelFromPath || modelName || getConfigManager().getModelName() || '',
    );
    if (memberPrefixNote) generationNote += memberPrefixNote;

    // The other half of that rename: an operation that REFERS to a member the
    // prefix has already renamed. add-field-to-field-group mints no name, so it
    // is rightly absent from the table above — but it names the field the
    // add-field before it just renamed, and pointed the group at a field that
    // does not exist. Corrected here, where the extension's real fields can be
    // read, and only when there is one reading (see the helper).
    if (autoCorrect) {
      const retargetNote = await resolveFieldNameForFieldGroup(
        args as Record<string, any>,
        objectType,
        operation,
        containment.modelSegment || resolvedModelFromPath || modelName || getConfigManager().getModelName() || '',
        actualFilePath,
        symbolIndex,
      );
      if (retargetNote) noteAutoCorrection(autoCorrectNotes, retargetNote);

      // Raw label TEXT on fieldLabel / fieldGroupLabel / enumValueLabel becomes a
      // real @LabelFile:Id here rather than a BP advisory the caller has to spend
      // a `labels` round trip (or three) acting on. See autoResolveOperationLabels.
      const labelNotes = await timer.time('label auto-resolve', () => autoResolveOperationLabels(
        args as Record<string, unknown>,
        {
          model: containment.modelSegment || resolvedModelFromPath || modelName ||
            getConfigManager().getModelName() || '',
          packagePath: args.packagePath,
          projectPath: (args as Record<string, unknown>).projectPath as string | undefined,
        },
        symbolIndex,
      ));
      for (const note of labelNotes) noteAutoCorrection(autoCorrectNotes, note);
    }

    // Settle a rebuild an earlier create/modify scheduled but did not wait for, so
    // an object written moments ago resolves on the FIRST attempt. Without this the
    // retry loop below would still recover — at the cost of a wasted bridge round
    // trip plus a full rebuild. Free when no write is outstanding.
    await timer.time('provider refresh (pending writes)', () => debouncedRefresh.flush());

    let bridgeResult: { success: boolean; message: string; viaXmlFallback?: boolean } | null = null;
    /** File content captured before a replace-code, to diff the reply against. */
    let replaceCodeBefore: string | null = null;
    let _bridgeRetried = false;
    // Retry loop: on the first null result with all required params present,
    // refresh the bridge provider (picks up objects created this session) and
    // re-run the operation once. Max 1 auto-refresh retry (_bridgeRetried guard).
    const bridgeStartedAt = Date.now();
    _bridgeRetry: do {
      bridgeResult = null;

    switch (operation) {
      case 'add-method': {
        // sourceCode and methodCode are aliases; sourceCode wins when both are set.
        const methodSource = args.sourceCode ?? (args as any).methodCode;
        if (methodSource) {
          // A single call may carry several methods — split and add each as its own
          // <Method> so callers don't have to issue one tool call per method.
          const bodies = countTopLevelMethodBodies(methodSource) > 1
            ? splitTopLevelMethodBodies(methodSource)
            : [methodSource];

          if (bodies.length > 1) {
            const added: string[] = [];
            let lastResult: { success: boolean; message: string } | null = null;
            for (const body of bodies) {
              const mName = extractMethodNameFromSource(body);
              if (!mName) {
                // A body without a derivable method name is typically a class/extension declaration
                // (e.g. "[ExtensionOf(tableStr(T))] final class T_Extension { }"). Such blocks are
                // NOT methods and do not belong in add-method — skip and continue.
                // The regex handles: optional attribute block(s) → optional modifiers (final/abstract/
                // public/static/…) → class or interface keyword.
                const trimmed = body.trim();
                if (/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|final|abstract|static|internal|sealed)\s+)*(?:class|interface)\b/i.test(trimmed)) {
                  console.warn(`[add-method] Skipping class/interface declaration block (not a method): ${trimmed.slice(0, 80)}...`);
                  continue;
                }
                throw new Error(
                  `⛔ add-method: could not derive a method name from one of the ${bodies.length} method bodies. ` +
                  `Ensure each method has a complete signature (e.g. "public void foo()").`,
                );
              }
              lastResult = await bridgeAddMethod(context.bridge, objectType, objectName, mName, body);
              if (!lastResult) {
                throw new Error(
                  `Bridge add-method failed for '${mName}' (${added.length} of ${bodies.length} method(s) added successfully: ${added.join(', ') || 'none'}).`,
                );
              }
              added.push(mName);
            }
            // Summarize as a single result for the downstream success message.
            bridgeResult = lastResult
              ? { ...lastResult, message: `Added ${added.length} methods: ${added.join(', ')}` }
              : null;
          } else if (args.methodName) {
            bridgeResult = await bridgeAddMethod(
              context.bridge,
              objectType,
              objectName,
              args.methodName,
              methodSource,
            );
          }
        }
        break;
      }
      case 'add-display-method': {
        // Explicit source wins; otherwise generate a stub from displayMethodReturnEdt.
        let methodSource = args.sourceCode ?? (args as any).methodCode;
        const methodName = args.methodName;
        if (!methodSource && methodName && (args as any).displayMethodReturnEdt) {
          methodSource = generateDisplayMethodSource(
            methodName,
            (args as any).displayMethodReturnEdt,
          );
          generationNote =
            `\n\n> 🔧 Display method \`${methodName}\` generated returning ` +
            `\`${(args as any).displayMethodReturnEdt}\` (stub — fill in the computation).`;
        }
        if (methodName && methodSource) {
          bridgeResult = await bridgeAddMethod(
            context.bridge,
            objectType,
            objectName,
            methodName,
            methodSource,
          );
        }
        break;
      }
      case 'add-table-method': {
        // Explicit source wins; otherwise generate from tableMethodType.
        let methodSource = args.sourceCode ?? (args as any).methodCode;
        let methodName = args.methodName;
        if (!methodSource && (args as any).tableMethodType) {
          const gen = generateTableMethodSource(
            objectName,
            (args as any).tableMethodType,
            (args as any).tableKeyField,
            symbolIndex.getReadDb(),
          );
          methodName = gen.methodName;
          methodSource = gen.source;
          generationNote =
            `\n\n> 🔧 Table method \`${gen.methodName}\` generated from ` +
            `tableMethodType="${(args as any).tableMethodType}".` +
            (gen.note ? `\n> ${gen.note}` : '');
        }
        // When caller supplies custom source (methodCode/sourceCode) + tableMethodType
        // but omits methodName, the method name equals the tableMethodType value
        // (find / exist / findByRecId / validateWrite / validateDelete / initValue).
        if (!methodName && (args as any).tableMethodType && methodSource) {
          methodName = (args as any).tableMethodType as string;
        }
        if (methodName && methodSource) {
          bridgeResult = await bridgeAddMethod(
            context.bridge,
            objectType,
            objectName,
            methodName,
            methodSource,
          );
        }
        break;
      }
      case 'remove-method': {
        if (args.methodName) {
          bridgeResult = await bridgeRemoveMethod(
            context.bridge,
            objectType,
            objectName,
            args.methodName,
          );
        }
        break;
      }
      case 'add-field': {
        // A data-entity-extension field is an AxDataEntityViewMappedField
        // (Name/DataField/DataSource/Label/Mandatory) — it has no EDT and no base type,
        // so none of the fieldType/fieldBaseType resolution below applies. It goes
        // through the same bridge op with the mapped-field binding attached; the bridge
        // routes on that binding, not on the object name.
        if (objectType === 'data-entity-extension' && args.fieldName) {
          const dataField = (args as any).dataField as string | undefined;
          const dataSource = (args as any).dataSource as string | undefined;
          if (!dataField || !dataSource) {
            return {
              content: [{
                type: 'text',
                text:
                  `❌ add-field on a data-entity-extension needs BOTH dataField and dataSource — ` +
                  `nothing was written.\n` +
                  `A mapped field has no EDT of its own: it names an entity-side field (fieldName) that ` +
                  `points at dataField on the entity data source dataSource.\n` +
                  `Half of the binding serialises fine and then fails to compile, so it is refused here.\n` +
                  `\n${renderOpSpec('add-field')}`,
              }],
              isError: true,
            };
          }
          bridgeResult = await bridgeAddField(
            context.bridge,
            objectName,
            args.fieldName,
            '',              // no base type — the mapped-field path ignores it
            undefined,       // no EDT
            args.fieldMandatory,
            args.fieldLabel,
            { dataField, dataSource, fieldGroupName: (args as any).fieldGroupName },
          );
          // Same-session fallback, same shape as add-index/add-control: the bridge
          // provider resolves against metadata roots fixed at startup, so an extension
          // CREATED THIS SESSION reports "not found" no matter what (ec07ca3).
          if (!bridgeResult || !bridgeResult.success) {
            const xmlFallbackResult = await directXmlAddDataEntityExtensionField(
              actualFilePath,
              args.fieldName,
              dataField,
              dataSource,
              args.fieldLabel,
              (args as any).fieldGroupName,
            );
            if (xmlFallbackResult) bridgeResult = viaXmlFallback(xmlFallbackResult);
          }
          break;
        }
        // Everything else is an AxTableField. `required` on add-field is only fieldName
        // (the mapped-field path above has no fieldType at all), so the type-specific half
        // of the contract is enforced here instead of silently falling through to a null
        // bridge result and a generic "required parameters may be missing".
        let enumTypeArg = ((args as any).fieldEnumType as string | undefined)?.trim() || undefined;

        // fieldType is an EDT NAME here. In `create` the sibling key fields[].fieldType is
        // the XML element name ("AxTableFieldEnum"), and that collision gets carried over
        // into add-field, where it used to be accepted and produce a bare AxTableFieldString
        // referencing a non-existent EDT — a wrong field, discovered only at build time.
        // Anchored on the metamodel's own container names, not on "starts with Ax
        // and contains Field": that broader shape also rejected any legitimate EDT
        // whose name happens to read that way, and refusing a valid EDT is the
        // same class of wrong answer this check exists to prevent.
        if (args.fieldType && /^Ax(Table|View|Query|Map|DataEntityView)[A-Za-z]*Field[A-Za-z0-9]*$/i.test(args.fieldType)) {
          // ── AUTO-CORRECT ──────────────────────────────────────────────────
          // The *Enum element is the one member of that family that names its own
          // fix: it says "this is an enum field", and the enum itself is either in
          // the same payload (fieldEnumType) or is the field's own name confirmed
          // as an enum in the symbol index. Both leave exactly ONE valid reading,
          // so apply it. Every other element name (AxTableFieldString, …) carries
          // no EDT to derive and still errors.
          const derivedEnum = autoCorrect
            ? resolveEnumForFieldElement(args.fieldType, enumTypeArg, [args.fieldName, preprefixFieldName], symbolIndex)
            : undefined;
          if (derivedEnum) {
            noteAutoCorrection(
              autoCorrectNotes,
              `fieldType="${args.fieldType}" is an XML element name; treated as fieldEnumType="${derivedEnum}". ` +
              `Pass fieldEnumType (and no fieldType) for an enum field.`,
            );
            enumTypeArg = derivedEnum;
            args.fieldType = undefined;   // an enum field takes no EDT
          } else {
            return {
              content: [{
                type: 'text',
                text:
                  `❌ fieldType="${args.fieldType}" is an XML element name, not an EDT — nothing was written.\n` +
                  `On add-field, fieldType is the EDT NAME (e.g. "TransDate", "ItemId"); the XML element is ` +
                  `chosen from fieldBaseType.\n` +
                  `For an enum field pass fieldEnumType="<enum name>" instead — no EDT is needed:\n` +
                  `  d365fo_file(action="modify", objectType="${objectType}", objectName="…", ` +
                  `operation="add-field", fieldName="${args.fieldName ?? 'MyField'}", fieldEnumType="MyEnum")\n` +
                  `\n${renderOpSpec('add-field')}`,
              }],
              isError: true,
            };
          }
        }

        if (args.fieldName && !args.fieldType && !enumTypeArg) {
          const mappedOnly = (args as any).dataField || (args as any).dataSource;
          return {
            content: [{
              type: 'text',
              text:
                (mappedOnly
                  ? `❌ dataField/dataSource describe a data-entity mapped field and do not apply to ` +
                    `objectType="${objectType}" — nothing was written.\n` +
                    `On a table or table-extension a field needs fieldType (its EDT), or ` +
                    `fieldEnumType for an enum field.\n`
                  : `❌ add-field on objectType="${objectType}" requires fieldType (the EDT), or ` +
                    `fieldEnumType for an enum field — nothing was written.\n`) +
                `\n${renderOpSpec('add-field')}`,
            }],
            isError: true,
          };
        }

        // Enum field: AxTableFieldEnum + <EnumType>, and NO EDT — an enum-typed table
        // field does not need one. Requiring an EDT here is what used to send callers off
        // building an AxEdtEnum wrapper, guessing at <Extends>, and failing the build twice
        // before getting there. fieldType stays accepted for the rarer "enum EDT" case.
        if (args.fieldName && enumTypeArg) {
          bridgeResult = await bridgeAddField(
            context.bridge,
            objectName,
            args.fieldName,
            'Enum',
            args.fieldType,      // usually undefined; an enum EDT when the caller has one
            args.fieldMandatory,
            args.fieldLabel,
          );
          // EnumType is set in a second call on purpose: the bridge's AddField RPC has no
          // enumType parameter, while ModifyField does. Doing it here keeps this a
          // single tool call for the caller AND works with the bridge already deployed —
          // no rebuild, which is the part that silently keeps the old binary.
          if (bridgeResult?.success) {
            const enumSet = await bridgeModifyField(
              context.bridge,
              objectName,
              args.fieldName,
              { enumType: enumTypeArg },
            );
            if (enumSet && !enumSet.success) {
              // Undo the half-written field. Two calls are not atomic, and what
              // they can leave behind — an AxTableFieldEnum with no enum — is a
              // field the caller did not ask for. Worse, the bridge's AddField
              // does not check for an existing field, so an agent that reads
              // "failed" and simply repeats the call ends up with the field
              // twice. Rolling back restores the pre-call state, which is the
              // only state a failed operation may leave.
              const undone = await bridgeRemoveField(context.bridge, objectName, args.fieldName);
              bridgeResult = {
                success: false,
                message: undone?.success
                  ? `EnumType could not be set (${enumSet.message}) — the field was rolled back and ` +
                    `nothing was written. Check that enum "${enumTypeArg}" exists ` +
                    `(get_object_info objectType="enum"), then retry add-field.`
                  : `Field '${args.fieldName}' was created but EnumType could not be set ` +
                    `(${enumSet.message}), and rolling the field back failed too. The field is an ` +
                    `AxTableFieldEnum with no enum — do NOT repeat add-field, it would add a SECOND ` +
                    `field of the same name. Fix it with operation="modify-field", ` +
                    `fieldEnumType="${enumTypeArg}", or remove it with operation="remove-field".`,
              };
            }
          }
          break;
        }

        if (args.fieldName && args.fieldType) {
          // fieldType is the EDT name; fieldBaseType is the primitive base type.
          // When fieldBaseType is omitted, auto-resolve it from the symbol index so the
          // correct AxTableField XML element is emitted. Always pass fieldType as edtName
          // so the <ExtendedDataType> reference is always written — previously, omitting
          // fieldBaseType left edtName undefined and produced fields with no EDT reference.
          const edtName = args.fieldType;
          let baseType: string = (args as any).fieldBaseType ?? '';
          if (!baseType) {
            try {
              const rdb = symbolIndex.getReadDb();
              baseType = resolveEdtBaseTypeForField(edtName, rdb);
            } catch {
              baseType = edtName; // bridge will apply its own name heuristics
            }
          }
          bridgeResult = await bridgeAddField(
            context.bridge,
            objectName,
            args.fieldName,
            baseType,
            edtName,
            args.fieldMandatory,
            args.fieldLabel,
          );
        }
        break;
      }
      case 'modify-field': {
        if (args.fieldName) {
          // Map the field-* params onto the bare prop keys the bridge expects.
          const fieldProps: Record<string, string> = {};
          if ((args as any).fieldLabel) fieldProps.label = (args as any).fieldLabel;
          if ((args as any).fieldHelpText) fieldProps.helpText = (args as any).fieldHelpText;
          if ((args as any).fieldMandatory !== undefined) fieldProps.mandatory = String((args as any).fieldMandatory);
          if ((args as any).fieldType) fieldProps.edt = (args as any).fieldType;
          if ((args as any).fieldEnumType) fieldProps.enumType = (args as any).fieldEnumType;
          if ((args as any).fieldStringSize) fieldProps.stringSize = String((args as any).fieldStringSize);
          bridgeResult = await bridgeModifyField(
            context.bridge,
            objectName,
            args.fieldName,
            Object.keys(fieldProps).length > 0 ? fieldProps : undefined,
          );
        }
        break;
      }
      case 'rename-field': {
        if (args.fieldName && (args as any).fieldNewName) {
          bridgeResult = await bridgeRenameField(
            context.bridge,
            objectName,
            args.fieldName,
            (args as any).fieldNewName,
          );
        }
        break;
      }
      case 'remove-field': {
        if (args.fieldName) {
          bridgeResult = await bridgeRemoveField(
            context.bridge,
            objectName,
            args.fieldName,
          );
        }
        break;
      }
      case 'replace-all-fields': {
        if ((args as any).fields) {
          const rawFields: any[] = (args as any).fields;
          const resolvedFields = rawFields.map((f: any) => {
            if (!f.type && f.edt) {
              try {
                const rdb = symbolIndex.getReadDb();
                return { ...f, type: resolveEdtBaseTypeForField(f.edt, rdb) };
              } catch {
                return f;
              }
            }
            return f;
          });
          bridgeResult = await bridgeReplaceAllFields(
            context.bridge,
            objectName,
            resolvedFields,
          );
        }
        break;
      }
      case 'add-index': {
        if ((args as any).indexName) {
          // indexFields is documented (Zod + MCP schema) as [{ fieldName, direction? }],
          // but the bridge's addIndex expects a flat string[] of field names. Map the
          // objects to their fieldName here — passing the objects straight through makes
          // the C# side deserialize [{fieldName:…}] into List<string>, which throws and
          // surfaces as a null bridge result (misreported as "could not resolve table").
          const indexFieldNames: string[] | undefined = Array.isArray((args as any).indexFields)
            ? (args as any).indexFields.map((f: any) => (typeof f === 'string' ? f : f?.fieldName)).filter(Boolean)
            : undefined;
          // indexAllowDuplicates / indexAlternateKey are booleans on the wire, but
          // the AxTable XML value is No/Yes — callers naturally pass the STRING and
          // used to get a bare "expected boolean" rejection (#27). Accept both.
          const allowDuplicates = coerceNoYesFlag((args as any).indexAllowDuplicates);
          const alternateKey = coerceNoYesFlag((args as any).indexAlternateKey);
          bridgeResult = await bridgeAddIndex(
            context.bridge,
            objectName,
            (args as any).indexName,
            indexFieldNames,
            allowDuplicates,
            alternateKey,
          );
          // Fallback: the bridge's AddIndex resolves the table via
          // _provider.Tables.Read, whose metadata roots are fixed at startup, so a
          // table CREATED THIS SESSION reports "Table '<name>' not found" — even
          // after update_symbol_index and even when an explicit filePath was
          // supplied (see corpus L2-error-handling-infolog / L3-workflow-document-
          // submit). Rather than push the agent into the forbidden whole-file
          // overwrite (which also drops allowDuplicates/alternateKey — #35), write
          // the index straight into the on-disk XML.
          if (!bridgeResult || !bridgeResult.success) {
            const xmlFallbackResult = await directXmlAddIndex(
              actualFilePath,
              (args as any).indexName,
              indexFieldNames,
              allowDuplicates,
              alternateKey,
            );
            if (xmlFallbackResult) bridgeResult = viaXmlFallback(xmlFallbackResult);
          }
        }
        break;
      }
      case 'remove-index': {
        if ((args as any).indexName) {
          bridgeResult = await bridgeRemoveIndex(
            context.bridge,
            objectName,
            (args as any).indexName,
          );
        }
        break;
      }
      case 'add-full-text-index': {
        if ((args as any).indexName) {
          // indexFields carries the same [{fieldName}] shape add-index documents.
          const fullTextFields: string[] | undefined = Array.isArray((args as any).indexFields)
            ? (args as any).indexFields.map((f: any) => (typeof f === 'string' ? f : f?.fieldName)).filter(Boolean)
            : undefined;
          bridgeResult = await bridgeAddFullTextIndex(
            context.bridge,
            objectName,
            (args as any).indexName,
            fullTextFields,
          );
        }
        break;
      }
      case 'remove-full-text-index': {
        if ((args as any).indexName) {
          bridgeResult = await bridgeRemoveFullTextIndex(
            context.bridge,
            objectName,
            (args as any).indexName,
          );
        }
        break;
      }
      case 'add-table-mapping': {
        if ((args as any).mapName) {
          bridgeResult = await bridgeAddTableMapping(
            context.bridge,
            objectName,
            (args as any).mapName,
            (args as any).mappingTable,
            (args as any).mappingConnections,
          );
        }
        break;
      }
      case 'remove-table-mapping': {
        if ((args as any).mapName) {
          bridgeResult = await bridgeRemoveTableMapping(
            context.bridge,
            objectName,
            (args as any).mapName,
          );
        }
        break;
      }
      case 'add-relation': {
        if ((args as any).relationName && (args as any).relatedTable) {
          // relationConstraints is documented as [{ fieldName, relatedFieldName }], but the
          // bridge/C# WriteRelationConstraint deserializes the JSON keys { field, relatedField }.
          // Without this remap the keys don't match: C# sees no `field`/`relatedField`, leaves
          // both null, and silently writes a relation with EMPTY constraints (no hard error —
          // the corruption only surfaces at compile time). Map the field names explicitly.
          const constraints: Array<{ field?: string; relatedField?: string }> | undefined =
            Array.isArray((args as any).relationConstraints)
              ? (args as any).relationConstraints.map((c: any) => ({
                  field: c?.field ?? c?.fieldName,
                  relatedField: c?.relatedField ?? c?.relatedFieldName,
                }))
              : undefined;
          const relationProperties = {
            relationCardinality: (args as any).relationCardinality ?? 'ZeroMore',
            relatedTableCardinality: (args as any).relatedTableCardinality ?? 'ExactlyOne',
            relationshipType: (args as any).relationshipType ?? 'Association',
          };
          bridgeResult = await bridgeAddRelation(
            context.bridge,
            objectName,
            (args as any).relationName,
            (args as any).relatedTable,
            constraints,
            relationProperties,
          );
          // The bridge now sets Cardinality/RelatedTableCardinality/RelationshipType
          // through the provider (verified on the VM: they serialise in the SDK's own
          // element order). Dropping them is what raised
          // BPErrorTableRelationshipPropertiesCompleteness on a relation reported as
          // added, with no repair path — modify-property rejects
          // Relations/<name>/RelationshipType (findings #5 / #35).
          //
          // The on-disk writer stays as the fallback for an OLD bridge binary, which
          // ignores the new params without complaint; it no-ops when the properties are
          // already present, so the bridge path costs one file read.
          if (bridgeResult?.success && !(bridgeResult as any).propertiesWritten) {
            const relProps = await directXmlEnsureRelationProperties(
              actualFilePath,
              (args as any).relationName,
              relationProperties.relationCardinality,
              relationProperties.relatedTableCardinality,
              relationProperties.relationshipType,
            );
            if (relProps && relProps.applied.length > 0) {
              bridgeResult = {
                success: true,
                message: `${bridgeResult.message} (+ ${relProps.applied.join(', ')} written directly to the XML)`,
              };
            }
          }
        }
        break;
      }
      case 'remove-relation': {
        if ((args as any).relationName) {
          bridgeResult = await bridgeRemoveRelation(
            context.bridge,
            objectName,
            (args as any).relationName,
          );
        }
        break;
      }
      case 'add-delete-action':
      case 'remove-delete-action': {
        // No bridge op exists for DeleteActions (#36) — this is the only path.
        const daName = (args as any).deleteActionName ?? (args as any).deleteActionTable;
        if (daName) {
          bridgeResult = viaXmlFallback(await directXmlDeleteAction(
            actualFilePath,
            operation === 'add-delete-action' ? 'add' : 'remove',
            daName,
            (args as any).deleteActionTable,
            (args as any).deleteActionType,
          ));
        }
        break;
      }
      case 'add-field-group': {
        if ((args as any).fieldGroupName) {
          bridgeResult = await bridgeAddFieldGroup(
            context.bridge,
            objectName,
            (args as any).fieldGroupName,
            (args as any).fieldGroupLabel,
            (args as any).fieldGroupFields,
          );
        }
        break;
      }
      case 'remove-field-group': {
        if ((args as any).fieldGroupName) {
          bridgeResult = await bridgeRemoveFieldGroup(
            context.bridge,
            objectName,
            (args as any).fieldGroupName,
          );
        }
        break;
      }
      case 'add-field-to-field-group': {
        if ((args as any).fieldGroupName && args.fieldName) {
          const groupName = (args as any).fieldGroupName as string;
          const extendFlag = (args as any).extendBaseFieldGroup as boolean | undefined;
          bridgeResult = await bridgeAddFieldToFieldGroup(
            context.bridge,
            objectName,
            groupName,
            args.fieldName,
            extendFlag,
          );

          // ── AUTO-CORRECT ────────────────────────────────────────────────────
          // The bridge refuses with a message that states its own fix: the group is
          // absent from the extension's own <FieldGroups>, so if the BASE table
          // defines it, <FieldGroupExtensions> is the only place the field can go.
          // Confirm that against the base table's XML before acting — the bridge
          // does not check it, and creating a FieldGroupExtension for a group that
          // exists nowhere would write metadata no form ever reads.
          // Only when the caller left extendBaseFieldGroup unset: an explicit
          // false is a decision, not an omission.
          if (
            autoCorrect &&
            extendFlag === undefined &&
            objectType === 'table-extension' &&
            bridgeResult && !bridgeResult.success &&
            isBaseFieldGroupMissError(bridgeResult.message)
          ) {
            const baseTable = objectName.split('.')[0];
            if (await baseObjectDefinesFieldGroup(baseTable, groupName, symbolIndex)) {
              const retried = await bridgeAddFieldToFieldGroup(
                context.bridge,
                objectName,
                groupName,
                args.fieldName,
                true,
              );
              if (retried?.success) {
                bridgeResult = retried;
                noteAutoCorrection(
                  autoCorrectNotes,
                  `'${groupName}' is defined by the base table "${baseTable}"; extended it through ` +
                  `<FieldGroupExtensions> instead of creating a new group. ` +
                  `Pass extendBaseFieldGroup=true for a base-table group.`,
                );
              }
            }
          }
        }
        break;
      }
      case 'modify-property': {
        if (args.propertyPath && args.propertyValue !== undefined) {
          // ── Form extension targeting a BASE-FORM control ─────────────────────
          // Must run BEFORE the bridge: a control-level request handed to the
          // generic property writer lands in the extension's ROOT
          // <PropertyModifications>, i.e. it hides/relabels the WHOLE FORM and
          // reports success. The base form's controls live in
          // <ControlModifications>, a different collection nothing else writes.
          // See formExtensionControlModifications.ts (eval case
          // L2-form-control-removal-lifecycle).
          if (objectType === 'form-extension') {
            const target = resolveControlPropertyTarget(
              args.propertyPath,
              (args as { controlName?: string }).controlName,
            );
            if (target) {
              const beforeXml = await fs.readFile(actualFilePath, 'utf-8');
              const outcome = upsertFormExtensionControlProperty(
                beforeXml.replace(/^﻿/, ''),
                target.controlName,
                target.propertyName,
                String(args.propertyValue),
              );
              if (!outcome.ok) {
                return {
                  content: [{
                    type: 'text',
                    text:
                      `❌ Could not modify '${target.controlName}.${target.propertyName}' on ` +
                      `${objectName}: ${outcome.reason}\n\n` +
                      `A base-form control is customised through <ControlModifications>, not the ` +
                      `extension's own properties — writing it as an extension property would change ` +
                      `the whole form.`,
                  }],
                  isError: true,
                };
              }
              if (outcome.changed) {
                await writeFileAtomic(actualFilePath, normalizeD365Xml(outcome.xml));
              }
              bridgeResult = viaXmlFallback({
                success: true,
                message:
                  `${outcome.changed ? '✅' : 'ℹ️'} ${outcome.detail} on base-form control ` +
                  `'${target.controlName}' (written to <ControlModifications>` +
                  `${outcome.changed ? '' : '; already in that state, nothing written'}). ` +
                  `File: ${actualFilePath}`,
              });
              break;
            }
          }

          // ── Semantic guard for AxEdtExtension property changes ───────────────
          // D365FO silently accepts illegal extension edits (e.g. widening
          // StringSize on a derived EDT) but the change is ineffective at
          // runtime and corrupts the metadata model. Block them here with a
          // clear explanation of the proper alternative.
          if (objectType === 'edt-extension') {
            const guard = await validateEdtExtensionChange(
              objectName,
              args.propertyPath,
              String(args.propertyValue),
              symbolIndex.getReadDb(),
              context.bridge,
            );
            if (!guard.ok) {
              return {
                content: [{ type: 'text', text: guard.message ?? 'EDT extension change rejected.' }],
                isError: true,
              };
            }
          }

          bridgeResult = await bridgeSetProperty(
            context.bridge,
            objectType,
            objectName,
            args.propertyPath,
            args.propertyValue,
          );

          // Fallback: some object types (confirmed: AxForm) are rejected by the
          // bridge outright for modify-property even though the property is a
          // plain text element trivially editable by string replacement.
          if (!bridgeResult || !bridgeResult.success) {
            const xmlFallbackResult = await directXmlModifyProperty(
              actualFilePath, args.propertyPath, String(args.propertyValue),
              describeBridgeFallbackReason(context.bridge, objectType, 'modify-property', bridgeResult),
            );
            if (xmlFallbackResult) {
              bridgeResult = viaXmlFallback(xmlFallbackResult);
            }
          }
        }
        break;
      }
      case 'replace-code': {
        // Auto-detect common mistake: agent sends sourceCode/methodCode instead of oldCode/newCode
        const hasOldNew = args.oldCode && args.newCode !== undefined;
        const sentSourceCode = args.sourceCode || (args as any).methodCode;
        
        if (!hasOldNew && sentSourceCode) {
          throw new Error(
            `⛔ replace-code requires 'oldCode' and 'newCode' — NOT 'sourceCode'/'methodCode'.\n\n` +
            `You sent sourceCode/methodCode but replace-code needs:\n` +
            `  • oldCode = the exact existing snippet to find\n` +
            `  • newCode = the replacement snippet\n\n` +
            `Example:\n` +
            `  d365fo_file(action="modify", objectType="form", objectName="MyForm",\n` +
            `    operation="replace-code",\n` +
            `    methodName="PostButton.clicked",\n` +
            `    oldCode="ttsbegin;",\n` +
            `    newCode="")\n\n` +
            `If you want to replace an entire existing method, pass the full old method source as oldCode and the full new method source as newCode so the edit stays in place. Use remove-method + add-method only when you intentionally want a remove/add operation.`
          );
        }
        
        if (hasOldNew) {
          // Decided before the bridge's replace-ALL semantics act on it.
          const beforeContent = await readForMatching(actualFilePath);
          if (beforeContent !== null) {
            replaceCodeBefore = beforeContent;
            const verdict = preflightReplaceCode(beforeContent, args.oldCode!, args.newCode!);
            if (verdict?.kind === 'refuse') throw new Error(verdict.message);
            if (verdict?.kind === 'noop') {
              // An already-correct file is a success; "oldCode not found" would
              // read as "the file is still wrong" and invite a retry.
              return {
                content: [{
                  type: 'text',
                  text:
                    `✅ ${operation} on ${objectType} "${objectName}" — no change needed.\n\n` +
                    `**File:** ${actualFilePath}\n${verdict.message}`,
                }],
              };
            }
          }

          // Try bridge first
          bridgeResult = await bridgeReplaceCode(
            context.bridge,
            objectType,
            objectName,
            args.methodName,
            args.oldCode!,
            args.newCode!,
          );

          // Fallback: if bridge returns null (unsupported type or not connected)
          // or success=false (SDK couldn't find the code — e.g. form control override),
          // do direct string replacement in the XML file.
          // This handles form control override methods which the SDK may not expose.
          if (!bridgeResult || !bridgeResult.success) {
            const xmlFallbackResult = await directXmlReplaceCode(
              actualFilePath, args.oldCode!, args.newCode!,
              describeBridgeFallbackReason(context.bridge, objectType, 'replace-code', bridgeResult),
            );
            if (xmlFallbackResult) {
              bridgeResult = viaXmlFallback(xmlFallbackResult);
            }
          }
        } else {
          throw new Error(
            `replace-code requires both 'oldCode' and 'newCode' parameters.\n` +
            `  oldCode: ${args.oldCode ? 'provided' : '⛔ MISSING'}\n` +
            `  newCode: ${args.newCode !== undefined ? 'provided' : '⛔ MISSING'}\n` +
            `Note: 'sourceCode' is NOT an alias for replace-code — you must use 'oldCode' and 'newCode'.\n\n` +
            renderOpSpec('replace-code')
          );
        }
        break;
      }
      case 'add-enum-value': {
        if ((args as any).enumValueName !== undefined) {
          bridgeResult = await bridgeAddEnumValue(
            context.bridge,
            objectName,
            (args as any).enumValueName,
            (args as any).enumValueInt ?? 0,
            (args as any).enumValueLabel,
            (args as any).enumValueCountryRegionCodes,
          );
        }
        break;
      }
      case 'modify-enum-value': {
        if ((args as any).enumValueName) {
          const evProps: Record<string, string> = {};
          if ((args as any).enumValueNewName) evProps.name = (args as any).enumValueNewName;
          if ((args as any).enumValueLabel) evProps.label = (args as any).enumValueLabel;
          if ((args as any).enumValueInt !== undefined) evProps.value = String((args as any).enumValueInt);
          bridgeResult = await bridgeModifyEnumValue(
            context.bridge,
            objectName,
            (args as any).enumValueName,
            Object.keys(evProps).length > 0 ? evProps : undefined,
          );
        }
        break;
      }
      case 'remove-enum-value': {
        if ((args as any).enumValueName) {
          bridgeResult = await bridgeRemoveEnumValue(
            context.bridge,
            objectName,
            (args as any).enumValueName,
          );
        }
        break;
      }
      case 'add-control': {
        if ((args as any).controlName && (args as any).parentControl) {
          const resolvedControlType =
            (args as any).controlType
            ?? resolveControlTypeForField(
                 (args as any).controlDataSource,
                 (args as any).controlDataField,
                 symbolIndex?.getReadDb?.(),
               )
            ?? 'String';
          // The bridge's AddControl resolves its target via _provider.Forms, which
          // never contains a form EXTENSION (keyed "Base.Suffix" in FormExtensions).
          // Calling it would always fail with 'Form "<ext>" not found' and log a
          // bridge error for a call that cannot succeed, so extensions go straight
          // to the XML writer. Metadata-root freshness is not a factor either way.
          const isFormExtension = objectType === 'form-extension';

          if (!isFormExtension) {
            bridgeResult = await bridgeAddControl(
              context.bridge,
              objectName,
              (args as any).controlName,
              (args as any).parentControl,
              resolvedControlType,
              (args as any).controlDataSource,
              (args as any).controlDataField,
              (args as any).controlLabel,
            );
          }

          if (isFormExtension && (!bridgeResult || !bridgeResult.success)) {
            const xmlFallbackResult = await directXmlAddControl(
              actualFilePath,
              (args as any).controlName,
              (args as any).parentControl,
              resolvedControlType,
              (args as any).controlDataSource,
              (args as any).controlDataField,
              (args as any).controlLabel,
              (args as any).previousSibling,
              (args as any).positionType,
            );
            if (xmlFallbackResult) bridgeResult = viaXmlFallback(xmlFallbackResult);
          }
        }
        break;
      }
      case 'remove-control': {
        // No bridge op exists for control removal (neither form nor extension) —
        // this is the only path, so the XML writer is called directly rather than
        // as a fallback behind a bridge attempt that cannot exist.
        if ((args as any).controlName) {
          bridgeResult = viaXmlFallback(await directXmlRemoveControl(
            actualFilePath,
            (args as any).controlName,
            (args as any).removeSeparator,
          ));
        }
        break;
      }
      case 'add-entry-point': {
        // Security objects have no bridge write path at all (see the writer).
        const epObject = (args as any).entryPointObjectName;
        const epType = (args as any).entryPointObjectType;
        if (epObject && epType) {
          bridgeResult = viaXmlFallback(await directXmlAddEntryPoint(actualFilePath, {
            objectName: epObject,
            objectType: epType,
            name: (args as any).entryPointName,
            accessLevel: (args as any).accessLevel,
          }));
        }
        break;
      }
      case 'remove-entry-point': {
        // Security objects have no bridge write path at all (see the writer).
        const epName = (args as any).entryPointName;
        const epObject = (args as any).entryPointObjectName;
        if (epName || epObject) {
          bridgeResult = viaXmlFallback(await directXmlRemoveEntryPoint(actualFilePath, {
            name: epName,
            objectName: epObject,
            objectType: (args as any).entryPointObjectType,
          }));
        }
        break;
      }
      case 'remove-diagnostic-suppression': {
        // Not an AOT object at all — no bridge write path exists (see the writer).
        const diagnosticPath = (args as any).diagnosticPath;
        if (diagnosticPath) {
          bridgeResult = viaXmlFallback(await directXmlRemoveDiagnosticSuppression(actualFilePath, {
            path: diagnosticPath,
            moniker: (args as any).diagnosticMoniker,
          }));
        }
        break;
      }
      case 'add-diagnostic-suppression': {
        // Not an AOT object at all — no bridge write path exists (see the writer).
        if ((args as any).diagnosticMoniker) {
          bridgeResult = viaXmlFallback(await directXmlAddDiagnosticSuppression(actualFilePath, {
            moniker: (args as any).diagnosticMoniker,
            path: (args as any).diagnosticPath,
            elementType: (args as any).diagnosticElementType,
            elementName: (args as any).diagnosticElementName,
            justification: (args as any).diagnosticJustification,
            message: (args as any).diagnosticMessage,
            severity: (args as any).diagnosticSeverity,
            itemSpecific: (args as any).diagnosticItemSpecific,
          }));
        }
        break;
      }
      case 'add-data-source': {
        if ((args as any).dataSourceName && (args as any).dataSourceTable) {
          bridgeResult = await bridgeAddDataSource(
            context.bridge,
            objectType,
            objectName,
            (args as any).dataSourceName,
            (args as any).dataSourceTable,
            (args as any).joinSource,
            (args as any).linkType,
          );
        }
        break;
      }
      case 'add-query-range': {
        // No bridge API exists for this — direct XML is the only path.
        if ((args as any).dataSourceName && (args as any).rangeField) {
          const rangeField: string = (args as any).rangeField;
          const rangeName: string = (args as any).rangeName || rangeField;
          const rangeValue: string = (args as any).rangeValue ?? '';
          bridgeResult = viaXmlFallback(await directXmlAddQueryRange(
            actualFilePath,
            (args as any).dataSourceName,
            rangeField,
            rangeName,
            rangeValue,
          ));
        }
        break;
      }
      case 'remove-query-range': {
        // No bridge API exists for this — direct XML is the only path.
        if ((args as any).dataSourceName && (args as any).rangeName) {
          bridgeResult = viaXmlFallback(await directXmlRemoveQueryRange(
            actualFilePath,
            (args as any).dataSourceName,
            (args as any).rangeName,
          ));
        }
        break;
      }
      case 'add-field-modification': {
        if (args.fieldName) {
          bridgeResult = await bridgeAddFieldModification(
            context.bridge,
            objectName,
            args.fieldName,
            (args as any).fieldLabel,
            (args as any).fieldMandatory,
          );
        }
        break;
      }
      case 'add-menu-item-to-menu': {
        if ((args as any).menuItemToAdd) {
          bridgeResult = await bridgeAddMenuItemToMenu(
            context.bridge,
            objectName,
            (args as any).menuItemToAdd,
            (args as any).menuItemToAddType,
          );
          // Fallback: bridge requires the menu to exist in its loaded metadata roots.
          // Newly created menus aren't there yet — write directly to the XML file.
          if (!bridgeResult || !bridgeResult.success) {
            const xmlFallbackResult = await directXmlAddMenuItemToMenu(
              actualFilePath,
              (args as any).menuItemToAdd,
              (args as any).menuItemToAddType ?? 'display',
            );
            if (xmlFallbackResult) {
              bridgeResult = viaXmlFallback(xmlFallbackResult);
            }
          }
        }
        break;
      }
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }

    if (!bridgeResult) {
      // Required params + full per-op specs live in the central registry
      // (d365foFileOpSpecs.ts) — the published schema only advertises a
      // free-form `params` object, so this error must carry the whole spec.
      const required = getRequiredParams(operation);
      // Treat a supplied alias as satisfying the requirement.
      const isProvided = (p: string) =>
        (args as any)[p] !== undefined || (OP_PARAM_ALIASES[p] ?? []).some(a => (args as any)[a] !== undefined);
      const missing = required.filter(p => !isProvided(p));

      // Auto-refresh retry: all required params are present but bridge returned
      // null — the object was likely written this session and isn't in the
      // bridge's metadata model yet (roots are fixed at startup). Refresh once
      // and re-run the operation. Afterwards the normal error path takes over.
      if (missing.length === 0 && !_bridgeRetried && context.bridge) {
        console.error(
          `[modify_d365fo_file] ⚠️ '${operation}' on '${objectName}' returned null — ` +
          `refreshing bridge provider and retrying once`,
        );
        try { await bridgeRefreshProvider(context.bridge); } catch { /* best-effort */ }
        _bridgeRetried = true;
        continue _bridgeRetry;
      }

      // Two distinct causes produce a null bridge result; pick the message that
      // matches reality instead of always blaming missing parameters.
      if (missing.length > 0) {
        const missingList = missing.map(p => `  ⛔ ${p}: MISSING`);
        const providedList = required.filter(isProvided).map(p => `  ✅ ${p}: provided`);
        throw new Error(
          `Bridge operation '${operation}' returned null — required parameters are missing.\n` +
          `Required parameters for '${operation}':\n${[...providedList, ...missingList].join('\n')}\n` +
          `Provided args: ${Object.keys(args).filter(k => (args as any)[k] !== undefined).join(', ')}\n\n` +
          renderOpSpec(operation)
        );
      }

      // All required params were supplied, yet the bridge returned null (it never
      // attempted the op — e.g. provider not ready). Surface the actionable
      // same-session resolution guidance.
      throw new Error(unresolvedObjectError(operation, objectType, objectName, actualFilePath));
    }

    // Bridge executed but reported failure. A resolution failure (object created
    // this session, not yet in the provider's fixed-root model) gets the same
    // one-shot refresh+retry the null path gets; any other failure falls through
    // to the real-message throw below — no longer masked as a generic guess.
    if (
      !bridgeResult.success &&
      !_bridgeRetried &&
      context.bridge &&
      // A refusal from this server's own XML writer never touched the bridge, so
      // there is no provider state a refresh could change — replaying it costs a
      // provider reload and a full retry to reach the identical answer.
      !bridgeResult.viaXmlFallback &&
      isUnresolvedObjectError(bridgeResult.message)
    ) {
      console.error(
        `[modify_d365fo_file] ⚠️ '${operation}' on '${objectName}' failed (${bridgeResult.message}) — ` +
        `refreshing bridge provider and retrying once`,
      );
      try { await bridgeRefreshProvider(context.bridge); } catch { /* best-effort */ }
      _bridgeRetried = true;
      continue _bridgeRetry;
    }
    break _bridgeRetry;
    // Labelled retry loop: every exit is an explicit `break _bridgeRetry`, so the
    // condition is deliberately unconditional.
    // biome-ignore lint/correctness/noConstantCondition: labelled retry loop, exits via break
    } while (true); // end of retry loop
    timer.add(`C# bridge ${operation}`, Date.now() - bridgeStartedAt);

    if (!bridgeResult!.success) {
      // A refusal from this server's own XML writer is not a bridge failure and
      // must not be rendered as one. Naming an API that never ran is the problem
      // viaXmlFallback was added to fix on the success branch; on this branch it
      // also sends the reader after provider and metadata-root causes that cannot
      // apply, past a message that already says exactly what to do.
      if (bridgeResult!.viaXmlFallback) throw new Error(bridgeResult!.message);

      // Surface the real bridge error. For an object-resolution failure keep the
      // actionable same-session fallback guidance, now including exactly what the
      // bridge reported instead of a generic "could not resolve" guess.
      if (isUnresolvedObjectError(bridgeResult!.message)) {
        throw new Error(
          unresolvedObjectError(operation, objectType, objectName, actualFilePath, bridgeResult!.message),
        );
      }
      let opErrorMsg = `Bridge operation '${operation}' failed: ${bridgeResult!.message}`;
      if (operation === 'add-control' && /parent control .* not found/i.test(bridgeResult!.message ?? '')) {
        opErrorMsg +=
          `\n\n💡 The ${objectType} '${objectName}' WAS found — only the parent container was not.\n` +
          `  • To add a control at the TOP LEVEL of the form design, pass parentControl="Design".\n` +
          `  • Otherwise list the existing containers first: get_object_info(objectType="${objectType}", name="${objectName}")\n` +
          `    and pass the exact container name (e.g. a Tab, TabPage, Group or Grid) as parentControl.\n` +
          `  • Do not rewrite the whole object from hand-authored XML — it loses metadata the ` +
          `provider writes for you. Fix the parentControl instead.`;
      }
      if (operation === 'replace-code' && /oldCode not found/i.test(bridgeResult!.message ?? '')) {
        opErrorMsg +=
          `\n\n💡 Tip: The oldCode must match the exact source currently on disk.\n` +
          `  • Fetch the current source first: get_object_info(objectType="${objectType}", name="${objectName}")\n` +
          `  • Then copy the exact snippet from the output as oldCode.\n` +
          `  • Alternative: use add-method with the complete new method body — it overwrites the existing method.`;
      }
      throw new Error(opErrorMsg);
    }

    console.error(`[modify_d365fo_file] ✅ Bridge ${operation}: ${bridgeResult.message}`);

    const bridgeValidation = '';
    // Schedule the provider rebuild so the NEXT read sees this write — toolHandler's
    // flush() settles it before the following bridge-backed call. This used to happen
    // only as a side effect INSIDE bridgeValidateAfterWrite, so it has to be explicit
    // now that the validation no longer runs by default.
    if (context.bridge) void debouncedRefresh.refresh(context.bridge);
    // The read-back validation itself never reached the caller — every outcome went
    // to stderr — while its validateObject RPC sat in the sequential bridge pipe and
    // delayed the next MCP call. Kept for debugging, off the default path.
    // See: https://github.com/dynamics365ninja/d365fo-mcp-server/issues/407
    if (process.env.DEBUG_LOGGING === 'true') {
      bridgeValidateAfterWrite(
        context.bridge,
        objectType,
        objectName,
      ).then(validationMsg => {
        if (validationMsg) {
          console.error(`[modify_d365fo_file] Bridge validation: ${validationMsg}`);
        }
      }).catch(e => {
        console.error(`[modify_d365fo_file] Bridge validation skipped: ${e}`);
      });
    }

    // Register the edited file in the ACTIVE project unless it is already there.
    //
    // Being referenced by a sibling project of the same model is not a reason to
    // skip this: an element may belong to several .rnrproj, the model is the
    // build unit and it compiles once regardless, and a project that does not
    // contain the object cannot build or hand over the change just made to it.
    // The previous gate stopped at 'registered somewhere', which left an edited
    // object missing from the very project it was edited in.
    let projectMessage = '';
    if (args.addToProject) {
      const configManager = getConfigManager();
      await configManager.ensureLoaded();

      let resolvedProjectPath = args.projectPath || await configManager.getProjectPath() || undefined;
      const resolvedSolutionPath = args.solutionPath || await configManager.getSolutionPath() || undefined;

      if (!resolvedProjectPath && resolvedSolutionPath) {
        resolvedProjectPath = await ProjectFileFinder.findProjectInSolution(
          resolvedSolutionPath,
          modelName || configManager.getModelName() || ''
        ) || undefined;
      }

      projectMessage = await registerFileInActiveProject(
        objectType,
        objectName,
        modelName || configManager.getModelName() || undefined,
        resolvedProjectPath,
      );
      // The "no project references this, and none is configured" variant is a
      // fact about the workspace and repeats verbatim on every write. Adding a
      // file to a project is an ACTION and is never collapsed.
      if (projectMessage.includes('No project of model')) {
        const model = modelName || configManager.getModelName() || '(unknown)';
        projectMessage = sayOncePerSession(
          'no-project',
          model,
          projectMessage,
          `\n\n⚠️ "${objectName}" is in no project of model "${model}" either ` +
            `(no projectPath configured — see above).`,
        );
      }
    }

    // Advisory X++ select-statement lint on the source just written (add-method /
    // replace-code etc.). Non-blocking: surfaces a likely "WHERE after join" mistake
    // up front instead of letting it become a build error the agent hunts by hand.
    const writtenXpp = args.sourceCode ?? (args as any).methodCode ?? args.newCode;
    const xppLintWarnings = lintXppSelect(writtenXpp);
    const xppLintNote = xppLintWarnings.length > 0 ? `\n\n${xppLintWarnings.join('\n\n')}` : '';

    // One read back of what is now on disk, used for both of the notes below.
    const afterContent = writtenXpp || replaceCodeBefore !== null
      ? await readForMatching(actualFilePath)
      : null;

    // The offline rule set on the same text. The object's <Declaration> supplies
    // the class header a method snippet lacks; without it, fewer rules apply.
    const xppRuleNote = writtenXpp ? validateWrittenXpp(writtenXpp, afterContent) : '';

    const changedLinesNote = replaceCodeBefore !== null && afterContent !== null
      ? renderChangedLines(replaceCodeBefore, afterContent)
      : '';

    // Two BP rules fire on a field that compiles perfectly, so they are invisible
    // until a BP run several steps later — and one of them (the label copy) then
    // needs new labels, i.e. rework of what was just written. Say it here instead.
    //
    // The field-group note used to spell out a whole follow-up call, so the agent
    // made one: every add-field manufactured a second round trip. It now points at
    // operations[], where the group entry travels in the SAME call as the field —
    // and stays quiet when that call already carries one.
    let addFieldBpNote = '';
    if (operation === 'add-field' && (objectType === 'table' || objectType === 'table-extension')) {
      const notes: string[] = [];
      // Silent when the group entry is already in this batch — the advice has
      // been taken, and repeating it teaches the agent that these warnings do
      // not track what it actually did.
      //
      // batchAdvice, when present, decides: only the batch can see that three
      // add-field entries want ONE paragraph naming three fields, and that a
      // field whose group entry sits two lines below needs no paragraph at all.
      // peerOperations stays the fallback for a call that carries no batchAdvice.
      const advice = args.batchAdvice;
      const groupEntryInBatch = (args.peerOperations ?? []).includes('add-field-to-field-group');
      const suppressGroupNote = advice
        ? advice.suppressFieldGroupNote === true
        : groupEntryInBatch;
      const coveredFields = advice?.fieldGroupNoteFields?.length
        ? advice.fieldGroupNoteFields
        : (args.fieldName ? [args.fieldName] : []);
      if (!suppressGroupNote) {
        notes.push(
          `⚠️ BP: a table field must belong to a field group (BPErrorTableFieldNotInFieldGroup)` +
          `${coveredFields.length > 1 ? ` — applies to ${coveredFields.join(', ')}` : ''}. ` +
          `Send the group entry in the SAME call next time — d365fo_file(action="modify", ` +
          `objectType="${objectType}", objectName="${objectName}", operations=[{operation:"add-field", …}, ` +
          `{operation:"add-field-to-field-group", fieldName:"${coveredFields[0] ?? args.fieldName}", fieldGroupName:"<group>"}]).`,
        );
      }
      if ((args as any).fieldEnumType) {
        notes.push(
          `⚠️ BP: the field's Label must be a DIFFERENT label id than the enum's own label ` +
          `(BPErrorFieldLabelIsCopyOfEnumLabel) — same visible text is fine, same id is not.`,
        );
      }
      addFieldBpNote = notes.length > 0 ? `\n\n${notes.join('\n')}` : '';
    }

    // A field group already rendered on a form via <DataGroup> puts the field on
    // that form by itself — said now, before a form extension gets created for it.
    // And when the group is rendered by nothing, say THAT, naming the groups that
    // are: a new group on a table extension reaches no form on its own, and an
    // agent that does not know it goes and builds the form extension anyway.
    let fieldGroupRenderNote = '';
    if (
      (operation === 'add-field-to-field-group' || operation === 'add-field-group') &&
      (objectType === 'table' || objectType === 'table-extension') &&
      (args as any).fieldGroupName
    ) {
      const baseTableName = objectType === 'table' ? objectName : objectName.split('.')[0];
      const groupName = (args as any).fieldGroupName as string;
      if (operation === 'add-field-to-field-group' && args.fieldName) {
        fieldGroupRenderNote = await timer.time('field-group render probe', () =>
          describeFieldGroupRendering(baseTableName, groupName, args.fieldName!, symbolIndex));
      }
      if (!fieldGroupRenderNote) {
        fieldGroupRenderNote = await timer.time('field-group reach probe', () =>
          describeUnrenderedFieldGroup(baseTableName, groupName, symbolIndex));
      }
    }

    // Corrections the server applied on its own. Kept in the payload so the agent
    // learns the correct form for next time and the write stays auditable.
    const autoCorrectNote = autoCorrectNotes.length > 0
      ? `\n\n${autoCorrectNotes.map(n => `📝 Note: ${n}`).join('\n')}\n` +
        `(Pass autoCorrect=false to have corrections like this raise an error instead.)`
      : '';

    // Inside a batch every one of the trailers below is the SAME answer about the
    // SAME file, and each entry re-ran the work to produce it: a 20-operation
    // batch stat()ed one file 20 times, re-parsed it into the symbol index 20
    // times, and repeated ~250 chars of trailer 20 times. runModifyBatch does all
    // of it once, after the loop — it is told which file to do it for through
    // `outcome` below.
    const inBatch = Array.isArray(args.peerOperations);
    if (outcome) {
      outcome.filePath = actualFilePath;
      outcome.objectType = objectType;
      outcome.objectName = objectName;
      outcome.modelName = modelName || getConfigManager().getModelName() || undefined;
    }

    // Re-index the modified object in-process. A modify changes the symbols the
    // index holds (a renamed field, a new method), and the parser is right here —
    // making the agent spend a round trip on update_symbol_index for a file this
    // process just wrote, and another on the lookup that failed for want of it,
    // was pure waste.
    const indexNote = inBatch ? '' : await timer.time('symbol index upsert',
      () => upsertWrittenFileIntoIndex(actualFilePath, context));

    // Verify the write here rather than leaving the caller to spend a
    // verify_d365fo_project round trip asking what this call already knows.
    // The project path resolved inside the addToProject branch is block-scoped,
    // and a modify commonly runs with addToProject off — re-resolve it here so the
    // .rnrproj check still happens (config reads are cached).
    const verifyProjectPath =
      args.projectPath || (await getConfigManager().getProjectPath()) || undefined;
    const verifyNote = inBatch ? '' : renderWriteVerification(
      await timer.time('write verification', () => verifyWrittenFile(
        actualFilePath,
        verifyProjectPath,
        membershipOf(objectType, objectName, modelName || getConfigManager().getModelName()),
      )),
    );
    const bpNote = await timer.time('inline BP check',
      () => runInlineBpCheck((args as any).bpCheck, objectType, objectName, context));

    return {
      content: [
        {
          type: 'text',
          text:
            `✅ ${operation} on ${objectType} "${objectName}" — applied via ${bridgeResult.viaXmlFallback
              ? "this server's XML writer (no bridge path for this operation)"
              : 'IMetadataProvider.Update()'}${crossModelNotice}${autoCorrectNote}\n\n` +
            `**File:** ${actualFilePath}${addControlNote}${generationNote}${bridgeValidation}${projectMessage}\n` +
            `🔧 API: ${bridgeResult.message}${changedLinesNote}${xppLintNote}${xppRuleNote}${addFieldBpNote}${fieldGroupRenderNote}${backupNote}${verifyNote}${indexNote}${bpNote}${timer.render()}` +
            // "Review changes in Visual Studio" is not something the caller can act
            // on, and it rode along on every write.
            (ignoredParamsWarning ? `\n\n${ignoredParamsWarning}` : '') +
            // One tool that builds AND runs the best-practice check. The old line
            // named build_d365fo_project alone, and the sampled sessions then spent
            // 35 verify_d365fo_project and 39 run_bp_check calls, largely right
            // after writes that had already verified themselves.
            //
            // Suppressed inside a batch, along with the batch-edit hint:
            // runModifyBatch emits one of each for the whole call, and telling an
            // operation that is already batched to batch itself reads as a defect.
            (inBatch
              ? ''
              : `\n\nNext: build_d365fo_project(bpCheck:true) — builds and runs the best-practice check in one call.` +
                renderBatchEditHint(objectType, objectName)),
        },
      ],
    };

  } catch (error) {
    // A parameter of the RIGHT name but the WRONG shape used to escape to the
    // generic message below, which renders a ZodError as its raw issue array:
    //
    //   ❌ Error modifying D365FO file: [ { "expected": "object", "code":
    //     "invalid_type", "path": [ "indexFields", 0 ], … } ]
    //
    // observed live on add-index called with indexFields: ["ProbeId"] instead of
    // [{fieldName:"ProbeId"}]. The published schema promises "A missing/wrong one
    // returns that COMPLETE spec — follow it, do not guess", and the missing-param
    // path above keeps that promise; this one did not, so the caller either guessed
    // or spent a round trip on get_knowledge to find out what it already asked for.
    //
    // normalizeModifyArgs now reshapes the single-reading cases before validation,
    // so this branch is reached by autoCorrect=false callers and by shapes that
    // genuinely have more than one reading — both of which want the spec.
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const opName = typeof rawArgs.operation === 'string' ? rawArgs.operation : undefined;
    if (error instanceof z.ZodError && opName) {
      const issues = error.issues
        .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join(String.fromCharCode(10));
      return {
        content: [{
          type: 'text',
          text:
            `❌ '${opName}': a parameter does not match the contract.\n` +
            issues + '\n\n' +
            renderOpSpec(opName),
        }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error modifying D365FO file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

// ── Auto-create for a modify that names an extension nobody has created yet ──

/**
 * Base-object names an extension name can refer to, best guess first.
 *
 * Dot notation (`CustTable.FmExtension`) says it outright. The element-style
 * class form (`CustTable_Extension`, `CustTableFm_Extension`) carries the model
 * infix in front of the word, so the plain strip is tried first and the
 * infix-stripped form after it - both are real spellings this repo produces.
 */
export function baseObjectNameCandidates(objectName: string, modelName?: string): string[] {
  const dot = objectName.indexOf('.');
  if (dot > 0) return [objectName.slice(0, dot)];
  if (!/extension$/i.test(objectName)) return [];

  const stripped = objectName.slice(0, -'Extension'.length).replace(/_+$/, '');
  if (!stripped) return [];
  const out = [stripped];
  const prefix = resolveObjectPrefix(modelName ?? '');
  for (const token of [deriveExtensionInfix(prefix, modelName), prefix]) {
    if (!token) continue;
    if (stripped.toLowerCase().endsWith(token.toLowerCase())) {
      const shorter = stripped.slice(0, -token.length).replace(/_+$/, '');
      if (shorter && !out.includes(shorter)) out.push(shorter);
    }
  }
  return out;
}

/** The call to send when the server may not create the extension on its own. */
function renderCreateWithOperations(
  objectType: string,
  objectName: string,
  operation: string,
  args: Record<string, unknown>,
): string {
  const spec = D365FO_FILE_OP_SPECS[operation];
  const params = [...(spec?.required ?? []), ...(spec?.optional ?? [])]
    .filter(name => args[name] !== undefined)
    .map(name => `${name}: ${JSON.stringify(args[name])}`);
  return (
    `d365fo_file(action="create", objectType="${objectType}", objectName="${objectName}", ` +
    `operations:[{operation: "${operation}"${params.length ? ', ' + params.join(', ') : ''}}])`
  );
}

interface MissingExtensionVerdict {
  /** The extension to create before the edit can run. */
  createFirst?: { objectType: string; objectName: string };
  /** Complete reply to return instead: it must not be created on our behalf. */
  refusal?: string;
}

/**
 * Decide whether a modify that found no file is really a missing extension.
 *
 * Only ever for an "-extension" objectType whose BASE object exists: without a
 * base there is nothing to extend, and the "not found" answer with its lookup
 * options is then the right one. Never for a plain object - a modify naming a
 * table that does not exist is a mistake, not a missing scaffold.
 *
 * Grounding is re-checked against the CREATE that would follow. It is the same
 * token and the same object the modify was already gated on, so in practice it
 * passes; the explicit check is what guarantees that turning GROUNDING_ENFORCE
 * on cannot be side-stepped by asking for a modify instead of a create. When it
 * refuses, the reply is the exact create call to send by hand.
 */
async function missingExtensionVerdict(
  args: Record<string, unknown>,
  objectType: string,
  objectName: string,
  operation: string,
  symbolIndex: any,
): Promise<MissingExtensionVerdict> {
  const modelName = (args.modelName as string | undefined) || getConfigManager().getModelName() || undefined;
  const baseType = objectType.slice(0, -'-extension'.length);
  const packagePath = args.packagePath as string | undefined;

  let baseFound: string | null = null;
  for (const candidate of baseObjectNameCandidates(objectName, modelName)) {
    baseFound = await resolveD365FileByName(symbolIndex, baseType, candidate, undefined, packagePath);
    if (baseFound) break;
  }
  // Nothing to extend — fall through to the ordinary "file not found" answer,
  // whose lookup options are exactly what a mistyped base name needs.
  if (!baseFound) return {};

  const groundingRefusal = enforceGrounding(
    args.groundingToken as string | undefined,
    `d365fo_file(action="create", objectType="${objectType}", objectName="${objectName}")`,
    objectName,
  );
  if (groundingRefusal) {
    return {
      refusal:
        `❌ ${objectType} "${objectName}" does not exist yet, and GROUNDING_ENFORCE=true means it ` +
        `cannot be created on your behalf without a groundingToken for it.\n\n` +
        `Create it and apply the same edit in ONE call:\n  ` +
        renderCreateWithOperations(objectType, objectName, operation, args) +
        `\n\n(prepare(mode="change", objectName="${objectName}") returns the groundingToken.)`,
    };
  }

  return { createFirst: { objectType, objectName } };
}

/** Object types whose members belong to a Microsoft-owned host object. */
const EXTENSION_OBJECT_TYPES = new Set([
  'table-extension', 'form-extension', 'enum-extension', 'edt-extension',
  'view-extension', 'query-extension', 'map-extension', 'data-entity-extension',
  'class-extension', 'menu-extension',
  'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
  'security-duty-extension', 'security-role-extension',
]);

/**
 * Which `args` key each operation mints a NEW member name in, for extensions.
 *
 * Deliberately absent:
 *  - every method operation. A CoC/extension-class method name must MATCH the
 *    base method it wraps (`public void insert() { next insert(); }`) — renaming
 *    it turns an override into a dead method that never runs.
 *  - add-field-to-field-group's fieldGroupName. That names an EXISTING, usually
 *    Microsoft-owned group being extended; prefixing it would point the write at
 *    a group that does not exist.
 *  - every remove-/modify- operation, which addresses members that already exist
 *    under whatever name they were created with.
 */
const EXTENSION_MEMBER_NAME_ARG: Record<string, string> = {
  'add-field': 'fieldName',
  'add-index': 'indexName',
  'add-full-text-index': 'indexName',
  'add-field-group': 'fieldGroupName',
  'add-enum-value': 'enumValueName',
};

/**
 * Extensions of `baseObject` that already live in `model` — so the cross-model
 * refusal can point at the extension the active model ALREADY has instead of
 * telling the agent to create a second one next to it.
 *
 * Reads `extension_metadata`, which is indexed on base_object_name and small
 * enough that COLLATE NOCASE here costs nothing (unlike the 1M-row symbols
 * table). Best-effort: a missing table or unbuilt index yields no suggestions,
 * never an error — the refusal itself does not depend on it.
 */
function findExtensionsInModel(
  symbolIndex: any,
  baseObject: string,
  model: string,
): ExistingExtension[] {
  if (!baseObject || !model) return [];
  try {
    const rdb = symbolIndex?.getReadDb?.();
    if (!rdb) return [];
    const rows = rdb.prepare(
      `SELECT extension_name AS name, extension_type AS type
         FROM extension_metadata
        WHERE base_object_name = ? COLLATE NOCASE
          AND model = ? COLLATE NOCASE
        LIMIT 5`,
    ).all(baseObject, model) as ExistingExtension[];
    return rows ?? [];
  } catch {
    return [];
  }
}

/**
 * Prefix the new member name this operation carries, when writing into an
 * extension. Mutates `args` in place and returns a note for the response (empty
 * when nothing changed), so the agent learns the real name and addresses the
 * member correctly in its next call.
 *
 * Idempotent: a name that already carries the prefix — in either the underscore
 * or the bare form, case-insensitively — is left untouched, so an agent that
 * prefixes by hand does not end up with DEMO_DEMO_Foo.
 */
export function applyExtensionMemberPrefix(
  args: Record<string, any>,
  objectType: string,
  operation: string,
  modelName: string,
): string {
  if (!EXTENSION_OBJECT_TYPES.has(objectType)) return '';

  const argKey = EXTENSION_MEMBER_NAME_ARG[operation];
  if (!argKey) return '';

  const original = args[argKey];
  if (typeof original !== 'string' || original.trim().length === 0) return '';

  const token = resolveRegularObjectPrefixToken(modelName);
  if (!token) return '';

  const bare = token.replace(/_+$/, '');
  const lower = original.toLowerCase();
  if (lower.startsWith(token.toLowerCase()) || lower.startsWith(bare.toLowerCase())) return '';

  const prefixed = `${token}${original.charAt(0).toUpperCase()}${original.slice(1)}`;
  args[argKey] = prefixed;
  console.error(`[modifyD365File] Extension member prefixed: ${original} → ${prefixed} (model ${modelName})`);

  return (
    `\n\n> 🔖 Named \`${prefixed}\` — members added to an extension carry model ` +
    `"${modelName}"'s prefix \`${token}\`. Use that name in later calls.`
  );
}

/** Field names declared by a table extension's own `<Fields>`, as spelled there. */
function extensionFieldNames(xml: string): string[] {
  const names: string[] = [];
  // <Name> is the first child of every <AxTableField>, so a non-greedy hop from
  // the opening tag to the first Name reads one field name per block. Field
  // GROUP entries use <DataField>, so they cannot be picked up by accident.
  for (const m of xml.matchAll(/<AxTableField\b[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/g)) {
    names.push(m[1].trim());
  }
  return names;
}

/** Whether the base table declares a field of this name. */
function baseTableDeclaresField(xml: string, fieldName: string): boolean {
  const needle = fieldName.trim().toLowerCase();
  return extensionFieldNames(xml).some(n => n.toLowerCase() === needle);
}

/**
 * Point `add-field-to-field-group` at the field that actually exists.
 *
 * add-field on an extension renames what it adds — `QualityTier` becomes
 * `CtsoSK_QualityTier`, because a member added to someone else's table has to
 * carry your prefix — and says so in the response. The group entry that follows
 * it names the SAME field, and it was left exactly as the caller spelled it:
 * applyExtensionMemberPrefix mints names for new members and this operation
 * mints none, so it is correctly absent from EXTENSION_MEMBER_NAME_ARG.
 *
 * The result was a dangling reference. The bridge validates no DataField, so
 * `<DataField>QualityTier</DataField>` was written against a field named
 * `CtsoSK_QualityTier`, reported as applied, and the group silently pointed at
 * nothing. Sending both operations in ONE call — which every add-field response
 * tells the agent to do — hit it every time.
 *
 * Blind prefixing is the wrong repair: a group extension may perfectly well
 * carry a BASE-table field, which has no prefix. So this corrects only the case
 * with one reading — the name as given is not a field of the extension, the
 * prefixed name is, and the base table has no field by the given name either.
 * Anything else is left untouched.
 *
 * Advisory, like every other auto-correction: it runs before a write that is
 * perfectly capable of succeeding without it, so anything unreadable — the
 * extension file, the base table, the prefix rules — means "no correction", not
 * a failed modify.
 */
export async function resolveFieldNameForFieldGroup(
  args: Record<string, any>,
  objectType: string,
  operation: string,
  modelName: string,
  actualFilePath: string,
  symbolIndex: any,
): Promise<string> {
  if (operation !== 'add-field-to-field-group' || objectType !== 'table-extension') return '';

  const given = args.fieldName;
  if (typeof given !== 'string' || given.trim().length === 0) return '';

  try {
    const token = resolveRegularObjectPrefixToken(modelName);
    if (!token) return '';
    const bare = token.replace(/_+$/, '');
    const lower = given.toLowerCase();
    if (lower.startsWith(token.toLowerCase()) || lower.startsWith(bare.toLowerCase())) return '';

    const extensionXml = await fs.readFile(actualFilePath, 'utf-8');
    const fields = extensionFieldNames(extensionXml);
    // Already a field of this extension — nothing to correct.
    if (fields.some(n => n.toLowerCase() === lower)) return '';

    const prefixed = `${token}${given.charAt(0).toUpperCase()}${given.slice(1)}`;
    const match = fields.find(n => n.toLowerCase() === prefixed.toLowerCase());
    if (!match) return '';

    // A base-table field of the given name makes both readings valid; say
    // nothing and let the caller's spelling stand.
    const baseTable = String(args.objectName ?? '').split('.')[0];
    if (baseTable) {
      const baseXml = await findBaseObjectXml('table', baseTable, symbolIndex);
      if (baseXml && baseTableDeclaresField(baseXml, given)) return '';
    }

    args.fieldName = match;
    console.error(`[modifyD365File] Field-group entry retargeted: ${given} → ${match}`);
    return (
      `'${given}' is not a field of this extension, but '${match}' is — the group entry now points at it. ` +
      `Members added to an extension carry the model's prefix \`${token}\`; use that name when referring to them.`
    );
  } catch {
    return '';
  }
}

/**
 * Find D365FO file path
 */
async function findD365File(
  symbolIndex: any,
  objectType: string,
  objectName: string,
  modelName?: string,
  _workspacePath?: string,
  explicitFilePath?: string,
  packagePath?: string,
): Promise<string | null> {
  // Explicit path bypasses all lookup — use when caller knows the exact location
  // (e.g. the path was returned by create_d365fo_file).
  if (explicitFilePath) {
    return explicitFilePath;
  }

  // Resolve by the given name first; if that misses, retry once with the model
  // prefix applied. create_d365fo_file auto-prefixes new object names (e.g.
  // "RentEquipmentTable" → "ContosoRentEquipmentTable"), so a modify call with the bare
  // name would otherwise fail to locate the file. The bridge object name is then
  // re-derived from the resolved file's basename, so the prefixed name flows through.
  const direct = await resolveD365FileByName(symbolIndex, objectType, objectName, modelName, packagePath);
  if (direct) return direct;

  // Retry under the name `create` would have written the file as.
  //
  // The old retry here called applyObjectPrefix and explicitly skipped every
  // "-extension" type, so `modify(objectType: "table-extension", objectName:
  // "PurchTable")` never looked for "PurchTable.CtsoExtension" — the exact file
  // `create` had produced from those same two arguments, whose path it had
  // printed one call earlier. The answer was "File not found for
  // table-extension", and the only way out was passing filePath by hand.
  // normalizeObjectName is what create uses, so the two now agree by
  // construction rather than by two implementations staying in sync.
  const effectiveModel = modelName || getConfigManager().getModelName() || undefined;
  const normalized = normalizeObjectName(objectName, objectType, effectiveModel);
  if (normalized && normalized.toLowerCase() !== objectName.toLowerCase()) {
    const viaNormalized = await resolveD365FileByName(symbolIndex, objectType, normalized, modelName, packagePath);
    if (viaNormalized) {
      console.error(`[modifyD365File] '${objectName}' not found — resolved via normalized name '${normalized}'`);
      return viaNormalized;
    }
  }
  return null;
}

/** Resolve a D365FO file by an exact object name (symbol DB, then filesystem). */
async function resolveD365FileByName(
  symbolIndex: any,
  objectType: string,
  objectName: string,
  modelName?: string,
  packagePath?: string,
): Promise<string | null> {
  // Symbol DB only indexes a subset of types — for the rest go straight to filesystem.
  const dbTypeMap: Record<string, string> = {
    class: 'class',
    table: 'table',
    form: 'form',
    enum: 'enum',
    query: 'query',
    view: 'view',
  };

  const symbolType = dbTypeMap[objectType];

  // Query database when a symbol type mapping exists
  if (symbolType) {
    let dbResult: string | null = null;
    const rdb = symbolIndex.getReadDb();
    if (modelName) {
      const stmt = rdb.prepare(`
        SELECT file_path
        FROM symbols
        WHERE type = ? AND name = ? AND model = ?
        LIMIT 1
      `);
      const row = stmt.get(symbolType, objectName, modelName);
      dbResult = row ? row.file_path : null;
    } else {
      // No modelName specified — prefer the user's configured model to avoid
      // accidentally resolving to a standard Microsoft model (issue #369).
      const configuredModel = getConfigManager().getModelName();
      if (configuredModel) {
        const stmtPref = rdb.prepare(`
          SELECT file_path
          FROM symbols
          WHERE type = ? AND name = ? AND model = ?
          LIMIT 1
        `);
        const prefRow = stmtPref.get(symbolType, objectName, configuredModel);
        dbResult = prefRow ? prefRow.file_path : null;
      }
      if (!dbResult) {
        // Fallback: any model (still guarded by the standard-model check after findD365File)
        const stmt = rdb.prepare(`
          SELECT file_path
          FROM symbols
          WHERE type = ? AND name = ?
          ORDER BY model
          LIMIT 1
        `);
        const row = stmt.get(symbolType, objectName);
        dbResult = row ? row.file_path : null;
      }
    }

    // Only trust the DB path when it is an absolute .xml/.xpp path that actually
    // exists on disk. The DB file_path column stores paths from the CI build agent
    // (e.g. C:\home\vsts\work\...) which are never accessible at runtime. Relative
    // paths (e.g. "ContosoExt/ContosoExt/AxClass/Foo.xml") also come from this source
    // and cannot be used directly.
    // Fall through to findD365FileOnDisk which builds the correct absolute path from config.
    //
    // Use cross-platform absolute detection so that Windows-style drive paths (C:\...)
    // are recognised as absolute even when the server runs on Linux/macOS (path.isAbsolute
    // returns false for Windows paths on POSIX hosts, causing spurious fallback loops).
    const isAbsoluteXPlat = (p: string) =>
      path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
    // Guard against a poisoned file_path: index* functions (e.g. indexEnums,
    // indexEdts) fall back to the pre-extracted JSON cache file's own path when the
    // cached object has no `sourcePath` (this is the documented, legacy shape for
    // enums/EDTs — `{ raw: "<xml>..." }`, no sourcePath at all). That cache file is
    // itself a real, accessible file on disk, so the plain existence check below
    // would wrongly trust it as the write target. Reject anything that isn't the
    // real AOT source file so we fall through to findD365FileOnDisk instead.
    const looksLikeAotSourceFile = (p: string) =>
      /\.(xml|xpp)$/i.test(p);
    if (dbResult && isAbsoluteXPlat(dbResult) && looksLikeAotSourceFile(dbResult)) {
      try {
        await import('fs').then(m => m.promises.access(dbResult!));
        return dbResult;
      } catch {
        // Absolute path from DB but not accessible — fall through to filesystem lookup
        console.error(`[modifyD365File] DB path not accessible: ${dbResult} — falling back to filesystem lookup`);
      }
    } else if (dbResult && isAbsoluteXPlat(dbResult)) {
      console.error(`[modifyD365File] DB returned a non-AOT-source path (likely a stale metadata cache entry): ${dbResult} — falling back to filesystem lookup`);
    } else if (dbResult) {
      console.error(`[modifyD365File] DB returned relative path: ${dbResult} — falling back to filesystem lookup`);
    }
  }

  // Filesystem fallback: handles newly created files not yet in the symbol index,
  // and all types not covered by the symbol DB (edt, report, extensions, security, menu …).
  return findD365FileOnDisk(objectType, objectName, modelName, packagePath);
}


/**
 * Create file backup and verify it was written successfully.
 * Throws if the source file is missing or the copy fails, so callers
 * always know whether a valid backup exists before overwriting.
 * Returns the backup file path.
 *
 * The name carries MILLISECONDS and, if that still collides, a counter. At the old
 * one-second resolution two modifies of the same file inside the same second
 * produced the same backup name, so the second copy overwrote the first with
 * already-modified content — on a target outside git (exactly the case that forces
 * a backup, see ensureRecoverableModification) the original was then unrecoverable.
 * COPYFILE_EXCL is what makes the retry a claim rather than a check: it fails
 * instead of overwriting, so two callers racing on the same name cannot both win.
 *
 * Exported for unit tests.
 */
export async function createFileBackup(filePath: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const base = `${filePath}.backup-${timestamp}`;

  for (let attempt = 0; ; attempt++) {
    const backupPath = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      await fs.copyFile(filePath, backupPath, FS_CONSTANTS.COPYFILE_EXCL);
      // Confirm the backup has non-zero size before proceeding
      const stat = await fs.stat(backupPath);
      if (stat.size === 0) {
        throw new Error('Backup file was created but is empty');
      }
      return backupPath;
    } catch (error: any) {
      if (error?.code === 'EEXIST' && attempt < 100) {
        continue;
      }
      throw new Error(
        `Failed to create backup at "${backupPath}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

const execFileAsync = util.promisify(execFile);

// Directory → inside-git-work-tree result, cached for the process lifetime so
// repeated modifies don't re-spawn git for the same metadata folder.
const gitWorkTreeCache = new Map<string, boolean>();

/**
 * Cheap check whether a file lives inside a git work tree — i.e. whether
 * undo_last_modification (git checkout) could revert a change to it.
 * git not installed, timeout, or any other error → treated as "not a repo".
 */
async function isInsideGitWorkTree(filePath: string): Promise<boolean> {
  const dir = path.dirname(filePath);
  const cached = gitWorkTreeCache.get(dir);
  if (cached !== undefined) return cached;
  let inside = false;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      timeout: 5_000,
      windowsHide: true,
    });
    inside = stdout.trim() === 'true';
  } catch {
    inside = false;
  }
  gitWorkTreeCache.set(dir, inside);
  return inside;
}

/**
 * Backup guard for modify operations. Honors an explicit createBackup=true;
 * with createBackup=false it force-enables the backup when the target is not
 * inside a git work tree, because the documented undo path
 * (undo_last_modification → git checkout) only works inside a repo.
 * Returns a note to append to the success response ('' when no forced backup
 * was needed). Exported for unit tests.
 */
export async function ensureRecoverableModification(
  actualFilePath: string,
  createBackup: boolean,
): Promise<string> {
  if (createBackup) {
    await createFileBackup(actualFilePath);
    return '';
  }
  if (await isInsideGitWorkTree(actualFilePath)) {
    return '';
  }
  const backupPath = await createFileBackup(actualFilePath);
  // Keyed by the MODEL folder (<...>/<Package>/<Model>/Ax<Type>/<file>.xml), not
  // the file: "this metadata tree is not under git" is a property of the tree, so
  // once said it is said for every object in it.
  return sayOncePerSession(
    'git-backup',
    path.win32.dirname(path.win32.dirname(actualFilePath)),
    `\n\nℹ️ Target is not under git — created backup ${backupPath} automatically ` +
      `(d365fo_file(action="undo") would not work here — it is a git checkout).`,
    `\n\nℹ️ Backup: ${backupPath}`,
  );
}

// ─── Form parent-control auto-resolution ────────────────────────────────────
//
// When add-control is called with a fuzzy parentControl (e.g. "general"),
// these helpers find the base form XML, walk the control hierarchy, and return
// the exact control name so the caller never has to call get_object_info(form) first.

interface ResolvedControl {
  name: string;
  parentName: string | null;
  pathStr: string;
}

/**
 * Recursively walk an AxFormControl node forest and collect every control.
 */
function walkFormControls(
  nodes: any[],
  out: ResolvedControl[],
  parentName: string | null,
  pathParts: string[],
): void {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const name: string = Array.isArray(node.Name) ? node.Name[0] : (node.Name ?? '');
    if (!name) continue;
    const currentPath = [...pathParts, name];
    out.push({ name, parentName, pathStr: currentPath.join(' › ') });
    const cn = Array.isArray(node.Controls) ? node.Controls[0] : node.Controls;
    if (cn?.AxFormControl) {
      const children = Array.isArray(cn.AxFormControl) ? cn.AxFormControl : [cn.AxFormControl];
      walkFormControls(children, out, name, currentPath);
    }
  }
}

/**
 * Extract all controls from a parsed AxForm xmlObj.
 */
function allControlsFromFormXmlObj(xmlObj: any): ResolvedControl[] {
  const results: ResolvedControl[] = [];
  const axForm = xmlObj.AxForm;
  if (!axForm) return results;

  const designNode = Array.isArray(axForm.Design) ? axForm.Design[0] : axForm.Design;
  if (!designNode) return results;

  let rootNodes: any[] = [];
  // AxFormDesign wrapper (standard D365FO 10.0 format)
  if (designNode.AxFormDesign) {
    const fds = Array.isArray(designNode.AxFormDesign) ? designNode.AxFormDesign : [designNode.AxFormDesign];
    for (const fd of fds) {
      const cn = Array.isArray(fd.Controls) ? fd.Controls[0] : fd.Controls;
      if (cn?.AxFormControl) {
        const items = Array.isArray(cn.AxFormControl) ? cn.AxFormControl : [cn.AxFormControl];
        rootNodes = rootNodes.concat(items);
      }
    }
  } else if (designNode.Controls) {
    const cn = Array.isArray(designNode.Controls) ? designNode.Controls[0] : designNode.Controls;
    if (cn?.AxFormControl) {
      rootNodes = Array.isArray(cn.AxFormControl) ? cn.AxFormControl : [cn.AxFormControl];
    }
  }
  walkFormControls(rootNodes, results, null, []);
  return results;
}

// ── Auto-correction helpers ────────────────────────────────────────────────
// A correction is applied ONLY where the failure has exactly one valid reading
// that the server can derive from state it already holds. Everything else keeps
// erroring — a wrong write costs far more than the retry round trip this saves.

/** Record a correction, ignoring a repeat from the bridge auto-refresh retry. */
function noteAutoCorrection(notes: string[], note: string): void {
  if (!notes.includes(note)) notes.push(note);
}

/**
 * The operation parameters that end up as a `<Label>` element, and what the
 * label belongs to (for the note the caller reads back).
 *
 * `propertyValue` is deliberately absent: modify-property's value is generic —
 * it is a TableGroup or a field name just as often as a label — and rewriting it
 * on the strength of the propertyPath would be a guess, not a determined
 * correction.
 */
const LABEL_OP_PARAMS: Array<{ key: string; noun: string; nameKey: string }> = [
  { key: 'fieldLabel', noun: 'field', nameKey: 'fieldName' },
  { key: 'fieldGroupLabel', noun: 'field group', nameKey: 'fieldGroupName' },
  { key: 'enumValueLabel', noun: 'enum value', nameKey: 'enumValueName' },
];

/**
 * Replace raw label TEXT on an operation with a real label reference, reusing an
 * existing label when one already carries that exact text.
 *
 * Same reason as the create path (see autoResolveRawLabels there): in a
 * 1,515-call corpus `labels` was called 268 times against 171 writes, nearly all
 * of it search-then-create in front of a write that already carried the text.
 * A value that is already an `@Ref` is written verbatim and produces no note.
 */
async function autoResolveOperationLabels(
  args: Record<string, unknown>,
  target: AutoLabelTarget,
  symbolIndex?: any,
): Promise<string[]> {
  if (!target.model) return [];
  const notes: string[] = [];

  for (const { key, noun, nameKey } of LABEL_OP_PARAMS) {
    if (!isRawLabelText(args[key])) continue;
    const name = typeof args[nameKey] === 'string' ? args[nameKey] as string : undefined;
    const outcome = await resolveOrCreateLabelRef(
      {
        text: args[key] as string,
        what: `${noun}${name ? ` "${name}"` : ''}`,
        // Only a FIELD's label can collide with an enum's own label; a field
        // group or an enum value has no enum behind it.
        enumType: key === 'fieldLabel' && typeof args.fieldEnumType === 'string'
          ? args.fieldEnumType as string
          : undefined,
      },
      target,
      symbolIndex,
    );
    if (!outcome) continue;
    if (outcome.ref) args[key] = outcome.ref;
    notes.push(outcome.note);
  }

  return notes;
}

/**
 * add-field was given an XML element name as fieldType. For the *Enum element
 * — and only that one — the intent is unambiguous ("this field is enum-typed"),
 * so the enum name is all that is missing. It comes from the payload itself
 * (fieldEnumType), or from the field name when the symbol index confirms an enum
 * of exactly that name. Anything else returns undefined and the call still fails.
 */
function resolveEnumForFieldElement(
  fieldTypeElement: string,
  explicitEnumType: string | undefined,
  fieldNameCandidates: readonly (string | undefined)[],
  symbolIndex: any,
): string | undefined {
  if (!/Enum$/i.test(fieldTypeElement)) return undefined;
  if (explicitEnumType) return explicitEnumType;

  for (const candidate of fieldNameCandidates) {
    if (!candidate) continue;
    try {
      const row = symbolIndex.getReadDb().prepare(
        `SELECT name FROM symbols WHERE type = 'enum' AND name = ? COLLATE NOCASE LIMIT 1`
      ).get(candidate) as { name?: string } | undefined;
      // Use the INDEXED spelling — the caller's casing may differ from the AOT name.
      if (row?.name) return row.name;
    } catch { /* index unavailable — no derivation, keep erroring */ }
  }
  return undefined;
}

/** The bridge's add-field-to-field-group refusal that names extendBaseFieldGroup as its fix. */
function isBaseFieldGroupMissError(message: string | undefined): boolean {
  if (!message) return false;
  return /field group .* not found on table-extension/i.test(message)
    && /extendBaseFieldGroup=true/i.test(message);
}

/** How many forms on the base table are opened looking for a <DataGroup> renderer. */
const DATA_GROUP_FORM_PROBE_LIMIT = 3;

/**
 * Note for a successful add-field-to-field-group: is this field group already
 * rendered on a form through a container's <DataGroup>?
 *
 * If it is, the compiler puts the new field on that form by itself and any
 * hand-added control for it collides with the generated one. The add-control
 * guard says the same thing, but only once a form extension exists and a control
 * is being added to it — a create that then has to be undone. Said here it costs
 * one indexed lookup.
 *
 * Returns '' on any miss — no form on the table, no container with that
 * DataGroup, an unreadable form, a database that cannot answer — which leaves
 * the reactive guard exactly as it was.
 */
export async function describeFieldGroupRendering(
  baseTableName: string,
  groupName: string,
  fieldName: string,
  symbolIndex: any,
): Promise<string> {
  try {
    const rdb = symbolIndex?.getReadDb?.();
    if (!rdb) return '';

    // BINARY probe on idx_form_datasources_table first; table_name casing comes
    // from the form XML, so fall back to NOCASE only when that misses
    // (form_datasources is small — the scan is cheap).
    const sql = (collate: string) =>
      `SELECT DISTINCT form_name, datasource_name FROM form_datasources ` +
      `WHERE table_name = ?${collate} LIMIT ${DATA_GROUP_FORM_PROBE_LIMIT}`;
    let rows = rdb.prepare(sql('')).all(baseTableName) as
      Array<{ form_name: string; datasource_name: string }>;
    if (rows.length === 0) {
      rows = rdb.prepare(sql(' COLLATE NOCASE')).all(baseTableName) as typeof rows;
    }

    for (const row of rows) {
      const xml = await findBaseFormXml(row.form_name, symbolIndex);
      if (!xml) continue;
      const renderers = await findDataGroupRenderers(xml, groupName);
      // A container bound to a different datasource renders a different table's
      // group of the same name — not this field's.
      const hit = renderers.find(
        r => !r.dataSource || r.dataSource.toLowerCase() === row.datasource_name.toLowerCase(),
      );
      if (!hit) continue;

      return (
        `\n\n🖼️ Form \`${row.form_name}\` renders field group **${groupName}** via ` +
        `\`<DataGroup>\` on control "${hit.controlName}" — the compiler generates ` +
        `\`${hit.generatedNameFor(fieldName)}\` for this field, so **it is already on the form**. ` +
        `Do not create a form extension or an add-control for it: that control and the ` +
        `generated one collide as a duplicate name, which only the build reports.`
      );
    }
  } catch {
    // A hint must never be the reason a successful write reports failure.
  }
  return '';
}

/**
 * The other half of {@link describeFieldGroupRendering}: the field group reaches
 * no form, and these are the groups on this table that do.
 *
 * A field group a form does not name in `<DataGroup>` generates no controls, so a
 * field parked in a brand-new group on a table extension is on no form at all.
 * Nothing said so, and the two paths look identical from the outside: put the
 * field in a rendered base group and it appears for free, or invent a group and
 * then need a form extension, an add-control, the duplicate-name guard and an
 * undo. Run 81803f01 spent ~24 AIU discovering the difference.
 *
 * Returns '' whenever the answer would be a guess — no form on the table, no
 * `<DataGroup>` anywhere, an unreadable form, an index that cannot answer — and
 * also when the group IS rendered, which is the sibling's sentence to say.
 */
export async function describeUnrenderedFieldGroup(
  baseTableName: string,
  groupName: string,
  symbolIndex: any,
): Promise<string> {
  try {
    const rdb = symbolIndex?.getReadDb?.();
    if (!rdb) return '';

    const sql = (collate: string) =>
      `SELECT DISTINCT form_name, datasource_name FROM form_datasources ` +
      `WHERE table_name = ?${collate} LIMIT ${DATA_GROUP_FORM_PROBE_LIMIT}`;
    let rows = rdb.prepare(sql('')).all(baseTableName) as
      Array<{ form_name: string; datasource_name: string }>;
    if (rows.length === 0) {
      rows = rdb.prepare(sql(' COLLATE NOCASE')).all(baseTableName) as typeof rows;
    }

    const needle = groupName.trim().toLowerCase();
    const rendered = new Map<string, string>();
    for (const row of rows) {
      const xml = await findBaseFormXml(row.form_name, symbolIndex);
      if (!xml) continue;
      for (const r of await listDataGroupRenderers(xml)) {
        // A container bound to another datasource renders another table's group.
        if (r.dataSource && r.dataSource.toLowerCase() !== row.datasource_name.toLowerCase()) continue;
        // Rendered after all — describeFieldGroupRendering owns this case.
        if (r.dataGroup.toLowerCase() === needle) return '';
        if (!rendered.has(r.dataGroup.toLowerCase())) {
          rendered.set(r.dataGroup.toLowerCase(), `\`${r.dataGroup}\` (form \`${row.form_name}\`, control "${r.controlName}")`);
        }
      }
    }
    if (rendered.size === 0) return '';

    return (
      `\n\n🖼️ No form checked on \`${baseTableName}\` renders field group **${groupName}** — a group ` +
      `no container names in \`<DataGroup>\` generates no controls, so a field in it is on no form.\n` +
      `Rendered instead: ${[...rendered.values()].join(', ')}.\n` +
      `Add the field to one of those (\`add-field-to-field-group\` with \`extendBaseFieldGroup=true\`) and it ` +
      `appears with no form extension. Keeping **${groupName}** means a form extension plus an explicit ` +
      `control — and that control must not collide with a generated one.`
    );
  } catch {
    // A hint must never be the reason a successful write reports failure.
  }
  return '';
}

/** True when the base table's own <FieldGroups> defines `groupName`. */
async function baseObjectDefinesFieldGroup(
  baseTableName: string,
  groupName: string,
  symbolIndex: any,
): Promise<boolean> {
  const xml = await findBaseObjectXml('table', baseTableName, symbolIndex);
  if (!xml) return false;
  // <Name> is the first child of every <AxTableFieldGroup>, so a non-greedy hop
  // from the opening tag to the first Name reads one group name per block.
  for (const m of xml.matchAll(/<AxTableFieldGroup>[\s\S]*?<Name>([^<]+)<\/Name>/g)) {
    if (m[1].trim().toLowerCase() === groupName.trim().toLowerCase()) return true;
  }
  return false;
}

/**
 * Resolve a possibly-fuzzy `parentControl` value to the exact control name in the base form.
 *
 * Returns:
 *  { resolved, pathStr }   — unique case-insensitive substring match (use this name)
 *  { multiple }            — ambiguous (return candidates to caller)
 *  null                    — form not found or no controls matched; caller uses original value
 */
async function resolveParentControl(
  extensionObjectName: string,
  parentControlQuery: string,
  symbolIndex: any,
  explicitBaseFormName?: string,
): Promise<{ resolved: string; pathStr: string } | { multiple: ResolvedControl[] } | null> {
  // Base form name: "CustTable.MyExt" → "CustTable"
  const baseFormName = explicitBaseFormName || extensionObjectName.split('.')[0];
  if (!baseFormName) return null;

  const xmlContent = await findBaseFormXml(baseFormName, symbolIndex);
  if (!xmlContent) return null;

  let xmlObj: any;
  try { xmlObj = await parseStringPromise(xmlContent); } catch { return null; }

  const all = allControlsFromFormXmlObj(xmlObj);
  const lq = parentControlQuery.toLowerCase();
  const matches = all.filter(c => c.name.toLowerCase().includes(lq));

  if (matches.length === 0) return null; // No match — caller proceeds with original
  if (matches.length === 1) return { resolved: matches[0].name, pathStr: matches[0].pathStr };

  // Multiple substring matches — try an exact case-insensitive match first
  const exact = matches.filter(c => c.name.toLowerCase() === lq);
  if (exact.length === 1) return { resolved: exact[0].name, pathStr: exact[0].pathStr };

  return { multiple: matches };
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.

/**
 * Resolve the primitive base type for an EDT by walking the edt_metadata chain.
 * Used by add-field to auto-fill fieldBaseType when the caller omits it.
 * A newly-created EDT not yet in the index returns the EDT name so the bridge
 * can still apply its own name-based heuristics.
 */
function resolveEdtBaseTypeForField(edtName: string, db: any, depth = 0): string {
  const PRIMITIVES = new Set([
    'String', 'Integer', 'Int64', 'Real', 'Date', 'UtcDateTime', 'DateTime',
    'Enum', 'Container', 'Guid', 'GUID',
  ]);
  if (depth > 8) return edtName;
  if (PRIMITIVES.has(edtName)) return edtName;
  try {
    const row = db.prepare(
      `SELECT extends, enum_type FROM edt_metadata WHERE edt_name = ? LIMIT 1`
    ).get(edtName) as { extends: string | null; enum_type: string | null } | undefined;
    if (!row) return edtName; // not yet indexed — let bridge use name heuristics
    if (row.enum_type && !row.extends) return 'Enum';
    if (!row.extends) return edtName;
    if (PRIMITIVES.has(row.extends)) return row.extends;
    return resolveEdtBaseTypeForField(row.extends, db, depth + 1);
  } catch {
    return edtName;
  }
}

/** Lower-case the first character — D365FO convention for a table buffer variable. */
function bufferVarName(tableName: string): string {
  return tableName.charAt(0).toLowerCase() + tableName.slice(1);
}

/**
 * Resolve the EDT/type of a table field from the symbol index so generated
 * find/exist signatures use the correct parameter type. The field's `signature`
 * column stores its EDT name. Returns null when the field is not indexed.
 */
/** Metadata base-type keywords (the stripped i:type, e.g. AxTableFieldString → "String").
 *  These are NOT valid X++ parameter types — a field's signature in the index stores
 *  the base type, not its EDT, so a resolved value matching one of these must be
 *  discarded in favour of the field name (D365 fields are conventionally named after
 *  their EDT, e.g. field ItemId uses EDT ItemId). */
const METADATA_BASE_TYPE_KEYWORDS = new Set([
  'string', 'integer', 'int', 'int64', 'real', 'date', 'time', 'datetime',
  'utcdatetime', 'guid', 'container', 'enum', 'boolean', 'memo',
]);

function isMetadataBaseTypeKeyword(t: string): boolean {
  return METADATA_BASE_TYPE_KEYWORDS.has(t.trim().toLowerCase());
}

/**
 * The form control type to bind to a table field: ComboBox for an enum, the
 * EDT's base type otherwise.
 *
 * This used to be `heuristicEdtBaseType(fieldName)` — a guess from the field's
 * NAME, with a comment saying an index lookup was out of scope because it would
 * mean resolving the data source back to its table. It costs one query:
 * resolveFieldEdt() already answers "what type is field F of table T", and a
 * form data source is conventionally named after its table, which is the case
 * the fallbacks below cover when it is not.
 *
 * The gap it left was enums. A name heuristic has nothing to match on, so an
 * enum field got the String default and became an AxFormStringControl — a text
 * box over an enum. Recovering from that took an undo, a re-create and a
 * re-modify, because a control's type cannot be changed in place.
 */
export function resolveControlTypeForField(
  dataSource: string | undefined,
  dataField: string | undefined,
  db: any,
): string | undefined {
  if (!dataField) return undefined;

  // The field's declared EDT or enum type, via the data source's table. Form
  // data sources are conventionally named after the table they bind.
  const declared = dataSource && db ? resolveFieldEdt(dataSource, dataField, db) : null;

  // resolveEdtBaseType answers "Enum" for an enum-backed EDT, and "Enum" is not
  // a form control type — left as-is it falls through to the String default and
  // reintroduces the text-box-over-an-enum this function exists to stop.
  const asControlType = (baseType: string | undefined): string | undefined =>
    baseType === 'Enum' ? 'ComboBox' : baseType;

  if (declared && db) {
    if (isEnumName(declared, db)) return enumControlType(declared);
    // Which enum, not just "an enum": a NoYes-backed EDT (the overwhelmingly
    // common flag field) is a CheckBox everywhere in the product, and a ComboBox
    // over it compiles fine but reads as a two-item dropdown the designer would
    // never have produced.
    const enumType = resolveEdtEnumType(declared, db);
    if (enumType) return enumControlType(enumType);
    const base = asControlType(resolveEdtBaseType(declared, db));
    if (base) return base;
  }

  // No data source, no index, or an unindexed field: the field name itself is
  // conventionally the EDT or enum name in X++, so try it directly before
  // falling back to the pure name heuristic.
  if (db) {
    if (isEnumName(dataField, db)) return enumControlType(dataField);
    const enumType = resolveEdtEnumType(dataField, db);
    if (enumType) return enumControlType(enumType);
    const base = asControlType(resolveEdtBaseType(dataField, db));
    if (base) return base;
  }
  return asControlType(heuristicEdtBaseType(dataField));
}

/**
 * The form control an enum binds to. Every enum is a ComboBox EXCEPT the boolean
 * ones: D365FO renders NoYes / NoYesId as a CheckBox, and the VS designer emits
 * AxFormCheckBoxControl for such a field. NoYesCombo is deliberately absent — it
 * is the enum you pick precisely when you DO want the dropdown.
 */
const BOOLEAN_ENUMS = new Set(['noyes', 'noyesid']);

function enumControlType(enumName: string): string {
  return BOOLEAN_ENUMS.has(enumName.toLowerCase()) ? 'CheckBox' : 'ComboBox';
}

function resolveFieldEdt(tableName: string, fieldName: string, db: any): string | null {
  try {
    // Canonicalize the parent — `parent_name = ? COLLATE NOCASE` cannot use
    // idx_parent_type_name and scans all 360k field rows (180 s cold). NOCASE
    // on the field name is fine inside the indexed parent+type range.
    const canonical = lookupSymbolNocase(db, tableName)?.name ?? tableName;
    const row = db.prepare(
      `SELECT signature FROM symbols WHERE type = 'field' AND parent_name = ? AND name = ? COLLATE NOCASE LIMIT 1`
    ).get(canonical, fieldName) as { signature: string | null } | undefined;
    const sig = row?.signature?.trim();
    // The index stores the field's BASE TYPE (e.g. "String"), not its EDT. A base-type
    // keyword is not a usable X++ parameter type, so treat it as unresolved — the caller
    // then falls back to the field name, which is conventionally the EDT.
    if (!sig || isMetadataBaseTypeKeyword(sig)) return null;
    return sig;
  } catch {
    return null;
  }
}

/**
 * Generate idiomatic X++ source for a standard table method from a high-level
 * `tableMethodType`. The method name is implied by the type (find/exist/…), so
 * callers need not pass methodName or sourceCode — only tableMethodType (plus
 * tableKeyField for find/exist).
 *
 * Returns the generated method name, source, and an optional advisory note
 * (e.g. when the key field's EDT could not be resolved from the index).
 */
export function generateTableMethodSource(
  tableName: string,
  methodType: 'find' | 'exist' | 'findByRecId' | 'validateWrite' | 'validateDelete' | 'initValue',
  keyField: string | undefined,
  db: any,
): { methodName: string; source: string; note?: string } {
  const buf = bufferVarName(tableName);

  switch (methodType) {
    case 'find':
    case 'exist': {
      if (!keyField) {
        throw new Error(
          `add-table-method with tableMethodType="${methodType}" requires tableKeyField ` +
          `(the primary key field to select on, e.g. tableKeyField="ItemId").`
        );
      }
      const resolvedEdt = resolveFieldEdt(tableName, keyField, db);
      const paramType = resolvedEdt ?? keyField;
      const note = resolvedEdt
        ? undefined
        : `⚠️ Could not resolve the EDT for field "${keyField}" on "${tableName}" from the index — ` +
          `the parameter type defaulted to "${keyField}". Verify it compiles, or pass full sourceCode instead.`;
      const param = `_${bufferVarName(keyField)}`;

      if (methodType === 'find') {
        const source =
          `/// <summary>\n` +
          `/// Finds the <c>${tableName}</c> record for the given ${keyField}.\n` +
          `/// </summary>\n` +
          `/// <param name = "${param}">The ${keyField} value to find.</param>\n` +
          `/// <param name = "_forUpdate">Select the record for update; optional.</param>\n` +
          `/// <returns>The matching <c>${tableName}</c> record; an empty buffer if none exists.</returns>\n` +
          `public static ${tableName} find(${paramType} ${param}, boolean _forUpdate = false)\n` +
          `{\n` +
          `    ${tableName} ${buf};\n` +
          `\n` +
          `    if (${param})\n` +
          `    {\n` +
          `        ${buf}.selectForUpdate(_forUpdate);\n` +
          `\n` +
          `        select firstonly ${buf}\n` +
          `            where ${buf}.${keyField} == ${param};\n` +
          `    }\n` +
          `\n` +
          `    return ${buf};\n` +
          `}`;
        return { methodName: 'find', source, note };
      }

      // exist
      const source =
        `/// <summary>\n` +
        `/// Checks whether a <c>${tableName}</c> record exists for the given ${keyField}.\n` +
        `/// </summary>\n` +
        `/// <param name = "${param}">The ${keyField} value to check.</param>\n` +
        `/// <returns>true if a matching record exists; otherwise false.</returns>\n` +
        `public static boolean exist(${paramType} ${param})\n` +
        `{\n` +
        `    return ${param} &&\n` +
        `        (select firstonly RecId from ${buf}\n` +
        `            where ${buf}.${keyField} == ${param}).RecId != 0;\n` +
        `}`;
      return { methodName: 'exist', source, note };
    }

    case 'findByRecId': {
      const source =
        `/// <summary>\n` +
        `/// Finds the <c>${tableName}</c> record for the given RecId.\n` +
        `/// </summary>\n` +
        `/// <param name = "_recId">The RecId to find.</param>\n` +
        `/// <param name = "_forUpdate">Select the record for update; optional.</param>\n` +
        `/// <returns>The matching <c>${tableName}</c> record; an empty buffer if none exists.</returns>\n` +
        `public static ${tableName} findByRecId(RefRecId _recId, boolean _forUpdate = false)\n` +
        `{\n` +
        `    ${tableName} ${buf};\n` +
        `\n` +
        `    if (_recId)\n` +
        `    {\n` +
        `        ${buf}.selectForUpdate(_forUpdate);\n` +
        `\n` +
        `        select firstonly ${buf}\n` +
        `            where ${buf}.RecId == _recId;\n` +
        `    }\n` +
        `\n` +
        `    return ${buf};\n` +
        `}`;
      return { methodName: 'findByRecId', source };
    }

    case 'validateWrite':
    case 'validateDelete': {
      const source =
        `/// <summary>\n` +
        `/// Validates the record before ${methodType === 'validateWrite' ? 'writing' : 'deletion'}.\n` +
        `/// </summary>\n` +
        `/// <returns>true if the record is valid; otherwise false.</returns>\n` +
        `public boolean ${methodType}()\n` +
        `{\n` +
        `    boolean ret;\n` +
        `\n` +
        `    ret = super();\n` +
        `\n` +
        `    // TODO: add custom ${methodType} validation\n` +
        `\n` +
        `    return ret;\n` +
        `}`;
      return { methodName: methodType, source };
    }

    case 'initValue': {
      const source =
        `/// <summary>\n` +
        `/// Initializes the record with default field values.\n` +
        `/// </summary>\n` +
        `public void initValue()\n` +
        `{\n` +
        `    super();\n` +
        `\n` +
        `    // TODO: set default field values\n` +
        `}`;
      return { methodName: 'initValue', source };
    }

    default: {
      // Exhaustiveness guard — the schema enum should keep this unreachable.
      throw new Error(`Unsupported tableMethodType: ${methodType as string}`);
    }
  }
}

/**
 * Generate an X++ display method stub returning the given EDT/type.
 * Used when add-display-method is called with displayMethodReturnEdt but no
 * explicit sourceCode/methodCode.
 */
export function generateDisplayMethodSource(methodName: string, returnEdt: string): string {
  return (
    `/// <summary>\n` +
    `/// Display method returning <c>${returnEdt}</c>.\n` +
    `/// </summary>\n` +
    `/// <returns>The computed ${returnEdt} value.</returns>\n` +
    `public display ${returnEdt} ${methodName}()\n` +
    `{\n` +
    `    ${returnEdt} ret;\n` +
    `\n` +
    `    // TODO: compute the display value\n` +
    `\n` +
    `    return ret;\n` +
    `}`
  );
}

// The once-per-session advisory memory moved to src/utils/repeatedNotes.ts so
// createD365File can share it — the layering guard forbids the two write tools
// from importing each other. Re-exported here because the test seam was part of
// this module's surface before the move.
export { resetRepeatedNoteMemory };

// The base-object XML locator moved to src/utils/baseObjectXml.ts so a generator
// can read a form without importing this write tool. Re-exported because it was
// part of this module's surface.
export { findBaseObjectXml, findBaseFormXml };
