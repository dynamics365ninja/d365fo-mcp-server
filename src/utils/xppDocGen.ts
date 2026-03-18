/**
 * X++ XML documentation comment generator.
 *
 * D365FO best practice: every public and protected method must be documented
 * with /// <summary>, /// <param name="…"> and /// <returns> blocks.
 *
 * This module auto-generates those comments when they are absent so that
 * generated AX object XML always conforms to the standard.
 */

/** Access modifiers and non-type keywords that are NOT part of the return type. */
const XPP_MODIFIERS = new Set([
  'public', 'protected', 'private',
  'static', 'final', 'abstract', 'virtual', 'override',
  'internal', 'server', 'client', 'display', 'edit', 'new',
]);

interface ParsedSig {
  isClass: boolean;
  name: string;
  returnType: string;
  params: Array<{ type: string; name: string }>;
  /** Base class from `extends XXX` (classes only) */
  baseClass?: string;
}

/**
 * Parses an X++ method or class-declaration signature line.
 * Returns null when the line cannot be parsed or represents a private/internal member.
 */
function parseSig(sigLine: string): ParsedSig | null {
  const isPublic    = /\bpublic\b/.test(sigLine);
  const isProtected = /\bprotected\b/.test(sigLine);
  if (!isPublic && !isProtected) return null;

  const hasParens = sigLine.includes('(');

  // ── Class / struct declaration ────────────────────────────────────────────
  if (!hasParens) {
    const classMatch = sigLine.match(/\bclass\s+(\w+)/);
    if (!classMatch) return null;
    const baseMatch = sigLine.match(/\bextends\s+(\w+)/);
    return { isClass: true, name: classMatch[1], returnType: '', params: [], baseClass: baseMatch?.[1] };
  }

  // ── Method signature ──────────────────────────────────────────────────────
  const parenIdx    = sigLine.indexOf('(');
  const beforeParen = sigLine.substring(0, parenIdx).trim();
  const tokens      = beforeParen.split(/\s+/).filter(Boolean);
  const methodName  = tokens[tokens.length - 1] ?? '';
  const typeTokens  = tokens.filter(t => !XPP_MODIFIERS.has(t));
  // typeTokens: [ReturnType, methodName] — second-to-last is return type
  const returnType  = typeTokens.length >= 2 ? typeTokens[typeTokens.length - 2] : '';

  // ── Parameters ────────────────────────────────────────────────────────────
  const closeIdx = sigLine.lastIndexOf(')');
  const paramStr  = closeIdx > parenIdx
    ? sigLine.substring(parenIdx + 1, closeIdx).trim()
    : '';

  const params: Array<{ type: string; name: string }> = [];
  if (paramStr) {
    for (const chunk of paramStr.split(',')) {
      // Strip default value: "TransDate _fromDate = dateNull()" → ["TransDate", "_fromDate"]
      const eqIdx = chunk.indexOf('=');
      const parts = (eqIdx !== -1 ? chunk.substring(0, eqIdx) : chunk)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (parts.length >= 2) {
        params.push({ type: parts[0], name: parts[parts.length - 1] });
      } else if (parts.length === 1 && parts[0]) {
        params.push({ type: '', name: parts[0] });
      }
    }
  }

  return { isClass: false, name: methodName, returnType, params };
}

// ── Humanization helpers ──────────────────────────────────────────────────────

/**
 * Split camelCase / PascalCase into space-separated lowercase words.
 * "processInventoryLines" → "process inventory lines"
 * "WHSZoneId" → "WHS zone id"
 */
function humanize(name: string): string {
  return name
    .replace(/^_+/, '')                            // strip leading underscores
    .replace(/([a-z])([A-Z])/g, '$1 $2')           // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')     // abbreviation boundary
    .toLowerCase();
}

/**
 * Infer a meaningful `/// <summary>` description for a **class** based on its
 * name, base class, and surrounding attributes.
 */
function inferClassSummary(name: string, baseClass?: string, attributes?: string[]): string {
  // Check attributes for common patterns
  const attrText = (attributes || []).join(' ');
  if (/ExtensionOf\s*\(\s*classStr\s*\((\w+)\)/i.test(attrText)) {
    const target = attrText.match(/ExtensionOf\s*\(\s*classStr\s*\((\w+)\)/i)?.[1];
    return `Extension of the <c>${target}</c> class.`;
  }
  if (/ExtensionOf\s*\(\s*tableStr\s*\((\w+)\)/i.test(attrText)) {
    const target = attrText.match(/ExtensionOf\s*\(\s*tableStr\s*\((\w+)\)/i)?.[1];
    return `Extension of the <c>${target}</c> table.`;
  }
  if (/ExtensionOf\s*\(\s*formStr\s*\((\w+)\)/i.test(attrText)) {
    const target = attrText.match(/ExtensionOf\s*\(\s*formStr\s*\((\w+)\)/i)?.[1];
    return `Extension of the <c>${target}</c> form.`;
  }
  if (/DataContractAttribute/i.test(attrText)) {
    return `Data contract class that defines dialog parameters for the ${humanize(name.replace(/DataContract$|Contract$/, ''))} operation.`;
  }
  if (/SRSReportParameterAttribute/i.test(attrText)) {
    return `SSRS report parameter contract for the ${humanize(name.replace(/Contract$|DataContract$/, ''))} report.`;
  }

  // Infer from base class
  if (baseClass) {
    const bc = baseClass.toLowerCase();
    if (bc === 'srsreportdataproviderbase')
      return `Report data provider that populates the temporary table for the ${humanize(name.replace(/DP$|DataProvider$/, ''))} report.`;
    if (bc === 'sysoperationservicecontroller' || bc === 'srsreportruncontroller')
      return `Controller class that orchestrates the ${humanize(name.replace(/Controller$/, ''))} operation.`;
    if (bc === 'sysoperationservicebase')
      return `Service class that implements the business logic for the ${humanize(name.replace(/Service$/, ''))} operation.`;
    if (bc === 'runbasebatch' || bc === 'runbase')
      return `Batch job class for ${humanize(name.replace(/Batch$|Job$/, ''))} processing.`;
  }

  // Infer from name suffix
  if (name.endsWith('Controller'))    return `Controller class that orchestrates the ${humanize(name.replace(/Controller$/, ''))} operation.`;
  if (name.endsWith('Service'))       return `Service class that implements the business logic for the ${humanize(name.replace(/Service$/, ''))} operation.`;
  if (name.endsWith('DataContract') || name.endsWith('Contract'))
    return `Data contract class that defines parameters for the ${humanize(name.replace(/DataContract$|Contract$/, ''))} operation.`;
  if (name.endsWith('UIBuilder'))     return `UI builder class that customizes the dialog for ${humanize(name.replace(/UIBuilder$/, ''))}.`;
  if (name.endsWith('EventHandler') || name.endsWith('Handler'))
    return `Event handler class for ${humanize(name.replace(/EventHandler$|Handler$/, ''))} events.`;
  if (/_Extension$/.test(name))       return `Extension class for ${humanize(name.replace(/_Extension$/, '').replace(/\w+$/, ''))}.`;
  if (name.endsWith('Helper'))        return `Helper class providing utility methods for ${humanize(name.replace(/Helper$/, ''))}.`;
  if (name.endsWith('Entity'))        return `Data entity for ${humanize(name.replace(/Entity$/, ''))}.`;
  if (name.endsWith('Provider'))      return `Data provider for ${humanize(name.replace(/Provider$/, ''))}.`;

  // Generic fallback — still better than "ClassName class."
  return `Provides ${humanize(name)} functionality.`;
}

/**
 * Infer a meaningful `/// <summary>` description for a **method** based on its
 * name, return type, parameter list, and surrounding source context.
 */
function inferMethodSummary(name: string, returnType: string, params: Array<{ type: string; name: string }>): string {
  const n = name.toLowerCase();

  // ── Well-known D365FO method names ────────────────────────────────────────
  if (n === 'main')            return 'Entry point for the class.';
  if (n === 'run')             return 'Executes the main processing logic.';
  if (n === 'construct')       return 'Creates and returns a new instance.';
  if (n === 'new' || n === 'init')  return 'Initializes a new instance of the class.';
  if (n === 'insert')          return 'Inserts the record into the database.';
  if (n === 'update')          return 'Updates the record in the database.';
  if (n === 'delete')          return 'Deletes the record from the database.';
  if (n === 'validatewrite')   return 'Validates the record before it is written to the database.';
  if (n === 'validatedelete')  return 'Validates the record before it is deleted.';
  if (n === 'validatefield')   return 'Validates the specified field value.';
  if (n === 'modifiedfield')   return 'Handles logic when a field value is modified.';
  if (n === 'initvalue')       return 'Initializes default field values for a new record.';
  if (n === 'close')           return 'Handles cleanup when the form or object is closed.';
  if (n === 'pack')            return 'Serializes the class state into a container.';
  if (n === 'unpack')          return 'Restores the class state from a packed container.';
  if (n === 'dialog')          return 'Builds the dialog for user parameter input.';
  if (n === 'getfromdialog')   return 'Reads parameter values from the dialog after user confirmation.';
  if (n === 'canrun')          return 'Determines whether the operation can be executed.';
  if (n === 'description')     return 'Returns a user-readable description of the operation.';
  if (n === 'processreport')   return 'Main processing method that populates the report data set.';
  if (n === 'caption')         return 'Returns the caption displayed to the user.';
  if (n === 'defaultcaption')  return 'Returns the default caption for the operation.';

  // ── Prefix-based patterns ─────────────────────────────────────────────────
  if (n.startsWith('find'))       return `Finds a record matching the specified ${describeParams(params)}.`;
  if (n.startsWith('exist'))      return `Checks whether a record exists for the specified ${describeParams(params)}.`;
  if (n.startsWith('validate'))   return `Validates ${humanize(name.substring(8))}.`;
  if (n.startsWith('parm')) {
    const prop = humanize(name.substring(4));
    return `Gets or sets the ${prop} value.`;
  }
  if (n.startsWith('calc') || n.startsWith('compute'))  return `Calculates ${humanize(name.replace(/^calc|^compute/i, ''))}.`;
  if (n.startsWith('process'))    return `Processes ${humanize(name.substring(7))}.`;
  if (n.startsWith('populate'))   return `Populates ${humanize(name.substring(8))}.`;
  if (n.startsWith('build'))      return `Builds ${humanize(name.substring(5))}.`;
  if (n.startsWith('create'))     return `Creates ${humanize(name.substring(6))}.`;
  if (n.startsWith('init'))       return `Initializes ${humanize(name.substring(4))}.`;
  if (n.startsWith('get'))        return `Gets ${humanize(name.substring(3))}.`;
  if (n.startsWith('set'))        return `Sets ${humanize(name.substring(3))}.`;
  if (n.startsWith('is') || n.startsWith('can') || n.startsWith('has'))
    return `Determines whether ${humanize(name)}.`;
  if (n.startsWith('on'))         return `Handles the ${humanize(name.substring(2))} event.`;

  // ── Return-type hint ──────────────────────────────────────────────────────
  if (returnType === 'boolean')    return `${humanize(name)} and returns the result.`;

  // ── Fallback: humanize the method name ────────────────────────────────────
  const h = humanize(name);
  return h.charAt(0).toUpperCase() + h.substring(1) + '.';
}

/**
 * Build a short natural-language summary of parameters for use inside a method summary.
 * e.g. [ItemId _itemId, InventDimId _dimId] → "item id and invent dim id"
 */
function describeParams(params: Array<{ type: string; name: string }>): string {
  if (params.length === 0) return 'criteria';
  const names = params.map(p => humanize(p.name));
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * Infer a meaningful description for a method parameter.
 */
function inferParamDescription(paramName: string, paramType: string): string {
  const n = paramName.replace(/^_+/, '').toLowerCase();

  // Well-known parameter names
  if (n === 'args')           return 'The framework arguments.';
  if (n === 'sender')         return 'The event sender object.';
  if (n === 'e' || n === 'eventargs') return 'The event arguments.';
  if (n === 'insertmode')     return 'Indicates whether the operation is an insert.';
  if (n === 'ret' || n === 'result') return 'The validation result.';

  // Type-based inference
  if (paramType) {
    const t = paramType.toLowerCase();
    if (t === 'boolean') return `A value indicating whether ${humanize(paramName)}.`;
    if (t === 'args')    return 'The framework arguments.';
  }

  // Generic: humanize the parameter name + type
  const h = humanize(paramName);
  return paramType
    ? `The ${h} (${paramType}).`
    : `The ${h}.`;
}

/**
 * Infer a meaningful description for a return type.
 */
function inferReturnDescription(returnType: string, methodName: string): string {
  const r = returnType.toLowerCase();
  const n = methodName.toLowerCase();

  if (r === 'boolean') {
    if (n.startsWith('validate'))  return 'true if validation passes; otherwise, false.';
    if (n.startsWith('exist'))     return 'true if the record exists; otherwise, false.';
    if (n.startsWith('is') || n.startsWith('can') || n.startsWith('has'))
      return `true if ${humanize(methodName)}; otherwise, false.`;
    return 'true if the operation succeeds; otherwise, false.';
  }
  if (r === 'container')  return 'A packed container with the serialized state.';
  if (r === 'str')        return 'The resulting string value.';
  if (r === 'int' || r === 'int64' || r === 'real') return `The ${humanize(methodName)} value.`;

  return `The ${returnType} result.`;
}

/**
 * Ensures there is exactly one blank line between the last member-variable
 * declaration and the closing `}` of the class body in an X++ class declaration.
 *
 * D365FO convention (visible in all Microsoft standard classes):
 *   public class MyClass
 *   {
 *       TransDate fromDate;
 *       str       selectedZoneIds;
 *                                    ← blank line here
 *   }
 *
 * Idempotent: already-correct declarations (and empty class bodies) are returned
 * unchanged.
 */
export function ensureBlankLineBeforeClosingBrace(declaration: string): string {
  // Match a `;`-terminated line followed immediately by the lone closing `}` (no
  // blank line between them). Only fires when there is NO blank line already.
  return declaration.replace(/;([ \t]*)\n([ \t]*\}[ \t]*)$/, ';\n\n$2');
}

/**
 * Ensures every public or protected X++ method / class declaration has a
 * leading XML doc-comment block (/// <summary> … </summary>).
 *
 * Idempotent — if `/// <summary>` is already present the source is returned
 * unchanged. Private / internal methods are left as-is per D365FO convention.
 */
export function ensureXppDocComment(source: string): string {
  // Strip leading blank lines — prevents gap at top of <Declaration>
  const cleanSource = source.replace(/^\n+/, '');
  const lines = cleanSource.split('\n');

  // Already documented?
  const firstNonEmpty = lines.find(l => l.trim().length > 0);
  if (firstNonEmpty?.trim().startsWith('///')) {
    // Remove blank lines between /// doc-comment block and the next code line,
    // then normalise the /// block indentation to match the method signature.
    return normalizeDocBlockIndent(stripDocCommentGap(cleanSource));
  }

  // Collect attribute lines before the signature (needed for class inference)
  const attributeLines: string[] = [];
  let sigLine = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) {
      continue;
    }
    if (t.startsWith('[')) {
      attributeLines.push(t);
      continue;
    }
    sigLine = t;
    break;
  }
  if (!sigLine) return cleanSource;

  const parsed = parseSig(sigLine);
  if (!parsed) return cleanSource;

  // Detect indentation from the signature line so doc comments align with the code
  const sigLineRaw = lines.find(l => l.trim() === sigLine) ?? '';
  const indent     = sigLineRaw.match(/^(\s*)/)?.[1] ?? '';

  // ── Build doc block with meaningful, AI-quality descriptions ──────────────
  const doc: string[] = [];

  if (parsed.isClass) {
    const summary = inferClassSummary(parsed.name, parsed.baseClass, attributeLines);
    doc.push(`${indent}/// <summary>`);
    doc.push(`${indent}/// ${summary}`);
    doc.push(`${indent}/// </summary>`);
  } else {
    const summary = inferMethodSummary(parsed.name, parsed.returnType, parsed.params);
    doc.push(`${indent}/// <summary>`);
    doc.push(`${indent}/// ${summary}`);
    doc.push(`${indent}/// </summary>`);
    for (const param of parsed.params) {
      const paramDesc = inferParamDescription(param.name, param.type);
      doc.push(`${indent}/// <param name="${param.name}">${paramDesc}</param>`);
    }
    if (parsed.returnType && parsed.returnType !== 'void') {
      const returnDesc = inferReturnDescription(parsed.returnType, parsed.name);
      doc.push(`${indent}/// <returns>${returnDesc}</returns>`);
    }
  }

  return doc.join('\n') + '\n' + cleanSource;
}

/**
 * Re-indent the leading /// doc-comment block so its indentation matches the
 * first non-/// non-blank line (the attribute or method signature).
 *
 * An AI model may generate the /// block at column 0 while the signature is
 * indented (or vice-versa).  This function normalises the mismatch so the
 * first /// line always aligns with the rest of the method source.
 */
function normalizeDocBlockIndent(source: string): string {
  const lines = source.split('\n');

  // Detect the indentation of the first non-/// non-blank line (signature / attribute)
  let sigIndent = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('///')) continue;
    sigIndent = line.match(/^(\s*)/)?.[1] ?? '';
    break;
  }

  // Re-indent every leading /// line to use sigIndent
  const result: string[] = [];
  let inLeadingDocBlock = true;
  for (const line of lines) {
    if (inLeadingDocBlock && line.trim().startsWith('///')) {
      result.push(sigIndent + line.trim());
    } else {
      inLeadingDocBlock = false;
      result.push(line);
    }
  }
  return result.join('\n');
}

/**
 * Remove blank lines between the last /// doc-comment line and the next
 * non-blank code line (attribute or class/method keyword).
 *
 * D365FO convention: no gap between doc block and the declaration it documents.
 */
function stripDocCommentGap(source: string): string {
  // Match a /// line followed by one or more blank lines, then a non-blank line
  return source.replace(/(\/\/\/[^\n]*\n)\s*\n(?:\s*\n)+(?=\s*\S)/g, '$1');
}
