/**
 * The one XML template generator.
 *
 * This class used to be declared TWICE — once in `tools/write/createD365File.ts`
 * (44 statics) and once in `tools/xml/generateD365Xml.ts` (27, all a subset) —
 * with the comment on each half claiming the other could not drift from it. The
 * 2026-08-25 audit compared them method by method: 26 of the 27 shared methods
 * had diverged, and every divergence but the comments went the same way — a fix
 * had been made on the create side and never reached the generate mirror:
 *
 *  • extractInnerClassMethods — the create copy collects macro directives
 *    (`#Library`, `#define`, `#localmacro`) and emits them ahead of the member
 *    variables. The generate copy's "a member variable is a line ending in `;`"
 *    rule dropped every one of them, so `d365fo_file(action="generate")` handed
 *    back a class referencing an undefined macro that cannot compile.
 *    Regression: eval/corpus/runs/2026-07-23T18__L1-macro-library-flight.
 *  • generateAxClassXml / parseSourceForBridge — the generate copy skipped
 *    normalizeSelfReferenceName, so a class whose X++ header named something
 *    other than objectName kept the stale name in <Declaration>.
 *  • generateAxTableXml — the generate copy dropped the `sourceCode` parameter
 *    entirely, so table methods and declaration never reached the XML.
 *  • generate('table') — the generate copy did not parse the JSON field-spec
 *    shorthand some callers pass as sourceCode.
 *  • generate('data-entity') — the generate copy reindented method bodies with
 *    reindentXppSource instead of xppMethodSourceForXml (no trailing blank line)
 *    and skipped the self-reference normalization.
 *  • generateAxTableExtensionXml — the generate copy read only `f.fieldName` on
 *    index fields and only `fieldName`/`relatedFieldName` on relation
 *    constraints, writing <DataField>undefined</DataField> / <Field>undefined</Field>
 *    for the documented `fields: ["AccountNum"]` and `{field, relatedField}` shapes.
 *  • splitXppClassSource — the generate copy lacked the "exactly one blank line
 *    before the closing brace" normalization.
 *
 * Both former homes now import this module, as does generateSmartReport.ts.
 * tests/tools/xmlTemplateGeneratorSingleton.test.ts fails if a second copy of
 * the class, or of any generateAx*Xml implementation, ever reappears.
 */

import { escapeXml, decodeXmlEntitiesFromXppSource } from '../../utils/xmlEscape.js';
import { readMethodCall } from '../../utils/methodBodyHint.js';
import { ensureXppDocComment, ensureBlankLineBeforeClosingBrace } from '../../utils/xppDocGen.js';
import { xppMethodSourceForXml, reindentXppSource } from '../../utils/xppFormat.js';
import {
  assertKnownEnumValue,
  resolveEnumValueMode,
  RELATED_TABLE_CARDINALITIES,
  RELATION_CARDINALITIES,
  RELATIONSHIP_TYPES,
  SECURITY_POLICY_CONTEXT_TYPES,
} from '../../utils/axEnumProperties.js';
import { buildAxTableXml, buildAxTableIndexesXml } from './tableXml.js';
import { buildAxFormXml } from './formXml.js';
import {
  buildAxSecurityDutyXml,
  buildAxSecurityRoleXml,
  buildAxSecurityDutyExtensionXml,
  buildAxSecurityRoleExtensionXml,
} from './securityDutyRoleXml.js';
import { buildAxSecurityPrivilegeXml } from './securityPrivilegeXml.js';
import { buildAxDataEntityXml, assertDataEntityIsFunctional } from './dataEntityXml.js';
import { buildAxQueryXml, buildAxViewXml } from './queryViewXml.js';
import { buildAxMapXml } from './mapXml.js';
import { buildAxEdtExtensionXml } from './edtExtensionXml.js';
import { buildAxDataEntityViewExtensionXml } from './dataEntityViewExtensionXml.js';
import { buildAxMenuItemExtensionXml, type AxMenuItemExtensionRootElement } from './menuItemExtensionXml.js';
import { buildAxServiceXml, buildAxServiceGroupXml } from './serviceXml.js';

/**
 * XML Templates for different D365FO object types
 */
export class XmlTemplateGenerator {

  /**
   * Split X++ class source into the Declaration block (class header + field
   * declarations) and individual method bodies, as required by D365FO XML.
   *
   * D365FO XML structure:
   *   <Declaration> = class keyword + field declarations (the outer {} block)
   *   <Methods>     = one <Method><Name/><Source/></Method> per method body
   *
   * AI generators often emit the entire source (header + methods) as a single
   * string.  This helper separates them so the generated XML is correct.
   */
  static splitXppClassSource(fullSource: string): {
    declaration: string;
    methods: Array<{ name: string; source: string }>;
  } {
    // Find the '{' that opens the class body
    const firstBrace = fullSource.indexOf('{');
    if (firstBrace === -1) return { declaration: fullSource, methods: [] };

    // Walk to the matching '}' that closes the class header block
    let depth = 0;
    let classEndIdx = -1;
    for (let i = firstBrace; i < fullSource.length; i++) {
      if (fullSource[i] === '{') depth++;
      else if (fullSource[i] === '}') {
        depth--;
        if (depth === 0) { classEndIdx = i; break; }
      }
    }
    if (classEndIdx === -1) return { declaration: fullSource, methods: [] };

    let declaration = fullSource.substring(0, classEndIdx + 1);
    const rest = fullSource.substring(classEndIdx + 1);
    if (!rest.trim()) {
      // Nothing after the class closing brace — methods may be nested inside the class braces instead.
      const innerResult = XmlTemplateGenerator.extractInnerClassMethods(declaration);
      if (innerResult) {
        console.error(
          '[splitXppClassSource] Inner-class methods detected — extracting into ' +
          'separate <Method> elements (D365FO format).'
        );
        return innerResult;
      }
      // Ensure exactly one blank line before the closing '}' when the body has content.
      const bodyStart = declaration.indexOf('{');
      const bodyContent = declaration.substring(bodyStart + 1, declaration.lastIndexOf('}'));
      if (bodyContent.trim().length > 0) {
        declaration = declaration.replace(/\n+(\s*)}(\s*)$/, '\n\n}');
      }
      return { declaration, methods: [] };
    }

    // D365FO requires member-variable declarations inside <Declaration>, so rescue any that
    // appear outside the class {} but before the first method.
    const nextBraceInRest = rest.indexOf('{');
    if (nextBraceInRest !== -1) {
      const preMethodText = rest.substring(0, nextBraceInRest);
      const varLines = preMethodText
        .split('\n')
        .filter(l => {
          const t = l.trim();
          // A variable declaration ends with ';' and does NOT contain '(' (not a method call/signature)
          return t.endsWith(';') && !t.includes('(');
        });
      if (varLines.length > 0) {
        // Inject the rescued declarations into the class body, just before the closing '}'
        const injected = varLines.map(l => '    ' + l.trim()).join('\n');
        declaration = declaration.replace(/}(\s*)$/, `\n${injected}\n\n}`);
        console.error(
          `[splitXppClassSource] Rescued ${varLines.length} member variable declaration(s) ` +
          'found outside the class {} block — injected into <Declaration>.'
        );
      }
    }

    // Parse each method block from the remaining source
    const methods: Array<{ name: string; source: string }> = [];
    let pos = 0;
    while (pos < rest.length) {
      const nextBrace = rest.indexOf('{', pos);
      if (nextBrace === -1) break;

      const sigText = rest.substring(pos, nextBrace);

      // Find the matching '}' for this method body (depth-counting)
      let d = 0;
      let bodyEnd = -1;
      for (let i = nextBrace; i < rest.length; i++) {
        if (rest[i] === '{') d++;
        else if (rest[i] === '}') {
          d--;
          if (d === 0) { bodyEnd = i; break; }
        }
      }
      if (bodyEnd === -1) break;

      const methodSource = rest.substring(pos, bodyEnd + 1).trim();

      // Extract method name: last identifier before '(' in the signature
      const parenIdx = sigText.lastIndexOf('(');
      const nameMatch =
        parenIdx !== -1 ? sigText.substring(0, parenIdx).match(/(\w+)\s*$/) : null;
      const methodName = nameMatch ? nameMatch[1] : `method${methods.length + 1}`;

      methods.push({ name: methodName, source: methodSource });
      pos = bodyEnd + 1;
    }

    // Fallback: if the source had no methods after the class body, they may be
    // nested at depth-1 inside the class body instead — extract them there.
    if (methods.length === 0) {
      const innerResult = XmlTemplateGenerator.extractInnerClassMethods(declaration);
      if (innerResult) {
        console.error(
          '[splitXppClassSource] Extracted inner class methods — moving them from ' +
          '<Declaration> into separate <Method> elements (D365FO format).'
        );
        return innerResult;
      }
    }

    return { declaration, methods };
  }

  /**
   * Extract methods that are defined INSIDE the class body (depth-1 inside {}).
   *
   * D365FO XML requires each method as a separate <Method><Source/></Method> element.
   * When AI generates a class with methods inside the class braces, all code ends up
   * in <Declaration> with no blank-line separation between methods.
   *
   * This helper detects that pattern and returns the correct split:
   *   declaration = class header + member variable declarations only
   *   methods     = each method body as a separate entry
   *
   * Returns null when no inner methods are found (i.e. the class body is just fields).
   */
  static extractInnerClassMethods(classDeclaration: string): {
    declaration: string;
    methods: Array<{ name: string; source: string }>;
  } | null {
    const classOpenIdx = classDeclaration.indexOf('{');
    const classCloseIdx = classDeclaration.lastIndexOf('}');
    if (classOpenIdx === -1 || classCloseIdx <= classOpenIdx) return null;

    const classBody = classDeclaration.substring(classOpenIdx + 1, classCloseIdx);

    const methods: Array<{ name: string; source: string }> = [];
    const memberVarLines: string[] = [];
    // Macro directives (#Library include, #define, #localmacro/#endmacro) live in the
    // class declaration but have no trailing ';', so the member-var rule below would
    // drop them — leaving the class referencing an undefined macro and failing to
    // compile. Collected separately and emitted FIRST, before the member vars that
    // may use them. Regression: eval/corpus/runs/2026-07-23T18__L1-macro-library-flight.
    const macroDirectiveLines: string[] = [];

    let pos = 0;
    while (pos < classBody.length) {
      const nextBrace = classBody.indexOf('{', pos);
      if (nextBrace === -1) {
        // No more braces — collect any trailing member-variable declarations
        for (const line of classBody.substring(pos).split('\n')) {
          const t = line.trim();
          if (t.startsWith('#')) {
            macroDirectiveLines.push(t);
          } else if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*')) {
            memberVarLines.push(t);
          }
        }
        break;
      }

      const sigText = classBody.substring(pos, nextBrace);

      // Find the matching '}' for this block
      let depth = 0;
      let bodyEnd = -1;
      for (let i = nextBrace; i < classBody.length; i++) {
        if (classBody[i] === '{') depth++;
        else if (classBody[i] === '}') {
          depth--;
          if (depth === 0) { bodyEnd = i; break; }
        }
      }
      if (bodyEnd === -1) break;

      const parenIdx = sigText.lastIndexOf('(');
      if (parenIdx !== -1) {
        // The block is a method (sigText contains a '(' — it's a parameter list).
        // Collect member-variable lines that appeared before the method signature.
        for (const line of sigText.split('\n')) {
          const t = line.trim();
          if (t.startsWith('#')) {
            macroDirectiveLines.push(t);
          } else if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('[')) {
            memberVarLines.push(t);
          }
        }

        // Find where the actual method signature starts within sigText:
        // walk backward from the last '(' to include attribute annotations ('[…]').
        const beforeLastParen = sigText.substring(0, parenIdx);
        const lastNewlineBeforeLastParen = beforeLastParen.lastIndexOf('\n');
        let methodStartInSig = lastNewlineBeforeLastParen !== -1
          ? lastNewlineBeforeLastParen + 1
          : 0;

        // Include any leading [Attribute] and doc-comment (///) lines that belong to this method.
        // Walking BACKWARDS through the lines that appear above the method signature:
        // we stop as soon as we hit a line that is neither empty, nor an attribute, nor a comment.
        //
        // An attribute block may SPAN LINES, and only the first line starts with a bracket:
        //
        //     [DataMemberAttribute('Query'),
        //      AifQueryTypeAttribute('_packedQuery', queryStr(MyQuery))]
        //     public str parmQuery(str _packedQuery = '')
        //
        // Testing each line in isolation stopped this walk at the continuation
        // line, so BOTH lines were left behind — and the member-variable
        // collector above skips anything starting with '[' or not ending in ';',
        // so they were dropped silently. The class then compiled clean without
        // its attributes, which are syntactically optional: a green build, a
        // contract with no data members, and no message anywhere. It reached a
        // committed golden that way (L3-sysoperation-dialog-attributes lost all
        // five of the attributes its own README says it demonstrates).
        //
        // So the walk tracks bracket depth: once a ']' is seen, every line above
        // belongs to the block until the '[' that opened it.
        const sigBeforeMethod = sigText.substring(0, methodStartInSig);
        const sigBeforeLines = sigBeforeMethod.split('\n').reverse();
        let droppedChars = 0;
        let pendingClose = 0;
        for (const line of sigBeforeLines) {
          const t = line.trim();
          const opens = (t.match(/\[/g) ?? []).length;
          const closes = (t.match(/\]/g) ?? []).length;
          const insideAttribute = pendingClose > 0;
          const isAttributeLine = t.startsWith('[') || closes > opens;
          const isCommentOrBlank =
            t.length === 0 || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');

          if (insideAttribute || isAttributeLine || isCommentOrBlank) {
            droppedChars += line.length + 1; // +1 for '\n'
            pendingClose = Math.max(0, pendingClose + closes - opens);
          } else {
            break;
          }
        }
        methodStartInSig = Math.max(0, methodStartInSig - droppedChars);

        const methodSource = classBody
          .substring(pos + methodStartInSig, bodyEnd + 1)
          .trim();

        const nameMatch = sigText.substring(0, parenIdx).match(/(\w+)\s*$/);
        const methodName = nameMatch ? nameMatch[1] : `method${methods.length + 1}`;

        methods.push({ name: methodName, source: methodSource });
      } else {
        // Not a method (no '(' in sigText) — collect member-variable declarations
        for (const line of sigText.split('\n')) {
          const t = line.trim();
          if (t.startsWith('#')) {
            macroDirectiveLines.push(t);
          } else if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*')) {
            memberVarLines.push(t);
          }
        }
        // Skip the block (e.g. object initialiser)
      }

      pos = bodyEnd + 1;
    }

    if (methods.length === 0) return null;

    // Rebuild the declaration as: class header + macro directives + member variables.
    // Macro includes/#define must precede any member var that references them.
    const classHeader = classDeclaration.substring(0, classOpenIdx + 1);
    const declLines = [...macroDirectiveLines, ...memberVarLines];
    const declBodyXpp = declLines.length > 0
      ? '\n' + declLines.map(v => '    ' + v).join('\n') + '\n\n'
      : '\n';

    return {
      declaration: classHeader + declBodyXpp + '}',
      methods,
    };
  }

  /**
   * If `declaration`'s own `class`/`interface` header names something other than
   * `className` (e.g. the object is being created as "ContosoFoo" but the caller's
   * X++ still says `class Foo`), rename every self-reference to that stale name —
   * in the header AND in every method body (constructor calls, return types,
   * etc.) — to `className`.
   *
   * Left unfixed, the AOT object's `<Name>` (which the create path always sets to
   * the resolved `className`, independent of whatever the caller typed in
   * `sourceCode`) does not match its own X++ class keyword — a hard xppc build
   * error ("class must be named the same as the object it is contained in"),
   * confirmed by corpus evidence: the caller passed an already-correct,
   * fully-resolved objectName ("ContosoXyzNoteFormatter") — so the existing
   * objectName-vs-finalObjectName prefix-mismatch guard below never fired — while
   * sourceCode's `class XyzNoteFormatter` used the bare, unprefixed name
   * (eval/corpus/runs/2026-07-06T16__L1-class-basic__73707ff.json).
   */
  static normalizeSelfReferenceName<T extends { name: string; source?: string }>(
    className: string,
    declaration: string,
    methods: T[],
  ): { declaration: string; methods: T[] } {
    // Match the class/interface header on CODE lines only. Matching the raw text
    // let a doc comment win: "/// The <c>Foo</c> class is the workflow document"
    // yields declaredName="is", and the rename then replaced every standalone "is"
    // in the declaration and in every method body with the class name
    // ("class is the workflow document" → "class Foo the workflow document").
    // Reproduced from the 2026-07-21 eval sweep, finding #22.
    const codeOnly = declaration
      .split('\n')
      .filter(l => !l.trim().startsWith('///') && !l.trim().startsWith('//'))
      .join('\n');
    const declaredName = codeOnly.match(/\b(?:class|interface)\s+(\w+)/)?.[1];
    if (!declaredName || declaredName === className) return { declaration, methods };

    const re = new RegExp(`\\b${declaredName}\\b`, 'g');
    return {
      declaration: declaration.replace(re, className),
      methods: methods.map(m => ({
        ...m,
        source: m.source !== undefined ? m.source.replace(re, className) : m.source,
      })) as T[],
    };
  }

  /**
   * Parse X++ sourceCode into declaration + methods for the C# bridge.
   *
   * Used by the bridge-first creation path in create_d365fo_file — the C# side
   * expects declaration (class header + member vars) and an array of method
   * objects {name, source} which it sets on the AxClass via IMetadataProvider.
   *
   * Delegates to splitXppClassSource after decoding any XML entities.
   *
   * `className` is the resolved AOT object name the bridge will create this
   * class under (`finalObjectName`) — passing it lets self-references in the
   * caller's sourceCode that don't match get corrected (normalizeSelfReferenceName).
   */
  static parseSourceForBridge(sourceCode: string, className?: string): {
    declaration: string;
    methods: { name: string; source?: string }[];
  } {
    // Same entity-decoding as generateAxClassXml to handle AI-generated &lt; etc.
    const cleaned = decodeXmlEntitiesFromXppSource(sourceCode);
    const split = XmlTemplateGenerator.splitXppClassSource(cleaned);
    const result = className
      ? XmlTemplateGenerator.normalizeSelfReferenceName(className, split.declaration, split.methods)
      : split;
    return {
      declaration: result.declaration,
      // The bridge stores each method's source verbatim (no reformatting on its
      // side) — re-derive consistent indentation here so this CREATE path gets
      // the same fix as bridgeAddMethod's MODIFY path, and end it the way
      // shipped metadata does, with the blank line that separates methods.
      methods: result.methods.map(m => ({
        ...m,
        source: m.source !== undefined ? xppMethodSourceForXml(m.source) : m.source,
      })),
    };
  }

  /**
   * Generate AxClass XML structure
   */
  static generateAxClassXml(
    className: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    // Decode XML entities that AI models may introduce when copying from SSRS report
    // entity-encoded <Text> blocks (e.g. &lt;summary&gt; → <summary>).
    const rawSource = decodeXmlEntitiesFromXppSource(sourceCode || `public class ${className}\n{\n}`);

    // Split full X++ source into Declaration (class header + fields) and Methods.
    // D365FO XML requires member variable declarations in <Declaration> and
    // each method body as a separate <Method> element under <Methods>.
    const rawSplit = XmlTemplateGenerator.splitXppClassSource(rawSource);
    // Correct any stale self-reference (caller's class/interface name doesn't match
    // the resolved `className`) so the emitted <Name> and X++ class keyword agree.
    const { declaration, methods } = XmlTemplateGenerator.normalizeSelfReferenceName(
      className, rawSplit.declaration, rawSplit.methods,
    );

    const extendsAttr = properties?.extends
      ? `\t<Extends>${properties.extends}</Extends>\n`
      : '';
    const implementsAttr = properties?.implements
      ? `\t<Implements>${properties.implements}</Implements>\n`
      : '';

    const methodsXml =
      methods.length === 0
        ? '\t\t<Methods />\n'
        : `\t\t<Methods>\n${methods
            .map(
              m =>
                `\t\t\t<Method>\n\t\t\t\t<Name>${m.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${reindentXppSource(ensureXppDocComment(m.source))}\n\n]]></Source>\n\t\t\t</Method>`
            )
            .join('\n\n')}\n\t\t</Methods>\n`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${className}</Name>
${extendsAttr}${implementsAttr}\t<SourceCode>
\t\t<Declaration><![CDATA[
${ensureBlankLineBeforeClosingBrace(ensureXppDocComment(declaration))}
]]></Declaration>
${methodsXml}\t</SourceCode>
</AxClass>
`;
  }

  /**
   * Generate AxClass XML structure for a Chain of Command (class-extension).
   * The XML format is identical to a regular AxClass — the distinction is purely
   * in the X++ source code ([ExtensionOf(classStr(...))] + final modifier).
   *
   * properties.baseClass   — name of the class being extended (required)
   * properties.modelInfix  — naming infix, e.g. "ContosoExt" → BaseClass_ContosoExt_Extension
   */
  static generateAxClassExtensionXml(
    extensionName: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    const baseClass = properties?.baseClass || extensionName.replace(/_[^_]+_Extension$/, '');

    const defaultSource = sourceCode ||
      `[ExtensionOf(classStr(${baseClass}))]\nfinal class ${extensionName}\n{\n    // ⚠️  ALWAYS call next <methodName>() — verify exact signature with:\n    //     ${readMethodCall('class', baseClass, '<methodName>')}\n    //\n    // Template for wrapping a method:\n    //   public ReturnType methodName(ParamType _param)\n    //   {\n    //       ReturnType result = next methodName(_param);\n    //       return result;\n    //   }\n}`;

    return XmlTemplateGenerator.generateAxClassXml(extensionName, defaultSource, { ...properties });
  }

  /**
   * Generate AxTable XML structure (based on real D365FO table structure)
   */
  static generateAxTableXml(
    tableName: string,
    properties?: Record<string, any>,
    sourceCode?: string,
  ): string {
    return buildAxTableXml(
      tableName,
      properties,
      sourceCode?.trim()
        ? XmlTemplateGenerator.parseSourceForBridge(sourceCode, tableName)
        : undefined,
    );
  }

  /**
   * Generate AxEnum XML structure
   */
  static generateAxEnumXml(
    enumName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || enumName;
    const configKeyXml = properties?.configurationKey
      ? `\t<ConfigurationKey>${properties.configurationKey}</ConfigurationKey>\n`
      : '';

    // Build <EnumValues> block from properties.enumValues array
    // Each entry: { name: string; value?: number; label?: string; helpText?: string }
    const enumValueSpecs: Array<{ name: string; value?: number; label?: string; helpText?: string }> =
      Array.isArray(properties?.enumValues) ? properties.enumValues : [];

    // D365FO hard limit: max 251 elements (0–250). Warn early — compiler rejects beyond this.
    if (enumValueSpecs.length > 251) {
      throw new Error(
        `Enum '${enumName}' has ${enumValueSpecs.length} values but D365FO supports a maximum of 251 (0–250). ` +
        `Consider redesigning as a class hierarchy or splitting into multiple enums.`
      );
    }

    const { useEnumValue, suppressExplicitValues } = resolveEnumValueMode(enumName, properties, enumValueSpecs);

    let enumValuesXml: string;
    if (enumValueSpecs.length === 0) {
      enumValuesXml = '\t<EnumValues />\n';
    } else {
      enumValuesXml = '\t<EnumValues>\n';
      let autoValue = 0;
      for (const v of enumValueSpecs) {
        const intValue = v.value ?? autoValue;
        autoValue = intValue + 1;
        enumValuesXml += `\t\t<AxEnumValue>\n`;
        enumValuesXml += `\t\t\t<Name>${v.name}</Name>\n`;
        if (v.label) enumValuesXml += `\t\t\t<Label>${escapeXml(v.label)}</Label>\n`;
        if (v.helpText) enumValuesXml += `\t\t\t<HelpText>${escapeXml(v.helpText)}</HelpText>\n`;
        // Omit <Value> when UseEnumValue=No (position-based ordering) or for implicit 0
        if (intValue !== 0 && !suppressExplicitValues) enumValuesXml += `\t\t\t<Value>${intValue}</Value>\n`;
        enumValuesXml += `\t\t</AxEnumValue>\n`;
      }
      enumValuesXml += '\t</EnumValues>\n';
    }

    // IsExtensible goes after EnumValues; value is lowercase true/false
    const isExtensibleXml = properties?.isExtensible ? '\t<IsExtensible>true</IsExtensible>\n' : '';

    // Element order matches real D365FO: Name → ConfigurationKey → Label → UseEnumValue → EnumValues → IsExtensible
    return `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${enumName}</Name>
${configKeyXml}\t<Label>${escapeXml(label)}</Label>
\t<UseEnumValue>${useEnumValue}</UseEnumValue>
${enumValuesXml}${isExtensibleXml}</AxEnum>
`;
  }

  /**
   * Generate AxForm XML for a new form from a pattern template.
   *
   * Delegates to the pattern-compliant {@link FormPatternTemplates} builders so
   * the generated skeleton actually satisfies the form-pattern gate. The old
   * inline skeleton declared a `<Pattern>` over empty `<Controls />`, which the
   * gate rejected as FP003 (required Grid/ActionPane missing) for every pattern
   * — and worse, defaulted to a `DetailsTransaction` pattern even when the
   * caller asked for a `SimpleList` template, guaranteeing a mismatch block.
   *
   * Pattern resolution: callers may express the intent as either `pattern`
   * (the design pattern) or `formTemplate` (the VS template name); both are
   * fuzzy strings normalized to a canonical pattern. When neither is given we
   * default to SimpleList — the most common shape for a new setup table.
   */
  static generateAxFormXml(
    formName: string,
    properties?: Record<string, any>,
  ): string {
    return buildAxFormXml(formName, properties);
  }

  /**
   * Generate AxQuery XML structure. Delegates to the shared builder so this
   * cannot drift from generateD365Xml.ts's copy — see queryViewXml.ts for the
   * property contract and why `dataSource` matters.
   */
  static generateAxQueryXml(
    queryName: string,
    properties?: Record<string, any>
  ): string {
    return buildAxQueryXml(queryName, properties);
  }

  /**
   * Generate AxView XML structure. Delegates to the shared builder so this
   * cannot drift from generateD365Xml.ts's copy — see queryViewXml.ts for the
   * property contract and why `query`/`fields` matter.
   */
  static generateAxViewXml(
    viewName: string,
    properties?: Record<string, any>
  ): string {
    return buildAxViewXml(viewName, properties);
  }

  /**
   * Generate AxMap XML structure. Delegates to the shared builder so this
   * cannot drift from generateD365Xml.ts's copy — see mapXml.ts for the
   * property contract.
   */
  static generateAxMapXml(
    mapName: string,
    properties?: Record<string, any>
  ): string {
    return buildAxMapXml(mapName, properties);
  }

  /**
   * Generate AxDataEntityView XML structure
   */
  /**
   * Generate AxDataEntityView XML. Delegates to the shared builder so this
   * cannot drift from generateD365Xml.ts's copy (they already had — see
   * dataEntityXml.ts for the property contract and why primaryTable/fields
   * matter).
   */
  static generateAxDataEntityXml(
    entityName: string,
    properties?: Record<string, any>
  ): string {
    // The result of THIS call gets written to disk and reported as created, so the
    // inert-skeleton branch is refused here rather than in the builder (whose
    // skeleton output is the pinned element-order baseline).
    assertDataEntityIsFunctional(entityName, properties);
    return buildAxDataEntityXml(entityName, properties);
  }

  /**
   * Generate AxReport XML skeleton.
   *
   * properties:
   *   dpClassName   - Data Provider class name          (default: <ReportName>DP)
   *   tmpTableName  - TempDB table name                 (default: <ReportName>Tmp)
   *   datasetName   - AxReportDataSet name              (default: tmpTableName)
   *   designName    - AxReportDesign name               (default: 'Report')
   *   caption       - Design caption label ref           (e.g. '@MyModel:MyLabel')
   *   style         - Design style template             (e.g. 'TableStyleTemplate')
   *   aotQuery      - AOT query name for DynamicParameter (e.g. 'SalesTable')
   *   fields        - Array of { name, alias?, dataType?, caption?, disableAutoCreate? } → AxReportDataSetField
   *   datasets      - Array of { name, dpClassName, tmpTableName, fields?, aotQuery?, contractParams? } for multi-dataset reports
   *   contractParams - Array of { name, dataType?, label?, defaultValue? } → contract class parameters (DataMember)
   *   rdlContent    - Full RDL XML string to embed (auto-generated from fields when omitted)
   *
   * AOT structure generated (mirrors real D365FO reports like ContosoReports_CashOrder_CZ):
   *   <AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">
   *     <DataMethods />
   *     <DataSets>
   *       <AxReportDataSet xmlns="">           ← one per dataset
   *         <Fields>…</Fields>
   *         <Parameters>   ← 6 AX system params + {DPCLASS}_DynamicParameter
   *       </AxReportDataSet>
   *     </DataSets>
   *     <DefaultParameterGroup>               ← 6 AX params + DynamicParameter (with AOTQuery+DataType)
   *     <Designs>
   *       <AxReportDesign xmlns="" i:type="AxReportPrecisionDesign">
   *         <Text><![CDATA[…RDL…]]></Text>   ← 2016 schema with DataSources/DataSets/ReportParameters
   *         <DisableIndividualTransformation><Name>…</Name></DisableIndividualTransformation>
   *     </Designs>
   *   </AxReport>
   */
  static generateAxReportXml(
    reportName: string,
    properties?: Record<string, any>
  ): string {
    // ── Type helpers ─────────────────────────────────────────────────────────
    type FieldDef = {
      name: string; alias?: string; dataType?: string;
      caption?: string; disableAutoCreate?: boolean;
    };
    type DatasetDef = {
      name: string; dpClassName: string; tmpTableName: string;
      fields?: FieldDef[]; aotQuery?: string;
      contractParams?: Array<{ name: string; dataType?: string; label?: string; defaultValue?: string }>;
    };

    // ── Resolve datasets (multi-dataset array OR single-dataset shorthand) ──
    let datasets: DatasetDef[];
    if (properties?.datasets && Array.isArray(properties.datasets)) {
      datasets = properties.datasets as DatasetDef[];
    } else {
      const tmpTableName = properties?.tmpTableName || `${reportName}Tmp`;
      const dpClassName  = properties?.dpClassName  || `${reportName}DP`;
      const datasetName  = properties?.datasetName  || tmpTableName;
      datasets = [{
        name:         datasetName,
        dpClassName,
        tmpTableName,
        fields:       properties?.fields    as FieldDef[] | undefined,
        aotQuery:     properties?.aotQuery  as string     | undefined,
        contractParams: properties?.contractParams as Array<{ name: string; dataType?: string; label?: string; defaultValue?: string }> | undefined,
      }];
    }
    const designName = properties?.designName || 'Report';

    // ── RDL .NET type mapping ──
    const rdlType = (dt?: string): string => {
      switch (dt) {
        case 'System.Double':   return 'System.Double';
        case 'System.Int32':    return 'System.Int32';
        case 'System.Int64':    return 'System.Int64';
        case 'System.DateTime': return 'System.DateTime';
        case 'System.Byte[]':   return 'System.Byte[]';
        default:                return 'System.String';
      }
    };

    // ── UUID helper — use Node.js crypto for guaranteed RFC-4122 v4 format ──
    const uuid = (): string => crypto.randomUUID();

    // ── Build one AxReportDataSet XML entry ──
    const buildDatasetXml = (ds: DatasetDef): string => {
      const dpParamName = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
      const contractDatasetParamsXml = (ds.contractParams || []).map(cp => {
        const pn = `${ds.name}_ds_${cp.name}`;
        const dt = cp.dataType || 'System.String';
        return `\t\t\t\t<AxReportDataSetParameter>\n\t\t\t\t\t<Name>${pn}</Name>\n\t\t\t\t\t<Alias>${pn}</Alias>\n\t\t\t\t\t<DataType>${dt}</DataType>\n\t\t\t\t\t<Parameter>${pn}</Parameter>\n\t\t\t\t</AxReportDataSetParameter>`;
      }).join('\n');
      let fieldsXml: string;
      if (ds.fields && ds.fields.length > 0) {
        const entries = ds.fields.map(f => {
          const alias      = f.alias    || `${ds.tmpTableName}.1.${f.name}`;
          const capLine    = f.caption          ? `\n\t\t\t\t<Caption>${escapeXml(f.caption)}</Caption>`                                 : '';
          const dtLine     = f.dataType         ? `\n\t\t\t\t<DataType>${f.dataType}</DataType>`                              : '';
          const disableLine = f.disableAutoCreate ? `\n\t\t\t\t<DisableAutoCreateInDataRegion>true</DisableAutoCreateInDataRegion>` : '';
          return [
            `\t\t\t<AxReportDataSetField>`,
            `\t\t\t\t<Name>${f.name}</Name>`,
            `\t\t\t\t<Alias>${alias}</Alias>${capLine}${dtLine}${disableLine}`,
            `\t\t\t\t<DisplayWidth>Auto</DisplayWidth>`,
            `\t\t\t\t<UserDefined>false</UserDefined>`,
            `\t\t\t</AxReportDataSetField>`,
          ].join('\n');
        });
        fieldsXml = `\t\t\t<Fields>\n${entries.join('\n')}\n\t\t\t</Fields>`;
      } else {
        // ⚠ No field definitions provided — dataset will have no columns visible in the
        // D365FO Report Designer.  Caller MUST pass a `fields` array listing all TmpTable
        // columns that the report should expose (name, alias, dataType).  Without this the
        // designer shows an empty dataset and the RDL tablix has no fields to bind to.
        fieldsXml = `\t\t\t<Fields />`;
      }
      return `\t\t<AxReportDataSet xmlns="">
\t\t\t<Name>${ds.name}</Name>
\t\t\t<DataSourceType>ReportDataProvider</DataSourceType>
\t\t\t<Query>SELECT * FROM ${ds.dpClassName}.${ds.tmpTableName}</Query>
\t\t\t<FieldGroups />
${fieldsXml}
\t\t\t<Parameters>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t\t\t<Alias>AX_PartitionKey</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_PartitionKey</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_CompanyName</Name>
\t\t\t\t\t<Alias>AX_CompanyName</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_CompanyName</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_UserContext</Name>
\t\t\t\t\t<Alias>AX_UserContext</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_UserContext</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_RenderingCulture</Name>
\t\t\t\t\t<Alias>AX_RenderingCulture</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_RenderingCulture</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_ReportContext</Name>
\t\t\t\t\t<Alias>AX_ReportContext</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_ReportContext</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_RdpPreProcessedId</Name>
\t\t\t\t\t<Alias>AX_RdpPreProcessedId</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_RdpPreProcessedId</Parameter>
\t\t\t\t</AxReportDataSetParameter>
${contractDatasetParamsXml ? contractDatasetParamsXml + '\n' : ''}\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>${dpParamName}</Name>
\t\t\t\t\t<Alias>${dpParamName}</Alias>
\t\t\t\t\t<DataType>Microsoft.Dynamics.AX.Framework.Services.Client.QueryMetadata</DataType>
\t\t\t\t\t<Parameter>${dpParamName}</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t</Parameters>
\t\t</AxReportDataSet>`;
    };

    const datasetsXml = datasets.map(buildDatasetXml).join('\n');

    // ── DefaultParameterGroup (uses first dataset's DP for DynamicParameter) ──
    const firstDs      = datasets[0];
    const dpParamName  = `${firstDs.dpClassName.toUpperCase()}_DynamicParameter`;
    const aotQueryLine = firstDs.aotQuery ? `\n\t\t\t\t<AOTQuery>${firstDs.aotQuery}</AOTQuery>` : '';

    // Contract parameters (from DataContract class with [DataMember] attributes)
    const contractParamsXml = (firstDs.contractParams || []).map(cp => {
      const dataTypeLine = cp.dataType ? `\n\t\t\t\t<DataType>${cp.dataType}</DataType>` : '';
      const promptLine = cp.label ? `\n\t\t\t\t<PromptString>${cp.label}</PromptString>` : '';
      return `\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>${firstDs.name}_ds_${cp.name}</Name>${dataTypeLine}${promptLine}
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>`;
    }).join('\n');

    const defaultParamGroupXml = `\t<DefaultParameterGroup>
\t\t<Name xmlns="">Parameters</Name>
\t\t<ReportParameterBases xmlns="">
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_CompanyName</Name>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_UserContext</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_RenderingCulture</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_ReportContext</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_RdpPreProcessedId</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
${contractParamsXml}${contractParamsXml ? '\n' : ''}\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>${dpParamName}</Name>${aotQueryLine}
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<DataType>Microsoft.Dynamics.AX.Framework.Services.Client.QueryMetadata</DataType>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t</ReportParameterBases>
\t</DefaultParameterGroup>`;

    // ── Auto-generate RDL skeleton (2016 namespace, mirrors real D365FO reports) ──
    const buildRdlSkeleton = (): string => {
      const ns2016 = 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition';
      const nsRd   = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';

      // DataSources block — single shared AX data source
      const rdlDataSourcesXml =
`  <DataSources>
    <DataSource Name="AutoGen__ReportDataProvider">
      <Transaction>true</Transaction>
      <ConnectionProperties>
        <DataProvider>AXREPORTDATAPROVIDER</DataProvider>
        <ConnectString />
        <IntegratedSecurity>true</IntegratedSecurity>
      </ConnectionProperties>
      <rd:DataSourceID>${uuid()}</rd:DataSourceID>
    </DataSource>
  </DataSources>`;

      // Build one RDL DataSet per AxReportDataSet
      const buildRdlDataset = (ds: DatasetDef): string => {
        const dsDpParam   = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
        const contractParamNamesRdl = (ds.contractParams || []).map(cp => `${ds.name}_ds_${cp.name}`);
        const paramNames  = [
          'AX_PartitionKey', 'AX_CompanyName', 'AX_UserContext',
          'AX_RenderingCulture', 'AX_ReportContext', 'AX_RdpPreProcessedId',
          ...contractParamNamesRdl,
          dsDpParam,
        ];
        const queryParams = paramNames
          .map(p =>
            `          <QueryParameter Name="${p}">\n            <Value>=Parameters!${p}.Value</Value>\n          </QueryParameter>`)
          .join('\n');

        let rdlFields = '';
        if (ds.fields && ds.fields.length > 0) {
          const flines = ds.fields.map(f => {
            const alias = f.alias || `${ds.tmpTableName}.1.${f.name}`;
            return `        <Field Name="${f.name}">\n          <DataField>${alias}</DataField>\n          <rd:TypeName>${rdlType(f.dataType)}</rd:TypeName>\n        </Field>`;
          });
          rdlFields = `      <Fields>\n${flines.join('\n')}\n      </Fields>\n`;
        }
        return `    <DataSet Name="${ds.name}">
      <rd:DataSetID>${uuid()}</rd:DataSetID>
      <Query>
        <DataSourceName>AutoGen__ReportDataProvider</DataSourceName>
        <QueryParameters>
${queryParams}
        </QueryParameters>
        <CommandText>SELECT * FROM ${ds.dpClassName}.${ds.tmpTableName}</CommandText>
        <rd:UseGenericDesigner>true</rd:UseGenericDesigner>
      </Query>
${rdlFields}      <rd:DataSetInfo>
        <rd:DataSetName>${ds.name}</rd:DataSetName>
        <rd:TableName>Fields</rd:TableName>
        <rd:TableAdapterFillMethod>Fill</rd:TableAdapterFillMethod>
        <rd:TableAdapterGetDataMethod>GetData</rd:TableAdapterGetDataMethod>
        <rd:TableAdapterName>FieldsTableAdapter</rd:TableAdapterName>
      </rd:DataSetInfo>
    </DataSet>`;
      };

      const rdlDatasetsXml = `  <DataSets>\n${datasets.map(buildRdlDataset).join('\n')}\n  </DataSets>`;

      // ── Build a simple detail tablix for each dataset so the design is not empty ──
      const buildRdlTablix = (ds: DatasetDef): string => {
        if (!ds.fields || ds.fields.length === 0) return '';
        const n      = ds.fields.length;
        const colW   = +Math.min(1.5, 7 / n).toFixed(2);
        const totalW = +(colW * n).toFixed(2);
        const grp    = `Details_${ds.name}`;
        const cols   = ds.fields.map(() =>
          `            <TablixColumn><Width>${colW}in</Width></TablixColumn>`).join('\n');
        const hCells = ds.fields.map(f => [
          `            <TablixCell><CellContents>`,
          `              <Textbox Name="Textbox_${f.name}_H">`,
          `                <CanGrow>true</CanGrow><Value>${f.name}</Value>`,
          `                <Style><FontWeight>Bold</FontWeight>`,
          `                  <BackgroundColor>LightGrey</BackgroundColor>`,
          `                  <Border><Style>Solid</Style></Border>`,
          `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
          `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
          `                </Style></Textbox>`,
          `            </CellContents></TablixCell>`,
        ].join('\n')).join('\n');
        const dCells = ds.fields.map(f => [
          `            <TablixCell><CellContents>`,
          `              <Textbox Name="Textbox_${f.name}">`,
          `                <CanGrow>true</CanGrow><Value>=Fields!${f.name}.Value</Value>`,
          `                <Style><Border><Style>Solid</Style></Border>`,
          `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
          `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
          `                </Style></Textbox>`,
          `            </CellContents></TablixCell>`,
        ].join('\n')).join('\n');
        const cMembers = ds.fields.map(() => `          <TablixMember />`).join('\n');
        return [
          `        <Tablix Name="Tablix_${ds.name}">`,
          `          <TablixBody>`,
          `            <TablixColumns>`,
          cols,
          `            </TablixColumns>`,
          `            <TablixRows>`,
          `              <TablixRow><Height>0.25in</Height><TablixCells>`,
          hCells,
          `              </TablixCells></TablixRow>`,
          `              <TablixRow><Height>0.25in</Height><TablixCells>`,
          dCells,
          `              </TablixCells></TablixRow>`,
          `            </TablixRows>`,
          `          </TablixBody>`,
          `          <TablixColumnHierarchy><TablixMembers>`,
          cMembers,
          `          </TablixMembers></TablixColumnHierarchy>`,
          `          <TablixRowHierarchy><TablixMembers>`,
          `            <TablixMember>`,
          `              <KeepWithGroup>After</KeepWithGroup>`,
          `              <RepeatOnNewPage>true</RepeatOnNewPage>`,
          `            </TablixMember>`,
          `            <TablixMember><Group Name="${grp}"><DataGroupName>${grp}</DataGroupName></Group></TablixMember>`,
          `          </TablixMembers></TablixRowHierarchy>`,
          `          <DataSetName>${ds.name}</DataSetName>`,
          `          <Top>0.5in</Top><Left>0.5in</Left>`,
          `          <Height>0.5in</Height><Width>${totalW}in</Width>`,
          `          <Style><Border><Style>Solid</Style></Border></Style>`,
          `        </Tablix>`,
        ].join('\n');
      };
      const rdlBodyItemsXml = datasets.map(buildRdlTablix).filter(Boolean).join('\n');
      const rdlBodyTag = rdlBodyItemsXml
        ? `        <ReportItems>\n${rdlBodyItemsXml}\n        </ReportItems>`
        : `        <ReportItems />`;

      // ReportParameters — 6 AX system params + DynamicParameter + contract params (all hidden)
      const contractRdlParams = (firstDs.contractParams || []).map(cp => ({
        name: `${firstDs.name}_ds_${cp.name}`,
        nullable: true, blank: true, usedInQuery: true,
      }));
      const rdlParamDefs = [
        { name: 'AX_PartitionKey',      nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_CompanyName',        nullable: false, blank: false, usedInQuery: false },
        { name: 'AX_UserContext',        nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_RenderingCulture',   nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_ReportContext',       nullable: true,  blank: true,  usedInQuery: true  },
        { name: 'AX_RdpPreProcessedId',  nullable: true,  blank: true,  usedInQuery: false },
        { name: dpParamName,             nullable: true,  blank: true,  usedInQuery: false },
        ...contractRdlParams,
      ];
      const rdlParamsXml = `  <ReportParameters>\n` +
        rdlParamDefs.map(p => {
          const nullLine  = p.nullable     ? `\n      <Nullable>true</Nullable>`        : '';
          const blankLine = p.blank        ? `\n      <AllowBlank>true</AllowBlank>`    : '';
          const usedLine  = p.usedInQuery  ? `\n      <UsedInQuery>true</UsedInQuery>` : '';
          return `    <ReportParameter Name="${p.name}">\n      <DataType>String</DataType>${nullLine}${blankLine}\n      <Prompt>${p.name}</Prompt>\n      <Hidden>true</Hidden>${usedLine}\n    </ReportParameter>`;
        }).join('\n') + `\n  </ReportParameters>`;

      // ReportParametersLayout
      const cellDefs = rdlParamDefs
        .map((p, i) =>
          `        <CellDefinition>\n          <ColumnIndex>${i}</ColumnIndex>\n          <RowIndex>0</RowIndex>\n          <ParameterName>${p.name}</ParameterName>\n        </CellDefinition>`)
        .join('\n');
      const rdlParamLayoutXml =
`  <ReportParametersLayout>
    <GridLayoutDefinition>
      <NumberOfColumns>${rdlParamDefs.length}</NumberOfColumns>
      <NumberOfRows>1</NumberOfRows>
      <CellDefinitions>
${cellDefs}
      </CellDefinitions>
    </GridLayoutDefinition>
  </ReportParametersLayout>`;

      return `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="${ns2016}" xmlns:rd="${nsRd}">
  <AutoRefresh>0</AutoRefresh>
${rdlDataSourcesXml}
${rdlDatasetsXml}
  <ReportSections>
    <ReportSection>
      <Body>
${rdlBodyTag}
        <Height>1in</Height>
        <Style>
          <Border>
            <Style>None</Style>
          </Border>
        </Style>
      </Body>
      <Width>7.5in</Width>
      <Page>
        <PageHeight>11.69in</PageHeight>
        <PageWidth>8.27in</PageWidth>
        <InteractiveHeight>11in</InteractiveHeight>
        <InteractiveWidth>8.5in</InteractiveWidth>
        <LeftMargin>0.2in</LeftMargin>
        <TopMargin>0.2in</TopMargin>
        <Style />
      </Page>
    </ReportSection>
  </ReportSections>
${rdlParamsXml}
${rdlParamLayoutXml}
  <Language>en-US</Language>
  <rd:ReportUnitType>Inch</rd:ReportUnitType>
  <rd:ReportID>${uuid()}</rd:ReportID>
</Report>`;
    };

    // ── Design block ──
    const captionLine = properties?.caption ? `\n\t\t\t<Caption>${escapeXml(properties.caption)}</Caption>` : '';
    const styleLine   = properties?.style   ? `\n\t\t\t<Style>${properties.style}</Style>`       : '';
    const rdlContent  = properties?.rdlContent as string | undefined;
    // Sanitize: fix old-schema <Header> inside <TablixMember> — renamed to <TablixHeader> in 2016 RDL.
    // This handles AI-generated or older-tool-generated RDL that still uses the pre-2016 element name.
    const rdl = (rdlContent || buildRdlSkeleton())
      .replace(/<Header>/g, '<TablixHeader>')
      .replace(/<\/Header>/g, '</TablixHeader>');
    const textElement = `\n\t\t\t<Text><![CDATA[${rdl}]]></Text>`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V2">
\t<Name>${reportName}</Name>
\t<DataMethods />
\t<DataSets>
${datasetsXml}
\t</DataSets>
${defaultParamGroupXml}
\t<Designs>
\t\t<AxReportDesign xmlns=""
\t\t\t\ti:type="AxReportPrecisionDesign">
\t\t\t<Name>${designName}</Name>${captionLine}${styleLine}${textElement}
\t\t\t<DisableIndividualTransformation>
\t\t\t\t<Name>DisableIndividualTransformation</Name>
\t\t\t</DisableIndividualTransformation>
\t\t</AxReportDesign>
\t</Designs>
\t<EmbeddedImages />
</AxReport>`;
  }

  /**
   * Generate XML based on object type
   */
  static generate(
    objectType: string,
    objectName: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    switch (objectType) {
      case 'class':
        return this.generateAxClassXml(objectName, sourceCode, properties);
      case 'class-extension':
        return this.generateAxClassExtensionXml(objectName, sourceCode, properties);
      case 'table': {
        // sourceCode carries either X++ (declaration + methods — see
        // generateAxTableXml, findings #19) or, from some callers, a JSON blob of
        // field definitions. Parse the JSON shape into properties; anything else is
        // treated as X++ and handed to the table generator as source.
        let mergedProperties = properties;
        if (sourceCode && sourceCode.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(sourceCode);
            if (parsed && (Array.isArray(parsed.fields) || parsed.label || parsed.tableGroup)) {
              mergedProperties = { ...parsed, ...properties }; // explicit properties win
              console.error('[create_d365fo_file] Parsed table field definitions from sourceCode JSON');
            }
          } catch {
            // Not valid JSON — ignore
          }
        }
        const tableSource = sourceCode && !sourceCode.trim().startsWith('{')
          ? sourceCode
          : undefined;
        return this.generateAxTableXml(objectName, mergedProperties, tableSource);
      }
      case 'enum':
        return this.generateAxEnumXml(objectName, properties);
      case 'form':
        return this.generateAxFormXml(objectName, properties);
      case 'query':
        return this.generateAxQueryXml(objectName, properties);
      case 'view':
        return this.generateAxViewXml(objectName, properties);
      case 'map':
        return this.generateAxMapXml(objectName, properties);
      case 'data-entity': {
        // X++ passed for a data entity used to be dropped on the floor: the
        // caller got a ✅ and an entity with no <SourceCode> at all. Split it
        // here (the builder deliberately does no X++ parsing) so validateWrite /
        // postLoad overrides survive. Accepts the top-level sourceCode arg or
        // properties.sourceCode; explicit declaration/methods still win.
        const entitySource = sourceCode ?? (properties as any)?.sourceCode;
        let entityProps = properties;
        if (typeof entitySource === 'string' && entitySource.trim()) {
          const parsed = XmlTemplateGenerator.parseSourceForBridge(entitySource, objectName);
          entityProps = { declaration: parsed.declaration, methods: parsed.methods, ...properties };
        }
        return this.generateAxDataEntityXml(objectName, entityProps);
      }
      case 'report':
        return this.generateAxReportXml(objectName, properties);
      case 'edt':
        return this.generateAxEdtXml(objectName, properties);
      case 'table-extension':
        return this.generateAxTableExtensionXml(objectName, properties);
      case 'form-extension':
        return this.generateAxFormExtensionXml(objectName);
      case 'edt-extension':
        return this.generateAxEdtExtensionXml(objectName, properties);
      case 'enum-extension':
        return this.generateAxEnumExtensionXml(objectName, properties);
      case 'data-entity-extension':
        return this.generateAxDataEntityViewExtensionXml(objectName, properties);
      case 'menu-item-display':
      case 'menu-item-action':
      case 'menu-item-output':
        return this.generateAxMenuItemXml(objectType, objectName, properties);
      case 'menu-item-display-extension':
        return this.generateAxMenuItemExtensionXml('AxMenuItemDisplayExtension', objectName, properties);
      case 'menu-item-action-extension':
        return this.generateAxMenuItemExtensionXml('AxMenuItemActionExtension', objectName, properties);
      case 'menu-item-output-extension':
        return this.generateAxMenuItemExtensionXml('AxMenuItemOutputExtension', objectName, properties);
      case 'menu':
        return this.generateAxMenuXml(objectName, properties);
      case 'menu-extension':
        return this.generateAxMenuExtensionXml(objectName);
      case 'security-privilege':
        return this.generateAxSecurityPrivilegeXml(objectName, properties);
      case 'security-duty':
        return this.generateAxSecurityDutyXml(objectName, properties);
      case 'security-role':
        return this.generateAxSecurityRoleXml(objectName, properties);
      case 'security-duty-extension':
        return this.generateAxSecurityDutyExtensionXml(objectName, properties);
      case 'security-role-extension':
        return this.generateAxSecurityRoleExtensionXml(objectName, properties);
      case 'business-event':
        return XmlTemplateGenerator.generateBusinessEventXml(objectName, properties);
      case 'tile':
        return XmlTemplateGenerator.generateAxTileXml(objectName, properties);
      case 'kpi':
        return XmlTemplateGenerator.generateAxKpiXml(objectName, properties);
      case 'service':
        return buildAxServiceXml(objectName, properties);
      case 'service-group':
        return buildAxServiceGroupXml(objectName, properties);
      case 'macro':
        return XmlTemplateGenerator.generateAxMacroXml(objectName, sourceCode, properties);
      case 'configuration-key':
        return XmlTemplateGenerator.generateAxConfigurationKeyXml(objectName, properties);
      case 'security-policy':
        return XmlTemplateGenerator.generateAxSecurityPolicyXml(objectName, properties);
      case 'aggregate-measurement':
        return XmlTemplateGenerator.generateAxAggregateMeasurementXml(objectName, properties);
      case 'license-code':
        return XmlTemplateGenerator.generateAxLicenseCodeXml(objectName, properties);
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }
  }

  /**
   * Sanitize AxQuery XML — ensures xmlns="" and i:type="AxQuerySimple" are present
   * on the root <AxQuery> element. D365FO deserializer requires both attributes.
   */
  static sanitizeQueryXml(xml: string): string {
    return xml.replace(
      /<AxQuery(\s[^>]*)?>/,
      (_match, attrs: string | undefined) => {
        let a = attrs || '';
        if (!a.includes('xmlns=""')) {
          a += ' xmlns=""';
        }
        if (!a.includes('i:type="AxQuerySimple"')) {
          a += '\n\ti:type="AxQuerySimple"';
        }
        return `<AxQuery${a}>`;
      }
    );
  }

  /**
   * Sanitize AxReport XML to guarantee the structural elements required by the D365FO
   * Visual Studio Designer metadata loader, regardless of whether the XML was generated
   * by the template or supplied verbatim by a caller via the xmlContent parameter.
   *
   * Required invariants:
   *  1. xmlns="Microsoft.Dynamics.AX.Metadata.V2" on <AxReport> root
   *  2. <DataMethods /> directly after <Name>…</Name>
   *  3. xmlns="" on every <AxReportDataSet> child element (namespace reset)
   *  4. </AxReport> closing tag present (guard against truncated XML)
   *  5. <AxReportDesign> has xmlns="" and i:type="AxReportPrecisionDesign" attributes
   *     (VS Designer won't show Designs sub-nodes without these)
   */

  /**
   * Sanitize AxEnum XML — fixes common AI-generator mistakes that cause VS2022 to
   * silently ignore enum values or refuse to open the file:
   *
   *  1. <Values>…</Values>  →  <EnumValues>…</EnumValues>
   *     AI models frequently map the JSON `enumValues` array to a plain <Values> wrapper;
   *     D365FO deserializer requires <EnumValues>.
   *
   *  2. <AxEnum> without xmlns:i="http://www.w3.org/2001/XMLSchema-instance"
   *     The attribute is required for the i:type resolution inside the file.
   *
   *  3. More than 251 <AxEnumValue> elements — D365FO compiler hard limit.
   */
  static sanitizeEnumXml(xml: string): string {
    // 1. Rename <Values> container to <EnumValues>
    if (/<Values>/.test(xml) && !/<EnumValues>/.test(xml)) {
      xml = xml.replace(/<Values>/g, '<EnumValues>').replace(/<\/Values>/g, '</EnumValues>');
      console.error('[sanitizeEnumXml] Renamed <Values> → <EnumValues>');
    }

    // 2. Add xmlns:i to <AxEnum> root if missing
    if (!xml.includes('xmlns:i=')) {
      xml = xml.replace(
        /(<AxEnum)(\s|>)/,
        '$1 xmlns:i="http://www.w3.org/2001/XMLSchema-instance"$2'
      );
      console.error('[sanitizeEnumXml] Added xmlns:i to <AxEnum>');
    }

    // 3. Validate max 251 enum values (D365FO compiler hard limit, MS Learn confirmed)
    const valueCount = (xml.match(/<AxEnumValue>/g) ?? []).length;
    if (valueCount > 251) {
      console.error(
        `[sanitizeEnumXml] ⚠️ WARNING: ${valueCount} enum values detected — D365FO supports max 251 (0–250). ` +
        `The compiler will reject this file. Consider splitting into multiple enums or using a class hierarchy.`
      );
    }

    return xml;
  }

  /**
   * Sanitize AxTable XML to ensure correct D365FO field element format.
   *
   * D365FO requires fields as:
   *   <AxTableField xmlns=""
   *     i:type="AxTableFieldString"> ... </AxTableField>
   *
   * AI generators often emit the shorter form:
   *   <AxTableFieldString> ... </AxTableFieldString>
   *
   * This method also ensures <FullTextIndexes /> is present between </Fields> and <Indexes>.
   */
  static sanitizeTableXml(xml: string): string {
    const fieldTypes = [
      'AxTableFieldString', 'AxTableFieldInt', 'AxTableFieldInt64',
      'AxTableFieldReal', 'AxTableFieldDate', 'AxTableFieldUtcDateTime',
      'AxTableFieldEnum', 'AxTableFieldGuid', 'AxTableFieldContainer',
    ];

    for (const ft of fieldTypes) {
      // Opening tag: <AxTableFieldString ...> → <AxTableField xmlns="" i:type="AxTableFieldString" ...>
      // Only replace if NOT already inside a correct <AxTableField xmlns="" i:type="..."> wrapper
      const openRe = new RegExp(`<${ft}(\\s[^>]*)?>`, 'g');
      xml = xml.replace(openRe, (_match, attrs: string | undefined) => {
        const extra = attrs ? attrs : '';
        return `<AxTableField xmlns=""\n\t\t\ti:type="${ft}"${extra}>`;
      });
      // Closing tag
      xml = xml.replace(new RegExp(`<\\/${ft}>`, 'g'), '</AxTableField>');
    }

    // Ensure <FullTextIndexes /> is present between </Fields> and <Indexes>
    if (!xml.includes('<FullTextIndexes')) {
      xml = xml.replace('</Fields>\n\t<Indexes', '</Fields>\n\t<FullTextIndexes />\n\t<Indexes');
      xml = xml.replace('</Fields>\n<Indexes', '</Fields>\n<FullTextIndexes />\n<Indexes');
    }

    return xml;
  }

  static sanitizeReportXml(xml: string): string {
    // 1. Ensure xmlns="Microsoft.Dynamics.AX.Metadata.V2" on <AxReport> opening tag
    if (!xml.includes('xmlns="Microsoft.Dynamics.AX.Metadata.V2"')) {
      xml = xml.replace(/<AxReport(\s[^>]*)?>/, (match) => {
        // Insert the namespace attribute before the closing > of the tag
        return match.slice(0, -1) + ' xmlns="Microsoft.Dynamics.AX.Metadata.V2">';
      });
      console.error('[sanitizeReportXml] Added xmlns="Microsoft.Dynamics.AX.Metadata.V2" to <AxReport>');
    }

    // 2. Ensure <DataMethods /> exists directly after the top-level <Name>
    if (!xml.includes('<DataMethods')) {
      // Match only the first <Name>…</Name> (the report's own name, not nested ones)
      xml = xml.replace(/(<Name>[^<]*<\/Name>)/, '$1\n\t<DataMethods />');
      console.error('[sanitizeReportXml] Inserted missing <DataMethods />');
    }

    // 3. Ensure xmlns="" on each <AxReportDataSet> (bare tag without the attribute)
    if (xml.includes('<AxReportDataSet>')) {
      xml = xml.replace(/<AxReportDataSet>/g, '<AxReportDataSet xmlns="">');
      console.error('[sanitizeReportXml] Added xmlns="" to <AxReportDataSet> elements');
    }

    // 4. Ensure </AxReport> closing tag is present (guard against truncated XML)
    const trimmed = xml.trimEnd();
    if (!trimmed.endsWith('</AxReport>')) {
      xml = trimmed + '\n</AxReport>';
      console.error('[sanitizeReportXml] Appended missing </AxReport> closing tag');
    }

    // 5. Ensure <AxReportDesign> has xmlns="" and i:type="AxReportPrecisionDesign"
    //    VS Designer requires both attributes to render the Designs sub-tree correctly.
    //    Match bare <AxReportDesign> or one that is already partially attributed.
    xml = xml.replace(/<AxReportDesign(\s[^>]*)?>/, (match, attrs: string | undefined) => {
      const current = attrs || '';
      let updated = current;
      if (!updated.includes('xmlns=""')) {
        updated = ` xmlns=""${updated}`;
      }
      if (!updated.includes('i:type=')) {
        updated += `\n\t\t\t\ti:type="AxReportPrecisionDesign"`;
      }
      if (updated === current) return match; // nothing changed — idempotent
      console.error('[sanitizeReportXml] Fixed <AxReportDesign> attributes (xmlns="" + i:type)');
      return `<AxReportDesign${updated}>`;
    });


    // 6. Ensure <Parameters> block inside <AxReportDataSet> for real RDP datasets.
    //    Skipped for stub/minimal datasets that have no <DataSourceType>.
    if (xml.includes('<DataSourceType>') && !xml.includes('<Parameters>')) {
      const axDatasetParams =
        '\t\t\t<Parameters>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_PartitionKey</Name>\n' +
        '\t\t\t\t\t<Alias>AX_PartitionKey</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_PartitionKey</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_CompanyName</Name>\n' +
        '\t\t\t\t\t<Alias>AX_CompanyName</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_CompanyName</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_UserContext</Name>\n' +
        '\t\t\t\t\t<Alias>AX_UserContext</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_UserContext</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_RenderingCulture</Name>\n' +
        '\t\t\t\t\t<Alias>AX_RenderingCulture</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_RenderingCulture</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_ReportContext</Name>\n' +
        '\t\t\t\t\t<Alias>AX_ReportContext</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_ReportContext</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_RdpPreProcessedId</Name>\n' +
        '\t\t\t\t\t<Alias>AX_RdpPreProcessedId</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_RdpPreProcessedId</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t</Parameters>';
      if (xml.includes('</Fields>')) {
        xml = xml.replace('</Fields>', `</Fields>\n${axDatasetParams}`);
      } else if (xml.includes('<Fields />')) {
        xml = xml.replace('<Fields />', `<Fields />\n${axDatasetParams}`);
      } else {
        xml = xml.replace('</AxReportDataSet>', `${axDatasetParams}\n\t\t</AxReportDataSet>`);
      }
      console.error('[sanitizeReportXml] Added missing <Parameters> to <AxReportDataSet>');
    }

    // 7. Ensure <DefaultParameterGroup> before <Designs> for real RDP datasets.
    if (xml.includes('<DataSourceType>') && !xml.includes('<DefaultParameterGroup>') && xml.includes('<Designs>')) {
      const defaultParamGroup =
        '\t<DefaultParameterGroup>\n' +
        '\t\t<Name xmlns="">Parameters</Name>\n' +
        '\t\t<ReportParameterBases xmlns="">\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_PartitionKey</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_CompanyName</Name>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_UserContext</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_RenderingCulture</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_ReportContext</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_RdpPreProcessedId</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t</ReportParameterBases>\n' +
        '\t</DefaultParameterGroup>';
      xml = xml.replace('<Designs>', `${defaultParamGroup}\n\t<Designs>`);
      console.error('[sanitizeReportXml] Added missing <DefaultParameterGroup>');
    }

    // 8. Fix embedded RDL structural issues based on the SSRS namespace version:
    //    2008/01 — <PageHeader>/<PageFooter> must be inside <Page> (direct child of <Report>).
    //    2010/01+ (2010, 2016, future) — <Body> and <Page> must NOT be direct children of
    //              <Report>; they must be wrapped in:
    //              <ReportSections><ReportSection>...</ReportSection></ReportSections>
    //              Placing <Page> directly under <Report> causes:
    //              "Deserialization failed: invalid child element 'Page'" in VS Designer.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const is2008 = rdl.includes('reporting/2008/01/reportdefinition');
      // Any SSRS namespace newer than 2008 requires ReportSections wrapping
      const isModernRdl = !is2008 && /reporting\/20\d\d\/\d\d\/reportdefinition/.test(rdl);
      const is2010 = isModernRdl; // kept for branch clarity below
      let fixedRdl = rdl;
      let changed = false;

      if (is2010 && !rdl.includes('<ReportSections>')) {
        // 2010 schema: collect any stray Body/Page/PageHeader/PageFooter that are direct
        // children of <Report>, then wrap them in ReportSections/ReportSection.
        let pageEl = '';
        const existingPageMatch = fixedRdl.match(/<Page(?:\s[^>]*)?>([\s\S]*?)<\/Page>/);
        if (existingPageMatch) {
          pageEl = existingPageMatch[0];
          fixedRdl = fixedRdl.replace(existingPageMatch[0], '');
          // PageHeader/PageFooter may still be direct children of <Report> (outside the <Page>
          // element we just extracted). Inject them into pageEl before </Page>.
          let extraPageContent = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch && !pageEl.includes('<PageHeader')) {
            extraPageContent += phMatch[0];
            fixedRdl = fixedRdl.replace(phMatch[0], '');
          }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch && !pageEl.includes('<PageFooter')) {
            extraPageContent += (extraPageContent ? '\n' : '') + pfMatch[0];
            fixedRdl = fixedRdl.replace(pfMatch[0], '');
          }
          if (extraPageContent) {
            pageEl = pageEl.replace('</Page>', extraPageContent.trim() + '\n</Page>');
            console.error('[sanitizeReportXml] Moved stray <PageHeader>/<PageFooter> into existing <Page> (2010 RDL)');
          }
        } else {
          let pageInner = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch) { pageInner += phMatch[0]; fixedRdl = fixedRdl.replace(phMatch[0], ''); }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch) { pageInner += (pageInner ? '\n' : '') + pfMatch[0]; fixedRdl = fixedRdl.replace(pfMatch[0], ''); }
          if (pageInner) pageEl = '<Page>\n' + pageInner.trim() + '\n</Page>';
        }
        const bodyMatch = fixedRdl.match(/<Body[\s\S]*?<\/Body>/);
        let sectionContent = '';
        if (bodyMatch) { sectionContent += bodyMatch[0]; fixedRdl = fixedRdl.replace(bodyMatch[0], ''); }
        if (pageEl) sectionContent += (sectionContent ? '\n' : '') + pageEl;
        if (sectionContent) {
          const reportSections =
            '<ReportSections>\n<ReportSection>\n' + sectionContent.trim() + '\n</ReportSection>\n</ReportSections>';
          fixedRdl = fixedRdl.includes('</Report>')
            ? fixedRdl.replace('</Report>', reportSections + '\n</Report>')
            : fixedRdl + '\n' + reportSections;
          changed = true;
          const rdlVersion = rdl.match(/reporting\/(20\d\d\/\d\d)\/reportdefinition/)?.[1] ?? 'modern';
          console.error(`[sanitizeReportXml] Wrapped Body+Page in <ReportSections>/<ReportSection> for ${rdlVersion} RDL`);
        }

      } else if (is2008 && (rdl.includes('<PageHeader') || rdl.includes('<PageFooter'))) {
        // 2008 schema: <PageHeader>/<PageFooter> must be inside <Page>, not direct children of <Report>.
        // A real D365FO RDL always has a <Page> element (PageWidth/Height/Margins) but PageHeader is
        // still a sibling — the old guard `!rdl.match(/<Page...>/)` incorrectly skipped this case.
        // Strategy:
        //   a) If <Page> already exists — inject PageHeader/PageFooter before </Page>.
        //   b) If <Page> doesn't exist — create one after </Body>.
        const pageMatch = fixedRdl.match(/<Page(?:\s[^>]*)?>[\s\S]*?<\/Page>/);
        const alreadyInPage = !!pageMatch &&
          (pageMatch[0].includes('<PageHeader') || pageMatch[0].includes('<PageFooter'));
        if (!alreadyInPage) {
          let pageInner = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch) { pageInner += phMatch[0]; fixedRdl = fixedRdl.replace(phMatch[0], ''); }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch) { pageInner += (pageInner ? '\n' : '') + pfMatch[0]; fixedRdl = fixedRdl.replace(pfMatch[0], ''); }
          if (pageInner) {
            if (pageMatch) {
              // Inject into the existing <Page> before </Page>
              const updatedPage = pageMatch[0].replace('</Page>', pageInner.trim() + '\n</Page>');
              fixedRdl = fixedRdl.replace(pageMatch[0], updatedPage);
            } else {
              // No existing <Page> — create one after </Body>
              const pageEl = '<Page>\n' + pageInner.trim() + '\n</Page>';
              fixedRdl = fixedRdl.includes('</Body>')
                ? fixedRdl.replace('</Body>', '</Body>\n' + pageEl)
                : fixedRdl.replace('</Report>', pageEl + '\n</Report>');
            }
            changed = true;
            console.error('[sanitizeReportXml] Moved <PageHeader>/<PageFooter> inside <Page> in 2008 RDL');
          }
        }
      }

      if (!changed) return _whole;
      return open + fixedRdl + close;
    });

    // 9. Fix wrong margin element names inside embedded RDL.
    //    Some AI-generated RDLs use CSS-style names (MarginTop, MarginLeft, …) instead of
    //    the correct SSRS RDL names (TopMargin, LeftMargin, …).  All SSRS namespace versions
    //    require the XMargin form — MarginX causes "invalid child element 'MarginTop'" in
    //    VS Designer even though the value and namespace are otherwise correct.
    if (xml.includes('<MarginTop>') || xml.includes('<MarginBottom>') ||
        xml.includes('<MarginLeft>') || xml.includes('<MarginRight>')) {
      xml = xml
        .replace(/<MarginTop>/g,    '<TopMargin>')   .replace(/<\/MarginTop>/g,    '</TopMargin>')
        .replace(/<MarginBottom>/g, '<BottomMargin>').replace(/<\/MarginBottom>/g, '</BottomMargin>')
        .replace(/<MarginLeft>/g,   '<LeftMargin>')  .replace(/<\/MarginLeft>/g,   '</LeftMargin>')
        .replace(/<MarginRight>/g,  '<RightMargin>') .replace(/<\/MarginRight>/g,  '</RightMargin>');
      console.error('[sanitizeReportXml] Fixed wrong margin element names (MarginX → XMargin) in embedded RDL');
    }

    // 10. Ensure <Body> inside embedded RDL <ReportSection> has <ReportItems /> as its first
    //     child element.  SSRS schema requires the order: ReportItems → Height → Style.
    //     Without <ReportItems>, VS Designer can't surface the DataSet in the Report Data panel
    //     (it appears as if the dataset "disappeared") and may refuse to open the report.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      // Match a <Body> that contains <Height> or <Style> but lacks <ReportItems>
      // (i.e., an empty skeleton body without any report items)
      const fixedRdl = rdl.replace(
        /<Body>\s*\n(\s*)((?!<ReportItems)[\s\S]*?)<\/Body>/,
        (_bodyMatch: string, indent: string, bodyContent: string) => {
          // Only add <ReportItems /> when the body has no report items at all
          if (bodyContent.includes('<ReportItems')) return _bodyMatch;
          console.error('[sanitizeReportXml] Added missing <ReportItems /> as first child of <Body> in embedded RDL');
          return `<Body>\n${indent}<ReportItems />\n${indent}${bodyContent.trimStart()}</Body>`;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 11. Fix doubled closing tags inside embedded RDL CDATA.
    //     AI generators sometimes emit </Foo></Foo> (the closing tag twice).
    //     These are invalid XML and cause "Deserialization failed" in VS Designer.
    //     Pattern: </TagName></TagName>  →  </TagName>
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(/<\/(\w+)><\/\1>/g, (_m: string, tag: string) => {
        console.error(`[sanitizeReportXml] Removed doubled closing tag </${tag}></${tag}> in embedded RDL`);
        return `</${tag}>`;
      });
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 12. Fix <Value> as direct child of <Textbox> in embedded RDL.
    //     SSRS 2008+ schema requires: <Textbox> → <Paragraphs><Paragraph><TextRuns><TextRun><Value>
    //     AI generators sometimes emit <Value> directly inside <Textbox>, which causes:
    //     "invalid child element 'Value'" error in VS Designer.
    //     This fix wraps any bare <Value>…</Value> found as a direct child of <Textbox>
    //     into the correct paragraph/textrun structure.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      // Look for <Textbox ...> that contains a direct <Value> child (not inside <TextRun>)
      const fixedRdl = rdl.replace(
        /(<Textbox\b[^>]*>)([\s\S]*?)(<\/Textbox>)/g,
        (tbMatch: string, tbOpen: string, tbContent: string, tbClose: string) => {
          // Only act if there is a <Value> but no <Paragraphs> wrapping yet
          if (!tbContent.includes('<Value>') && !tbContent.includes('<Value =')) return tbMatch;
          if (tbContent.includes('<Paragraphs>')) return tbMatch;
          const fixedContent = tbContent.replace(
            /<Value>([\s\S]*?)<\/Value>/,
            (_vMatch: string, val: string) => {
              console.error('[sanitizeReportXml] Wrapped bare <Value> in <Textbox> into <Paragraphs> structure');
              return `<Paragraphs>\n            <Paragraph>\n              <TextRuns>\n                <TextRun>\n                  <Value>${val}</Value>\n                  <Style />\n                </TextRun>\n              </TextRuns>\n              <Style />\n            </Paragraph>\n          </Paragraphs>`;
            }
          );
          if (fixedContent === tbContent) return tbMatch;
          return tbOpen + fixedContent + tbClose;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 13. Fix <ColSpan>/<RowSpan> as direct children of <TablixCell>.
    //     SSRS schema only allows CellContents, DataElementName, DataElementOutput
    //     as direct children of <TablixCell>. ColSpan/RowSpan must be INSIDE
    //     <CellContents> (after the report item, before </CellContents>).
    //     AI generators emit them BEFORE or AFTER the <CellContents> block:
    //       <TablixCell><ColSpan>2</ColSpan><CellContents>...</CellContents></TablixCell>
    //       <TablixCell><CellContents>...</CellContents><ColSpan>2</ColSpan></TablixCell>
    //     Both cause "invalid child element 'ColSpan'" deserialization error.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(
        /(<TablixCell>)([\s\S]*?)(<\/TablixCell>)/g,
        (tcMatch: string, tcOpen: string, tcContent: string, tcClose: string) => {
          // Use indexOf to split tcContent into: beforeCC / ccBlock / afterCC.
          // This reliably handles spans placed either before OR after CellContents.
          const ccStart = tcContent.indexOf('<CellContents');
          const ccEnd   = tcContent.indexOf('</CellContents>');
          if (ccStart === -1 || ccEnd === -1) return tcMatch;

          const beforeCC = tcContent.substring(0, ccStart);
          const ccBlock  = tcContent.substring(ccStart, ccEnd + '</CellContents>'.length);
          const afterCC  = tcContent.substring(ccEnd + '</CellContents>'.length);

          // Collect ColSpan/RowSpan from anywhere outside CellContents
          const spanTagRe = () => /[ \t\r\n]*<(ColSpan|RowSpan)>[^<]*<\/\1>/g;
          let spans = '';
          const cleanBefore = beforeCC.replace(spanTagRe(), (m) => { spans += '\n' + m.trim(); return ''; });
          const cleanAfter  = afterCC.replace( spanTagRe(), (m) => { spans += '\n' + m.trim(); return ''; });

          if (!spans) return tcMatch;

          // Move collected spans inside CellContents, just before </CellContents>
          const fixedCC = ccBlock.replace('</CellContents>', `${spans}\n</CellContents>`);
          console.error('[sanitizeReportXml] Moved <ColSpan>/<RowSpan> from <TablixCell> into <CellContents> in embedded RDL');
          return tcOpen + cleanBefore + fixedCC + cleanAfter + tcClose;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 14. Fix flat border properties as direct children of <Style>.
    //     SSRS <Style> only accepts <Border>, <TopBorder>, <BottomBorder>,
    //     <LeftBorder>, <RightBorder> as border wrappers — not flat attributes
    //     like <BorderStyle>, <BorderColor>, <BorderWidth>.
    //     AI generators often emit:
    //       <Style><BorderStyle>Solid</BorderStyle><BorderColor>#000</BorderColor></Style>
    //     but the correct form is:
    //       <Style><Border><Style>Solid</Style><Color>#000</Color></Border></Style>
    //     Same pattern applies to TopBorderStyle/TopBorderColor/TopBorderWidth etc.
    //
    //     Previous approach (matching <Style>…</Style> blocks non-greedily) had a
    //     nesting failure: if an outer <Style> contained a nested <Style> element
    //     (e.g. <Border><Style>Solid</Style>…</Border>) BEFORE a flat <BorderStyle>,
    //     the non-greedy regex would bind the outer opening <Style> to the inner
    //     closing </Style>, leaving the flat tag unprocessed.
    //
    //     New approach: scan the CDATA directly for flat border-property clusters
    //     and replace them with the correct wrapper, independent of the containing
    //     <Style> block.  Adjacent flat tags (same group, separated only by
    //     whitespace) are collapsed into a single wrapper element.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/g, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      let changed = false;

      const groups: Array<[string, string]> = [
        ['Border',       'Border'],
        ['TopBorder',    'TopBorder'],
        ['BottomBorder', 'BottomBorder'],
        ['LeftBorder',   'LeftBorder'],
        ['RightBorder',  'RightBorder'],
      ];

      for (const [prefix, wrapper] of groups) {
        const st = `${prefix}Style`;
        const ct = `${prefix}Color`;
        const wt = `${prefix}Width`;

        if (!new RegExp(`<(?:${st}|${ct}|${wt})>`).test(fixedRdl)) continue;

        // Build a regex that matches a cluster of 1–3 adjacent flat border tags
        // for this group (in any order, with optional whitespace between them).
        const singleTag =
          `(?:<${st}>([^<]*)<\\/${st}>|<${ct}>([^<]*)<\\/${ct}>|<${wt}>([^<]*)<\\/${wt}>)`;
        const clusterRe = new RegExp(
          `${singleTag}(?:\\s*${singleTag})?(?:\\s*${singleTag})?`,
          'g'
        );

        fixedRdl = fixedRdl.replace(clusterRe, (match: string) => {
          // Extract each flat-tag value from the matched cluster via side-effect callbacks.
          let bStyle = '', bColor = '', bWidth = '';
          match.replace(new RegExp(`<${st}>([^<]*)<\\/${st}>`), (_: string, v: string) => { bStyle = v; return ''; });
          match.replace(new RegExp(`<${ct}>([^<]*)<\\/${ct}>`), (_: string, v: string) => { bColor = v; return ''; });
          match.replace(new RegExp(`<${wt}>([^<]*)<\\/${wt}>`), (_: string, v: string) => { bWidth = v; return ''; });

          let inner = '';
          if (bStyle) inner += `<Style>${bStyle}</Style>`;
          if (bColor) inner += `<Color>${bColor}</Color>`;
          if (bWidth) inner += `<Width>${bWidth}</Width>`;

          changed = true;
          return `<${wrapper}>${inner}</${wrapper}>`;
        });
      }

      if (!changed) return _whole;
      console.error('[sanitizeReportXml] Wrapped flat border properties into <Border> inside <Style> in embedded RDL');
      return open + fixedRdl + close;
    });

    // 15. Fix absorbed TablixCells following a ColSpan > 1.
    //     Confirmed by real D365FO reports: when <CellContents> has <ColSpan>N</ColSpan>,
    //     the next N-1 sibling TablixCells in the same <TablixCells> block must be empty
    //     (<TablixCell />). AI generators give those absorbed cells full CellContents,
    //     causing VS Report Designer to render an empty/broken design surface.
    //     Approach: for each <ColSpan>N</ColSpan>, trace past its containing
    //     </CellContents></TablixCell> then depth-count-walk the next N-1 TablixCells
    //     and replace any non-empty ones with <TablixCell />.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl;
      const patches: { start: number; end: number }[] = [];

      const csRe = /<ColSpan>(\d+)<\/ColSpan>/g;
      let csMatch: RegExpExecArray | null;
      while ((csMatch = csRe.exec(fixedRdl)) !== null) {
        const span = parseInt(csMatch[1], 10);
        if (span <= 1) continue;

        // Find </CellContents> that closes the CellContents containing this ColSpan
        const ccCloseIdx = fixedRdl.indexOf('</CellContents>', csMatch.index + csMatch[0].length);
        if (ccCloseIdx === -1) continue;
        // Find </TablixCell> that closes the TablixCell containing this CellContents
        const tcCloseIdx = fixedRdl.indexOf('</TablixCell>', ccCloseIdx + '</CellContents>'.length);
        if (tcCloseIdx === -1) continue;

        let pos = tcCloseIdx + '</TablixCell>'.length;

        for (let i = 0; i < span - 1; i++) {
          // Skip whitespace
          while (pos < fixedRdl.length && /\s/.test(fixedRdl[pos])) pos++;

          if (fixedRdl.startsWith('<TablixCell />', pos) || fixedRdl.startsWith('<TablixCell/>', pos)) {
            // Already empty — advance
            pos += fixedRdl.startsWith('<TablixCell />', pos) ? '<TablixCell />'.length : '<TablixCell/>'.length;
            continue;
          }
          if (!fixedRdl.startsWith('<TablixCell>', pos)) break; // Not a TablixCell

          // Walk to balanced </TablixCell>, counting nested TablixCell depth
          let depth = 1;
          let search = pos + '<TablixCell>'.length;
          while (depth > 0 && search < fixedRdl.length) {
            const nextOpen  = fixedRdl.indexOf('<TablixCell>',  search);
            const nextClose = fixedRdl.indexOf('</TablixCell>', search);
            if (nextClose === -1) { depth = 0; break; }
            if (nextOpen !== -1 && nextOpen < nextClose) {
              depth++;
              search = nextOpen + '<TablixCell>'.length;
            } else {
              depth--;
              search = nextClose + '</TablixCell>'.length;
            }
          }
          const cellEnd = search;
          patches.push({ start: pos, end: cellEnd });
          pos = cellEnd;
        }
      }

      if (patches.length === 0) return _whole;
      // Apply patches in reverse order to preserve string positions
      patches.sort((a, b) => b.start - a.start);
      let result = fixedRdl;
      for (const p of patches) {
        result = result.substring(0, p.start) + '<TablixCell />' + result.substring(p.end);
      }
      console.error(`[sanitizeReportXml] Emptied ${patches.length} absorbed TablixCell(s) following ColSpan in embedded RDL`);
      return open + result + close;
    });

    // 16. Rename reversed border side wrapper element names.
    //     SSRS schema expects <TopBorder>, <BottomBorder>, <LeftBorder>, <RightBorder>.
    //     AI generators often emit them reversed: <BorderTop>, <BorderBottom>, etc.
    //     The inner content (<Style>, <Color>, <Width>) is already correct — only
    //     the wrapper element name needs to change.
    if (xml.includes('<BorderTop>') || xml.includes('<BorderBottom>') ||
        xml.includes('<BorderLeft>') || xml.includes('<BorderRight>')) {
      xml = xml
        .replace(/<BorderTop>/g,     '<TopBorder>')    .replace(/<\/BorderTop>/g,     '</TopBorder>')
        .replace(/<BorderBottom>/g,  '<BottomBorder>') .replace(/<\/BorderBottom>/g,  '</BottomBorder>')
        .replace(/<BorderLeft>/g,    '<LeftBorder>')   .replace(/<\/BorderLeft>/g,    '</LeftBorder>')
        .replace(/<BorderRight>/g,   '<RightBorder>')  .replace(/<\/BorderRight>/g,   '</RightBorder>');
      console.error('[sanitizeReportXml] Fixed reversed border side wrapper names (BorderXxx → XxxBorder) in RDL');
    }

    // 17. Add missing </Style> before </Paragraph> when Paragraph-level Style is
    //     left unclosed. AI generators sometimes emit:
    //       <Paragraph><TextRuns>...</TextRuns><Style><TextAlign>Right</TextAlign></Paragraph>
    //     The </Style> before </Paragraph> is missing, which makes the XML
    //     malformed (</Paragraph> appears to close inside <Style>) and causes
    //     SSRS deserialization to fail entirely.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(
        /<Paragraph>([\s\S]*?)<\/Paragraph>/g,
        (match: string, inner: string) => {
          const opens  = (inner.match(/<Style>/g)  || []).length;
          const closes = (inner.match(/<\/Style>/g) || []).length;
          if (opens === closes) return match;
          const missing = opens - closes;
          console.error('[sanitizeReportXml] Added missing </Style> tag(s) inside <Paragraph> in embedded RDL');
          return `<Paragraph>${inner}${'</Style>'.repeat(missing)}</Paragraph>`;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 18. Reconcile TablixCells count with TablixColumns count.
    //     Each TablixRow must have exactly as many TablixCell elements as there
    //     are TablixColumn entries in the enclosing Tablix's TablixColumns block.
    //     When the counts are mismatched VS Report Designer throws:
    //       "Index was out of range. Must be non-negative and less than the size
    //        of the collection. Parameter name: index"
    //
    //     Two cases are handled:
    //       A) A TablixRow has FEWER cells than TablixColumns → pad with <TablixCell />
    //       B) TablixColumns has FEWER entries than max cells per row → pad columns
    //
    //     The fix finds each top-level <Tablix>…</Tablix> block using depth
    //     tracking (to handle multiple/nested Tablix controls correctly) and
    //     reconciles column vs cell counts within each one independently.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/g, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      let changed = false;

      const processTablix = (block: string): string => {
        // Count declared TablixColumn entries (exclude TablixColumns container)
        const colsMatch = block.match(/<TablixColumns>([\s\S]*?)<\/TablixColumns>/);
        if (!colsMatch) return block;
        const colCount = (colsMatch[1].match(/<TablixColumn[\s>\/]/g) || []).length;
        if (colCount === 0) return block;

        // Sub-case A: pad each TablixCells block that has too few cells
        let result = block.replace(
          /(<TablixCells>)([\s\S]*?)(<\/TablixCells>)/g,
          (m: string, o: string, inner: string, c: string) => {
            const n = (inner.match(/<TablixCell[\s>\/]/g) || []).length;
            if (n >= colCount) return m;
            changed = true;
            const padding = Array(colCount - n).fill('\t\t\t\t<TablixCell />').join('\n');
            return `${o}${inner}\n${padding}\n\t\t\t${c}`;
          }
        );

        // Sub-case B: ensure TablixColumns has enough entries
        const cellsBlocks = result.match(/<TablixCells>([\s\S]*?)<\/TablixCells>/g) || [];
        const maxCells = cellsBlocks.reduce((mx, b) => {
          const n = (b.match(/<TablixCell[\s>\/]/g) || []).length;
          return n > mx ? n : mx;
        }, 0);
        if (maxCells > colCount) {
          const extra = Array(maxCells - colCount)
            .fill('\t\t<TablixColumn><Width>1in</Width></TablixColumn>')
            .join('\n');
          result = result.replace('</TablixColumns>', `\n${extra}\n\t\t</TablixColumns>`);
          changed = true;
        }

        return result;
      };

      // Depth-tracking scan for each top-level <Tablix>…</Tablix> block.
      // Child elements (<TablixBody>, <TablixColumns>, <TablixCell>, …) all have
      // letters immediately after '<Tablix', so the main element is identified by
      // '<Tablix' followed by '>', ' ', tab, or newline.
      let pos = 0;
      while (pos < fixedRdl.length) {
        const tagStart = fixedRdl.indexOf('<Tablix', pos);
        if (tagStart < 0) break;

        const ch = fixedRdl[tagStart + 7];
        if (ch !== '>' && ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
          pos = tagStart + 8;
          continue;
        }

        // Self-closing <Tablix /> — skip
        const tagEndIdx = fixedRdl.indexOf('>', tagStart);
        if (tagEndIdx < 0) break;
        if (fixedRdl[tagEndIdx - 1] === '/') { pos = tagEndIdx + 1; continue; }

        // Depth-scan for matching </Tablix>
        let depth = 1;
        let scan = tagEndIdx + 1;
        let closeTagPos = -1;
        while (depth > 0 && scan < fixedRdl.length) {
          const nxtOpen  = fixedRdl.indexOf('<Tablix', scan);
          const nxtClose = fixedRdl.indexOf('</Tablix>', scan);
          if (nxtClose < 0) break;

          if (nxtOpen >= 0 && nxtOpen < nxtClose) {
            const nc = fixedRdl[nxtOpen + 7];
            if (nc === '>' || nc === ' ' || nc === '\t' || nc === '\n' || nc === '\r') {
              depth++;
              const innerTagEnd = fixedRdl.indexOf('>', nxtOpen);
              scan = innerTagEnd >= 0 ? innerTagEnd + 1 : nxtOpen + 8;
            } else {
              scan = nxtOpen + 8;
            }
          } else {
            depth--;
            if (depth === 0) closeTagPos = nxtClose;
            scan = nxtClose + 9; // '</Tablix>'.length === 9
          }
        }

        if (closeTagPos < 0) break;
        const blockEnd = closeTagPos + 9;
        const block = fixedRdl.substring(tagStart, blockEnd);
        const fixed  = processTablix(block);
        if (fixed !== block) {
          fixedRdl = fixedRdl.substring(0, tagStart) + fixed + fixedRdl.substring(blockEnd);
          pos = tagStart + fixed.length;
        } else {
          pos = blockEnd;
        }
      }

      if (!changed) return _whole;
      console.error('[sanitizeReportXml] Reconciled TablixCell count with TablixColumn count in embedded RDL');
      return open + fixedRdl + close;
    });

    return xml;
  }

  /**
   * Convert <Text><![CDATA[…RDL…]]></Text> to XML entity-encoded form.
   *
   * D365FO stores and expects the embedded RDL as entity-encoded text, not CDATA:
   *   <Text>&lt;?xml version="1.0"?&gt;&lt;Report ...&gt;...&lt;/Report&gt;</Text>
   *
   * CDATA is valid XML and semantically equivalent, but the VS Designer metadata loader
   * does not render <Designs> correctly when the <Text> value uses CDATA — the design
   * appears empty even though no parse error is raised. Using entity encoding matches
   * what VS writes natively and fixes the empty-design issue.
   *
   * This is a SEPARATE method from sanitizeReportXml intentionally:
   *   - sanitizeReportXml operates on CDATA form (efficient regex over raw XML text)
   *   - encodeReportTextElement runs AFTER sanitize, just before writing to disk
   */
  static encodeReportTextElement(xml: string): string {
    return xml.replace(/<Text><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/g, (_match, rdlInner: string) => {
      return `<Text>${escapeXml(rdlInner)}</Text>`;
    });
  }

  /**
   * Generate AxEdt XML (Extended Data Type).
   * Default i:type is AxEdtString; override via properties.edtType.
   * Accepts either the full AxEdt* form or a plain base-type name
   * (string → AxEdtString, integer/int → AxEdtInt, int64 → AxEdtInt64,
   *  real → AxEdtReal, date → AxEdtDate, datetime/utcdatetime → AxEdtUtcDateTime,
   *  enum → AxEdtEnum, guid → AxEdtGuid, container → AxEdtContainer).
   */
  static generateAxEdtXml(name: string, properties?: Record<string, any>): string {
    const edtTypeRaw = properties?.edtType || 'AxEdtString';
    const edtTypeNormMap: Record<string, string> = {
      string:      'AxEdtString',
      integer:     'AxEdtInt',
      int:         'AxEdtInt',
      int64:       'AxEdtInt64',
      real:        'AxEdtReal',
      date:        'AxEdtDate',
      datetime:    'AxEdtUtcDateTime',
      utcdatetime: 'AxEdtUtcDateTime',
      enum:        'AxEdtEnum',
      guid:        'AxEdtGuid',
      container:   'AxEdtContainer',
    };
    const edtType = edtTypeNormMap[edtTypeRaw.toLowerCase()] ?? edtTypeRaw;
    const label = properties?.label || '@TODO:LabelId';
    const extends_ = properties?.extends ? `\n\t<Extends>${properties.extends}</Extends>` : '';
    const stringSize = edtType === 'AxEdtString'
      ? `\n\t<StringSize>${properties?.stringSize ?? 30}</StringSize>` : '';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxEdt xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""
\ti:type="${edtType}">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>${extends_}
\t<ArrayElements />
\t<Relations />
\t<TableReferences />${stringSize}
</AxEdt>`;
  }

  /**
   * Extension XML. Name convention throughout: BaseObjectName.ExtensionName
   * (e.g. CustTable.ConExtension). Each of these delegates to a shared builder so
   * this class cannot drift from generateD365Xml.ts's mirrored copy.
   */

  /**
   * Generate AxEdtExtension XML — see edtExtensionXml.ts for the property
   * contract and why <ArrayElements /> is unconditional.
   */
  static generateAxEdtExtensionXml(name: string, properties?: Record<string, any>): string {
    return buildAxEdtExtensionXml(name, properties);
  }

  /**
   * Generate AxDataEntityViewExtension XML — see dataEntityViewExtensionXml.ts
   * for the fields / fieldGroupExtensions / propertyModifications contract.
   */
  static generateAxDataEntityViewExtensionXml(name: string, properties?: Record<string, any>): string {
    return buildAxDataEntityViewExtensionXml(name, properties);
  }

  /**
   * Generate AxMenuItem{Display,Action,Output}Extension XML — see
   * menuItemExtensionXml.ts for the property-modification contract.
   */
  static generateAxMenuItemExtensionXml(
    rootElement: AxMenuItemExtensionRootElement,
    name: string,
    properties?: Record<string, any>
  ): string {
    return buildAxMenuItemExtensionXml(rootElement, name, properties);
  }

  /**
   * Generate AxEnumExtension XML.
   * Name convention: BaseEnumName.PrefixExtension
   *
   * Supported properties:
   *   enumValues: Array<{ name, label?, value?, countryRegionCodes?, helpText? }>
   */
  static generateAxEnumExtensionXml(name: string, properties?: Record<string, any>): string {
    // Build <EnumValues> block
    const enumValueSpecs: Array<{
      name: string; label?: string; value?: number; countryRegionCodes?: string; helpText?: string;
    }> = Array.isArray(properties?.enumValues) ? properties.enumValues : [];

    let enumValuesXml: string;
    if (enumValueSpecs.length === 0) {
      enumValuesXml = '\t<EnumValues />';
    } else {
      enumValuesXml = '\t<EnumValues>';
      for (const v of enumValueSpecs) {
        enumValuesXml += `\n\t\t<AxEnumValue>`;
        enumValuesXml += `\n\t\t\t<Name>${v.name}</Name>`;
        if (v.countryRegionCodes) enumValuesXml += `\n\t\t\t<CountryRegionCodes>${v.countryRegionCodes}</CountryRegionCodes>`;
        if (v.label) enumValuesXml += `\n\t\t\t<Label>${escapeXml(v.label)}</Label>`;
        if (v.helpText) enumValuesXml += `\n\t\t\t<HelpText>${escapeXml(v.helpText)}</HelpText>`;
        if (v.value !== undefined && v.value !== 0) enumValuesXml += `\n\t\t\t<Value>${v.value}</Value>`;
        enumValuesXml += `\n\t\t</AxEnumValue>`;
      }
      enumValuesXml += '\n\t</EnumValues>';
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxEnumExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
${enumValuesXml}
\t<PropertyModifications />
\t<ValueModifications />
</AxEnumExtension>`;
  }

  /**
   * Generate AxTableExtension XML.
   * Name convention: TableName.PrefixExtension
   *
   * Supported properties:
   *   fields:       Array<{ name, edt?, enumType?, label?, mandatory?, fieldType? }>
   *   fieldGroups:  Array<{ name, label?, fields?: string[] }>
   *   fieldGroupExtensions: Array<{ name, fields: string[] }>  — extend base-table field groups
   *   indexes:      Array<{ name, fields: Array<string | {fieldName, direction?}>, allowDuplicates?, alternateKey? }>
   *   relations:    Array<{ name, relatedTable,
   *                         constraints: Array<{fieldName|field, relatedFieldName|relatedField}>,
   *                         cardinality?, relatedTableCardinality?, relationshipType? }>
   */
  static generateAxTableExtensionXml(name: string, properties?: Record<string, any>): string {
    // ── Fields ───────────────────────────────────────────────────────────────
    const fieldSpecs: Array<{
      name: string;
      edt?: string;
      enumType?: string;
      label?: string;
      mandatory?: boolean;
      fieldType?: string;
    }> = Array.isArray(properties?.fields) ? properties.fields : [];

    let fieldsXml: string;
    if (fieldSpecs.length === 0) {
      fieldsXml = '\t<Fields />';
    } else {
      fieldsXml = '\t<Fields>\n';
      for (const f of fieldSpecs) {
        const iType = f.fieldType ?? (f.enumType ? 'AxTableFieldEnum' : 'AxTableFieldString');
        fieldsXml += `\t\t<AxTableField xmlns=""\n\t\t\ti:type="${iType}">\n`;
        fieldsXml += `\t\t\t<Name>${f.name}</Name>\n`;
        if (f.edt)       fieldsXml += `\t\t\t<ExtendedDataType>${f.edt}</ExtendedDataType>\n`;
        if (f.label)     fieldsXml += `\t\t\t<Label>${escapeXml(f.label)}</Label>\n`;
        if (f.mandatory) fieldsXml += `\t\t\t<Mandatory>Yes</Mandatory>\n`;
        if (f.enumType)  fieldsXml += `\t\t\t<EnumType>${f.enumType}</EnumType>\n`;
        fieldsXml += `\t\t</AxTableField>\n`;
      }
      fieldsXml += '\t</Fields>';
    }

    // ── FieldGroups (new groups defined in this extension) ───────────────────
    const fgSpecs: Array<{ name: string; label?: string; fields?: string[] }> =
      Array.isArray(properties?.fieldGroups) ? properties.fieldGroups : [];
    let fieldGroupsXml: string;
    if (fgSpecs.length === 0) {
      fieldGroupsXml = '\t<FieldGroups />';
    } else {
      fieldGroupsXml = '\t<FieldGroups>\n';
      for (const fg of fgSpecs) {
        fieldGroupsXml += `\t\t<AxTableFieldGroup>\n\t\t\t<Name>${fg.name}</Name>\n`;
        if (fg.label) fieldGroupsXml += `\t\t\t<Label>${escapeXml(fg.label)}</Label>\n`;
        const fgFields = Array.isArray(fg.fields) ? fg.fields : [];
        if (fgFields.length === 0) {
          fieldGroupsXml += `\t\t\t<Fields />\n`;
        } else {
          fieldGroupsXml += `\t\t\t<Fields>\n`;
          for (const df of fgFields) {
            fieldGroupsXml += `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${df}</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n`;
          }
          fieldGroupsXml += `\t\t\t</Fields>\n`;
        }
        fieldGroupsXml += `\t\t</AxTableFieldGroup>\n`;
      }
      fieldGroupsXml += '\t</FieldGroups>';
    }

    // ── FieldGroupExtensions (extend base-table field groups) ────────────────
    const fgeSpecs: Array<{ name: string; fields: string[] }> =
      Array.isArray(properties?.fieldGroupExtensions) ? properties.fieldGroupExtensions : [];
    let fieldGroupExtensionsXml: string;
    if (fgeSpecs.length === 0) {
      fieldGroupExtensionsXml = '\t<FieldGroupExtensions />';
    } else {
      fieldGroupExtensionsXml = '\t<FieldGroupExtensions>\n';
      for (const fge of fgeSpecs) {
        fieldGroupExtensionsXml += `\t\t<AxTableFieldGroupExtension>\n\t\t\t<Name>${fge.name}</Name>\n`;
        const fgeFields = Array.isArray(fge.fields) ? fge.fields : [];
        if (fgeFields.length === 0) {
          fieldGroupExtensionsXml += `\t\t\t<Fields />\n`;
        } else {
          fieldGroupExtensionsXml += `\t\t\t<Fields>\n`;
          for (const df of fgeFields) {
            fieldGroupExtensionsXml += `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${df}</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n`;
          }
          fieldGroupExtensionsXml += `\t\t\t</Fields>\n`;
        }
        fieldGroupExtensionsXml += `\t\t</AxTableFieldGroupExtension>\n`;
      }
      fieldGroupExtensionsXml += '\t</FieldGroupExtensions>';
    }

    // ── Indexes ────────────────────────────────────────────────────────
    // Shared with the plain table builder, which used to emit a hardcoded
    // <Indexes /> and drop every index the caller passed.
    const indexesXml = buildAxTableIndexesXml(
      Array.isArray(properties?.indexes) ? properties.indexes : [],
    );

    // ── Relations ────────────────────────────────────────────────────────────
    const relSpecs: Array<{
      name: string;
      relatedTable: string;
      constraints: Array<{ fieldName: string; relatedFieldName: string }>;
      cardinality?: string;
      relatedTableCardinality?: string;
      relationshipType?: string;
    }> = Array.isArray(properties?.relations) ? properties.relations : [];
    let relationsXml: string;
    if (relSpecs.length === 0) {
      relationsXml = '\t<Relations />';
    } else {
      relationsXml = '\t<Relations>\n';
      for (const rel of relSpecs) {
        relationsXml += `\t\t<AxTableRelation>\n`;
        // Cardinality/RelationshipType are metamodel enums: an unknown value is
        // dropped by the deserializer, so "OneToMany" used to be written verbatim,
        // build clean, and leave the relation at NotSpecified.
        const relCtx = `Relation '${rel.name}' on '${name}'`;
        relationsXml += `\t\t\t<Name>${rel.name}</Name>\n`;
        relationsXml += `\t\t\t<Cardinality>${assertKnownEnumValue(`${relCtx}: cardinality`, rel.cardinality, RELATION_CARDINALITIES, 'ZeroMore')}</Cardinality>\n`;
        relationsXml += `\t\t\t<RelatedTable>${rel.relatedTable}</RelatedTable>\n`;
        relationsXml += `			<RelatedTableCardinality>${assertKnownEnumValue(`${relCtx}: relatedTableCardinality`, rel.relatedTableCardinality, RELATED_TABLE_CARDINALITIES, 'ExactlyOne')}</RelatedTableCardinality>
`;
        relationsXml += `			<RelationshipType>${assertKnownEnumValue(`${relCtx}: relationshipType`, rel.relationshipType, RELATIONSHIP_TYPES, 'Association')}</RelationshipType>
`;
        // `{ field, relatedField }` is what generateSmartTable and the bridge's
        // add-relation both speak, and reading only `fieldName`/`relatedFieldName`
        // turned it into <Field>undefined</Field> — a relation the compiler accepts
        // and that joins on nothing.
        const constraints = (Array.isArray(rel.constraints) ? rel.constraints : [])
          .map((c: any) => ({
            field: c?.fieldName ?? c?.field,
            relatedField: c?.relatedFieldName ?? c?.relatedField,
          }))
          .filter((c: any) => typeof c.field === 'string' && typeof c.relatedField === 'string');
        if (constraints.length === 0) {
          relationsXml += `\t\t\t<Constraints />\n`;
        } else {
          relationsXml += `\t\t\t<Constraints>\n`;
          for (const c of constraints) {
            relationsXml += `\t\t\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">\n`;
            relationsXml += `\t\t\t\t\t<Name>${c.field}</Name>\n`;
            relationsXml += `\t\t\t\t\t<Field>${c.field}</Field>\n`;
            relationsXml += `\t\t\t\t\t<RelatedField>${c.relatedField}</RelatedField>\n`;
            relationsXml += `\t\t\t\t</AxTableRelationConstraint>\n`;
          }
          relationsXml += `\t\t\t</Constraints>\n`;
        }
        relationsXml += `\t\t</AxTableRelation>\n`;
      }
      relationsXml += '\t</Relations>';
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
${fieldGroupExtensionsXml}
${fieldGroupsXml}
\t<FieldModifications />
${fieldsXml}
\t<FullTextIndexes />
${indexesXml}
\t<Mappings />
\t<PropertyModifications />
\t<RelationExtensions />
\t<RelationModifications />
${relationsXml}
</AxTableExtension>`;
  }

  /**
   * Generate AxFormExtension XML.
   * Name convention: FormName.ExtensionName
   */
  static generateAxFormExtensionXml(name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${name}</Name>
\t<ControlModifications />
\t<Controls />
\t<DataSourceModifications />
\t<DataSourceReferences />
\t<DataSources />
\t<Parts />
\t<PropertyModifications />
</AxFormExtension>`;
  }

  /**
   * Generate AxSecurityPrivilege XML. Delegates to the shared builder so this
   * mirror and the one in generateD365Xml.ts cannot drift.
   * @see buildAxSecurityPrivilegeXml for the property contract and element order.
   */
  static generateAxSecurityPrivilegeXml(name: string, properties?: Record<string, any>): string {
    return buildAxSecurityPrivilegeXml(name, properties);
  }

  /**
   * Generate AxSecurityDuty XML.
   * properties.privileges – privilege names to reference (array or comma-separated).
   */
  static generateAxSecurityDutyXml(name: string, properties?: Record<string, any>): string {
    return buildAxSecurityDutyXml(name, properties);
  }

  /**
   * Generate AxSecurityRole XML.
   * properties.duties     – duty names to reference (array or comma-separated).
   * properties.privileges – privilege names to reference directly on the role.
   */
  static generateAxSecurityRoleXml(name: string, properties?: Record<string, any>): string {
    return buildAxSecurityRoleXml(name, properties);
  }

  /**
   * Generate AxSecurityDutyExtension XML — adds privileges to an EXISTING (often
   * Microsoft-owned) duty without overlaying it. Real Microsoft object type, e.g.
   * K:\...\ApplicationCommon\AxSecurityDutyExtension\BatchJobMaintain.ApplicationCommon.xml.
   * Name convention: "<BaseDuty>.<PrefixOrModel>Extension" (same dot-notation as
   * menu-extension / table-extension — see DOT_NOTATION_EXTENSION_TYPES).
   * properties.privileges – privilege names to add to the base duty (array or comma-separated).
   */
  static generateAxSecurityDutyExtensionXml(name: string, properties?: Record<string, any>): string {
    return buildAxSecurityDutyExtensionXml(name, properties);
  }

  /**
   * Generate AxSecurityRoleExtension XML — adds duties and/or privileges to an
   * EXISTING (often Microsoft-owned) role without overlaying it. Real Microsoft
   * object type, e.g. K:\...\ApplicationCommon\AxSecurityRoleExtension\SystemUser.ApplicationCommon.xml.
   * Name convention: "<BaseRole>.<PrefixOrModel>Extension".
   * properties.duties     – duty names to add to the base role (array or comma-separated).
   * properties.privileges – privilege names to add directly to the base role.
   */
  static generateAxSecurityRoleExtensionXml(name: string, properties?: Record<string, any>): string {
    return buildAxSecurityRoleExtensionXml(name, properties);
  }

  /**
   * Generate BusinessEventsContract class XML (AxClass) for a Business Event.
   * The class extends BusinessEventsBase and includes a companion contract class.
   */
  static generateBusinessEventXml(name: string, properties?: Record<string, any>): string {
    const label      = properties?.label     || `@TODO:${name}Label`;
    const helpText   = properties?.helpText  || `@TODO:${name}HelpText`;
    const module     = properties?.module    || 'ModuleAxapta::Other';
    const contractName = `${name}Contract`;

    const source =
`[BusinessEvents(classStr(${contractName}),
    '${name}',
    '${name}',
    ${module})]
public final class ${name} extends BusinessEventsBase
{
    private ${contractName} contract;

    public static ${name} newFromContract(${contractName} _contract)
    {
        ${name} event = new ${name}();
        event.contract = _contract;
        return event;
    }

    [Hookable(false)]
    public BusinessEventsContract buildContract()
    {
        return contract;
    }
}

// ── Contract class ──────────────────────────────────────────────────────────
[DataContractAttribute]
public final class ${contractName} extends BusinessEventsContract
{
    // TODO: add private fields and parmXxx() methods for the event payload

    public static ${contractName} newDefault()
    {
        ${contractName} c = new ${contractName}();
        return c;
    }
}`;

    return XmlTemplateGenerator.generateAxClassXml(name, source, { label, helpText });
  }

  /**
   * Generate Workspace Tile XML (AxTile).
   * Tiles appear in workspace panorama sections as KPI / navigation tiles.
   */
  static generateAxTileXml(name: string, properties?: Record<string, any>): string {
    const label      = properties?.label     || `@TODO:${name}Label`;
    const helpText   = properties?.helpText  || `@TODO:${name}HelpText`;
    const tileType   = properties?.tileType  || 'Count';       // Count | Link | Summary
    const menuItem   = properties?.menuItem  || '';
    const query      = properties?.query     || '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTile xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>
\t<HelpText>${escapeXml(helpText)}</HelpText>
\t<TileType>${tileType}</TileType>${menuItem ? `\n\t<MenuItemName>${menuItem}</MenuItemName>\n\t<MenuItemType>Display</MenuItemType>` : ''}${query ? `\n\t<Query>${query}</Query>` : ''}
\t<Size>Wide</Size>
\t<RefreshFrequency>600</RefreshFrequency>
</AxTile>`;
  }

  /**
   * Generate KPI XML (AxKPI).
   * KPIs appear in workspace summary sections.
   */
  static generateAxKpiXml(name: string, properties?: Record<string, any>): string {
    const label      = properties?.label     || `@TODO:${name}Label`;
    const helpText   = properties?.helpText  || `@TODO:${name}HelpText`;
    const measure    = properties?.measure   || '';
    const dimension  = properties?.dimension || '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxKPI xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>
\t<HelpText>${escapeXml(helpText)}</HelpText>${measure ? `\n\t<Measure>${measure}</Measure>` : ''}${dimension ? `\n\t<MeasureDimension>${dimension}</MeasureDimension>` : ''}
\t<Goal>0</Goal>
\t<GoalType>None</GoalType>
\t<Trend>None</Trend>
</AxKPI>`;
  }

  /**
   * Generate macro-library XML (AxMacroDictionary).
   *
   * The whole library body is ONE property (`Source`) — there is no per-macro
   * sub-element in the metadata, so the caller's sourceCode is emitted verbatim
   * (XML-escaped) exactly the way the platform's own flight libraries do it.
   *
   * Line breaks are written as CRLF with the CR escaped (`&#xD;` + newline),
   * which is what the MS serializer emits (see ApplicationFoundationFlights.xml).
   * A literal CRLF also compiles — an XML parser normalises it to LF — but it
   * does not round-trip: the CR is lost on re-serialization, so a golden frozen
   * on the unescaped form would churn the first time the element is rewritten
   * by Visual Studio. Verified on the VM by L1-macro-library-flight.
   */
  static generateAxMacroXml(name: string, sourceCode?: string, properties?: Record<string, any>): string {
    const source = (sourceCode ?? properties?.source ?? `#define.${name}Placeholder('${name}')`)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\r\n|\r|\n/g, '&#xD;\r\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<AxMacroDictionary xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Source>${source}</Source>
\t<Macros />
</AxMacroDictionary>`;
  }

  /**
   * Generate configuration-key XML (AxConfigurationKey).
   * ParentKey nests the key under an existing one; LicenseCode ties it to an
   * ISV licence (both optional — an omitted element means "no parent/licence").
   */
  static generateAxConfigurationKeyXml(name: string, properties?: Record<string, any>): string {
    const label       = properties?.label       || `@TODO:${name}Label`;
    const parentKey   = properties?.parentKey   || '';
    const licenseCode = properties?.licenseCode || '';
    const tags        = properties?.tags        || '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxConfigurationKey xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>${parentKey ? `\n\t<ParentKey>${parentKey}</ParentKey>` : ''}${licenseCode ? `\n\t<LicenseCode>${licenseCode}</LicenseCode>` : ''}${tags ? `\n\t<Tags>${escapeXml(tags)}</Tags>` : ''}
</AxConfigurationKey>`;
  }

  /**
   * Generate XDS security-policy XML (AxSecurityPolicy).
   * A policy constrains PrimaryTable through Query; every constrained table is
   * an AxSecurityPolicyConstrainedTable entry carrying its TableRelation.
   */
  static generateAxSecurityPolicyXml(name: string, properties?: Record<string, any>): string {
    const label            = properties?.label            || `@TODO:${name}Label`;
    const primaryTable     = properties?.primaryTable     || '';
    const query            = properties?.query            || '';
    const enabled          = properties?.enabled === false ? 'No' : 'Yes';
    const constrainedTable = properties?.constrainedTable === false ? 'No' : 'Yes';
    // <ContextType> is the SecurityPolicyContextType enum. It was written verbatim,
    // so "Role" / "User" produced a policy whose context silently reverted to the
    // default while the build stayed green — the policy then constrains nothing.
    const contextType      = assertKnownEnumValue(
      `Security policy '${name}': contextType`, properties?.contextType, SECURITY_POLICY_CONTEXT_TYPES, '');
    const roleName         = properties?.roleName         || '';
    const constrained: Array<{ name: string; tableRelation?: string }> =
      Array.isArray(properties?.constrainedTables) ? properties!.constrainedTables : [];

    const constrainedXml = constrained.length
      ? constrained.map(t => `\t\t<AxSecurityPolicyConstrainedEntity xmlns=""
\t\t\ti:type="AxSecurityPolicyConstrainedTable">
\t\t\t<Name>${t.name}</Name>
\t\t\t<ConstrainedTables />
\t\t\t<TableRelation>${t.tableRelation ?? t.name}</TableRelation>
\t\t</AxSecurityPolicyConstrainedEntity>`).join('\n')
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPolicy xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<ConstrainedTable>${constrainedTable}</ConstrainedTable>
\t<Enabled>${enabled}</Enabled>
\t<Label>${escapeXml(label)}</Label>${contextType ? `\n\t<ContextType>${contextType}</ContextType>` : ''}${roleName ? `\n\t<RoleName>${roleName}</RoleName>` : ''}${primaryTable ? `\n\t<PrimaryTable>${primaryTable}</PrimaryTable>` : ''}${query ? `\n\t<Query>${query}</Query>` : ''}
\t<ConstrainedTables>${constrainedXml ? `\n${constrainedXml}\n\t` : ''}</ConstrainedTables>
</AxSecurityPolicy>`;
  }

  /**
   * The aggregation of an <AxMeasure>, as the contract actually spells it.
   *
   * The element is <DefaultAggregate> — `AggregateFunction` appears NOWHERE in
   * PackagesLocalDirectory, and an unknown child element is DROPPED SILENTLY by
   * the deserializer: the L3-aggregate-measurement-basic run built green while
   * the measure fell back to Sum, with nothing anywhere reporting the loss.
   *
   * The enum is not the SQL vocabulary either — the platform's 531 measures use
   * only Sum (495), DistinctCount (23), AverageOfChildren (10), Max (2), Min (1).
   * "Avg" and "Count" are accepted as aliases because that is what a caller
   * (and every BI doc) reaches for; anything else is refused rather than written
   * out to be dropped.
   */
  static resolveDefaultAggregate(value: string | undefined, measureName: string): string {
    const LEGAL = ['Sum', 'DistinctCount', 'AverageOfChildren', 'Max', 'Min'];
    const ALIASES: Record<string, string> = {
      avg: 'AverageOfChildren',
      average: 'AverageOfChildren',
      averageofchildren: 'AverageOfChildren',
      count: 'DistinctCount',
      distinctcount: 'DistinctCount',
      sum: 'Sum',
      max: 'Max',
      min: 'Min',
    };
    if (value === undefined || value === null || value === '') return 'Sum';
    const resolved = ALIASES[String(value).trim().toLowerCase()];
    if (!resolved) {
      throw new Error(
        `Measure "${measureName}": DefaultAggregate "${value}" is not a legal aggregation. ` +
        `Use one of ${LEGAL.join(', ')} (Avg/Average map to AverageOfChildren, Count to DistinctCount).`
      );
    }
    return resolved;
  }

  /**
   * Generate aggregate-measurement XML (AxAggregateMeasurement).
   * One measure group per fact table/entity: Attributes are the slicing keys,
   * Measures the aggregated fields (see resolveDefaultAggregate for the enum).
   */
  static generateAxAggregateMeasurementXml(name: string, properties?: Record<string, any>): string {
    const usage = properties?.usage || 'StagedEntityStore';
    const groups: Array<{
      name: string;
      table: string;
      attributes?: Array<{ name: string; field?: string; nameField?: string }>;
      measures?: Array<{ name: string; field: string; defaultAggregate?: string; aggregateFunction?: string }>;
    }> = Array.isArray(properties?.measureGroups) ? properties!.measureGroups : [];

    const groupXml = groups.map(group => {
      const attributes = (group.attributes ?? []).map(attr => {
        const field = attr.field ?? attr.name;
        return `\t\t\t\t<AxDimensionAttribute>
\t\t\t\t\t<Name>${attr.name}</Name>${attr.nameField ? `\n\t\t\t\t\t<NameField>${attr.nameField}</NameField>` : ''}
\t\t\t\t\t<KeyFields>
\t\t\t\t\t\t<AxDimensionFieldReference>
\t\t\t\t\t\t\t<DimensionField>${field}</DimensionField>
\t\t\t\t\t\t</AxDimensionFieldReference>
\t\t\t\t\t</KeyFields>
\t\t\t\t</AxDimensionAttribute>`;
      }).join('\n');

      const measures = (group.measures ?? []).map(measure => `\t\t\t\t<AxMeasure>
\t\t\t\t\t<Name>${measure.name}</Name>
\t\t\t\t\t<DefaultAggregate>${XmlTemplateGenerator.resolveDefaultAggregate(
        measure.defaultAggregate ?? measure.aggregateFunction,
        measure.name,
      )}</DefaultAggregate>
\t\t\t\t\t<Field>${measure.field}</Field>
\t\t\t\t</AxMeasure>`).join('\n');

      return `\t\t<AxMeasureGroup xmlns="">
\t\t\t<Name>${group.name}</Name>
\t\t\t<Table>${group.table}</Table>
\t\t\t<Attributes>${attributes ? `\n${attributes}\n\t\t\t` : ''}</Attributes>
\t\t\t<Measures>${measures ? `\n${measures}\n\t\t\t` : ''}</Measures>
\t\t</AxMeasureGroup>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<AxAggregateMeasurement xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V2">
\t<Name>${name}</Name>
\t<Usage>${usage}</Usage>
\t<MeasureGroups>${groupXml ? `\n${groupXml}\n\t` : ''}</MeasureGroups>
</AxAggregateMeasurement>`;
  }

  /**
   * Generate license-code XML (AxLicenseCode) — the ISV licensing anchor a
   * configuration key points at through its LicenseCode property.
   */
  static generateAxLicenseCodeXml(name: string, properties?: Record<string, any>): string {
    const label     = properties?.label     || `@TODO:${name}Label`;
    const group     = properties?.group     || 'Module';
    const pkg       = properties?.package   || 'BusinessEssential';
    // PublicKey is a GLOBALLY unique ISV key slot: xppc fails the build with
    // "Duplicate value 'N' detected" if any other installed model already owns
    // the slot (all 74 platform license codes hold 74 distinct slots). There is
    // therefore no safe default — defaulting to a literal collided with
    // ApplicationFoundation/LogisticsBasic in the L2-license-code-configkey run.
    const publicKey = properties?.publicKey;
    if (publicKey === undefined || publicKey === null || publicKey === '') {
      throw new Error(
        'license-code requires properties.publicKey — the ISV key slot, which must be globally unique ' +
        'across every installed model (the build fails with "Duplicate value \'N\' detected" otherwise). ' +
        'Slots in use on a standard install: 1-11, 13, 14, 18, 19, 24-234 (sparse), 603-605, 634, 635, 654, 655.'
      );
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxLicenseCode xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Group>${group}</Group>
\t<Label>${escapeXml(label)}</Label>
\t<Package>${pkg}</Package>
\t<PublicKey>${publicKey}</PublicKey>
</AxLicenseCode>`;
  }

  /**
   * Generate AxMenu XML.
   */
  static generateAxMenuXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>${escapeXml(label)}</Label>
\t<Elements />
</AxMenu>`;
  }

  /**
   * Generate AxMenuExtension XML.
   * Name convention: MenuName.ExtensionName
   */
  static generateAxMenuExtensionXml(name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Customizations />
\t<Elements />
\t<MenuElementModifications />
\t<PropertyModifications />
</AxMenuExtension>`;
  }

  /**
   * Generate AxMenuItemDisplay / AxMenuItemAction / AxMenuItemOutput XML.
   *
   * AOT folder mapping:
   *   menu-item-display → AxMenuItemDisplay  (ObjectType: Form)
   *   menu-item-action  → AxMenuItemAction   (ObjectType: Class)
   *   menu-item-output  → AxMenuItemOutput   (ObjectType: Report)
   */
  static generateAxMenuItemXml(
    itemType: 'menu-item-display' | 'menu-item-action' | 'menu-item-output',
    name: string,
    properties?: Record<string, any>
  ): string {
    const elemName = itemType === 'menu-item-action' ? 'AxMenuItemAction'
      : itemType === 'menu-item-output' ? 'AxMenuItemOutput'
      : 'AxMenuItemDisplay';
    const targetObject = properties?.targetObject || properties?.object || name;
    // `label: null` = the caller has no label ID to give, so the element is omitted
    // rather than filled with prose or a dangling '@TODO:LabelId'. `undefined` keeps
    // the placeholder, leaving callers that never thought about labels unaffected.
    const label: string | null = properties?.label === null
      ? null
      : (properties?.label || '@TODO:LabelId');

    // Determine ObjectType based on item type and explicit properties.
    // D365FO serializer rules (confirmed from real XML files):
    //   - AxMenuItemAction:  ObjectType is always "Class"; must be present.
    //   - AxMenuItemDisplay: ObjectType is OMITTED when targeting a Form (default);
    //                        use "Class" only when explicitly set.
    //   - AxMenuItemOutput:  ObjectType is "Class" (controller) or "SSRSReport";
    //                        "Report" is NOT a valid value — real files use "SSRSReport".
    const explicitObjType: string | undefined = properties?.objectType || properties?.targetType;
    let objType: string | undefined;
    if (itemType === 'menu-item-action') {
      // Action always needs ObjectType; default to Class
      objType = explicitObjType || 'Class';
    } else if (itemType === 'menu-item-output') {
      // Output: Class (controller pattern) or SSRSReport; "Report" is invalid
      if (explicitObjType === 'Report') {
        objType = 'SSRSReport';
      } else {
        objType = explicitObjType || 'Class';
      }
    } else {
      // Display: omit ObjectType entirely when targeting a Form (the implicit default).
      // Include it only when caller explicitly requests "Class".
      if (explicitObjType && explicitObjType !== 'Form') {
        objType = explicitObjType;
      }
      // else leave objType undefined → element omitted
    }

    const objectTypeXml = objType ? `\n\t<ObjectType>${objType}</ObjectType>` : '';
    const labelXml = label === null ? '' : `\n\t<Label>${escapeXml(label)}</Label>`;
    return `<?xml version="1.0" encoding="utf-8"?>
<${elemName} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>${labelXml}
\t<Object>${targetObject}</Object>${objectTypeXml}
</${elemName}>`;
  }

  /**
   * Ensure AxMenuItemAction/Display/Output XML always has the required namespace
   * attributes on the root element.  D365FO metadata deserializer rejects the file
   * without both:
   *   xmlns="Microsoft.Dynamics.AX.Metadata.V1"
   *   xmlns:i="http://www.w3.org/2001/XMLSchema-instance"
   *
   * Also fix invalid ObjectType values:
   *   "Form"   → remove element entirely (display items targeting a form should
   *              omit ObjectType; D365FO has no ObjectType enum value "Form")
   *   "Report" → "SSRSReport" (only valid values are Class / SSRSReport)
   */
  static sanitizeMenuItemXml(xml: string): string {
    // 1. Ensure xmlns namespace attributes on root element
    xml = xml.replace(
      /<(AxMenuItem(?:Action|Display|Output))(\s[^>]*)?>/,
      (_match, tag: string, attrs: string | undefined) => {
        let a = attrs || '';
        if (!a.includes('xmlns="Microsoft.Dynamics.AX.Metadata.V1"')) {
          a += ' xmlns="Microsoft.Dynamics.AX.Metadata.V1"';
        }
        if (!a.includes('xmlns:i="')) {
          a = ` xmlns:i="http://www.w3.org/2001/XMLSchema-instance"` + a;
        }
        return `<${tag}${a}>`;
      }
    );
    // 2. Fix invalid ObjectType value "Form" → remove element
    //    Real AxMenuItemDisplay files targeting forms simply omit ObjectType.
    xml = xml.replace(/\s*<ObjectType>Form<\/ObjectType>/g, '');
    // 3. Fix invalid ObjectType value "Report" → "SSRSReport"
    xml = xml.replace(/<ObjectType>Report<\/ObjectType>/g, '<ObjectType>SSRSReport</ObjectType>');
    return xml;
  }
}
