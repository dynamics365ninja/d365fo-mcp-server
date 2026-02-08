/**
 * Azure Blob Storage Metadata Manager
 * Manages separation of standard and custom metadata in Azure Blob Storage
 */

import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { isCustomModel } from '../src/utils/modelClassifier.js';

const AZURE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
const BLOB_CONTAINER = process.env.BLOB_CONTAINER_NAME || 'xpp-metadata';
const LOCAL_METADATA_PATH = process.env.METADATA_PATH || './extracted-metadata';

// Concurrency limit to avoid EMFILE errors (too many open files)
const MAX_CONCURRENT_UPLOADS = 50;

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
    await this.containerClient.createIfNotExists();
    console.log('✅ Container ready');
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
        
        console.log(`   📂 Queuing model: ${modelName} → ${targetPrefix}/${modelName}`);
        
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
    console.log(`\n🚀 Starting parallel upload of ${uploadPromises.length} models...`);
    const results = await Promise.all(uploadPromises);
    
    // Calculate total and log results
    const uploadCount = results.reduce((sum, r) => sum + r.count, 0);
    results.forEach(r => {
      if (r.count > 0) {
        console.log(`   ✅ ${r.modelName}: ${r.count} files`);
      }
    });
    
    console.log(`\n✅ Upload complete! Total files: ${uploadCount}`);
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
      
      const blobs = this.containerClient.listBlobsFlat({ prefix });
      
      for await (const blob of blobs) {
        // Check if we should download this specific model
        if (specificModels && specificModels.length > 0) {
          const modelName = this.extractModelNameFromBlobPath(blob.name);
          if (modelName && !specificModels.includes(modelName)) {
            continue;
          }
        }
        
        try {
          const relativePath = blob.name.replace(/^metadata\/(standard|custom)\//, '');
          const localFilePath = path.join(LOCAL_METADATA_PATH, relativePath);
          
          // Create directory structure
          await fs.mkdir(path.dirname(localFilePath), { recursive: true });
          
          // Download blob
          const blobClient = this.containerClient.getBlobClient(blob.name);
          await blobClient.downloadToFile(localFilePath);
          
          downloadCount++;
          
          if (downloadCount % 100 === 0) {
            console.log(`   📄 Downloaded ${downloadCount} files...`);
          }
        } catch (error) {
          console.error(`   ❌ Error downloading ${blob.name}:`, error);
        }
      }
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
        
        if (deleteCount % 50 === 0) {
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
    console.log('\n📤 Uploading compiled database to Azure Blob Storage');
    
    const blobName = 'database/xpp-metadata.db';
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    
    const uploadBlobResponse = await blockBlobClient.uploadFile(dbPath, {
      blobHTTPHeaders: {
        blobContentType: 'application/x-sqlite3'
      },
      metadata: {
        uploadDate: new Date().toISOString(),
        version: '1.0'
      }
    });
    
    console.log(`✅ Database uploaded successfully`);
    console.log(`   Request ID: ${uploadBlobResponse.requestId}`);
    console.log(`   Blob URL: ${blockBlobClient.url}`);
  }

  /**
   * Download compiled database from blob storage
   */
  async downloadDatabase(localDbPath: string): Promise<void> {
    console.log('\n📥 Downloading compiled database from Azure Blob Storage');
    
    const blobName = 'database/xpp-metadata.db';
    const blobClient = this.containerClient.getBlobClient(blobName);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(localDbPath), { recursive: true });
    
    await blobClient.downloadToFile(localDbPath);
    
    console.log('✅ Database downloaded successfully');
    console.log(`   Local path: ${localDbPath}`);
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
        // Create upload task (not executed yet)
        uploadTasks.push(async () => {
          try {
            const blockBlobClient = this.containerClient.getBlockBlobClient(blobPath);
            await blockBlobClient.uploadFile(localPath);
            return 1;
          } catch (error) {
            console.error(`   ❌ Error uploading ${localPath}:`, error);
            return 0;
          }
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
      
      // Log progress for large batches
      if (tasks.length > 100 && i > 0 && i % 100 === 0) {
        console.log(`   📊 Progress: ${i}/${tasks.length} files processed`);
      }
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
  const args = process.argv.slice(2);
  const command = args[0];
  
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}
