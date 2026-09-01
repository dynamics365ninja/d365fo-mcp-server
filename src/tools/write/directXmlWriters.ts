/**
 * Direct-XML writers — the fallback that lands a change the bridge could not.
 *
 * Every one of these reads the object's XML, patches the string and writes it
 * back, and each is wrapped in `serializedOnFile` because two that overlap on
 * one file would both read the same original and the second write would silently
 * drop the first one's element.
 *
 * They lived inside modifyD365File.ts, which the 2026-08-25 audit found at 5,645
 * lines and growing 44% between audits — a 62-arm operation switch, the argument
 * schema, the disk locators and these fifteen writers in one file. This is a pure
 * move: the block needed exactly one symbol from its old home
 * (`serializedOnFile`, used nowhere else in src, so it came too) and exports the
 * nineteen the switch consumes.
 */

import * as fs from 'fs/promises';
import path from 'path';
import { withFileLock, writeFileAtomic } from '../../utils/atomicFileWrite.js';
import { normalizeD365Xml } from '../../utils/d365XmlNormalizer.js';
import { insertFormExtensionControl } from '../../utils/formExtensionControlXml.js';
import { removeFormControl } from '../../utils/formControlRemoval.js';
import { addSecurityEntryPoint, removeSecurityEntryPoint } from '../xml/securityPrivilegeXml.js';
import { removeDiagnosticSuppression, addDiagnosticSuppression, emptySuppressionListXml } from '../../utils/ignoreDiagnosticListXml.js';
import { buildSuppressionXml } from '../../knowledge/bpMonikers/index.js';
import { upsertAxTableProperty, AX_TABLE_NON_EXISTENT_PROPERTIES } from '../../utils/axTablePropertyOrder.js';
import { upsertAxFormDesignProperty } from '../../utils/axFormDesignProperties.js';
import { buildAxDataEntityViewFieldXml } from '../xml/dataEntityViewExtensionXml.js';
import { escapeXml } from '../../utils/xmlEscape.js';

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


/**
 * Direct XML file-level replace-code fallback, used when the C# bridge can't
 * reach a method (e.g. form/form-extension control overrides not exposed via
 * the Methods API). Last resort — the bridge is always preferred.
 *
 * `reason` comes from describeBridgeFallbackReason so the success message names the
 * cause that actually applied instead of asserting an outage that may not exist.
 */
export const directXmlReplaceCode = serializedOnFile(async (
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
export const directXmlModifyProperty = serializedOnFile(async (
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
      // the agent is trying to fix (the 2026-07-21 eval sweep, finding #37).
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
export const directXmlAddMenuItemToMenu = serializedOnFile(async (
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
    // the 2026-07-21 eval sweep, finding #30. `MenuItemType` is omitted for
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
export function viaXmlFallback<T extends { success: boolean; message: string } | null>(result: T): T {
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
export const directXmlAddControl = serializedOnFile(async (
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
export const directXmlAddIndex = serializedOnFile(async (
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
  const openTag = /^<[A-Za-z_][\w.-]*(?:"[^"]*"|'[^']*'|[^>"'])*?>/.exec(block);
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
export const directXmlAddQueryRange = serializedOnFile(async (
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
export const directXmlRemoveQueryRange = serializedOnFile(async (
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
export const directXmlAddDataEntityExtensionField = serializedOnFile(async (
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
 * route was the forbidden whole-file overwrite.
 *
 * ORDER INSIDE THE ENTRY IS LOAD-BEARING, and this writer had it wrong. The
 * comment here used to say "shape matches MetadataWriteService.cs: Name, Table,
 * DeleteAction" — that is the order of a C# object initialiser, which says
 * nothing about the order the DataContract serialiser reads. Microsoft's own
 * metadata is the oracle: all 126 <AxTableDeleteAction> entries shipped in
 * ApplicationSuite/Foundation/Common/Platform are
 *
 *     Name → DeleteAction → Relation → Table   (26 of them then add Tags)
 *
 * with no exceptions. Writing <DeleteAction> AFTER <Table> put it out of
 * declaration order, and the deserializer drops a misordered element in
 * silence — the same failure mode the top-level property block already had
 * (axTablePropertyOrder.ts, finding #13). The file on disk said Cascade, the
 * provider read the entry with DeleteAction at its default, and the next
 * bridge-backed Update() serialised the object back WITHOUT the element. The
 * 2026-08-31 capture run of L4-headerlines-document-slice recorded that as
 * "the bridge destroyed the delete action"; the bridge only wrote back what
 * the deserializer had been able to read.
 *
 * <Relation> is emitted when the caller names one: a delete action without an
 * explicit relation is legal but draws BPUpgradeMetadataDeleteAction. Which side
 * DECLARES that relation is not fixed — of the resolvable delete actions in the
 * four big packages, 5 name a relation declared on the related table and 4 name
 * one declared on the table that owns the delete action — so the op-spec tells
 * the caller to read it rather than derive it.
 */
export const directXmlDeleteAction = serializedOnFile(async (
  filePath: string,
  mode: 'add' | 'remove',
  name: string,
  table: string | undefined,
  deleteAction: string | undefined,
  relation?: string | undefined,
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

    // Canonical serialised order — see the header. Name first, then DeleteAction,
    // then the optional Relation, then Table.
    const renderEntry = (): string =>
      `\t\t<AxTableDeleteAction>\n` +
      `\t\t\t<Name>${name}</Name>\n` +
      `\t\t\t<DeleteAction>${deleteAction ?? 'Restricted'}</DeleteAction>\n` +
      (relation ? `\t\t\t<Relation>${relation}</Relation>\n` : '') +
      `\t\t\t<Table>${table ?? name}</Table>\n` +
      `\t\t</AxTableDeleteAction>`;

    if (existing) {
      // Idempotency used to key on the NAME alone, so an entry whose DeleteAction
      // differed from the one asked for was reported "already present — skipped"
      // and left as it was. That removed the only forward-only repair path there
      // is: the capture run that found the ordering bug above could not correct
      // the value it had just written wrong without the delete+re-add the eval
      // loop forbids. Same name, different type ⇒ rewrite the entry in place.
      const current = /<DeleteAction>\s*(\w+)\s*<\/DeleteAction>/.exec(existing[0])?.[1];
      const wanted = deleteAction ?? 'Restricted';
      if (current === wanted) {
        return { success: true, message: `✅ Delete action '${name}' already present in ${filePath} — skipped (idempotent).` };
      }
      const rewritten = content.replace(blockRe, `${renderEntry()}\n`);
      if (rewritten === content) return null;
      await writeFileAtomic(filePath, normalizeD365Xml(rewritten));
      return {
        success: true,
        message:
          `✅ Delete action '${name}' updated: ${current ?? '(none)'} → ${wanted} on ${table ?? name}. ` +
          `File: ${filePath}`,
      };
    }

    const newElement = renderEntry();

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
export const directXmlRemoveControl = serializedOnFile(async (
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
export const directXmlAddEntryPoint = serializedOnFile(async (
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
export const directXmlRemoveEntryPoint = serializedOnFile(async (
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
export const directXmlRemoveDiagnosticSuppression = serializedOnFile(async (
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
export const directXmlAddDiagnosticSuppression = serializedOnFile(async (
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
 * Stamp `<ValidTimeStateKey>` / `<ValidTimeStateMode>` onto an existing `<AxTableIndex>`.
 *
 * Neither the bridge's AddIndex nor its SetAxTableProperty knows these two index
 * properties, so a date-effective table (ValidTimeStateFieldType = Date/UtcDateTime)
 * could be created but never completed through the tool path — its valid-time-state
 * key index is exactly what xppc demands (Phase F, L2-date-effective-table). The
 * SDK serialises index properties alphabetically before the <Fields> collection
 * (Name, AllowDuplicates, AlternateKey, …, ValidTimeStateKey, ValidTimeStateMode,
 * Fields — see PersonnelCore/AxTable/HcmPositionDetail.xml), so both land right
 * before <Fields>. Idempotent: an already-present element is rewritten in place.
 *
 * ValidTimeStateMode: NoGap is the SDK DEFAULT and the serializer omits it — a
 * bridge round-trip of a table carrying <ValidTimeStateMode>NoGap</…> dropped the
 * element, and every shipped index that spells the mode out says Gap
 * (HcmEmployment, HcmJobDuration, HcmPositionHierarchy…). So NoGap REMOVES the
 * element and Gap writes it; either way the request is honoured.
 */
export const directXmlSetIndexValidTimeState = serializedOnFile(async (
  filePath: string,
  indexName: string,
  validTimeStateKey: boolean | undefined,
  validTimeStateMode: string | undefined,
): Promise<{ success: boolean; message: string } | null> => {
  if (validTimeStateKey === undefined && validTimeStateMode === undefined) return null;
  const mode = validTimeStateMode === undefined ? undefined : String(validTimeStateMode).trim();
  if (mode !== undefined && mode !== 'Gap' && mode !== 'NoGap') {
    return { success: false, message: `ValidTimeStateMode must be "Gap" or "NoGap", got "${mode}" — nothing was written.` };
  }
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (!/<AxTable\b/.test(content) && !/<AxTableExtension\b/.test(content)) return null;

    const blockRe = new RegExp(`(<AxTableIndex>\\s*<Name>${indexName}</Name>)([\\s\\S]*?)(</AxTableIndex>)`);
    const m = content.match(blockRe);
    if (!m) {
      return {
        success: false,
        message: `Index '${indexName}' not found in ${filePath} — add it first (add-index), then set its valid-time-state properties.`,
      };
    }
    let body = m[2]
      .replace(/\s*<ValidTimeStateKey>[^<]*<\/ValidTimeStateKey>/g, '')
      .replace(/\s*<ValidTimeStateMode>[^<]*<\/ValidTimeStateMode>/g, '');
    const props =
      (validTimeStateKey === undefined ? '' : `\n\t\t\t<ValidTimeStateKey>${validTimeStateKey ? 'Yes' : 'No'}</ValidTimeStateKey>`) +
      (mode === 'Gap' ? `\n\t\t\t<ValidTimeStateMode>Gap</ValidTimeStateMode>` : '');
    const fieldsAt = body.search(/\n\s*<Fields\b/);
    body = fieldsAt >= 0 ? body.slice(0, fieldsAt) + props + body.slice(fieldsAt) : body + props;
    const updated = content.replace(blockRe, (_all, open: string, _old: string, close: string) => open + body + close);
    if (updated === content) {
      return { success: true, message: `✅ Index '${indexName}' already carries the requested valid-time-state properties — skipped (idempotent).` };
    }
    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(`[modify_d365fo_file] ✅ directXmlSetIndexValidTimeState: '${indexName}' in ${filePath}`);
    const written = [
      validTimeStateKey === undefined ? null : `ValidTimeStateKey=${validTimeStateKey ? 'Yes' : 'No'}`,
      mode === undefined
        ? null
        : (mode === 'Gap' ? 'ValidTimeStateMode=Gap' : 'ValidTimeStateMode=NoGap (the SDK default — no element written)'),
    ].filter(Boolean).join(', ');
    return {
      success: true,
      message: `✅ Index '${indexName}': ${written} written into the AxTable XML (the C# bridge does not know these index properties).`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlSetIndexValidTimeState failed: ${err}`);
    return null;
  }
});

/**
 * Remove an EMPTY top-level property element (`<PrimaryIndex></PrimaryIndex>` or
 * `<PrimaryIndex />`) from an AOT XML file.
 *
 * modify-property with propertyValue="" is how a caller says "back to the default",
 * and the bridge's SetProperty obliges by writing the empty element the SDK
 * serialiser produces for an empty string — which no shipped file carries: the
 * default is expressed by ABSENCE (a table with no <PrimaryIndex> has the
 * surrogate-key primary index, the shape of every date-effective table). Only a
 * top-level, empty element is touched; a populated one is left alone.
 */
export const directXmlClearEmptyProperty = serializedOnFile(async (
  filePath: string,
  property: string,
): Promise<{ success: boolean; message: string } | null> => {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(property)) return null;
  try {
    const rawContent = await fs.readFile(filePath, 'utf-8');
    const content = rawContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const empty = new RegExp(`\\n[ \\t]*<${property}>\\s*</${property}>[ \\t]*(?=\\n)|\\n[ \\t]*<${property}\\s*/>[ \\t]*(?=\\n)`);
    if (!empty.test(content)) return null;
    const updated = content.replace(empty, '');
    await writeFileAtomic(filePath, normalizeD365Xml(updated));
    console.error(`[modify_d365fo_file] ✅ directXmlClearEmptyProperty: removed empty <${property}> from ${filePath}`);
    return {
      success: true,
      message: `🔧 Empty <${property}> element removed — the default is expressed by absence, no shipped file carries \`<${property}></${property}>\`.`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlClearEmptyProperty failed: ${err}`);
    return null;
  }
});
