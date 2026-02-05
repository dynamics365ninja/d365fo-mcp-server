/**
 * Debug parser to test XML parsing
 */

import * as fs from 'fs/promises';
import { Parser } from 'xml2js';

async function debugParse() {
  const parser = new Parser({
    explicitArray: false,
    mergeAttrs: true,
    trim: true,
  });

  const filePath = 'K:\\AOSService\\PackagesLocalDirectory\\ApplicationSuite\\Foundation\\AxClass\\AdvanceInvoiceContract_W.xml';
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = await parser.parseStringPromise(content);

    console.log('=== Parsed Structure ===');
    console.log('AxClass exists:', !!parsed.AxClass);
    console.log('Name:', parsed.AxClass?.Name);
    console.log('SourceCode exists:', !!parsed.AxClass?.SourceCode);
    console.log('SourceCode.Methods exists:', !!parsed.AxClass?.SourceCode?.Methods);
    console.log('SourceCode.Methods.Method type:', typeof parsed.AxClass?.SourceCode?.Methods?.Method);
    console.log('SourceCode.Methods.Method is array:', Array.isArray(parsed.AxClass?.SourceCode?.Methods?.Method));
    
    if (parsed.AxClass?.SourceCode?.Methods?.Method) {
      const methods = Array.isArray(parsed.AxClass.SourceCode.Methods.Method) 
        ? parsed.AxClass.SourceCode.Methods.Method 
        : [parsed.AxClass.SourceCode.Methods.Method];
      
      console.log('\n=== First Method ===');
      console.log('Count:', methods.length);
      console.log('First method:', JSON.stringify(methods[0], null, 2));
    }

    // Try alternative path
    console.log('\n=== Alternative Path ===');
    console.log('axClass.Methods exists:', !!parsed.AxClass?.Methods);
    console.log('axClass.Methods.Method exists:', !!parsed.AxClass?.Methods?.Method);

  } catch (error) {
    console.error('Error:', error);
  }
}

debugParse();
