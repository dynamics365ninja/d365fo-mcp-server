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
import { findD365FileOnDisk } from '../../utils/objectFileLookup.js';

/** Default ceiling on returned XML. A large form is well past any useful read. */
const DEFAULT_MAX_CHARS = 40_000;

export interface ObjectXmlOptions {
  modelName?: string;
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

/** The message for an object with no file — never an empty result. */
export function objectXmlNotFound(
  objectType: string,
  objectName: string,
  modelName?: string,
): ObjectXmlResult {
  return {
    isError: true,
    text:
      `❌ get_object_info(include="xml"): no file on disk for ${objectType} "${objectName}"` +
      `${modelName ? ` in model "${modelName}"` : ''}.\n` +
      `The object may live in another model — pass options.modelName — or may not exist yet.`,
  };
}

export async function readObjectXml(
  objectType: string,
  objectName: string,
  options: ObjectXmlOptions = {},
): Promise<ObjectXmlResult> {
  const filePath = await findD365FileOnDisk(objectType, objectName, options.modelName);
  if (!filePath) return objectXmlNotFound(objectType, objectName, options.modelName);
  return renderObjectXml(filePath, objectType, objectName, options);
}
