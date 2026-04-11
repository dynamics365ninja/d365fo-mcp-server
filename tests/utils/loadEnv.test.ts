/**
 * loadEnv Tests
 *
 * Covers:
 *  - default .env path resolved relative to caller's directory
 *  - ENV_FILE override (absolute and relative)
 *  - fallback to process.cwd() only when ENV_FILE is NOT set
 *  - no fallback when ENV_FILE points to a missing file
 *  - relative PATH_VARS resolved relative to the .env file directory
 *  - absolute PATH_VARS left unchanged
 *  - PATH_VARS resolved relative to ENV_FILE directory, not caller directory
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// ── Mock dotenv before importing the module under test ───────────────────────
vi.mock('dotenv', () => ({
  default: {
    config: vi.fn(() => ({ parsed: {}, error: undefined })),
  },
}));

import dotenv from 'dotenv';
import { loadEnv } from '../../src/utils/loadEnv.js';

const mockConfig = vi.mocked(dotenv.config);

// ── Env-var isolation ────────────────────────────────────────────────────────
const TRACKED_VARS = ['ENV_FILE', 'DB_PATH', 'LABELS_DB_PATH', 'METADATA_PATH'] as const;
let savedEnv: Partial<Record<string, string>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of TRACKED_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockConfig.mockReset();
  // Default: dotenv.config succeeds with no output (no env vars changed)
  mockConfig.mockReturnValue({ parsed: {} } as any);
});

afterEach(() => {
  for (const key of TRACKED_VARS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// Simulate a caller at /repo/src/index.ts → callerDir = /repo/src
// Default envPath resolves to /repo/src/../.env = /repo/.env
const FAKE_CALLER_URL = 'file:///repo/src/index.ts';
const REPO_ROOT_ENV = path.resolve('/repo/.env');

// ── Env file path resolution ─────────────────────────────────────────────────
describe('env file path resolution', () => {
  it('uses <repo-root>/.env when ENV_FILE is not set', () => {
    loadEnv(FAKE_CALLER_URL);

    expect(mockConfig).toHaveBeenCalledTimes(1);
    expect(mockConfig).toHaveBeenCalledWith({ path: REPO_ROOT_ENV });
  });

  it('uses ENV_FILE when set to an absolute path', () => {
    process.env.ENV_FILE = '/some/instances/alpha/.env';
    loadEnv(FAKE_CALLER_URL);

    expect(mockConfig).toHaveBeenCalledTimes(1);
    expect(mockConfig).toHaveBeenCalledWith({
      path: path.resolve('/some/instances/alpha/.env'),
    });
  });

  it('resolves a relative ENV_FILE against process.cwd()', () => {
    process.env.ENV_FILE = 'instances/alpha/.env';
    loadEnv(FAKE_CALLER_URL);

    expect(mockConfig).toHaveBeenCalledWith({
      path: path.resolve('instances/alpha/.env'),
    });
  });
});

// ── Fallback behaviour ───────────────────────────────────────────────────────
describe('fallback behaviour', () => {
  it('falls back to process.cwd() .env when default .env is missing and ENV_FILE is not set', () => {
    mockConfig.mockReturnValueOnce({ error: new Error('ENOENT') } as any);

    loadEnv(FAKE_CALLER_URL);

    // First call: explicit path; second call: no args (process.cwd() fallback)
    expect(mockConfig).toHaveBeenCalledTimes(2);
    expect(mockConfig).toHaveBeenNthCalledWith(1, { path: REPO_ROOT_ENV });
    expect(mockConfig).toHaveBeenNthCalledWith(2);
  });

  it('does NOT fall back when ENV_FILE is set but the file is missing', () => {
    process.env.ENV_FILE = '/nonexistent/.env.beta';
    mockConfig.mockReturnValueOnce({ error: new Error('ENOENT') } as any);

    loadEnv(FAKE_CALLER_URL);

    // Must NOT call dotenv.config() a second time
    expect(mockConfig).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on success even when ENV_FILE is not set', () => {
    loadEnv(FAKE_CALLER_URL);
    expect(mockConfig).toHaveBeenCalledTimes(1);
  });
});

// ── Relative path resolution for PATH_VARS ───────────────────────────────────
describe('relative path resolution', () => {
  it('resolves DB_PATH relative to the .env file directory', () => {
    // envDir = /repo (default env at /repo/.env)
    mockConfig.mockImplementation(() => {
      process.env.DB_PATH = './data/xpp-metadata.db';
      return { parsed: {} } as any;
    });

    loadEnv(FAKE_CALLER_URL);

    expect(process.env.DB_PATH).toBe(path.resolve('/repo', './data/xpp-metadata.db'));
  });

  it('resolves LABELS_DB_PATH relative to the .env file directory', () => {
    mockConfig.mockImplementation(() => {
      process.env.LABELS_DB_PATH = './data/labels.db';
      return { parsed: {} } as any;
    });

    loadEnv(FAKE_CALLER_URL);

    expect(process.env.LABELS_DB_PATH).toBe(path.resolve('/repo', './data/labels.db'));
  });

  it('resolves METADATA_PATH relative to the .env file directory', () => {
    mockConfig.mockImplementation(() => {
      process.env.METADATA_PATH = './metadata';
      return { parsed: {} } as any;
    });

    loadEnv(FAKE_CALLER_URL);

    expect(process.env.METADATA_PATH).toBe(path.resolve('/repo', './metadata'));
  });

  it('does NOT modify absolute DB_PATH', () => {
    mockConfig.mockImplementation(() => {
      process.env.DB_PATH = '/absolute/path/xpp.db';
      return { parsed: {} } as any;
    });

    loadEnv(FAKE_CALLER_URL);

    expect(process.env.DB_PATH).toBe('/absolute/path/xpp.db');
  });

  it('does NOT modify absolute METADATA_PATH', () => {
    // Use a POSIX absolute path — Windows-style paths (C:\...) are not
    // recognised as absolute on macOS/Linux by path.isAbsolute.
    mockConfig.mockImplementation(() => {
      process.env.METADATA_PATH = '/absolute/metadata';
      return { parsed: {} } as any;
    });

    loadEnv(FAKE_CALLER_URL);

    expect(process.env.METADATA_PATH).toBe('/absolute/metadata');
  });

  it('resolves paths relative to ENV_FILE directory, not caller directory', () => {
    process.env.ENV_FILE = '/instances/alpha/.env';

    mockConfig.mockImplementation(() => {
      process.env.DB_PATH = './data/xpp.db';
      return { parsed: {} } as any;
    });

    loadEnv(FAKE_CALLER_URL);

    // envDir = /instances/alpha, not /repo/src
    expect(process.env.DB_PATH).toBe(path.resolve('/instances/alpha', './data/xpp.db'));
  });

  it('does not change PATH_VARS that are already unset', () => {
    // No env vars set by dotenv mock → nothing to resolve
    loadEnv(FAKE_CALLER_URL);

    expect(process.env.DB_PATH).toBeUndefined();
    expect(process.env.LABELS_DB_PATH).toBeUndefined();
    expect(process.env.METADATA_PATH).toBeUndefined();
  });
});
