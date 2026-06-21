const ALLOWED_HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeHttpBaseUrl(rawBaseUrl: string, label: string): string {
  const trimmed = rawBaseUrl.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }

  if (!ALLOWED_HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${label} must use http or https`);
  }

  return parsed.toString().replace(/\/$/, '');
}
