/**
 * Form Cloner — clones an existing AxForm XML into a new form, re-binding
 * datasources/fields to target tables.
 *
 * All transformations are STRING-LEVEL on the original XML text — never
 * parse/re-serialize. D365FO metadata XML is whitespace-, CDATA- and
 * namespace-marker-sensitive (tabs, CRLF, xmlns="", i:nil), and a round-trip
 * through an XML library corrupts it (the same reason normalizeD365Xml
 * exists). Regions we don't touch stay byte-identical.
 */

export interface CloneFormOptions {
  /** Name of the new form (already prefixed) */
  targetFormName: string;
  /** sourceTable → targetTable re-binding (omit to keep the source tables) */
  tableMapping?: Record<string, string>;
  /**
   * Field lookup for a target table (case-insensitive names). Return null when
   * the table is unknown — fields then pass through unfiltered.
   */
  getTableFields?: (table: string) => string[] | null;
  /** Strip form/datasource methods except classDeclaration (default true) */
  stripMethods?: boolean;
  /** New Design caption (label ref or text). Replaces the source form's caption. */
  caption?: string;
}

export interface CloneFormResult {
  xml: string;
  sourceFormName: string;
  renamedDataSources: Array<{ from: string; to: string }>;
  droppedFields: Array<{ dataSource: string; field: string }>;
  removedControls: string[];
  strippedMethods: string[];
  /** True when the <SourceCode> datasource/control method mirror was emptied. */
  clearedSourceCodeMirror: boolean;
  /** True when the classDeclaration body (member vars/macros) was reset to empty. */
  resetClassDeclaration: boolean;
  /** Default datasource indexes dropped from re-bound datasources. */
  removedIndexes: Array<{ dataSource: string; index: string }>;
  /** QuickFilter defaultColumnName references repointed/cleared after column removal. */
  repointedQuickFilters: Array<{ from: string; to: string }>;
}

interface ElementBlock {
  start: number;
  end: number; // exclusive, past the closing tag
  content: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find all top-level blocks of `tagName` inside `xml` using balanced
 * open/close counting (handles nested same-name elements, e.g. AxFormControl
 * inside AxFormControl, AxFormDataSource inside DerivedDataSources).
 * Self-closing tags (<Tag ... />) count as complete blocks.
 */
export function findElementBlocks(xml: string, tagName: string, searchStart = 0, searchEnd?: number): ElementBlock[] {
  const blocks: ElementBlock[] = [];
  const limit = searchEnd ?? xml.length;
  const openRe = new RegExp(`<${escapeRegExp(tagName)}(?=[\\s>/])`, 'g');
  const closeTag = `</${tagName}>`;

  let cursor = searchStart;
  while (cursor < limit) {
    openRe.lastIndex = cursor;
    const open = openRe.exec(xml);
    if (!open || open.index >= limit) break;

    const start = open.index;
    // Find the end of the opening tag to detect self-closing
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd === -1) break;
    if (xml[tagEnd - 1] === '/') {
      blocks.push({ start, end: tagEnd + 1, content: xml.slice(start, tagEnd + 1) });
      cursor = tagEnd + 1;
      continue;
    }

    // Balanced scan for the matching close tag
    let depth = 1;
    let scan = tagEnd + 1;
    while (depth > 0 && scan < xml.length) {
      openRe.lastIndex = scan;
      const nextOpen = openRe.exec(xml);
      const nextClose = xml.indexOf(closeTag, scan);
      if (nextClose === -1) { scan = xml.length; break; }
      if (nextOpen && nextOpen.index < nextClose) {
        const innerTagEnd = xml.indexOf('>', nextOpen.index);
        if (innerTagEnd !== -1 && xml[innerTagEnd - 1] === '/') {
          scan = innerTagEnd + 1; // self-closing inner tag — depth unchanged
        } else {
          depth++;
          scan = (innerTagEnd === -1 ? nextOpen.index + 1 : innerTagEnd + 1);
        }
      } else {
        depth--;
        scan = nextClose + closeTag.length;
      }
    }
    blocks.push({ start, end: scan, content: xml.slice(start, scan) });
    cursor = scan;
  }
  return blocks;
}

/** First <Tag>value</Tag> (optionally with attributes) inside a string */
function firstElementValue(content: string, tagName: string): string | undefined {
  const m = content.match(new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([^<]*)</${escapeRegExp(tagName)}>`));
  return m?.[1];
}

/** Value of a FormControlExtension ExtensionProperty by property name. */
function extPropValue(content: string, propName: string): string | undefined {
  for (const p of findElementBlocks(content, 'AxFormControlExtensionProperty')) {
    if (firstElementValue(p.content, 'Name') === propName) {
      return p.content.match(/<Value>([^<]*)<\/Value>/)?.[1];
    }
  }
  return undefined;
}

/** Depth-first search for an AxFormControl with a given <Name> under <Design>. */
function findControlByName(xml: string, name: string): ElementBlock | undefined {
  const designStart = xml.indexOf('<Design>');
  const stack = [...findElementBlocks(xml, 'AxFormControl', designStart === -1 ? 0 : designStart)];
  while (stack.length) {
    const blk = stack.pop()!;
    if (firstElementValue(blk.content, 'Name') === name) return blk;
    for (const child of findElementBlocks(blk.content, 'AxFormControl', blk.content.indexOf('>') + 1)) {
      stack.push({ start: blk.start + child.start, end: blk.start + child.end, content: child.content });
    }
  }
  return undefined;
}

/** First direct child AxFormControl <Name> not in the removed set. */
function firstRemainingChildName(containerContent: string, removed: Set<string>): string | undefined {
  for (const child of findElementBlocks(containerContent, 'AxFormControl', containerContent.indexOf('>') + 1)) {
    const n = firstElementValue(child.content, 'Name');
    if (n && !removed.has(n.toLowerCase())) return n;
  }
  return undefined;
}

/** Remove a set of [start,end) ranges from a string (ranges must not overlap). */
function removeRanges(xml: string, ranges: Array<{ start: number; end: number }>): string {
  let result = xml;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    // Also swallow the preceding line indentation + newline for clean output
    let start = r.start;
    while (start > 0 && (result[start - 1] === '\t' || result[start - 1] === ' ')) start--;
    if (start > 0 && result[start - 1] === '\n') start--;
    if (start > 0 && result[start - 1] === '\r') start--;
    result = result.slice(0, start) + result.slice(r.end);
  }
  return result;
}

/** Replace <Tag>old</Tag> with <Tag>new</Tag> for DataSource-reference tags, token-exact. */
function replaceDsReferences(xml: string, from: string, to: string): string {
  const tags = ['DataSource', 'TitleDataSource', 'JoinSource'];
  let result = xml;
  for (const tag of tags) {
    const re = new RegExp(
      `(<${tag}(?:\\s[^>]*)?>)${escapeRegExp(from)}(</${tag}>)`,
      'g',
    );
    result = result.replace(re, `$1${to}$2`);
  }
  return result;
}

export function cloneFormXml(sourceXml: string, opt: CloneFormOptions): CloneFormResult {
  const {
    targetFormName,
    tableMapping = {},
    getTableFields,
    stripMethods = true,
    caption,
  } = opt;

  let xml = sourceXml;
  const result: CloneFormResult = {
    xml: sourceXml,
    sourceFormName: '',
    renamedDataSources: [],
    droppedFields: [],
    removedControls: [],
    strippedMethods: [],
    clearedSourceCodeMirror: false,
    resetClassDeclaration: false,
    removedIndexes: [],
    repointedQuickFilters: [],
  };

  // ── 1. Form rename ─────────────────────────────────────────────────────────
  const rootNameMatch = xml.match(/<Name>([^<]+)<\/Name>/);
  if (!rootNameMatch) throw new Error('Source XML has no <Name> element — not an AxForm?');
  const sourceFormName = rootNameMatch[1];
  result.sourceFormName = sourceFormName;

  // Root <Name> — first occurrence only
  xml = xml.replace(`<Name>${sourceFormName}</Name>`, `<Name>${targetFormName}</Name>`);
  // classDeclaration + any self-references in remaining source
  xml = xml.replace(
    new RegExp(`\\bclass\\s+${escapeRegExp(sourceFormName)}\\b`, 'g'),
    `class ${targetFormName}`,
  );

  // ── 2. Method stripping (inside <SourceCode> only) ─────────────────────────
  if (stripMethods) {
    const sourceCodeBlocks = findElementBlocks(xml, 'SourceCode');
    if (sourceCodeBlocks.length > 0) {
      const sc = sourceCodeBlocks[0];
      const removals: Array<{ start: number; end: number }> = [];
      for (const method of findElementBlocks(xml, 'Method', sc.start, sc.end)) {
        const name = firstElementValue(method.content, 'Name');
        if (name && name !== 'classDeclaration') {
          result.strippedMethods.push(name);
          removals.push(method);
        }
      }
      xml = removeRanges(xml, removals);
    }
  }

  // ── 2b. Empty the <SourceCode> datasource/control method mirror ────────────
  // <SourceCode> carries a <DataSources>/<DataControls> mirror that exists only
  // to host per-datasource, per-field and per-control method overrides. We strip
  // those methods, so the mirror is dead weight — and it still names the SOURCE
  // table's fields and the source form's controls, which the deserializer
  // cross-checks against the (re-bound) real datasources and rejects. Reset both
  // to the empty self-closing form every clean form uses.
  for (const childTag of ['DataSources', 'DataControls']) {
    const sc = findElementBlocks(xml, 'SourceCode')[0];
    if (!sc) break;
    const blk = findElementBlocks(xml, childTag, sc.start, sc.end)[0];
    if (!blk || blk.content.endsWith('/>')) continue;
    const xmlnsAttr = blk.content.match(/^<\w+\s+(xmlns="[^"]*")/)?.[1] ?? 'xmlns=""';
    xml = xml.slice(0, blk.start) + `<${childTag} ${xmlnsAttr} />` + xml.slice(blk.end);
    result.clearedSourceCodeMirror = true;
  }

  // ── 2c. Reset the classDeclaration body ────────────────────────────────────
  // Member variables and macros (e.g. `boolean isDefaultPaymentChange;`,
  // `#ISOCountryRegionCodes`) only existed to support the methods we just
  // stripped. Keep the class header (attributes / extends / implements) but
  // empty the body so the clone compiles. The form name was already retargeted.
  {
    const sc = findElementBlocks(xml, 'SourceCode')[0];
    if (sc) {
      for (const method of findElementBlocks(xml, 'Method', sc.start, sc.end)) {
        if (firstElementValue(method.content, 'Name') !== 'classDeclaration') continue;
        const cdata = method.content.match(/<Source>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Source>/);
        if (cdata) {
          const body = cdata[1];
          const open = body.indexOf('{');
          const close = body.lastIndexOf('}');
          if (open !== -1 && close > open && body.slice(open + 1, close).trim().length > 0) {
            const header = body.slice(0, open).replace(/[ \t]+$/, '');
            const newCdata = cdata[0].replace(cdata[1], `\n${header.trimStart()}\n{\n}\n`);
            const newMethod = method.content.replace(cdata[0], newCdata);
            xml = xml.slice(0, method.start) + newMethod + xml.slice(method.end);
            result.resetClassDeclaration = true;
          }
        }
        break;
      }
    }
  }

  // ── 3. Datasource re-binding ───────────────────────────────────────────────
  // Locate the top-level <DataSources> AFTER </SourceCode> (the SourceCode
  // section has its own DataSources element for methods).
  const scEnd = xml.indexOf('</SourceCode>');
  const dsBlocks = findElementBlocks(xml, 'AxFormDataSource', scEnd === -1 ? 0 : scEnd);

  // Map of dsName → {table, block} for top-level datasources (DerivedDataSources
  // nested blocks are covered because findElementBlocks consumes whole outer
  // blocks; we only re-bind on the outer ones).
  // Process in REVERSE document order: replacing a block can change its length,
  // which would invalidate the absolute offsets of every later block.
  const mappingEntries = Object.entries(tableMapping);
  for (const ds of [...dsBlocks].sort((a, b) => b.start - a.start)) {
    const dsName = firstElementValue(ds.content, 'Name');
    const dsTable = firstElementValue(ds.content, 'Table');
    if (!dsName || !dsTable) continue;

    const mapped = mappingEntries.find(([src]) => src.toLowerCase() === dsTable.toLowerCase());
    if (!mapped) continue;
    const targetTable = mapped[1];

    // Replace <Table> inside this block (positional, so we don't touch other DSes)
    let newBlock = ds.content.replace(
      new RegExp(`(<Table(?:\\s[^>]*)?>)${escapeRegExp(dsTable)}(</Table>)`),
      `$1${targetTable}$2`,
    );

    // Rename the datasource itself when it carries the table's name
    const renameDs = dsName.toLowerCase() === dsTable.toLowerCase() && dsName !== targetTable;
    if (renameDs) {
      newBlock = newBlock.replace(`<Name>${dsName}</Name>`, `<Name>${targetTable}</Name>`);
      result.renamedDataSources.push({ from: dsName, to: targetTable });
    }

    // The default-sort <Index> names an index on the SOURCE table that the
    // target table almost certainly doesn't have — drop it (D365FO falls back
    // to the table's primary index).
    newBlock = newBlock.replace(/[ \t]*<Index(?:\s[^>]*)?>([^<]*)<\/Index>\r?\n?/g, (_m, idx) => {
      result.removedIndexes.push({ dataSource: renameDs ? targetTable : dsName, index: idx });
      return '';
    });

    xml = xml.slice(0, ds.start) + newBlock + xml.slice(ds.end);
  }

  // Re-bind <DataSource>/<TitleDataSource>/<JoinSource> references for renames
  for (const { from, to } of result.renamedDataSources) {
    xml = replaceDsReferences(xml, from, to);
  }

  // ── 4. Field filtering against target tables ───────────────────────────────
  if (getTableFields) {
    const scEnd2 = xml.indexOf('</SourceCode>');
    const removals: Array<{ start: number; end: number }> = [];
    for (const ds of findElementBlocks(xml, 'AxFormDataSource', scEnd2 === -1 ? 0 : scEnd2)) {
      const dsName = firstElementValue(ds.content, 'Name');
      const dsTable = firstElementValue(ds.content, 'Table');
      if (!dsName || !dsTable) continue;

      const fields = getTableFields(dsTable);
      if (!fields) continue; // unknown table — keep everything
      const fieldSet = new Set(fields.map((f) => f.toLowerCase()));

      for (const fieldBlock of findElementBlocks(xml, 'AxFormDataSourceField', ds.start, ds.end)) {
        const dataField = firstElementValue(fieldBlock.content, 'DataField');
        if (dataField && !fieldSet.has(dataField.toLowerCase())) {
          result.droppedFields.push({ dataSource: dsName, field: dataField });
          removals.push(fieldBlock);
        }
      }
    }
    xml = removeRanges(xml, removals);

    // Remove controls bound to dropped fields
    if (result.droppedFields.length > 0) {
      const dropped = new Set(
        result.droppedFields.map((d) => `${d.dataSource.toLowerCase()}|${d.field.toLowerCase()}`),
      );
      const controlRemovals: Array<{ start: number; end: number }> = [];
      const designStart = xml.indexOf('<Design>');
      const consumed: Array<{ start: number; end: number }> = [];
      for (const control of findElementBlocks(xml, 'AxFormControl', designStart === -1 ? 0 : designStart)) {
        // findElementBlocks returns only top-level blocks; recurse manually so
        // nested bound controls (grid columns) are found too.
        const stack: ElementBlock[] = [control];
        while (stack.length > 0) {
          const blk = stack.pop()!;
          const dataField = firstElementValue(blk.content, 'DataField');
          const dataSource = firstElementValue(blk.content, 'DataSource');
          const isBoundToDropped =
            dataField && dataSource && dropped.has(`${dataSource.toLowerCase()}|${dataField.toLowerCase()}`);
          const inner = findElementBlocks(blk.content, 'AxFormControl', blk.content.indexOf('>') + 1);
          if (isBoundToDropped && inner.length === 0) {
            // Leaf control bound to a dropped field — remove it
            const alreadyCovered = consumed.some((c) => blk.start >= c.start && blk.end <= c.end);
            if (!alreadyCovered) {
              const name = firstElementValue(blk.content, 'Name') ?? '(unnamed)';
              result.removedControls.push(name);
              controlRemovals.push({ start: blk.start, end: blk.end });
              consumed.push({ start: blk.start, end: blk.end });
            }
          } else {
            for (const child of inner) {
              stack.push({
                start: blk.start + child.start,
                end: blk.start + child.end,
                content: child.content,
              });
            }
          }
        }
      }
      xml = removeRanges(xml, controlRemovals);

      // Repoint QuickFilter defaultColumnName references that named a removed
      // column — otherwise the QuickFilter points at a control that no longer
      // exists. Best-effort: retarget to the first surviving column of the same
      // grid (named by the sibling targetControlName property).
      const removedSet = new Set(result.removedControls.map((c) => c.toLowerCase()));
      for (const ext of [...findElementBlocks(xml, 'FormControlExtension')].sort((a, b) => b.start - a.start)) {
        const defCol = extPropValue(ext.content, 'defaultColumnName');
        if (!defCol || !removedSet.has(defCol.toLowerCase())) continue;
        const gridName = extPropValue(ext.content, 'targetControlName');
        const grid = gridName ? findControlByName(xml, gridName) : undefined;
        const replacement = grid ? firstRemainingChildName(grid.content, removedSet) : undefined;
        if (replacement) {
          const newExt = ext.content.replace(
            new RegExp(`(<Value>)${escapeRegExp(defCol)}(</Value>)`),
            `$1${replacement}$2`,
          );
          xml = xml.slice(0, ext.start) + newExt + xml.slice(ext.end);
        }
        result.repointedQuickFilters.push({ from: defCol, to: replacement ?? '' });
      }
    }
  }

  // ── 5. Caption override ────────────────────────────────────────────────────
  // The cloned Design keeps the SOURCE form's caption (e.g. @SYS23346 "Payment
  // terms"). Replace it when the caller supplied a caption. Scoped to the region
  // before <Controls> so we only touch the Design-level caption, not a tab page's.
  if (caption) {
    const designStart = xml.indexOf('<Design>');
    const controlsStart = xml.indexOf('<Controls', designStart);
    if (designStart !== -1 && controlsStart !== -1) {
      const region = xml.slice(designStart, controlsStart);
      const capRe = /(<Caption(?:\s[^>]*)?>)[^<]*(<\/Caption>)/;
      if (capRe.test(region)) {
        xml = xml.slice(0, designStart) + region.replace(capRe, `$1${caption}$2`) + xml.slice(controlsStart);
      }
    }
  }

  result.xml = xml;
  return result;
}
