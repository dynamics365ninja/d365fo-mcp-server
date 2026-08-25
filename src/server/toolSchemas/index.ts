/**
 * Aggregated MCP tool definitions, in the EXACT order they were published
 * from mcpServer.ts before the split — order affects the serialized
 * tools/list payload and is covered by tests.
 */
import { searchTool } from './search.js';
import { generateObjectTool } from './generateObject.js';
import { analyzeCodeTool } from './analyzeCode.js';
import { d365foFileTool } from './d365foFile.js';
import { findReferencesTool } from './findReferences.js';
import { getObjectInfoTool } from './getObjectInfo.js';
import { labelsTool } from './labels.js';
import { objectPatternsTool } from './objectPatterns.js';
import { securityInfoTool } from './securityInfo.js';
import { extensionInfoTool } from './extensionInfo.js';
import { validateObjectNamingTool } from './validateObjectNaming.js';
import { getWorkspaceInfoTool } from './getWorkspaceInfo.js';
import { verifyD365foProjectTool } from './verifyD365foProject.js';
import { updateSymbolIndexTool } from './updateSymbolIndex.js';
import { buildD365foProjectTool } from './buildD365foProject.js';
import { runBpCheckTool } from './runBpCheck.js';
import { runSystestClassTool } from './runSystestClass.js';
import { getKnowledgeTool } from './getKnowledge.js';
import { validateCodeTool } from './validateCode.js';
import { prepareTool } from './prepare.js';

export const toolSchemas = [
  searchTool,
  generateObjectTool,
  analyzeCodeTool,
  d365foFileTool,
  findReferencesTool,
  getObjectInfoTool,
  labelsTool,
  objectPatternsTool,
  securityInfoTool,
  extensionInfoTool,
  validateObjectNamingTool,
  getWorkspaceInfoTool,
  verifyD365foProjectTool,
  updateSymbolIndexTool,
  buildD365foProjectTool,
  runBpCheckTool,
  runSystestClassTool,
  getKnowledgeTool,
  validateCodeTool,
  prepareTool,
];
