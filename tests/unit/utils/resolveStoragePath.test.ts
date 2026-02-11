import * as path from 'path';
import * as os from 'os';
import { resolveStoragePath } from '../../../src/utils/helpers';

describe('resolveStoragePath', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return custom path + filename when customStoragePath provided', () => {
    const result = resolveStoragePath({
      customStoragePath: '/data/engram',
      workflowId: 'abc123',
    });
    expect(result).toBe(path.resolve('/data/engram', 'abc123-engram.json'));
  });

  it('should return default n8n storage path when no custom path', () => {
    const result = resolveStoragePath({
      customStoragePath: '',
      workflowId: 'abc123',
    });
    const expected = path.join(os.homedir(), '.n8n', 'storage', 'n8n-nodes-engram', 'abc123-engram.json');
    expect(result).toBe(expected);
  });

  it('should use "default" as workflowId when empty', () => {
    const result = resolveStoragePath({
      customStoragePath: '',
      workflowId: '',
    });
    expect(result).toContain('default-engram.json');
  });

  it('should trim whitespace from custom path', () => {
    const result = resolveStoragePath({
      customStoragePath: '  /data/engram  ',
      workflowId: 'abc123',
    });
    expect(result).toBe(path.resolve('/data/engram', 'abc123-engram.json'));
  });

  it('should reject path traversal attacks', () => {
    expect(() =>
      resolveStoragePath({
        customStoragePath: '/data/../../../etc/passwd',
        workflowId: 'abc123',
      }),
    ).toThrow('Invalid storage path');
  });

  it('should reject /etc paths', () => {
    expect(() =>
      resolveStoragePath({
        customStoragePath: '/etc/engram',
        workflowId: 'abc123',
      }),
    ).toThrow('Invalid storage path');
  });

  it('should reject /dev paths', () => {
    expect(() =>
      resolveStoragePath({
        customStoragePath: '/dev/shm/engram',
        workflowId: 'abc123',
      }),
    ).toThrow('Invalid storage path');
  });

  it('should respect N8N_USER_FOLDER env var', () => {
    process.env.N8N_USER_FOLDER = '/custom/n8n';
    const result = resolveStoragePath({
      customStoragePath: '',
      workflowId: 'abc123',
    });
    expect(result).toBe(
      path.join('/custom/n8n', '.n8n', 'storage', 'n8n-nodes-engram', 'abc123-engram.json'),
    );
  });

  it('should handle custom path with trailing slash', () => {
    const result = resolveStoragePath({
      customStoragePath: '/data/engram/',
      workflowId: 'abc123',
    });
    expect(result).toBe(path.resolve('/data/engram/', 'abc123-engram.json'));
  });

  it('should treat whitespace-only custom path as empty', () => {
    const result = resolveStoragePath({
      customStoragePath: '   ',
      workflowId: 'abc123',
    });
    // Should use default path, not custom
    expect(result).toContain(path.join('storage', 'n8n-nodes-engram'));
  });
});
