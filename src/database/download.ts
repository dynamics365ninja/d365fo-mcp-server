/**
 * Azure Blob Storage Database Download Utility
 * Downloads SQLite database from Azure Blob Storage on startup
 */

import { BlobServiceClient } from '@azure/storage-blob';
import * as fs from 'fs/promises';
import * as path from 'path';
import Database from 'better-sqlite3';

interface DownloadOptions {
  connectionString?: string;
  containerName?: string;
  blobName?: string;
  localPath?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Validate SQLite database integrity
 */
async function validateDatabase(filePath: string): Promise<boolean> {
  try {
    const db = new Database(filePath, { readonly: true });
    // Run integrity check
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    db.close();
    
    return result.length === 1 && result[0].integrity_check === 'ok';
  } catch (error) {
    console.error(`   Database validation failed:`, error);
    return false;
  }
}

/**
 * Sleep helper for retries
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function downloadDatabaseFromBlob(options?: DownloadOptions): Promise<string> {
  const connectionString = options?.connectionString || process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = options?.containerName || process.env.BLOB_CONTAINER_NAME || 'xpp-metadata';
  const blobName = options?.blobName || process.env.BLOB_DATABASE_NAME || 'databases/xpp-metadata-latest.db';
  const localPath = options?.localPath || process.env.DB_PATH || './data/xpp-metadata.db';
  const maxRetries = options?.maxRetries || 3;
  const timeoutMs = options?.timeoutMs || 300000; // 5 minutes default

  if (!connectionString) {
    throw new Error('Azure Storage connection string not configured');
  }

  console.log(`📥 Downloading database from blob storage...`);
  console.log(`   Container: ${containerName}`);
  console.log(`   Blob: ${blobName}`);
  console.log(`   Local path: ${localPath}`);
  console.log(`   Timeout: ${timeoutMs / 1000}s`);

  // Ensure directory exists
  const dir = path.dirname(localPath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${localPath}.tmp`;
  
  // Retry loop
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`   Attempt ${attempt}/${maxRetries}...`);
      
      // Clean up temp file if exists
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore if doesn't exist
      }

      // Create blob service client
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      // Check if blob exists
      const exists = await blobClient.exists();
      if (!exists) {
        throw new Error(`Blob "${blobName}" not found in container "${containerName}"`);
      }

      // Get blob properties
      const properties = await blobClient.getProperties();
      const sizeInMB = ((properties.contentLength || 0) / (1024 * 1024)).toFixed(2);
      console.log(`   Size: ${sizeInMB} MB`);

      // Download to temporary file with timeout
      const startTime = Date.now();
      const downloadPromise = blobClient.downloadToFile(tmpPath, 0, undefined, {
        maxRetryRequests: 5,
      });
      
      // Race against timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Download timeout')), timeoutMs)
      );
      
      await Promise.race([downloadPromise, timeoutPromise]);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`   Downloaded in ${duration}s`);

      // Validate database integrity
      console.log(`   Validating database integrity...`);
      const isValid = await validateDatabase(tmpPath);
      
      if (!isValid) {
        throw new Error('Downloaded database is corrupted (failed integrity check)');
      }
      
      console.log(`   ✅ Database validation passed`);

      // Atomic move: rename temp to final
      await fs.rename(tmpPath, localPath);
      
      console.log(`✅ Database downloaded successfully`);
      return localPath;
      
    } catch (error) {
      console.error(`   ❌ Attempt ${attempt} failed:`, error);
      
      // Clean up temp file
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      
      // If this was the last attempt, also clean up potentially corrupted final file
      if (attempt === maxRetries) {
        console.log(`   🧹 Cleaning up potentially corrupted database file...`);
        try {
          await fs.unlink(localPath);
        } catch {
          // Ignore if doesn't exist
        }
        throw error;
      }
      
      // Wait before retry with exponential backoff
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`   ⏳ Retrying in ${backoffMs / 1000}s...`);
      await sleep(backoffMs);
    }
  }

  throw new Error('Download failed after all retries');
}

/**
 * Check local database version against blob storage
 */
export async function checkDatabaseVersion(localPath: string, options?: DownloadOptions): Promise<{
  needsUpdate: boolean;
  localModified?: Date;
  remoteModified?: Date;
}> {
  const connectionString = options?.connectionString || process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = options?.containerName || process.env.BLOB_CONTAINER_NAME || 'xpp-metadata';
  const blobName = options?.blobName || process.env.BLOB_DATABASE_NAME || 'databases/xpp-metadata-latest.db';

  if (!connectionString) {
    return { needsUpdate: false };
  }

  try {
    // Check local file
    const localStats = await fs.stat(localPath);
    const localModified = localStats.mtime;

    // Check remote blob
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);
    
    const properties = await blobClient.getProperties();
    const remoteModified = properties.lastModified;

    if (!remoteModified) {
      return { needsUpdate: false, localModified };
    }

    // Compare timestamps
    const needsUpdate = remoteModified > localModified;

    return {
      needsUpdate,
      localModified,
      remoteModified,
    };
  } catch (error) {
    // If local file doesn't exist, needs download
    return { needsUpdate: true };
  }
}

/**
 * Initialize database (download if needed)
 */
export async function initializeDatabase(options?: DownloadOptions): Promise<string> {
  const localPath = options?.localPath || process.env.DB_PATH || './data/xpp-metadata.db';

  // Check if we should use blob storage
  const useBlob = !!process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (!useBlob) {
    console.log('ℹ️  No Azure Storage connection configured, using local database');
    return localPath;
  }

  // Check if update is needed
  const versionCheck = await checkDatabaseVersion(localPath, options);

  if (versionCheck.needsUpdate) {
    console.log('🔄 Database update available or local file missing');
    await downloadDatabaseFromBlob(options);
  } else {
    console.log('✅ Local database is up to date');
    if (versionCheck.localModified) {
      console.log(`   Last modified: ${versionCheck.localModified.toISOString()}`);
    }
  }

  return localPath;
}
