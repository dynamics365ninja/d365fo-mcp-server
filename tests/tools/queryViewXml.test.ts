/**
 * buildAxQueryXml / buildAxViewXml (src/tools/queryViewXml.ts).
 *
 * Regression: eval/corpus/runs/2026-07-06T18__L1-query-view-basic__cb1b73d.json
 * — `query` had NO entry at all in the d365fo_file properties documentation
 * (same gap already found and fixed for `map`), so a caller reasonably
 * guessed `table` (mirroring data-entity's `primaryTable` convention)
 * instead of the actual `dataSource` key buildAxQueryXml read — the query's
 * root datasource was silently never created, leaving an inert
 * classDeclaration-only skeleton that reported success.
 */

import { describe, it, expect } from 'vitest';
import { buildAxQueryXml, buildAxViewXml } from '../../src/tools/queryViewXml';

describe('buildAxQueryXml — root datasource property name', () => {
  it('creates a root datasource from the documented `dataSource` key (existing behaviour, unchanged)', () => {
    const xml = buildAxQueryXml('ConDemoNoteQuery', {
      dataSource: 'ConDemoNoteHeader',
      fields: [{ name: 'NoteId' }],
    });
    expect(xml).toContain('<Table>ConDemoNoteHeader</Table>');
    expect(xml).toContain('<AxQuerySimpleRootDataSource>');
  });

  it('ALSO creates a root datasource from `table` (the guessed alias) — regression', () => {
    const xml = buildAxQueryXml('ConDemoNoteQuery', {
      table: 'ConDemoNoteHeader',
      fields: [{ name: 'NoteId' }],
    });
    expect(xml).toContain('<Table>ConDemoNoteHeader</Table>');
    expect(xml).toContain('<AxQuerySimpleRootDataSource>');
  });

  it('dataSource wins when both are somehow given', () => {
    const xml = buildAxQueryXml('ConDemoNoteQuery', {
      dataSource: 'ConDemoNoteHeader',
      table: 'SomeOtherTable',
      fields: [{ name: 'NoteId' }],
    });
    expect(xml).toContain('<Table>ConDemoNoteHeader</Table>');
    expect(xml).not.toContain('SomeOtherTable');
  });

  it('emits an inert <DataSources /> skeleton when neither key is given (unchanged)', () => {
    const xml = buildAxQueryXml('ConDemoNoteQuery', {});
    expect(xml).toContain('<DataSources />');
  });

  it('dataSourceName defaults to the resolved table name (via either key)', () => {
    const xml = buildAxQueryXml('ConDemoNoteQuery', {
      table: 'ConDemoNoteHeader',
      fields: [{ name: 'NoteId' }],
    });
    expect(xml).toContain('<Name>ConDemoNoteHeader</Name>');
  });
});

describe('buildAxViewXml — documented shape (already correct, regression-guard)', () => {
  it('builds a view from query + fields', () => {
    const xml = buildAxViewXml('ConDemoNoteView', {
      query: 'ConDemoNoteQuery',
      fields: [{ name: 'NoteId' }, { name: 'Subject', dataField: 'Subject' }],
    });
    expect(xml).toContain('<Query>ConDemoNoteQuery</Query>');
    expect(xml).toContain('<DataSource>ConDemoNoteQuery</DataSource>');
    expect(xml).toContain('<DataField>Subject</DataField>');
  });

  it('emits an inert skeleton when query/fields are missing (unchanged)', () => {
    const xml = buildAxViewXml('ConDemoNoteView', {});
    expect(xml).toContain('<Fields />');
    expect(xml).not.toContain('<Query>');
  });
});
