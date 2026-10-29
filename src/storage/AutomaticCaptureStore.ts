import * as path from 'path';
import { fingerprint } from '../extraction/QueueState';

/** Existing logical-store recipe; it is identity data, never write authority. */
export function embeddedAutomaticCaptureStoreHash(persistPath: string | undefined): string | null {
  if (typeof persistPath !== 'string' || persistPath.length === 0) return null;
  return fingerprint({ backend: 'embedded', persistPath: path.resolve(persistPath) });
}

/**
 * Use the original configured URI, before transport-only localhost rewriting.
 * Credentials are deliberately not inputs. Userinfo URIs are unsupported in
 * this new capture path; legacy connection behavior is unaffected.
 */
export function neo4jAutomaticCaptureStoreHash(
  originalConfiguredUri: string,
  configuredDatabase?: string,
): string | null {
  if (typeof originalConfiguredUri !== 'string' || originalConfiguredUri.length === 0) return null;
  if (originalConfiguredUri !== originalConfiguredUri.trim()) return null;
  for (let index = 0; index < originalConfiguredUri.length; index++) {
    const unit = originalConfiguredUri.charCodeAt(index);
    if (unit <= 0x20 || unit === 0x7f) return null;
  }
  try {
    const uri = new URL(originalConfiguredUri);
    const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(originalConfiguredUri)?.[1];
    if (uri.username || uri.password || authority?.includes('@') || !uri.hostname) return null;
    if (
      !['neo4j:', 'neo4j+s:', 'neo4j+ssc:', 'bolt:', 'bolt+s:', 'bolt+ssc:'].includes(uri.protocol)
    )
      return null;
  } catch {
    return null;
  }
  if (
    configuredDatabase !== undefined &&
    (typeof configuredDatabase !== 'string' || !configuredDatabase.length)
  )
    return null;
  return fingerprint({
    backend: 'neo4j',
    uri: originalConfiguredUri,
    database: configuredDatabase ?? 'neo4j',
  });
}
