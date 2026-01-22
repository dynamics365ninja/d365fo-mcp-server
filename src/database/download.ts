/**
 * Azure Blob Storage Database Download Utility
 * Downloads SQLite database from Azure Blob Storage on startup
 */

import { BlobServiceClient } from '@azure/storage-blob';
import * as fs from 'fs/promises';
import * as path from 'path';

interface DownloadOptions {
  connectionString?: string;
  containerName?: string;
  blobName?: string;
  localPath?: string;
}

export async function downloadDatabaseFromBlob(options?: DownloadOptions): Promise<string> {
  const connectionString = options?.connectionString || process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = options?.containerName || process.env.BLOB_CONTAINER_NAME || 'xpp-metadata';
  const blobName = options?.blobName || process.env.BLOB_DATABASE_NAME || 'databases/xpp-metadata-latest.db';
  const localPath = options?.localPath || process.env.DB_PATH || './data/xpp-metadata.db';

  if (!connectionString) {
    throw new Error('Azure Storage connection string not configured');
  }

  console.log(`📥 Downloading database from blob storage...`);
  console.log(`   Container: ${containerName}`);
  console.log(`   Blob: ${blobName}`);
  console.log(`   Local path: ${localPath}`);

  try {
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

    // Ensure directory exists
    const dir = path.dirname(localPath);
    await fs.mkdir(dir, { recursive: true });

    // Download to file
    const startTime = Date.now();
    await blobClient.downloadToFile(localPath);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ Database downloaded successfully in ${duration}s`);
    return localPath;
  } catch (error) {
    console.error('❌ Failed to download database from blob storage:', error);
    throw error;
  }
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
