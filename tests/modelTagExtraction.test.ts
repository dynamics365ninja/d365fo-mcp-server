/**
 * Tests for .rnrproj Model Tag Extraction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { detectD365Project } from '../src/utils/workspaceDetector.js';

describe('Model Tag Extraction', () => {
  let testDir: string;
  
  beforeEach(async () => {
    // Create unique test directory for each test to avoid race conditions
    testDir = path.join(process.cwd(), `test-model-tags-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(testDir, { recursive: true });
  });
  
  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should extract model from <Model> tag (standard format)', async () => {
    const projectDir = path.join(testDir, 'StandardProject');
    const projectFile = path.join(projectDir, 'Test.rnrproj');
    
    await fs.mkdir(projectDir, { recursive: true });
    
    const projectContent = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration>Debug</Configuration>
    <Model>AslCore</Model>
    <Name>TestProject</Name>
  </PropertyGroup>
</Project>`;
    
    await fs.writeFile(projectFile, projectContent, 'utf-8');
    
    const result = await detectD365Project(testDir);
    
    expect(result).not.toBeNull();
    expect(result?.modelName).toBe('AslCore');
  });

  it('should extract model from <ModelName> tag (fallback format)', async () => {
    const projectDir = path.join(testDir, 'LegacyProject');
    const projectFile = path.join(projectDir, 'Test.rnrproj');
    
    await fs.mkdir(projectDir, { recursive: true });
    
    const projectContent = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration>Debug</Configuration>
    <ModelName>CustomExtension</ModelName>
    <Name>TestProject</Name>
  </PropertyGroup>
</Project>`;
    
    await fs.writeFile(projectFile, projectContent, 'utf-8');
    
    const result = await detectD365Project(testDir);
    
    expect(result).not.toBeNull();
    expect(result?.modelName).toBe('CustomExtension');
  });

  it('should prefer <Model> over <ModelName> when both exist', async () => {
    const projectDir = path.join(testDir, 'BothTagsProject');
    const projectFile = path.join(projectDir, 'Test.rnrproj');
    
    await fs.mkdir(projectDir, { recursive: true });
    
    const projectContent = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration>Debug</Configuration>
    <Model>PreferredModel</Model>
    <ModelName>FallbackModel</ModelName>
    <Name>TestProject</Name>
  </PropertyGroup>
</Project>`;
    
    await fs.writeFile(projectFile, projectContent, 'utf-8');
    
    const result = await detectD365Project(testDir);
    
    expect(result).not.toBeNull();
    expect(result?.modelName).toBe('PreferredModel');
  });

  it('should return null when neither tag exists', async () => {
    const projectDir = path.join(testDir, 'NoModelProject');
    const projectFile = path.join(projectDir, 'Test.rnrproj');
    
    await fs.mkdir(projectDir, { recursive: true });
    
    const projectContent = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration>Debug</Configuration>
    <Name>TestProject</Name>
  </PropertyGroup>
</Project>`;
    
    await fs.writeFile(projectFile, projectContent, 'utf-8');
    
    const result = await detectD365Project(testDir);
    
    expect(result).toBeNull();
  });

  it('should handle empty model tags gracefully', async () => {
    const projectDir = path.join(testDir, 'EmptyTagProject');
    const projectFile = path.join(projectDir, 'Test.rnrproj');
    
    await fs.mkdir(projectDir, { recursive: true });
    
    const projectContent = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration>Debug</Configuration>
    <Model></Model>
    <ModelName>FallbackToThis</ModelName>
    <Name>TestProject</Name>
  </PropertyGroup>
</Project>`;
    
    await fs.writeFile(projectFile, projectContent, 'utf-8');
    
    const result = await detectD365Project(testDir);
    
    expect(result).not.toBeNull();
    // Should fallback to ModelName when Model is empty
    expect(result?.modelName).toBe('FallbackToThis');
  });
});
