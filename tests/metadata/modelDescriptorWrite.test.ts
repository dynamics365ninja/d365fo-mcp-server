/**
 * The descriptor's WRITE side — add/removeModuleReference and findDescriptorPath.
 *
 * `<ModuleReferences>` is the only statement of what a model may see, so these
 * transforms decide what compiles. The cases that matter are not the happy path
 * but the ones that must NOT write: a duplicate, a descriptor with no
 * `<ModuleReferences>` element at all, and a module that is not referenced. Each
 * of those used to be a hand edit, where the same mistakes are silent.
 *
 * Shape preservation is asserted byte-for-byte on the surrounding lines, not by
 * re-parsing: a descriptor goes through code review on the way to `main`, and a
 * re-indented or re-namespaced file is a diff a reviewer stops at.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  addModuleReference,
  removeModuleReference,
  parseModuleReferences,
  findDescriptorPath,
  isValidModuleReferenceName,
} from '../../src/metadata/modelDescriptor';
import { preserveDroppedProperties } from '../../src/tools/write/preserveMetadataElements';

/** A real descriptor's shape: d2p1 on the root, nil sibling, two-space indent. */
const descriptor = (refs: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<AxModelInfo xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays" ` +
  `xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
  `  <Name>Contoso</Name>\n` +
  `  <ModelReferences i:nil="true" />\n` +
  (refs.length
    ? `  <ModuleReferences>\n` +
      refs.map(r => `    <d2p1:string>${r}</d2p1:string>\n`).join('') +
      `  </ModuleReferences>\n`
    : `  <ModuleReferences />\n`) +
  `  <Publisher>Contoso</Publisher>\n` +
  `</AxModelInfo>`;

describe('module reference name validation', () => {
  // Each of these used to be written verbatim into <d2p1:string>: a space made
  // an entry parseModuleReferences cannot read back, a blank made an empty
  // entry, and & or < made the descriptor malformed.
  it.each(['Application Suite', '', '   ', 'A&B', 'A<B', '..', '.hidden', '..\\Other', 'a/b'])(
    'refuses %j without writing',
    name => {
      expect(isValidModuleReferenceName(name.trim())).toBe(false);
      expect(addModuleReference(descriptor(['Ledger']), name)).toEqual({ kind: 'invalid-name' });
    },
  );

  // Every package folder shape on a real install: plain, underscored, and the
  // hyphenated custom one (fm-mcp).
  it.each(['ApplicationSuite', 'Tax_Core', 'fm-mcp', 'Isv.Core'])('accepts %j', name => {
    expect(isValidModuleReferenceName(name)).toBe(true);
    expect(addModuleReference(descriptor(['Ledger']), name).kind).toBe('added');
  });
});

describe('addModuleReference', () => {
  it('adds one entry and leaves every other line byte-identical', () => {
    const before = descriptor(['ApplicationSuite', 'Ledger']);
    const r = addModuleReference(before, 'ApplicationFoundation');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;

    // The list is sorted, so the entry lands in order rather than at the end.
    expect(r.xml).toBe(descriptor(['ApplicationFoundation', 'ApplicationSuite', 'Ledger']));
    // The namespace declaration and the nil sibling are untouched — the two
    // things a naive rewrite loses.
    expect(r.xml).toContain('xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"');
    expect(r.xml).toContain('<ModelReferences i:nil="true" />');
  });

  it('matches the file\'s own indentation instead of imposing one', () => {
    const tabbed =
      `<AxModelInfo xmlns:d2p1="x">\n` +
      `\t<ModuleReferences>\n` +
      `\t\t<d2p1:string>Ledger</d2p1:string>\n` +
      `\t</ModuleReferences>\n` +
      `</AxModelInfo>`;
    const r = addModuleReference(tabbed, 'Tax');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(r.xml).toContain('\t\t<d2p1:string>Tax</d2p1:string>');
    expect(r.xml).not.toContain('  <d2p1:string>Tax');
  });

  it('expands an empty <ModuleReferences /> and keeps its attributes', () => {
    const empty =
      `<AxModelInfo>\n  <ModuleReferences xmlns:d2p1="http://arrays" />\n</AxModelInfo>`;
    const r = addModuleReference(empty, 'Ledger');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    // Dropping the attribute would unbind the prefix the new entry uses.
    expect(r.xml).toContain('<ModuleReferences xmlns:d2p1="http://arrays">');
    expect(r.xml).toContain('<d2p1:string>Ledger</d2p1:string>');
    expect(parseModuleReferences(r.xml)).toEqual(['Ledger']);
  });

  it('refuses a duplicate rather than writing a second entry', () => {
    const r = addModuleReference(descriptor(['ApplicationSuite']), 'ApplicationSuite');
    expect(r.kind).toBe('duplicate');
    if (r.kind !== 'duplicate') return;
    expect(r.existing).toBe('ApplicationSuite');
  });

  it('treats a case-differing spelling as the same reference', () => {
    // Two entries differing only in case are ONE reference to xppc and two lines
    // to a reviewer.
    const r = addModuleReference(descriptor(['ApplicationSuite']), 'applicationsuite');
    expect(r.kind).toBe('duplicate');
    if (r.kind !== 'duplicate') return;
    expect(r.existing).toBe('ApplicationSuite');
  });

  it('reports a descriptor with no <ModuleReferences> instead of inventing one', () => {
    // The element's entries need the d2p1 prefix bound by an xmlns:d2p1
    // attribute; guessing where that declaration belongs writes a file Visual
    // Studio rewrites on the next save.
    const bare = `<?xml version="1.0"?>\n<AxModelInfo>\n  <Name>Contoso</Name>\n</AxModelInfo>`;
    expect(addModuleReference(bare, 'Ledger').kind).toBe('no-element');
  });

  it('does not mistake the nil <ModelReferences> sibling for the list', () => {
    const onlySibling =
      `<AxModelInfo>\n  <ModelReferences i:nil="true" />\n</AxModelInfo>`;
    expect(addModuleReference(onlySibling, 'Ledger').kind).toBe('no-element');
  });
});

/**
 * The shape a descriptor on a real dev box actually has: xmlns:d2p1 on the
 * ELEMENT (the root carries only xmlns:i), tab indentation, an `i:nil`
 * <ModelReferences> sibling whose attributes wrap onto a second line, and the
 * entries in ascending order.
 *
 * The first draft of this feature was written against a fixture that put the
 * namespace on the root and left the list unsorted — both wrong, and the second
 * one produced a misplaced line on every real file.
 */
const realWorldDescriptor = (refs: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
  `\t<AppliedUpdates xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays" />\n` +
  `\t<DisplayName>Contoso</DisplayName>\n` +
  `\t<ModelReferences xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"\n` +
  `\t\ti:nil="true" />\n` +
  `\t<ModuleReferences xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">\n` +
  refs.map(r => `\t\t<d2p1:string>${r}</d2p1:string>\n`).join('') +
  `\t</ModuleReferences>\n` +
  `\t<Name>Contoso</Name>\n` +
  `</AxModelInfo>`;

const REAL_REFS = [
  'ApplicationCommon', 'ApplicationFoundation', 'ApplicationPlatform', 'ApplicationSuite',
  'ContosoCore', 'Dimensions', 'GeneralLedger', 'Retail', 'Subledger',
];

describe('parseModuleReferences is scoped to the element, not the document', () => {
  // Found by running the transforms over all 176 descriptors on a real box: the
  // flat scan this replaces also picked up <InternalsVisibleTo> and
  // <AppliedUpdates>, which are <d2p1:string> arrays too. 112 of 176 descriptors
  // over-reported, 606 phantom references in total. Both readers treat the
  // result as "packages this model may see", so every phantom made
  // resolve_references' visibility oracle MORE permissive — waving through the
  // missing-reference defect it exists to catch.
  const withSiblings = (refs: string[]) =>
    `<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `  <AppliedUpdates xmlns:d2p1="http://arrays">\n` +
    `    <d2p1:string>SomeUpdateId</d2p1:string>\n` +
    `  </AppliedUpdates>\n` +
    // Sorts BEFORE <ModuleReferences> in a serialized descriptor, which is why
    // its entries used to lead the answer.
    `  <InternalsVisibleTo xmlns:d2p1="http://arrays">\n` +
    `    <d2p1:string>ApplicationCommonTests</d2p1:string>\n` +
    `    <d2p1:string>UnitTests</d2p1:string>\n` +
    `  </InternalsVisibleTo>\n` +
    `  <ModuleReferences xmlns:d2p1="http://arrays">\n` +
    refs.map(r => `    <d2p1:string>${r}</d2p1:string>\n`).join('') +
    `  </ModuleReferences>\n` +
    `</AxModelInfo>`;

  it('ignores <InternalsVisibleTo> and <AppliedUpdates> entries', () => {
    expect(parseModuleReferences(withSiblings(['Ledger', 'Tax']))).toEqual(['Ledger', 'Tax']);
  });

  it('answers [] for a model whose only <d2p1:string> arrays are the siblings', () => {
    // ApplicationPlatform: references NOTHING, used to answer 19.
    const noRefs =
      `<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
      `  <InternalsVisibleTo xmlns:d2p1="http://arrays">\n` +
      `    <d2p1:string>UnitTests</d2p1:string>\n` +
      `  </InternalsVisibleTo>\n` +
      `  <ModuleReferences xmlns:d2p1="http://arrays" i:nil="true" />\n` +
      `</AxModelInfo>`;
    expect(parseModuleReferences(noRefs)).toEqual([]);
  });

  it('does not let a sibling entry masquerade as a duplicate', () => {
    // The practical consequence: add-module-reference would have refused
    // "UnitTests" as already referenced when it is only internals-visible-to.
    const r = addModuleReference(withSiblings(['Ledger']), 'UnitTests');
    expect(r.kind).toBe('added');
  });
});

describe('an i:nil <ModuleReferences> is a missing list, not an empty one', () => {
  // ApplicationPlatform ships `<ModuleReferences … i:nil="true" />`. Keeping the
  // attribute while adding children writes a file that loads clean and reports
  // no reference — the serializer reads the element as null and discards them.
  const nil =
    `<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `  <ModuleReferences xmlns:d2p1="http://arrays" i:nil="true" />\n` +
    `</AxModelInfo>`;

  it('drops i:nil when the first reference materialises the list', () => {
    const r = addModuleReference(nil, 'Ledger');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(r.xml).not.toMatch(/<ModuleReferences[^>]*i:nil/);
    // The namespace declaration must survive — the new entry uses that prefix.
    expect(r.xml).toContain('<ModuleReferences xmlns:d2p1="http://arrays">');
    expect(parseModuleReferences(r.xml)).toEqual(['Ledger']);
  });

  it('collapses back to the self-closing form when the last reference goes', () => {
    const added = addModuleReference(nil, 'Ledger');
    if (added.kind !== 'added') throw new Error('expected added');
    const back = removeModuleReference(added.xml, 'Ledger');
    expect(back.kind).toBe('removed');
    if (back.kind !== 'removed') return;
    expect(back.xml).toContain('<ModuleReferences xmlns:d2p1="http://arrays" />');
    expect(parseModuleReferences(back.xml)).toEqual([]);
  });
});

describe('addModuleReference on a real-world descriptor', () => {
  it('inserts in SORTED position, not at the end, when the list is sorted', () => {
    // 137 of the 173 descriptors with 2+ references on a real box are sorted,
    // including every custom model. Appending would put the entry out of order,
    // which a reviewer stops at and the next VS save silently re-sorts.
    const r = addModuleReference(realWorldDescriptor(REAL_REFS), 'Ledger');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(parseModuleReferences(r.xml)).toEqual([
      'ApplicationCommon', 'ApplicationFoundation', 'ApplicationPlatform', 'ApplicationSuite',
      'ContosoCore', 'Dimensions', 'GeneralLedger', 'Ledger', 'Retail', 'Subledger',
    ]);
    // One line added, tab-indented like its siblings, nothing else touched.
    expect(r.xml).toBe(realWorldDescriptor([
      'ApplicationCommon', 'ApplicationFoundation', 'ApplicationPlatform', 'ApplicationSuite',
      'ContosoCore', 'Dimensions', 'GeneralLedger', 'Ledger', 'Retail', 'Subledger',
    ]));
  });

  it('sorts case-insensitively, the order the real files are in', () => {
    // An ISV package spelled in caps is where raw `<` and case-insensitive `<`
    // disagree: uppercase letters sort ahead of lowercase ones, so ordinal `<`
    // puts "ISVCore" BEFORE "Inventory" ('S' < 'n'), while the order the real
    // files are in puts it after ('s' > 'n').
    const r = addModuleReference(
      realWorldDescriptor(['Currency', 'Inventory', 'Ledger']), 'ISVCore',
    );
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(parseModuleReferences(r.xml)).toEqual(['Currency', 'Inventory', 'ISVCore', 'Ledger']);
  });

  it('still appends when the file is NOT sorted, rather than tidying it', () => {
    // 36 shipped descriptors are unsorted (Foundation, SCMControls, …).
    // Re-sorting a file to add one line to it is the larger diff.
    const unsorted = ['Retail', 'ApplicationSuite', 'Ledger'];
    const r = addModuleReference(realWorldDescriptor(unsorted), 'Tax');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(parseModuleReferences(r.xml)).toEqual([...unsorted, 'Tax']);
  });

  it('sorts a new FIRST entry to the front', () => {
    const r = addModuleReference(realWorldDescriptor(REAL_REFS), 'AccountsPayable');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(parseModuleReferences(r.xml)[0]).toBe('AccountsPayable');
  });

  it('appends a new LAST entry when nothing sorts after it', () => {
    const r = addModuleReference(realWorldDescriptor(REAL_REFS), 'Tax');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(parseModuleReferences(r.xml).at(-1)).toBe('Tax');
  });

  it('does not mistake the d2p1-declaring siblings for the list', () => {
    // <AppliedUpdates> and <ModelReferences> both declare xmlns:d2p1 and both
    // self-close — the element regex must key on the NAME, not the namespace.
    const r = addModuleReference(realWorldDescriptor(REAL_REFS), 'Ledger');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(r.xml).toContain('<AppliedUpdates xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays" />');
    expect(r.xml).toContain('\t\ti:nil="true" />');
  });

  it('round-trips a real-world descriptor byte-for-byte', () => {
    const before = realWorldDescriptor(REAL_REFS);
    const added = addModuleReference(before, 'Ledger');
    if (added.kind !== 'added') throw new Error('expected added');
    const back = removeModuleReference(added.xml, 'Ledger');
    if (back.kind !== 'removed') throw new Error('expected removed');
    expect(back.xml).toBe(before);
  });
});

describe('removeModuleReference', () => {
  it('removes the whole line and leaves no blank behind', () => {
    const r = removeModuleReference(descriptor(['ApplicationSuite', 'Ledger', 'Tax']), 'Ledger');
    expect(r.kind).toBe('removed');
    if (r.kind !== 'removed') return;
    expect(r.removed).toBe('Ledger');
    expect(r.xml).toBe(descriptor(['ApplicationSuite', 'Tax']));
    expect(r.xml).not.toMatch(/\n[\t ]*\n/);
  });

  it('matches case-insensitively and reports the spelling that was in the file', () => {
    const r = removeModuleReference(descriptor(['ApplicationSuite']), 'APPLICATIONSUITE');
    expect(r.kind).toBe('removed');
    if (r.kind !== 'removed') return;
    expect(r.removed).toBe('ApplicationSuite');
    expect(parseModuleReferences(r.xml)).toEqual([]);
  });

  it('collapses to the self-closing form when its last entry goes', () => {
    // The shape a shipped descriptor with no references actually has — and what
    // makes add-then-remove byte-identical on a file that started empty.
    const r = removeModuleReference(descriptor(['Ledger']), 'Ledger');
    expect(r.kind).toBe('removed');
    if (r.kind !== 'removed') return;
    expect(r.xml).toBe(descriptor([]));
    expect(r.xml).toContain('<ModuleReferences />');
    expect(parseModuleReferences(r.xml)).toEqual([]);
  });

  it('reports what IS referenced when the module is not', () => {
    const r = removeModuleReference(descriptor(['ApplicationSuite', 'Ledger']), 'Tax');
    expect(r.kind).toBe('not-found');
    if (r.kind !== 'not-found') return;
    expect(r.present).toEqual(['ApplicationSuite', 'Ledger']);
  });

  it('reports a descriptor with no <ModuleReferences> element', () => {
    const bare = `<AxModelInfo>\n  <Name>Contoso</Name>\n</AxModelInfo>`;
    expect(removeModuleReference(bare, 'Ledger').kind).toBe('no-element');
  });
});

describe('add then remove is a round trip', () => {
  it('returns the file to byte-identical', () => {
    const before = descriptor(['ApplicationSuite', 'Ledger']);
    const added = addModuleReference(before, 'Tax');
    expect(added.kind).toBe('added');
    if (added.kind !== 'added') return;
    const back = removeModuleReference(added.xml, 'Tax');
    expect(back.kind).toBe('removed');
    if (back.kind !== 'removed') return;
    expect(back.xml).toBe(before);
  });
});

describe('findDescriptorPath', () => {
  let root: string;

  beforeAll(async () => {
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-write-')), 'PackagesLocalDirectory');
    const write = async (pkg: string, model: string) => {
      const dir = path.join(root, pkg, 'Descriptor');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${model}.xml`), descriptor(['Ledger']), 'utf-8');
    };
    await write('Contoso', 'Contoso');
    await write('IsvPackage', 'IsvModel');
  });

  afterAll(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it('finds a descriptor whose package shares its model name', () => {
    const found = findDescriptorPath(root, 'Contoso');
    expect(found?.packageName).toBe('Contoso');
    expect(found?.filePath).toBe(path.join(root, 'Contoso', 'Descriptor', 'Contoso.xml'));
  });

  it('finds a model that lives inside a differently named package', () => {
    // package == model is the common case, not the rule — a write that assumed
    // it would land on a path that does not exist.
    const found = findDescriptorPath(root, 'IsvModel');
    expect(found?.packageName).toBe('IsvPackage');
  });

  it('returns null for a model with no descriptor', () => {
    expect(findDescriptorPath(root, 'NoSuchModel')).toBeNull();
  });
});

describe('the preservation guard after a first module reference', () => {
  // modifyD365File runs every XML-only write through preserveDroppedProperties.
  // Its leaf scan did not recognise </d2p1:string>, so on a descriptor with no
  // entry anywhere before <ModuleReferences> the FIRST add pushed Publisher,
  // SolutionId and Version* one level deeper, the guard read them as dropped and
  // "restored" duplicates of them out of order — a corrupt descriptor under ✅.
  const bare = (moduleRefs: string) =>
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
    '\t<Name>Contoso</Name>\n' +
    '\t<ModelReferences i:nil="true" />\n' +
    moduleRefs +
    '\t<Publisher>Contoso</Publisher>\n' +
    '\t<SolutionId>00000000-0000-0000-0000-000000000000</SolutionId>\n' +
    '\t<VersionMajor>1</VersionMajor>\n' +
    '</AxModelInfo>';

  it.each([
    ['empty', '\t<ModuleReferences xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays" />\n'],
    ['nil', '\t<ModuleReferences xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"\n\t\ti:nil="true" />\n'],
  ])('restores nothing for an %s element', (_shape, moduleRefs) => {
    const before = bare(moduleRefs);
    const r = addModuleReference(before, 'ApplicationPlatform');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    const guarded = preserveDroppedProperties(before, r.xml, 'add-module-reference');
    expect(guarded.restored).toEqual([]);
    expect(guarded.xml.match(/<Publisher>/g)).toHaveLength(1);
  });
});

describe('InternalsVisibleTo — the same transforms on the other string list', () => {
  const ns = 'xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"';
  const withIv = (iv: string) =>
    `<AxModelInfo>\n  <Name>Contoso</Name>\n${iv}\n` +
    `  <ModuleReferences ${ns}>\n    <d2p1:string>Ledger</d2p1:string>\n  </ModuleReferences>\n</AxModelInfo>`;

  it('fills an empty self-closing list, keeping the namespace attribute', () => {
    const r = addModuleReference(withIv(`  <InternalsVisibleTo ${ns} />`), 'ContosoTests', 'InternalsVisibleTo');
    expect(r.kind).toBe('added');
    if (r.kind !== 'added') return;
    expect(r.xml).toContain(
      `  <InternalsVisibleTo ${ns}>\n    <d2p1:string>ContosoTests</d2p1:string>\n  </InternalsVisibleTo>`);
    // The sibling list is untouched.
    expect(parseModuleReferences(r.xml)).toEqual(['Ledger']);
  });

  it('inserts in sorted position, refuses a case-insensitive duplicate', () => {
    const xml = withIv(
      `  <InternalsVisibleTo ${ns}>\n    <d2p1:string>Alpha</d2p1:string>\n    <d2p1:string>Zulu</d2p1:string>\n  </InternalsVisibleTo>`);
    const r = addModuleReference(xml, 'ContosoTests', 'InternalsVisibleTo');
    expect(r.kind === 'added' && r.xml).toContain(
      'Alpha</d2p1:string>\n    <d2p1:string>ContosoTests</d2p1:string>\n    <d2p1:string>Zulu');
    expect(addModuleReference(xml, 'alpha', 'InternalsVisibleTo').kind).toBe('duplicate');
  });

  it('does not mistake a module reference for an internals entry', () => {
    const xml = withIv(`  <InternalsVisibleTo ${ns} />`);
    expect(removeModuleReference(xml, 'Ledger', 'InternalsVisibleTo').kind).toBe('not-found');
    expect(addModuleReference(xml, 'Ledger', 'InternalsVisibleTo').kind).toBe('added');
  });

  it('removing the last entry collapses back to the self-closing element (round trip)', () => {
    const empty = withIv(`  <InternalsVisibleTo ${ns} />`);
    const added = addModuleReference(empty, 'ContosoTests', 'InternalsVisibleTo');
    if (added.kind !== 'added') throw new Error('add failed');
    const removed = removeModuleReference(added.xml, 'ContosoTests', 'InternalsVisibleTo');
    expect(removed.kind === 'removed' && removed.xml).toBe(empty);
  });

  it('reports a descriptor with no <InternalsVisibleTo> instead of inventing one', () => {
    const none = `<AxModelInfo>\n  <Name>Contoso</Name>\n</AxModelInfo>`;
    expect(addModuleReference(none, 'ContosoTests', 'InternalsVisibleTo').kind).toBe('no-element');
    expect(removeModuleReference(none, 'ContosoTests', 'InternalsVisibleTo').kind).toBe('no-element');
  });
});
