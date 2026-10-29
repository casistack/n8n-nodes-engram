import type { NativeCaptureAttributeKeys } from '../schemas/NativeCaptureAttributeKeys.schema';
import { types as utilTypes } from 'util';

const prefixes = ['engram_write_owner_v', 'engram_source_envelope_v'] as const;
const legacyKeys = ['engram_write_owner_v1', 'engram_source_envelope_v1'] as const;
const MAX_KEY_PREFIX = 32;
const white = (code: number) => code === 0x20 || code === 9 || code === 10 || code === 13;
const digit = (code: number) => code >= 48 && code <= 57;
const reserved = (key: string) => prefixes.some((prefix) => key.startsWith(prefix));
const legacy = (key: string) => legacyKeys.some((known) => known === key);
const hex = (code: number) =>
  code >= 48 && code <= 57
    ? code - 48
    : code >= 65 && code <= 70
      ? code - 55
      : code >= 97 && code <= 102
        ? code - 87
        : -1;

/** Scans one string without copying its body. Only a bounded key prefix is decoded. */
function stringEnd(raw: string, start: number, key: boolean) {
  let prefix = '';
  for (let index = start + 1; index < raw.length; index++) {
    let code = raw.charCodeAt(index);
    if (code === 34) return { end: index + 1, prefix, protected: false };
    if (code < 0x20) return null;
    if (code === 92) {
      code = raw.charCodeAt(++index);
      if (code === 117) {
        let decoded = 0;
        for (let offset = 0; offset < 4; offset++) {
          const value = hex(raw.charCodeAt(++index));
          if (value < 0) return null;
          decoded = decoded * 16 + value;
        }
        code = decoded;
      } else if (code === 98) code = 8;
      else if (code === 102) code = 12;
      else if (code === 110) code = 10;
      else if (code === 114) code = 13;
      else if (code === 116) code = 9;
      else if (code !== 34 && code !== 92 && code !== 47) return null;
    }
    if (key && prefix.length < MAX_KEY_PREFIX) {
      prefix += String.fromCharCode(code);
      // Once the decoded prefix cannot be a canonical legacy key, no suffix
      // can make this a safe legacy-only object. Malformed suffixes stay closed.
      if (reserved(prefix) && !legacyKeys.some((known) => known.startsWith(prefix)))
        return { end: index + 1, prefix, protected: true };
    }
  }
  return null;
}

function primitiveEnd(raw: string, start: number): number | null {
  for (const literal of ['true', 'false', 'null'])
    if (raw.startsWith(literal, start)) return start + literal.length;
  let index = start;
  if (raw.charCodeAt(index) === 45) index++;
  if (raw.charCodeAt(index) === 48) index++;
  else {
    if (raw.charCodeAt(index) < 49 || raw.charCodeAt(index) > 57) return null;
    do {
      index++;
    } while (digit(raw.charCodeAt(index)));
  }
  if (raw.charCodeAt(index) === 46) {
    if (!digit(raw.charCodeAt(++index))) return null;
    do {
      index++;
    } while (digit(raw.charCodeAt(index)));
  }
  if (raw.charCodeAt(index) === 101 || raw.charCodeAt(index) === 69) {
    index++;
    if (raw.charCodeAt(index) === 43 || raw.charCodeAt(index) === 45) index++;
    if (!digit(raw.charCodeAt(index))) return null;
    do {
      index++;
    } while (digit(raw.charCodeAt(index)));
  }
  return index;
}

/**
 * Classifies top-level attribute keys before native JSON parsing. This is not
 * an authority check or a replacement JSON validator. For valid JSON objects,
 * every reserved root key is recognized, including escaped/duplicate keys.
 * Uses scalar nesting depth and bounded key decoding; no recursive/token tree.
 */
export function inspectNativeCaptureAttributeKeys(raw: string): NativeCaptureAttributeKeys {
  let index = 0;
  while (white(raw.charCodeAt(index))) index++;
  if (raw.charCodeAt(index++) !== 123) return 'uncertain';
  let depth = 1;
  let hasLegacy = false;
  let phase: 'key_or_end' | 'key' | 'colon' | 'value' | 'after_value' = 'key_or_end';
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    if (white(code)) {
      index++;
      continue;
    }
    if (depth > 1) {
      if (code === 34) {
        const text = stringEnd(raw, index, false);
        if (!text) return 'uncertain';
        index = text.end;
      } else {
        if (code === 123 || code === 91) depth++;
        else if (code === 125 || code === 93) depth--;
        else if (code < 0x20) return 'uncertain';
        index++;
      }
      continue;
    }
    if (phase === 'key_or_end' || phase === 'key') {
      if (code === 125 && phase === 'key_or_end') {
        depth = 0;
        index++;
        break;
      }
      if (code !== 34) return 'uncertain';
      const key = stringEnd(raw, index, true);
      if (!key) return 'uncertain';
      if (key.protected || (reserved(key.prefix) && !legacy(key.prefix))) return 'protected';
      hasLegacy ||= legacy(key.prefix);
      index = key.end;
      phase = 'colon';
    } else if (phase === 'colon') {
      if (code !== 58) return 'uncertain';
      index++;
      phase = 'value';
    } else if (phase === 'value') {
      if (code === 123 || code === 91) {
        depth++;
        index++;
      } else if (code === 34) {
        const value = stringEnd(raw, index, false);
        if (!value) return 'uncertain';
        index = value.end;
      } else {
        const end = primitiveEnd(raw, index);
        if (end === null) return 'uncertain';
        index = end;
      }
      phase = 'after_value';
    } else if (code === 44) {
      index++;
      phase = 'key';
    } else if (code === 125) {
      index++;
      depth = 0;
      break;
    } else return 'uncertain';
  }
  if (depth !== 0) return 'uncertain';
  while (white(raw.charCodeAt(index))) index++;
  return index === raw.length ? (hasLegacy ? 'legacy_owned' : 'unowned') : 'uncertain';
}

/** Native drivers normally return a JSON string; plain maps are handled without invoking values. */
export function inspectNativeCaptureAttributeValue(value: unknown): NativeCaptureAttributeKeys {
  if (typeof value === 'string') return inspectNativeCaptureAttributeKeys(value);
  if (value === null || value === undefined) return 'unowned';
  if (typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
    return 'uncertain';
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return 'uncertain';
  let hasLegacy = false;
  for (const key of Object.keys(value)) {
    if (reserved(key) && !legacy(key)) return 'protected';
    hasLegacy ||= legacy(key);
  }
  return hasLegacy ? 'legacy_owned' : 'unowned';
}

/** Must run before JSON.parse. Length is checked before counting UTF-8 bytes. */
export function assertNativeCaptureAttributeJsonSize(value: unknown): void {
  if (typeof value !== 'string') return;
  if (value.length > 524288 || Buffer.byteLength(value, 'utf8') > 524288)
    throw new Error('Engram automatic capture: native_attributes_too_large');
}
