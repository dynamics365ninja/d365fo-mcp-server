/**
 * Raw AOT XML for an object, by name.
 *
 * The readers render metadata; they never show the file. Callers that want the
 * actual XML — to copy a convention, to see element order, to check what a
 * previous write produced — had no tool for it and went to the shell:
 * `Get-ChildItem -Recurse` to find the path, then `Get-Content -Raw` to read
 * it. A recursive scan of PackagesLocalDirectory costs seconds; this is one
 * indexed lookup.
 */

import * as fs from 'fs/promises';
import {
  findD365FileOnDisk, findD365FileViaIndex, modelsHoldingObject,
  type SymbolFileLookupSource,
} from '../../utils/objectFileLookup.js';

/** Default ceiling on returned XML. A large form is well past any useful read. */
const DEFAULT_MAX_CHARS = 40_000;

export interface ObjectXmlOptions {
  modelName?: string;
  /**
   * The symbol index, when the caller has one. Without it this falls back to the
   * configured model's folder layout, which only ever finds objects in that model.
   */
  index?: SymbolFileLookupSource;
  /** 1-based, inclusive. Omit both for the whole file (up to maxChars). */
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}

export interface ObjectXmlResult {
  text: string;
  isError: boolean;
}

/** Render a file already located. Split out so it is testable without config. */
export async function renderObjectXml(
  filePath: string,
  objectType: string,
  objectName: string,
  options: ObjectXmlOptions = {},
): Promise<ObjectXmlResult> {
  let content: string;
  try {
    content = (await fs.readFile(filePath, 'utf-8')).replace(/^﻿/, '');
  } catch (err) {
    return {
      isError: true,
      text: `❌ get_object_info(include="xml"): found ${filePath} but could not read it: ${err}`,
    };
  }

  const allLines = content.split(/\r?\n/);
  const from = Math.max(1, options.startLine ?? 1);
  const to = Math.min(allLines.length, options.endLine ?? allLines.length);
  const ranged = allLines.slice(from - 1, to).join('\n');

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = ranged.length > maxChars;
  const body = truncated ? ranged.slice(0, maxChars) : ranged;

  const header =
    `# ${objectType} ${objectName} — raw XML\n\n` +
    `**File:** ${filePath}\n` +
    `**Lines:** ${from}-${to} of ${allLines.length}\n`;

  const footer = truncated
    ? `\n\n> ✂️ Cut at ${maxChars} chars. Re-read a range with ` +
      `options={include:"xml", startLine:…, endLine:…} rather than raising maxChars.`
    : '';

  return { isError: false, text: `${header}\n\`\`\`xml\n${body}\n\`\`\`${footer}` };
}

/**
 * The message for an object with no file — never an empty result.
 *
 * `elsewhere` are the models the index says DO hold an object of this name. Naming
 * them is the whole difference between a message the caller can act on and one it
 * can only guess at: "pass options.modelName" sent an agent looking for
 * JournalVoucherNum in "Application Foundation" (wrong) before "Foundation"
 * (right), three calls for one file. An empty list is itself an answer — no model
 * has it, so retrying with a different modelName cannot help.
 */
export function objectXmlNotFound(
  objectType: string,
  objectName: string,
  modelName?: string,
  elsewhere: string[] = [],
): ObjectXmlResult {
  const where = elsewhere.filter(m => m !== modelName);
  const hint = where.length > 0
    ? `The index has it in ${where.map(m => `"${m}"`).join(' · ')} — retry with ` +
      `options.modelName="${where[0]}". If that also misses, the index row is stale ` +
      `(the file was moved or deleted since the last index run).`
    : `No model in the symbol index holds a ${objectType} of that name, so retrying with ` +
      `a different options.modelName will not help — check the spelling and the ` +
      `objectType, or the object does not exist yet.`;
  return {
    isError: true,
    text:
      `❌ get_object_info(include="xml"): no file on disk for ${objectType} "${objectName}"` +
      `${modelName ? ` in model "${modelName}"` : ''}.\n${hint}`,
  };
}

export async function readObjectXml(
  objectType: string,
  objectName: string,
  options: ObjectXmlOptions = {},
): Promise<ObjectXmlResult> {
  // Configured-model layout first: it is a couple of fs.access calls, it is what a
  // freshly created object (not yet indexed) resolves through, and it keeps the
  // common case — reading something in the model being worked in — off the DB.
  const onDisk = await findD365FileOnDisk(objectType, objectName, options.modelName);
  if (onDisk) return renderObjectXml(onDisk, objectType, objectName, options);

  // Then the index, which knows every model rather than just the configured one.
  if (options.index) {
    const indexed = await findD365FileViaIndex(
      options.index, objectType, objectName, options.modelName,
    );
    if (indexed) return renderObjectXml(indexed.filePath, objectType, objectName, options);
    return objectXmlNotFound(
      objectType, objectName, options.modelName,
      modelsHoldingObject(options.index, objectType, objectName),
    );
  }
  return objectXmlNotFound(objectType, objectName, options.modelName);
}
