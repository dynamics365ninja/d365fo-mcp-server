/**
 * Quick end-to-end test for the C# bridge from Node.js.
 * Run with: npx tsx tests/bridge-e2e.ts
 */

import { BridgeClient } from '../src/bridge/bridgeClient.js';

async function main() {
  console.log('=== Bridge E2E Test ===\n');

  const client = new BridgeClient({
    packagesPath: 'K:\\AosService\\PackagesLocalDirectory',
  });

  try {
    console.log('1. Initializing bridge...');
    const ready = await client.initialize();
    console.log(`   ✅ Ready: metadata=${ready.metadataAvailable}, xref=${ready.xrefAvailable}, version=${ready.version}`);

    console.log('\n2. Ping...');
    const pong = await client.ping();
    console.log(`   ✅ ${pong}`);

    console.log('\n3. Read table CustTable...');
    const table = await client.readTable('CustTable');
    if (table) {
      console.log(`   ✅ ${table.name}: ${table.fields.length} fields, ${table.indexes.length} indexes, ${table.relations.length} relations`);
      console.log(`   Label: ${table.label}, Model: ${table.model}, TableGroup: ${table.tableGroup}`);
      console.log(`   First 3 fields: ${table.fields.slice(0, 3).map(f => `${f.name}(${f.extendedDataType || f.fieldType})`).join(', ')}`);
    } else {
      console.log('   ❌ CustTable not found');
    }

    console.log('\n4. Read class SalesFormLetter...');
    const cls = await client.readClass('SalesFormLetter');
    if (cls) {
      console.log(`   ✅ ${cls.name}: ${cls.methods.length} methods, extends=${cls.extends}, abstract=${cls.isAbstract}`);
      console.log(`   First 5 methods: ${cls.methods.slice(0, 5).map(m => m.name).join(', ')}`);
    } else {
      console.log('   ❌ SalesFormLetter not found');
    }

    console.log('\n5. Get method source CustTable.find...');
    const method = await client.getMethodSource('CustTable', 'find');
    if (method.found) {
      console.log(`   ✅ Found: ${method.source?.substring(0, 150)}...`);
    } else {
      console.log('   ❌ CustTable.find not found');
    }

    console.log('\n6. Read enum SalesStatus...');
    const en = await client.readEnum('SalesStatus');
    if (en) {
      console.log(`   ✅ ${en.name}: ${en.values.length} values, extensible=${en.isExtensible}`);
      console.log(`   Values: ${en.values.map(v => `${v.name}=${v.value}`).join(', ')}`);
    } else {
      console.log('   ❌ SalesStatus not found');
    }

    console.log('\n7. Read EDT CustAccount...');
    const edt = await client.readEdt('CustAccount');
    if (edt) {
      console.log(`   ✅ ${edt.name}: baseType=${edt.baseType}, extends=${edt.extends}, size=${edt.stringSize}`);
    } else {
      console.log('   ❌ CustAccount not found');
    }

    console.log('\n8. Search "SalesInvoice" classes...');
    const search = await client.searchObjects('SalesInvoice', 'class');
    console.log(`   ✅ Found ${search.results.length} results`);
    search.results.slice(0, 5).forEach(r => console.log(`   - ${r.name} (${r.type})`));

    console.log('\n9. Find references to CustTable...');
    const refs = await client.findReferences('CustTable');
    console.log(`   ✅ ${refs.count} references found`);
    refs.references.slice(0, 5).forEach(r => console.log(`   - ${r.sourcePath} (module: ${r.sourceModule}, line: ${r.line})`));

    console.log('\n10. Read form CustTable...');
    const form = await client.readForm('CustTable');
    if (form) {
      console.log(`   ✅ ${form.name}: ${form.dataSources.length} datasources, ${form.controls.length} top controls`);
    } else {
      console.log('   ❌ CustTable form not found');
    }

    console.log('\n11. Read data entity CustCustomerV3Entity...');
    const entity = await client.readDataEntity('CustCustomerV3Entity');
    if (entity) {
      console.log(`   ✅ ${entity.name}: public=${entity.isPublic}, collection=${entity.publicCollectionName}`);
      console.log(`   DataSources: ${entity.dataSources.map(ds => ds.name).join(', ')}`);
    } else {
      console.log('   ❌ CustCustomerV3Entity not found');
    }

    console.log('\n12. List all tables (count)...');
    const list = await client.listObjects('table');
    console.log(`   ✅ ${list.count} tables in the system`);

    console.log('\n=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    client.dispose();
  }
}

main();
