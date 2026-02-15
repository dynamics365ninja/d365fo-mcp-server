import 'dotenv/config';
import * as fs from 'fs/promises';
import { XppMetadataParser } from '../../src/metadata/xmlParser.js';

const testFile = 'K:\\AOSService\\PackagesLocalDirectory\\ApplicationFoundation\\ApplicationFoundation\\AxClass\\AifChangeTrackingEntityMetadataUpdateEventHandler.xml';

async function test() {
  console.log('Reading:', testFile);
  const parser = new XppMetadataParser();
  const result = await parser.parseClassFile(testFile, 'ApplicationFoundation');
  
  console.log('Success:', result.success);
  console.log('Error:', result.error);
  console.log('Data:', JSON.stringify(result.data, null, 2));
  
  // Also read the raw XML to see structure
  const raw = await fs.readFile(testFile, 'utf-8');
  console.log('\n--- First 2000 chars of XML ---');
  console.log(raw.substring(0, 2000));
}

test().catch(console.error);
