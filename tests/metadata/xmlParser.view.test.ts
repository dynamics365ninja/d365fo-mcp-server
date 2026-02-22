import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { XppMetadataParser } from '../../src/metadata/xmlParser.js';

describe('XppMetadataParser parseViewFile', () => {
  it('parses AxDataEntityView metadata including fields and relations', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xml-parser-view-'));
    const xmlPath = path.join(tempDir, 'TestEntity.xml');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>TestEntity</Name>
  <Label>@Test:TestEntityLabel</Label>
  <IsPublic>Yes</IsPublic>
  <IsReadOnly>No</IsReadOnly>
  <PrimaryKey>PrimaryIndex</PrimaryKey>
  <Keys>
    <AxDataEntityViewKey>
      <Name>PrimaryIndex</Name>
      <Fields>
        <AxDataEntityViewKeyField>
          <DataField>AccountNum</DataField>
        </AxDataEntityViewKeyField>
      </Fields>
    </AxDataEntityViewKey>
  </Keys>
  <Fields>
    <AxDataEntityViewField>
      <Name>AccountNum</Name>
      <DataSource>CustTable</DataSource>
      <DataField>AccountNum</DataField>
      <Label>@SYS12345</Label>
    </AxDataEntityViewField>
    <AxDataEntityViewField>
      <Name>DisplayName</Name>
      <DataMethod>computeDisplayName</DataMethod>
      <Label>@Test:DisplayNameLabel</Label>
    </AxDataEntityViewField>
  </Fields>
  <Relations>
    <AxDataEntityViewRelation>
      <Name>CustRelation</Name>
      <RelatedDataEntity>CustCustomerV3Entity</RelatedDataEntity>
      <RelationType>Association</RelationType>
      <Cardinality>ZeroOne</Cardinality>
      <Fields>
        <AxDataEntityViewRelationField>
          <DataField>AccountNum</DataField>
          <RelatedDataField>CustomerAccount</RelatedDataField>
        </AxDataEntityViewRelationField>
      </Fields>
    </AxDataEntityViewRelation>
  </Relations>
  <SourceCode>
    <Methods>
      <Method>
        <Name>computeDisplayName</Name>
        <Source><![CDATA[public str computeDisplayName() { return ''; }]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxDataEntityView>`;

    await fs.writeFile(xmlPath, xml, 'utf-8');

    const parser = new XppMetadataParser();
    const result = await parser.parseViewFile(xmlPath, 'TestModel');

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.name).toBe('TestEntity');
    expect(result.data?.type).toBe('data-entity');
    expect(result.data?.fields.length).toBe(2);
    expect(result.data?.primaryKeyFields).toEqual(['AccountNum']);
    expect(result.data?.fields.find(f => f.name === 'AccountNum')?.labelId).toBe('@SYS12345');
    expect(result.data?.fields.find(f => f.name === 'DisplayName')?.labelId).toBe('@Test:DisplayNameLabel');
    expect(result.data?.fields.find(f => f.name === 'DisplayName')?.isComputed).toBe(true);
    expect(result.data?.relations.length).toBe(1);
    expect(result.data?.relations[0].fields).toEqual([
      { field: 'AccountNum', relatedField: 'CustomerAccount' },
    ]);
    expect(result.data?.methods.length).toBe(1);
  });
});
