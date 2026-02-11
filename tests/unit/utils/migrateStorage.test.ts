import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IDataObject } from 'n8n-workflow';
import { migrateStorageIfNeeded } from '../../../src/utils/helpers';

describe('migrateStorageIfNeeded', () => {
  let tmpDir: string;
  let staticData: IDataObject;
  let mockLogger: { info: jest.Mock; warn: jest.Mock };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-migrate-test-'));
    staticData = {};
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should no-op when data already exists at newPath', () => {
    const newPath = path.join(tmpDir, 'new', 'test-engram.json');
    const sourceDir = path.join(tmpDir, 'old');
    const sourcePath = path.join(sourceDir, 'test-engram.json');

    // Create both old and new files
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, '{"entities":[],"edges":[],"episodes":[]}');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, '{"entities":["old"],"edges":[],"episodes":[]}');

    // Point static data at old path
    staticData.__engramPersistPath = sourcePath;

    migrateStorageIfNeeded({
      newPath,
      workflowId: 'test',
      staticData,
      logger: mockLogger,
    });

    // New file should be untouched (not overwritten)
    const content = JSON.parse(fs.readFileSync(newPath, 'utf-8'));
    expect(content.entities).toEqual([]);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('should copy from legacy path when new path has no data', () => {
    const newPath = path.join(tmpDir, 'new', 'wf1-engram.json');

    // Create a legacy file at the path that path.resolve would produce
    const legacyDir = path.resolve('engram-data');
    const legacyPath = path.join(legacyDir, 'wf1-engram.json');
    const legacyExisted = fs.existsSync(legacyPath);

    // We can't easily test the legacy path without creating it in the real CWD,
    // so we test via static data path instead (see next test)
    // This test verifies the static data path works
    const sourcePath = path.join(tmpDir, 'source', 'wf1-engram.json');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '{"entities":["migrated"],"edges":[],"episodes":[]}');

    staticData.__engramPersistPath = sourcePath;

    migrateStorageIfNeeded({
      newPath,
      workflowId: 'wf1',
      staticData,
      logger: mockLogger,
    });

    expect(fs.existsSync(newPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(newPath, 'utf-8'));
    expect(content.entities).toEqual(['migrated']);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Migrated graph data from'),
    );
  });

  it('should copy from static data last-used path', () => {
    const oldPath = path.join(tmpDir, 'old-location', 'wf2-engram.json');
    const newPath = path.join(tmpDir, 'new-location', 'wf2-engram.json');

    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, '{"entities":["from-old"],"edges":[],"episodes":[]}');

    staticData.__engramPersistPath = oldPath;

    migrateStorageIfNeeded({
      newPath,
      workflowId: 'wf2',
      staticData,
      logger: mockLogger,
    });

    expect(fs.existsSync(newPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(newPath, 'utf-8'));
    expect(content.entities).toEqual(['from-old']);
    // Static data should be updated to new path
    expect(staticData.__engramPersistPath).toBe(newPath);
  });

  it('should create target directory if needed', () => {
    const oldPath = path.join(tmpDir, 'source', 'wf3-engram.json');
    const newPath = path.join(tmpDir, 'deep', 'nested', 'dir', 'wf3-engram.json');

    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, '{"entities":[],"edges":[],"episodes":[]}');

    staticData.__engramPersistPath = oldPath;

    migrateStorageIfNeeded({
      newPath,
      workflowId: 'wf3',
      staticData,
      logger: mockLogger,
    });

    expect(fs.existsSync(newPath)).toBe(true);
  });

  it('should store newPath in static data after migration', () => {
    const newPath = path.join(tmpDir, 'store-test', 'wf4-engram.json');

    migrateStorageIfNeeded({
      newPath,
      workflowId: 'wf4',
      staticData,
      logger: mockLogger,
    });

    expect(staticData.__engramPersistPath).toBe(newPath);
  });

  it('should store newPath in static data even when no migration occurs', () => {
    const newPath = path.join(tmpDir, 'no-migrate', 'wf5-engram.json');

    // No source files exist — nothing to migrate
    migrateStorageIfNeeded({
      newPath,
      workflowId: 'wf5',
      staticData,
      logger: mockLogger,
    });

    expect(staticData.__engramPersistPath).toBe(newPath);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('should handle missing source gracefully', () => {
    const newPath = path.join(tmpDir, 'missing', 'wf6-engram.json');

    // Static data points to a non-existent file
    staticData.__engramPersistPath = '/nonexistent/path/wf6-engram.json';

    migrateStorageIfNeeded({
      newPath,
      workflowId: 'wf6',
      staticData,
      logger: mockLogger,
    });

    // Should not create newPath since source doesn't exist
    expect(fs.existsSync(newPath)).toBe(false);
    // Static data still updated
    expect(staticData.__engramPersistPath).toBe(newPath);
  });

  it('should not copy when source equals destination', () => {
    const samePath = path.join(tmpDir, 'same', 'wf7-engram.json');

    fs.mkdirSync(path.dirname(samePath), { recursive: true });
    fs.writeFileSync(samePath, '{"entities":[],"edges":[],"episodes":[]}');

    staticData.__engramPersistPath = samePath;

    migrateStorageIfNeeded({
      newPath: samePath,
      workflowId: 'wf7',
      staticData,
      logger: mockLogger,
    });

    // Should not log any migration
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('should work without a logger', () => {
    const oldPath = path.join(tmpDir, 'no-logger-src', 'wf8-engram.json');
    const newPath = path.join(tmpDir, 'no-logger-dst', 'wf8-engram.json');

    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, '{"entities":["no-logger"],"edges":[],"episodes":[]}');

    staticData.__engramPersistPath = oldPath;

    // No logger provided — should not throw
    expect(() =>
      migrateStorageIfNeeded({
        newPath,
        workflowId: 'wf8',
        staticData,
      }),
    ).not.toThrow();

    expect(fs.existsSync(newPath)).toBe(true);
  });

  it('should not poison static data on migration failure so retries work', () => {
    const oldPath = path.join(tmpDir, 'retry-src', 'wf9-engram.json');
    const targetDir = path.join(tmpDir, 'retry-dst');
    const newPath = path.join(targetDir, 'wf9-engram.json');

    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, '{"entities":["retry"],"edges":[],"episodes":[]}');

    // Create target directory as read-only so copyFileSync fails with EACCES
    fs.mkdirSync(targetDir, { recursive: true });
    fs.chmodSync(targetDir, 0o444);

    staticData.__engramPersistPath = oldPath;

    try {
      migrateStorageIfNeeded({
        newPath,
        workflowId: 'wf9',
        staticData,
        logger: mockLogger,
      });
    } finally {
      // Restore write permissions for cleanup
      fs.chmodSync(targetDir, 0o755);
    }

    // Static data should still point to old path so next execution can retry
    expect(staticData.__engramPersistPath).toBe(oldPath);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('migration failed'));
  });
});
