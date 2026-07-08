/**
 * Per-pattern FormRun / datasource lifecycle method stubs.
 *
 * Stubs are correct-signature skeletons with super() calls and TODO markers —
 * injected by generate_smart when includeMethodStubs=true, and exposed
 * through get_form_pattern_spec as lifecycle guidance.
 */

import { resolvePattern } from './index.js';

export interface MethodStub {
  name: string;
  /** Complete X++ source, 4-space indented, ready for a CDATA block */
  source: string;
}

// Form-level stubs

const FORM_INIT: MethodStub = {
  name: 'init',
  source: `    public void init()
    {
        super();

        // TODO: read caller context, e.g.:
        // if (element.args() && element.args().record())
        // {
        //     ...
        // }
    }`,
};

const FORM_EXECUTE_QUERY = (dsName: string): MethodStub => ({
  name: 'executeQuery',
  source: `    public void executeQuery()
    {
        // TODO: add dynamic ranges before super(), e.g.:
        // SysQuery::findOrCreateRange(${dsName}_ds.queryBuildDataSource(), fieldNum(${dsName}, RecId));

        super();
    }`,
});

const FORM_CLOSE_OK: MethodStub = {
  name: 'closeOk',
  source: `    public void closeOk()
    {
        // TODO: apply the dialog action before the form closes.

        super();
    }`,
};

// Datasource-level stubs

const DS_INIT_VALUE: MethodStub = {
  name: 'initValue',
  source: `        public void initValue()
        {
            super();

            // TODO: default field values for new records.
        }`,
};

const DS_ACTIVE: MethodStub = {
  name: 'active',
  source: `        public int active()
        {
            int ret = super();

            // TODO: enable/disable controls based on the current record.

            return ret;
        }`,
};

const DS_VALIDATE_WRITE: MethodStub = {
  name: 'validateWrite',
  source: `        public boolean validateWrite()
        {
            boolean ret = super();

            // TODO: cross-field validation before save.

            return ret;
        }`,
};

/** Lines datasource initValue that defaults the foreign key from the header record. */
const LINES_INIT_VALUE = (headerDsName: string): MethodStub => ({
  name: 'initValue',
  source: `        public void initValue()
        {
            super();

            // TODO: default line fields from the header record, e.g.:
            // this.cursor().HeaderRecId = ${headerDsName || 'Header'}.RecId;
        }`,
});

// Per-pattern selection

export interface PatternMethodStubs {
  formMethods: MethodStub[];
  /** Stubs for the PRIMARY datasource */
  dataSourceMethods: MethodStub[];
  /** Stubs for the LINES datasource (header+lines patterns) */
  linesDataSourceMethods?: MethodStub[];
}

/**
 * Lifecycle stubs appropriate for a pattern. `dsName` is the primary
 * datasource name; `linesDsName` (optional) the lines datasource for
 * header+lines patterns (used to default line fields from the header).
 */
export function methodStubsForPattern(
  patternName: string,
  dsName: string,
  linesDsName?: string,
): PatternMethodStubs {
  const spec = resolvePattern(patternName);
  const id = spec?.id ?? 'SimpleList';

  switch (id) {
    case 'Dialog':
    case 'DropDialog':
      return {
        formMethods: [FORM_INIT, FORM_CLOSE_OK],
        dataSourceMethods: dsName ? [DS_INIT_VALUE] : [],
      };
    case 'Lookup':
      return {
        formMethods: [FORM_INIT, FORM_EXECUTE_QUERY(dsName)],
        dataSourceMethods: [],
      };
    case 'DetailsMaster':
    case 'DetailsMasterTabs':
      return {
        formMethods: [FORM_INIT],
        dataSourceMethods: [DS_ACTIVE, DS_VALIDATE_WRITE],
      };
    case 'DetailsTransaction':
      return {
        formMethods: [FORM_INIT],
        // Header datasource drives selection + save-time validation.
        dataSourceMethods: [DS_ACTIVE, DS_VALIDATE_WRITE],
        // Lines datasource defaults new-line fields from the header.
        linesDataSourceMethods: linesDsName
          ? [LINES_INIT_VALUE(dsName), DS_VALIDATE_WRITE]
          : undefined,
      };
    case 'SimpleListDetails':
      return {
        formMethods: [],
        dataSourceMethods: [DS_ACTIVE, DS_INIT_VALUE],
      };
    case 'Workspace':
    case 'WorkspaceOperational':
      return { formMethods: [FORM_INIT], dataSourceMethods: [] };
    case 'SimpleList':
    case 'ListPage':
    case 'TableOfContents':
    default:
      return {
        formMethods: [],
        dataSourceMethods: dsName ? [DS_INIT_VALUE, DS_VALIDATE_WRITE] : [],
      };
  }
}

// String-level injection into AxForm XML

function methodXml(stub: MethodStub, indent: string): string {
  return (
    `${indent}<Method>\n` +
    `${indent}\t<Name>${stub.name}</Name>\n` +
    `${indent}\t<Source><![CDATA[\n${stub.source}\n]]></Source>\n` +
    `${indent}</Method>\n`
  );
}

/**
 * Inject method stubs into AxForm XML (string-level, format-preserving):
 *  - form methods: appended after the classDeclaration </Method> inside
 *    SourceCode > Methods
 *  - datasource methods: inserted into the SourceCode > DataSources >
 *    DataSource > Methods mirror section (merged when a <DataSource> for the
 *    target datasource already exists), NOT the top-level
 *    DataSources > AxFormDataSource element — no shipped D365FO form ever
 *    populates a <Methods> child there, and doing so desyncs xppc's
 *    positional schema binding for that element (the following <Table> then
 *    deserializes as empty — "datasource 'X' refers to table '' which does
 *    not exist" — even though the emitted <Table> text is correct).
 *
 * Returns the new XML and the names of injected methods.
 */
export function injectMethodStubs(
  xml: string,
  stubs: PatternMethodStubs,
  dsName: string,
  linesDsName?: string,
): { xml: string; injected: string[] } {
  let result = xml;
  const injected: string[] = [];

  // Insert a <Methods> block for `targetDs` into the SourceCode mirror's
  // <DataSources> collection (self-closed/empty on a fresh scaffold; may
  // already contain entries on a cloned-from-real-form source, or from a
  // prior call to this same function for a different datasource). Returns
  // the updated XML (or the original when SourceCode/DataSources or the
  // methods list is missing).
  const injectDsMethods = (src: string, targetDs: string, methods: MethodStub[]): string => {
    if (methods.length === 0 || !targetDs) return src;

    // Scope to <SourceCode>...</SourceCode> so the top-level DataSources
    // collection (which follows SourceCode in every template) is never touched.
    const scStart = src.indexOf('<SourceCode>');
    const scEnd = scStart === -1 ? -1 : src.indexOf('</SourceCode>', scStart);
    if (scStart === -1 || scEnd === -1) return src;

    // The SourceCode mirror's own <DataSources> — self-closed when empty
    // (`<DataSources xmlns="" />`), open when it already carries entries.
    const dsOpenMatch = /<DataSources([^>]*?)(\/>|>)/.exec(src.slice(scStart, scEnd));
    if (!dsOpenMatch) return src;
    const dsOpenStart = scStart + dsOpenMatch.index;
    const dsOpenEnd = dsOpenStart + dsOpenMatch[0].length;
    const dsAttrs = dsOpenMatch[1].trimEnd(); // e.g. ` xmlns=""` (drop any space before the `/>`/`>`)
    const selfClosed = dsOpenMatch[2] === '/>';

    const methodsBlock =
      `\t\t\t\t<Methods>\n` +
      methods.map((s) => methodXml(s, '\t\t\t\t\t')).join('') +
      `\t\t\t\t</Methods>\n`;
    injected.push(...methods.map((s) => `${targetDs}.${s.name}`));

    if (selfClosed) {
      // Expand the empty placeholder into a single-entry collection.
      const dataSourceBlock =
        `<DataSources${dsAttrs}>\n` +
        `\t\t\t<DataSource>\n` +
        `\t\t\t\t<Name>${targetDs}</Name>\n` +
        methodsBlock +
        `\t\t\t</DataSource>\n` +
        `\t\t</DataSources>`;
      return src.slice(0, dsOpenStart) + dataSourceBlock + src.slice(dsOpenEnd);
    }

    // Already open: find the closing </DataSources> for THIS collection
    // (bounded to the SourceCode region so a later top-level tag can't match).
    const dsCloseIdx = src.indexOf('</DataSources>', dsOpenEnd);
    if (dsCloseIdx === -1 || dsCloseIdx > scEnd) return src;

    const dsRegion = src.slice(dsOpenEnd, dsCloseIdx);
    const nameTag = `<Name>${targetDs}</Name>`;
    const nameIdxInRegion = dsRegion.indexOf(nameTag);

    if (nameIdxInRegion === -1) {
      // No existing <DataSource> for this datasource — append a new one just
      // before the collection's closing tag. Strip the closing tag's own
      // trailing indent first so appending doesn't compound it.
      const before = src.slice(0, dsCloseIdx).replace(/[ \t]+$/, '');
      const dataSourceBlock =
        `\t\t\t<DataSource>\n` +
        `\t\t\t\t<Name>${targetDs}</Name>\n` +
        methodsBlock +
        `\t\t\t</DataSource>\n\t\t`;
      return before + dataSourceBlock + src.slice(dsCloseIdx);
    }

    // Existing <DataSource> found. Merge into its <Methods> if present,
    // otherwise insert a fresh <Methods> block right after <Name>.
    const nameIdxAbs = dsOpenEnd + nameIdxInRegion;
    const afterNameAbs = nameIdxAbs + nameTag.length;
    const existingMethodsMatch = /^\s*<Methods\s*\/>|^\s*<Methods>([\s\S]*?)<\/Methods>/.exec(
      src.slice(afterNameAbs, dsCloseIdx),
    );
    if (existingMethodsMatch) {
      const matchStart = afterNameAbs + existingMethodsMatch.index;
      const matchEnd = matchStart + existingMethodsMatch[0].length;
      const replacement =
        `\n\t\t\t\t<Methods>\n` +
        methods.map((s) => methodXml(s, '\t\t\t\t\t')).join('') +
        (existingMethodsMatch[1] ?? '') +
        `\t\t\t\t</Methods>`;
      return src.slice(0, matchStart) + replacement + src.slice(matchEnd);
    }
    const inserted = `\n${methodsBlock.replace(/\n$/, '')}`;
    return src.slice(0, afterNameAbs) + inserted + src.slice(afterNameAbs);
  };

  if (stubs.formMethods.length > 0) {
    // classDeclaration method block ends at the first </Method> after its <Name>
    const cdIdx = result.indexOf('<Name>classDeclaration</Name>');
    const closeIdx = cdIdx === -1 ? -1 : result.indexOf('</Method>', cdIdx);
    if (closeIdx !== -1) {
      const insertAt = closeIdx + '</Method>'.length;
      const block = stubs.formMethods
        .map((s) => `\n\t\t\t<Method>\n\t\t\t\t<Name>${s.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${s.source}\n]]></Source>\n\t\t\t</Method>`)
        .join('');
      result = result.slice(0, insertAt) + block + result.slice(insertAt);
      injected.push(...stubs.formMethods.map((s) => s.name));
    }
  }

  result = injectDsMethods(result, dsName, stubs.dataSourceMethods);
  if (stubs.linesDataSourceMethods && linesDsName) {
    result = injectDsMethods(result, linesDsName, stubs.linesDataSourceMethods);
  }

  return { xml: result, injected };
}
