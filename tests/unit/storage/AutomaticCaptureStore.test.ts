import * as path from 'path';
import { fingerprint } from '../../../src/extraction/QueueState';
import {
  embeddedAutomaticCaptureStoreHash,
  neo4jAutomaticCaptureStoreHash,
} from '../../../src/storage/AutomaticCaptureStore';

describe('backend-owned automatic capture logical store identities', () => {
  it('uses the existing embedded recipe with the resolved persistent path', () => {
    expect(embeddedAutomaticCaptureStoreHash('./synthetic-store.json')).toBe(
      fingerprint({ backend: 'embedded', persistPath: path.resolve('./synthetic-store.json') }),
    );
    expect(embeddedAutomaticCaptureStoreHash(undefined)).toBeNull();
    expect(embeddedAutomaticCaptureStoreHash('')).toBeNull();
  });
  it('retains the original URI and configured database without transport normalization', () => {
    const uri = 'bolt://localhost:7687';
    expect(neo4jAutomaticCaptureStoreHash(uri)).toBe(
      fingerprint({ backend: 'neo4j', uri, database: 'neo4j' }),
    );
    expect(neo4jAutomaticCaptureStoreHash(uri, 'synthetic')).toBe(
      fingerprint({ backend: 'neo4j', uri, database: 'synthetic' }),
    );
    expect(neo4jAutomaticCaptureStoreHash(uri)).not.toBe(
      neo4jAutomaticCaptureStoreHash('bolt://127.0.0.1:7687'),
    );
  });
  it.each([
    'bolt://synthetic-user@localhost:7687',
    'neo4j+s://synthetic-user:synthetic-password@example.invalid',
    'bolt://synthetic%40user@localhost:7687',
    'bolt://@localhost:7687',
    ' bolt://@localhost:7687',
    '\tbolt://@localhost:7687',
    '\u0000bolt://@localhost:7687',
    'bolt://localhost:7687\n',
    'https://example.invalid',
    'not-a-uri',
  ])('rejects unsupported or credential-bearing URI %s without returning it', (uri) => {
    expect(neo4jAutomaticCaptureStoreHash(uri)).toBeNull();
  });
});
