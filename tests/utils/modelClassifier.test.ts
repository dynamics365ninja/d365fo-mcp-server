import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isCustomModel, isStandardModel, getCustomModels, filterModelsByType } from '../../src/utils/modelClassifier';

describe('modelClassifier', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('getCustomModels', () => {
    it('should return empty array when CUSTOM_MODELS is not set', () => {
      delete process.env.CUSTOM_MODELS;
      expect(getCustomModels()).toEqual([]);
    });

    it('should parse comma-separated custom models', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,FinanceExtension,MyCustomModel';
      expect(getCustomModels()).toEqual(['CustomCore', 'FinanceExtension', 'MyCustomModel']);
    });

    it('should trim whitespace from model names', () => {
      process.env.CUSTOM_MODELS = ' CustomCore , FinanceExtension , MyCustomModel ';
      expect(getCustomModels()).toEqual(['CustomCore', 'FinanceExtension', 'MyCustomModel']);
    });

    it('should filter out empty strings', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,,FinanceExtension,';
      expect(getCustomModels()).toEqual(['CustomCore', 'FinanceExtension']);
    });
  });

  describe('isCustomModel', () => {
    it('should return false when no custom models are defined', () => {
      delete process.env.CUSTOM_MODELS;
      delete process.env.EXTENSION_PREFIX;
      
      expect(isCustomModel('ApplicationFoundation')).toBe(false);
      expect(isCustomModel('ApplicationPlatform')).toBe(false);
    });

    it('should identify models in CUSTOM_MODELS list', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,FinanceExtension';

      expect(isCustomModel('CustomCore')).toBe(true);
      expect(isCustomModel('FinanceExtension')).toBe(true);
      expect(isCustomModel('ApplicationFoundation')).toBe(false);
    });

    it('should be case-insensitive for custom models', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,FinanceExtension';

      expect(isCustomModel('customcore')).toBe(true);
      expect(isCustomModel('CUSTOMCORE')).toBe(true);
      expect(isCustomModel('CustomCore')).toBe(true);
    });

    it('should identify models with EXTENSION_PREFIX', () => {
      process.env.EXTENSION_PREFIX = 'Custom';
      delete process.env.CUSTOM_MODELS;
      
      expect(isCustomModel('CustomCore')).toBe(true);
      expect(isCustomModel('CustomFinance')).toBe(true);
      expect(isCustomModel('ApplicationFoundation')).toBe(false);
    });

    it('should combine CUSTOM_MODELS and EXTENSION_PREFIX', () => {
      process.env.CUSTOM_MODELS = 'MyCustomModel';
      process.env.EXTENSION_PREFIX = 'Custom';
      
      expect(isCustomModel('MyCustomModel')).toBe(true);
      expect(isCustomModel('CustomCore')).toBe(true);
      expect(isCustomModel('ApplicationFoundation')).toBe(false);
    });
  });

  describe('isStandardModel', () => {
    it('should return true for models not in custom list', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,FinanceExtension';
      
      expect(isStandardModel('ApplicationFoundation')).toBe(true);
      expect(isStandardModel('ApplicationPlatform')).toBe(true);
      expect(isStandardModel('Directory')).toBe(true);
    });

    it('should return false for custom models', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,FinanceExtension';

      expect(isStandardModel('CustomCore')).toBe(false);
      expect(isStandardModel('FinanceExtension')).toBe(false);
    });

    it('should be opposite of isCustomModel', () => {
      process.env.CUSTOM_MODELS = 'CustomCore';
      process.env.EXTENSION_PREFIX = 'My';
      
      const testModels = ['CustomCore', 'MyCustom', 'ApplicationFoundation', 'Directory'];
      
      testModels.forEach(model => {
        expect(isStandardModel(model)).toBe(!isCustomModel(model));
      });
    });
  });

  describe('filterModelsByType', () => {
    const allModels = [
      'ApplicationFoundation',
      'ApplicationPlatform',
      'CustomCore',
      'CustomFinance',
      'Directory',
      'Ledger',
      'MyCustomModel'
    ];

    it('should filter custom models', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,CustomFinance,MyCustomModel';
      
      const customModels = filterModelsByType(allModels, 'custom');
      expect(customModels).toEqual(['CustomCore', 'CustomFinance', 'MyCustomModel']);
    });

    it('should filter standard models', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,CustomFinance,MyCustomModel';
      
      const standardModels = filterModelsByType(allModels, 'standard');
      expect(standardModels).toEqual([
        'ApplicationFoundation',
        'ApplicationPlatform',
        'Directory',
        'Ledger'
      ]);
    });

    it('should work with EXTENSION_PREFIX', () => {
      process.env.EXTENSION_PREFIX = 'Custom';
      delete process.env.CUSTOM_MODELS;
      
      const customModels = filterModelsByType(allModels, 'custom');
      expect(customModels).toEqual(['CustomCore', 'CustomFinance']);
    });

    it('should return empty array when no models match', () => {
      process.env.CUSTOM_MODELS = 'NonExistent';
      
      const customModels = filterModelsByType(allModels, 'custom');
      expect(customModels).toEqual([]);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle typical custom model setup', () => {
      process.env.CUSTOM_MODELS = 'CustomCore,FinanceExtension,FinanceLocalization,CustomReports';
      process.env.EXTENSION_PREFIX = 'Custom';
      
      // Standard Microsoft models
      expect(isStandardModel('ApplicationFoundation')).toBe(true);
      expect(isStandardModel('ApplicationPlatform')).toBe(true);
      expect(isStandardModel('ApplicationSuite')).toBe(true);
      expect(isStandardModel('Ledger')).toBe(true);
      
      // Custom models
      expect(isCustomModel('CustomCore')).toBe(true);
      expect(isCustomModel('FinanceExtension')).toBe(true);
      expect(isCustomModel('CustomAudit')).toBe(true); // Via prefix
    });

    it('should handle wildcards in CUSTOM_MODELS', () => {
      process.env.CUSTOM_MODELS = 'Custom*,MyCompany*';
      delete process.env.EXTENSION_PREFIX;
      
      // Should match Custom*
      expect(isCustomModel('CustomCore')).toBe(true);
      expect(isCustomModel('CustomFinance')).toBe(true);
      expect(isCustomModel('CustomReports')).toBe(true);
      
      // Should match MyCompany*
      expect(isCustomModel('MyCompanyModule')).toBe(true);
      expect(isCustomModel('MyCompanyExtension')).toBe(true);
      
      // Should not match
      expect(isStandardModel('ApplicationFoundation')).toBe(true);
      expect(isStandardModel('Directory')).toBe(true);
    });

    it('should handle suffix wildcards', () => {
      process.env.CUSTOM_MODELS = '*Extension,*Custom';
      
      expect(isCustomModel('MyExtension')).toBe(true);
      expect(isCustomModel('CompanyExtension')).toBe(true);
      expect(isCustomModel('MyCustom')).toBe(true);
      expect(isStandardModel('ApplicationFoundation')).toBe(true);
    });

    it('should handle middle wildcards', () => {
      process.env.CUSTOM_MODELS = '*Custom*,*Test*';
      
      expect(isCustomModel('MyCustomModule')).toBe(true);
      expect(isCustomModel('CustomExtension')).toBe(true);
      expect(isCustomModel('TestModule')).toBe(true);
      expect(isCustomModel('MyTestUtils')).toBe(true);
      expect(isStandardModel('ApplicationFoundation')).toBe(true);
    });

    it('should handle mixed case in real zip files', () => {
      process.env.CUSTOM_MODELS = 'Custom*';
      
      // Lowercase names from zip
      expect(isCustomModel('customcore')).toBe(true);
      expect(isCustomModel('customfinance')).toBe(true);
      expect(isStandardModel('applicationfoundation')).toBe(true);
    });

    it('should combine wildcards and exact matches', () => {
      process.env.CUSTOM_MODELS = 'Custom*,SpecificModel,*Extension';
      
      expect(isCustomModel('CustomCore')).toBe(true);
      expect(isCustomModel('SpecificModel')).toBe(true);
      expect(isCustomModel('MyExtension')).toBe(true);
      expect(isStandardModel('OtherModel')).toBe(true);
    });
  });
});
