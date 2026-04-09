/**
 * Azure Blob Storage Metadata Manager
 * Manages separation of standard and custom metadata in Azure Blob Storage
 */

console.log('📦 Loading azure-blob-manager.ts...');

import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import * as fs from 'fs/promises';
import * as path from 'path';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { isCustomModel } from '../src/utils/modelClassifier.js';

console.log('✅ Imports loaded');
console.log(`🔑 Connection string configured: ${process.env.AZURE_STORAGE_CONNECTION_STRING ? 'YES' : 'NO'}`);

const AZURE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
const BLOB_CONTAINER = process.env.BLOB_CONTAINER_NAME || 'xpp-metadata';
const LOCAL_METADATA_PATH = process.env.METADATA_PATH || './extracted-metadata';

console.log(`📦 Container: ${BLOB_CONTAINER}`);
console.log(`📁 Local path: ${LOCAL_METADATA_PATH}`);

// Concurrency limit for uploads — keep low to avoid ECONNREFUSED / throttling
const MAX_CONCURRENT_UPLOADS = 5;
// Downloads can go higher — Azure Blob Storage handles parallel GETs well
const MAX_CONCURRENT_DOWNLOADS = 64;

// Retry settings for transient network errors (ECONNREFUSED, ETIMEDOUT, 503, 500)
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;

// Blob structure:
// /metadata/standard/{ModelName}/...  - Standard metadata (změna párkrát ročně)
// /metadata/custom/{ModelName}/...    - Custom metadata (denní změny)
// /databases/xpp-metadata-latest.db   - Compiled database

interface BlobManagerOptions {
  operation: 'upload' | 'download' | 'delete-custom' | 'sync';
  modelType?: 'standard' | 'custom' | 'all';
  specificModels?: string[];
}

export class AzureBlobMetadataManager {
  private blobServiceClient: BlobServiceClient;
  private containerClient: ContainerClient;

  constructor() {
    if (!AZURE_CONNECTION_STRING) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
    }
    
    this.blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_CONNECTION_STRING);
    this.containerClient = this.blobServiceClient.getContainerClient(BLOB_CONTAINER);
  }

  /**
   * Initialize blob container (create if not exists)
   */
  async initialize(): Promise<void> {
    console.log(`📦 Initializing container: ${BLOB_CONTAINER}`);
    try {
      await this.containerClient.createIfNotExists();
      console.log('✅ Container ready');
    } catch (error) {
      console.error('❌ Error initializing container:', error);
      throw error;
    }
  }

  /**
   * Upload metadata to blob storage
   * @param modelType - Type of models to upload: 'standard', 'custom', or 'all'
   * @param specificModels - Optional: Upload only specific models
   */
  async uploadMetadata(modelType: 'standard' | 'custom' | 'all', specificModels?: string[]): Promise<void> {
    console.log(`\n📤 Uploading ${modelType} metadata to Azure Blob Storage`);
    
    const localPath = LOCAL_METADATA_PATH;
    const models = specificModels || await this.getLocalModels();
    
    // Filter and prepare models for parallel upload
    const uploadPromises: Promise<{ modelName: string; count: number }>[] = [];
    let queuedCount = 0;
    
    for (const modelName of models) {
      const modelPath = path.join(localPath, modelName);
      
      try {
        const stats = await fs.stat(modelPath);
        if (!stats.isDirectory()) continue;
        
        // Determine target blob path based on model type
        const isCustomModel = await this.isCustomModel(modelName);
        const targetPrefix = isCustomModel ? 'metadata/custom' : 'metadata/standard';
        
        // Skip if not matching requested type
        if (modelType === 'custom' && !isCustomModel) continue;
        if (modelType === 'standard' && isCustomModel) continue;
        
        queuedCount++;
        
        // Add to parallel upload queue
        uploadPromises.push(
          this.uploadDirectory(modelPath, `${targetPrefix}/${modelName}`)
            .then(count => ({ modelName, count }))
            .catch(error => {
              console.error(`   ❌ Error uploading ${modelName}:`, error);
              return { modelName, count: 0 };
            })
        );
      } catch (error) {
        console.error(`   ❌ Error preparing ${modelName}:`, error);
      }
    }
    
    // Execute all uploads in parallel
    const results = await Promise.all(uploadPromises);
    
    // Calculate total and log summary (not every model to reduce log spam)
    const uploadCount = results.reduce((sum, r) => sum + r.count, 0);
    const successCount = results.filter(r => r.count > 0).length;
    
    console.log(`\n✅ Upload complete!`);
    console.log(`   Models uploaded: ${successCount}/${results.length}`);
    console.log(`   Total files: ${uploadCount}`);
  }

  /**
   * Download metadata from blob storage
   * @param modelType - Type of models to download: 'standard', 'custom', or 'all'
   * @param specificModels - Optional: Download only specific models
   */
  async downloadMetadata(modelType: 'standard' | 'custom' | 'all', specificModels?: string[]): Promise<void> {
    console.log(`\n📥 Downloading ${modelType} metadata from Azure Blob Storage`);
    
    const prefixes: string[] = [];
    if (modelType === 'all' || modelType === 'standard') {
      prefixes.push('metadata/standard/');
    }
    if (modelType === 'all' || modelType === 'custom') {
      prefixes.push('metadata/custom/');
    }
    
    let downloadCount = 0;
    
    for (const prefix of prefixes) {
      console.log(`\n   📁 Downloading from: ${prefix}`);
      console.log(`   🔍 Listing blobs with prefix: ${prefix}`);
      
      // First, collect all blobs to download
      const blobsToDownload: Array<{ name: string; size?: number }> = [];
      const blobs = this.containerClient.listBlobsFlat({ prefix });
      
      let scanCount = 0;
      for await (const blob of blobs) {
        scanCount++;
        
        // Log first few blobs for debugging
        if (scanCount <= 5) {
          console.log(`   📄 Found: ${blob.name}`);
        }
        
        // Check if we should download this specific model
        if (specificModels && specificModels.length > 0) {
          const modelName = this.extractModelNameFromBlobPath(blob.name);
          if (modelName && !specificModels.includes(modelName)) {
            continue;
          }
        }
        
        blobsToDownload.push({ name: blob.name, size: blob.properties.contentLength });
      }
      
      if (scanCount > 5) {
        console.log(`   ... (and ${scanCount - 5} more)`);
      }
      
      console.log(`   📊 Found ${blobsToDownload.length} files to download (scanned ${scanCount} blobs)`);
      
      if (blobsToDownload.length === 0) {
        console.log(`   ⚠️  No files found in ${prefix}`);
        continue;
      }
      
      // Download in parallel batches
      const downloadPromises: Promise<boolean>[] = [];
      let completed = 0;
      
      for (const blob of blobsToDownload) {
        const downloadTask = (async () => {
          try {
            const relativePath = blob.name.replace(/^metadata\/(standard|custom)\//, '');
            const localFilePath = path.join(LOCAL_METADATA_PATH, relativePath);
            
            // Create directory structure
            await fs.mkdir(path.dirname(localFilePath), { recursive: true });
            
            // Download blob
            const blobClient = this.containerClient.getBlobClient(blob.name);
            await blobClient.downloadToFile(localFilePath);
            
            completed++;
            
            return true;
          } catch (error) {
            console.error(`   ❌ Error downloading ${blob.name}:`, error);
            return false;
          }
        })();
        
        downloadPromises.push(downloadTask);
        
        // Process in batches to avoid overwhelming the system
        if (downloadPromises.length >= MAX_CONCURRENT_DOWNLOADS) {
          await Promise.all(downloadPromises);
          downloadCount += downloadPromises.length;
          downloadPromises.length = 0;
          
          // Log progress less frequently for large downloads
          if (blobsToDownload.length > 500 && completed % 500 === 0) {
            console.log(`   📄 Progress: ${completed}/${blobsToDownload.length} files`);
          }
        }
      }
      
      // Process remaining downloads
      if (downloadPromises.length > 0) {
        await Promise.all(downloadPromises);
        downloadCount += downloadPromises.length;
      }
      
      console.log(`   ✅ Completed: ${blobsToDownload.length} files`);
    }
    
    console.log(`\n✅ Download complete! Total files: ${downloadCount}`);
  }

  /**
   * Delete custom metadata from blob storage
   * This is used before re-extracting custom models to ensure clean state
   * @param specificModels - Optional: Delete only specific models
   */
  async deleteCustomMetadata(specificModels?: string[]): Promise<void> {
    console.log('\n🗑️  Deleting custom metadata from Azure Blob Storage');
    
    if (specificModels && specificModels.length > 0) {
      console.log(`   📋 Models to delete: ${specificModels.join(', ')}`);
    } else {
      console.log('   ⚠️  Deleting ALL custom metadata');
    }
    
    const prefix = 'metadata/custom/';
    const blobs = this.containerClient.listBlobsFlat({ prefix });
    
    let deleteCount = 0;
    
    for await (const blob of blobs) {
      // Check if we should delete this specific model
      if (specificModels && specificModels.length > 0) {
        const modelName = this.extractModelNameFromBlobPath(blob.name);
        if (modelName && !specificModels.includes(modelName)) {
          continue;
        }
      }
      
      try {
        const blobClient = this.containerClient.getBlobClient(blob.name);
        await blobClient.delete();
        deleteCount++;
        
        // Log progress every 500 files for large deletions
        if (deleteCount % 500 === 0) {
          console.log(`   🗑️  Deleted ${deleteCount} files...`);
        }
      } catch (error) {
        console.error(`   ❌ Error deleting ${blob.name}:`, error);
      }
    }
    
    console.log(`\n✅ Deletion complete! Total files deleted: ${deleteCount}`);
  }

  /**
   * Delete local custom metadata
   * This prepares the local environment for re-extraction
   */
  async deleteLocalCustomMetadata(specificModels?: string[]): Promise<void> {
    console.log('\n🗑️  Deleting local custom metadata');
    
    const customModels = specificModels || await this.getLocalCustomModels();
    
    for (const modelName of customModels) {
      const modelPath = path.join(LOCAL_METADATA_PATH, modelName);
      
      try {
        const stats = await fs.stat(modelPath);
        if (stats.isDirectory()) {
          console.log(`   🗑️  Deleting: ${modelName}`);
          await fs.rm(modelPath, { recursive: true, force: true });
        }
      } catch (error) {
        // Directory might not exist, which is fine
        console.warn(`   ⚠️  Could not delete ${modelName}:`, error);
      }
    }
    
    console.log('✅ Local custom metadata deleted');
  }

  /**
   * Upload compiled database to blob storage
   */
  async uploadDatabase(dbPath: string): Promise<void> {
    console.log('\n📤 Uploading compiled databases to Azure Blob Storage');
    
    // Upload main symbols database
    const mainBlobName = 'database/xpp-metadata.db';
    const mainBlockBlobClient = this.containerClient.getBlockBlobClient(mainBlobName);
    
    console.log('   📦 Uploading symbols database...');
    const mainUploadResponse = await mainBlockBlobClient.uploadFile(dbPath, {
      blobHTTPHeaders: {
        blobContentType: 'application/x-sqlite3'
      },
      metadata: {
        uploadDate: new Date().toISOString(),
        version: '1.0',
        type: 'symbols'
      }
    });
    
    console.log(`   ✅ Symbols database uploaded`);
    console.log(`      Request ID: ${mainUploadResponse.requestId}`);
    
    // Upload labels database (if exists)
    const labelsDbPath = dbPath.replace('.db', '-labels.db');
    if (await fs.access(labelsDbPath).then(() => true).catch(() => false)) {
      const labelsBlobName = 'database/xpp-metadata-labels.db';
      const labelsBlockBlobClient = this.containerClient.getBlockBlobClient(labelsBlobName);
      
      console.log('   📦 Uploading labels database...');
      const labelsUploadResponse = await labelsBlockBlobClient.uploadFile(labelsDbPath, {
        blobHTTPHeaders: {
          blobContentType: 'application/x-sqlite3'
        },
        metadata: {
          uploadDate: new Date().toISOString(),
          version: '1.0',
          type: 'labels'
        }
      });
      
      console.log(`   ✅ Labels database uploaded`);
      console.log(`      Request ID: ${labelsUploadResponse.requestId}`);
    } else {
      console.log('   ⚠️  Labels database not found, skipping');
    }
    
    console.log('\n✅ Database upload complete!');
  }

  /**
   * Download compiled database from blob storage
   */
  async downloadDatabase(localDbPath: string): Promise<void> {
    console.log('\n📥 Downloading compiled databases from Azure Blob Storage');
    
    // Download main symbols database
    const mainBlobName = 'database/xpp-metadata.db';
    const mainBlobClient = this.containerClient.getBlobClient(mainBlobName);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(localDbPath), { recursive: true });
    
    console.log('   📦 Downloading symbols database...');
    await mainBlobClient.downloadToFile(localDbPath);
    console.log(`   ✅ Symbols database downloaded`);
    console.log(`      Local path: ${localDbPath}`);
    
    // Download labels database (if exists)
    const labelsBlobName = 'database/xpp-metadata-labels.db';
    const labelsBlobClient = this.containerClient.getBlobClient(labelsBlobName);
    const labelsDbPath = localDbPath.replace('.db', '-labels.db');
    
    try {
      console.log('   📦 Downloading labels database...');
      await labelsBlobClient.downloadToFile(labelsDbPath);
      console.log(`   ✅ Labels database downloaded`);
      console.log(`      Local path: ${labelsDbPath}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        console.log('   ⚠️  Labels database not found in blob storage (might be old format)');
      } else {
        throw error;
      }
    }
    
    console.log('\n✅ Database download complete!');
  }

  /**
   * Helper: Upload directory recursively with controlled parallel file uploads
   */
  private async uploadDirectory(localDir: string, blobPrefix: string): Promise<number> {
    const entries = await fs.readdir(localDir, { withFileTypes: true });
    const uploadTasks: Array<() => Promise<number>> = [];
    
    for (const entry of entries) {
      const localPath = path.join(localDir, entry.name);
      const blobPath = `${blobPrefix}/${entry.name}`;
      
      if (entry.isDirectory()) {
        // Recursively upload subdirectories (controlled parallelism at file level)
        uploadTasks.push(() => this.uploadDirectory(localPath, blobPath));
      } else {
        // Create upload task with retry logic
        uploadTasks.push(async () => {
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
              await blockBlobClient.uploadFile(localPath);
              return 1;
            } catch (error: any) {
              const isTransient =
                error.code === 'ECONNREFUSED' ||
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ENOTFOUND' ||
                error.statusCode === 500 ||
                error.statusCode === 503;

              if (isTransient && attempt < MAX_RETRIES) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.warn(`   ⚠️  Transient error uploading ${blobPath} (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${error.code || error.statusCode}`);
                await new Promise(resolve => setTimeout(resolve, delay));
              } else {
                console.error(`   ❌ Error uploading ${blobPath}:`, error);
                return 0;
              }
            }
          }
          return 0;
        });
      }
    }
    
    // Execute tasks with controlled concurrency
    return await this.executeBatch(uploadTasks, MAX_CONCURRENT_UPLOADS);
  }

  /**
   * Helper: Execute promises in batches with controlled concurrency
   */
  private async executeBatch<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number
  ): Promise<T extends number ? number : T[]> {
    const results: T[] = [];
    
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(task => task()));
      results.push(...batchResults);
    }
    
    // Sum if results are numbers, otherwise return array
    if (typeof results[0] === 'number') {
      return results.reduce((sum: number, val) => sum + (val as number), 0) as any;
    }
    return results as any;
  }

  /**
   * Helper: Get all local models
   */
  private async getLocalModels(): Promise<string[]> {
    try {
      const entries = await fs.readdir(LOCAL_METADATA_PATH, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Helper: Get local custom models
   */
  private async getLocalCustomModels(): Promise<string[]> {
    const allModels = await this.getLocalModels();
    const customModels: string[] = [];
    
    for (const model of allModels) {
      if (await this.isCustomModel(model)) {
        customModels.push(model);
      }
    }
    
    return customModels;
  }

  /**
   * Helper: Determine if model is custom or standard
   */
  private async isCustomModel(modelName: string): Promise<boolean> {
    const customModelsEnv = process.env.CUSTOM_MODELS?.split(',').map(m => m.trim()) || [];
    const extensionPrefix = process.env.EXTENSION_PREFIX || '';
    
    // Check if explicitly listed as custom
    if (customModelsEnv.includes(modelName)) {
      return true;
    }
    
    // Check if starts with extension prefix
    if (extensionPrefix && modelName.startsWith(extensionPrefix)) {
      return true;
    }
    
    // Check against standard models list
    return isCustomModel(modelName);
  }

  /**
   * Helper: Extract model name from blob path
   */
  private extractModelNameFromBlobPath(blobPath: string): string | null {
    // Extract model name from path like: metadata/custom/ModelName/...
    const match = blobPath.match(/^metadata\/(standard|custom)\/([^/]+)/);
    return match ? match[2] : null;
  }
}

// CLI Interface
async function main() {
  console.log('🚀 Azure Blob Metadata Manager');
  console.log(`📋 Command: ${process.argv.slice(2).join(' ')}`);
  
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command) {
    console.log('Usage:');
    console.log('  npm run blob-manager upload-standard     # Upload standard metadata');
    console.log('  npm run blob-manager upload-custom       # Upload custom metadata');
    console.log('  npm run blob-manager upload-all          # Upload all metadata');
    console.log('  npm run blob-manager download-standard   # Download standard metadata');
    console.log('  npm run blob-manager download-custom     # Download custom metadata');
    console.log('  npm run blob-manager download-all        # Download all metadata');
    console.log('  npm run blob-manager delete-custom       # Delete custom metadata from blob');
    console.log('  npm run blob-manager delete-custom Model1,Model2  # Delete specific models');
    console.log('  npm run blob-manager delete-local-custom # Delete local custom metadata');
    console.log('  npm run blob-manager upload-database     # Upload compiled database');
    console.log('  npm run blob-manager download-database   # Download compiled database');
    process.exit(1);
  }
  
  console.log(`\n🔧 Initializing Azure Blob Storage...`);
  const manager = new AzureBlobMetadataManager();
  await manager.initialize();
  
  switch (command) {
    case 'upload-standard':
      await manager.uploadMetadata('standard');
      break;
      
    case 'upload-custom':
      await manager.uploadMetadata('custom');
      break;
      
    case 'upload-all':
      await manager.uploadMetadata('all');
      break;
      
    case 'download-standard':
      await manager.downloadMetadata('standard');
      break;
      
    case 'download-custom':
      await manager.downloadMetadata('custom');
      break;
      
    case 'download-all':
      await manager.downloadMetadata('all');
      break;
      
    case 'delete-custom':
      const modelsToDelete = args[1]?.split(',').map(m => m.trim());
      await manager.deleteCustomMetadata(modelsToDelete);
      break;
      
    case 'delete-local-custom':
      const localModelsToDelete = args[1]?.split(',').map(m => m.trim());
      await manager.deleteLocalCustomMetadata(localModelsToDelete);
      break;
      
    case 'upload-database':
      const dbPath = args[1] || process.env.DB_PATH || './data/xpp-metadata.db';
      await manager.uploadDatabase(dbPath);
      break;
      
    case 'download-database':
      const localDbPath = args[1] || process.env.DB_PATH || './data/xpp-metadata.db';
      await manager.downloadDatabase(localDbPath);
      break;
      
    default:
      console.log('Usage:');
      console.log('  npm run blob-manager upload-standard     # Upload standard metadata');
      console.log('  npm run blob-manager upload-custom       # Upload custom metadata');
      console.log('  npm run blob-manager upload-all          # Upload all metadata');
      console.log('  npm run blob-manager download-standard   # Download standard metadata');
      console.log('  npm run blob-manager download-custom     # Download custom metadata');
      console.log('  npm run blob-manager download-all        # Download all metadata');
      console.log('  npm run blob-manager delete-custom       # Delete custom metadata from blob');
      console.log('  npm run blob-manager delete-custom Model1,Model2  # Delete specific models');
      console.log('  npm run blob-manager delete-local-custom # Delete local custom metadata');
      console.log('  npm run blob-manager upload-database     # Upload compiled database');
      console.log('  npm run blob-manager download-database   # Download compiled database');
      process.exit(1);
  }
}

// Normalize path for cross-platform compatibility (Windows uses backslashes)
const scriptPath = process.argv[1]?.replace(/\\/g, '/');
const isMainModule = import.meta.url === `file:///${scriptPath}` || import.meta.url === `file://${scriptPath}`;

console.log(`📍 import.meta.url: ${import.meta.url}`);
console.log(`📍 process.argv[1]: ${scriptPath}`);
console.log(`📍 Is main module: ${isMainModule}`);

if (isMainModule) {
  console.log('✅ Running as main module, calling main()');
  main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
} else {
  console.log('ℹ️  Loaded as module (not executing main)');
}
