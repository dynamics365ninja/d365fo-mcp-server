/**
 * Test script for create_d365fo_file tool
 * Run: node test-create-file.js
 */

import { handleCreateD365File } from './dist/tools/createD365File.js';

async function test() {
  console.log('Testing create_d365fo_file tool...\n');

  const request = {
    method: 'tools/call',
    params: {
      name: 'create_d365fo_file',
      arguments: {
        objectType: 'class',
        objectName: 'TestDebugClass',
        modelName: 'CustomCore',
        addToProject: false, // Start without project to isolate XML generation issue
      },
    },
  };

  try {
    const result = await handleCreateD365File(request);
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('\n=== ERROR ===');
    console.error(error);
  }
}

test();
