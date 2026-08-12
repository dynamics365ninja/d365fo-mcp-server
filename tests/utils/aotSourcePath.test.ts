/**
 * `isAotSourcePath` — regression cover for indexed file_path values that point
 * at the JSON metadata cache instead of the AOT source.
 *
 * The trap this guards is specifically NOT "the file is missing". Twenty sites
 * in symbolIndex.ts fall back to `path.join(<cacheDir>, '<name>.json')` when a
 * cached object carries no `sourcePath`, and that cache file is real. Every
 * existence check downstream passes, so the caller reads — or writes — the
 * wrong file with no error to show for it. Anything asserting here that a
 * `.json` path is rejected is asserting the whole point.
 */

import { describe, it, expect } from 'vitest';
import { isAotSourcePath } from '../../src/utils/packagesRoot.js';

describe('isAotSourcePath', () => {
  it('accepts AOT metadata and X++ source files', () => {
    for (const p of [
      'C:\\AosService\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxForm\\Foo.xml',
      'ContosoExt/ContosoExt/AxClass/Foo.xml',
      '/mnt/packages/ContosoExt/AxTable/Bar.xpp',
    ]) {
      expect(isAotSourcePath(p), p).toBe(true);
    }
  });

  it('rejects the JSON metadata cache — the path that exists but is not the source', () => {
    for (const p of [
      'C:\\d365fo-mcp\\extracted-metadata\\ContosoExt\\enums\\MyEnum.json',
      '/var/cache/extracted-metadata/edts/MyEdt.json',
      'extracted-metadata/classes/Foo.json',
    ]) {
      expect(isAotSourcePath(p), p).toBe(false);
    }
  });

  it('is case-insensitive — AOT casing on disk is not guaranteed', () => {
    expect(isAotSourcePath('AxForm/Foo.XML')).toBe(true);
    expect(isAotSourcePath('AxClass/Foo.XPP')).toBe(true);
    expect(isAotSourcePath('enums/MyEnum.JSON')).toBe(false);
  });

  it('rejects absent, empty and whitespace paths without throwing', () => {
    for (const p of [undefined, null, '', '   ']) {
      expect(isAotSourcePath(p as string | null | undefined), String(p)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace on an otherwise valid path', () => {
    expect(isAotSourcePath('  AxForm/Foo.xml  ')).toBe(true);
  });

  it('matches only a trailing extension, not one embedded in a directory name', () => {
    // A directory called "Foo.xml" holding a cache file must not read as source.
    expect(isAotSourcePath('cache/Foo.xml/data.json')).toBe(false);
    expect(isAotSourcePath('cache/Foo.json/real.xml')).toBe(true);
  });
});
