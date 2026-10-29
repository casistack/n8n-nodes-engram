import { createHash } from 'crypto';
import { z } from 'zod';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const MAX_SOURCE_BYTES = 65_536;
const MAX_UTF16_UNITS = 65_536;
const MAX_GEOMETRY_BYTES = 16 * 1024;
const HASH_64 = /^[a-f0-9]{64}$/u;

const hashSchema = z.string().regex(HASH_64);
const utf16OffsetSchema = z.number().int().safe().min(0).max(MAX_UTF16_UNITS);

const regionSchema = z
  .object({
    start: utf16OffsetSchema,
    end: utf16OffsetSchema,
  })
  .strict()
  .refine((region) => region.start < region.end, 'Region must be nonempty');

const inputMappingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('full_body') }).strict(),
  z
    .object({
      mode: z.literal('application_region'),
      humanRegion: regionSchema,
      applicationWrapper: z.object({ configurationFingerprint: hashSchema }).strict(),
    })
    .strict(),
]);

const sourceGeometryInputSchema = z
  .object({
    rawContent: z.string().max(MAX_UTF16_UNITS),
    mapping: inputMappingSchema,
    quoteRegions: z.array(regionSchema).max(32),
  })
  .strict();
/** Strict shape for geometry input that is already owned by a bounded raw facade. */
export const AutonomousSourceGeometryInputV3OwnedDataSchema = sourceGeometryInputSchema;
export type AutonomousSourceGeometryInputV3 = z.infer<typeof sourceGeometryInputSchema>;

const mappingSchema = z
  .object({
    rawStart: utf16OffsetSchema,
    rawEnd: utf16OffsetSchema,
    mappedStart: utf16OffsetSchema,
    mappedEnd: utf16OffsetSchema,
  })
  .strict()
  .superRefine((mapping, context) => {
    if (
      mapping.rawStart >= mapping.rawEnd ||
      mapping.mappedStart >= mapping.mappedEnd ||
      mapping.rawEnd - mapping.rawStart !== mapping.mappedEnd - mapping.mappedStart
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Mapping must be one exact span' });
    }
  });

const applicationWrapperSchema = z.object({ configurationFingerprint: hashSchema }).strict();

const geometryBodySchema = z
  .object({
    version: z.literal(3),
    mode: z.enum(['full_body', 'application_region']),
    rawContentHash: hashSchema,
    mappedContentHash: hashSchema,
    rawUtf16Length: utf16OffsetSchema,
    mappedUtf16Length: utf16OffsetSchema,
    humanRegion: regionSchema.nullable(),
    mappings: z.array(mappingSchema).max(1),
    quoteRegionSpace: z.literal('mapped_utf16'),
    quoteRegions: z.array(regionSchema).max(32),
    applicationWrapper: applicationWrapperSchema.nullable(),
  })
  .strict();

/** Strict Zod data shape for already-owned geometry metadata. */
export const AutonomousSourceGeometryV3OwnedDataSchema = geometryBodySchema
  .strict()
  .superRefine((geometry, context) => {
    if (geometry.mappings.length + geometry.quoteRegions.length > 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Mapping and quote region count exceeds the source geometry limit',
        path: ['mappings'],
      });
    }

    for (let index = 1; index < geometry.quoteRegions.length; index += 1) {
      if (geometry.quoteRegions[index].start < geometry.quoteRegions[index - 1].end) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Quote regions must be ascending and disjoint',
          path: ['quoteRegions', index],
        });
      }
    }
    for (const [index, region] of geometry.quoteRegions.entries()) {
      if (region.end > geometry.mappedUtf16Length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Quote region exceeds mapped source length',
          path: ['quoteRegions', index],
        });
      }
    }

    if (geometry.mode === 'full_body') {
      if (
        geometry.mappings.length !== 0 ||
        geometry.humanRegion !== null ||
        geometry.applicationWrapper !== null ||
        geometry.rawUtf16Length !== geometry.mappedUtf16Length ||
        geometry.rawContentHash !== geometry.mappedContentHash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Full-body geometry must preserve the complete source exactly',
        });
      }
    } else {
      const mapping = geometry.mappings[0];
      if (
        geometry.mappings.length !== 1 ||
        geometry.humanRegion === null ||
        geometry.applicationWrapper === null ||
        mapping === undefined ||
        mapping.rawStart !== geometry.humanRegion?.start ||
        mapping.rawEnd !== geometry.humanRegion?.end ||
        mapping.rawEnd > geometry.rawUtf16Length ||
        mapping.mappedStart !== 0 ||
        mapping.mappedEnd !== geometry.mappedUtf16Length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Application-region geometry must have one complete contiguous map',
        });
      }
      if (
        geometry.humanRegion?.start === 0 &&
        geometry.humanRegion.end === geometry.rawUtf16Length &&
        (geometry.rawUtf16Length !== geometry.mappedUtf16Length ||
          geometry.rawContentHash !== geometry.mappedContentHash)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A full-span application region must preserve source hashes and length',
        });
      }
    }

    if (Buffer.byteLength(JSON.stringify(geometry), 'utf8') > MAX_GEOMETRY_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source geometry metadata exceeds 16 KiB',
      });
    }
  });

export type AutonomousSourceGeometryV3 = z.infer<typeof AutonomousSourceGeometryV3OwnedDataSchema>;

const compilationSchema = z
  .object({
    mappedHumanBody: z.string().max(MAX_UTF16_UNITS),
    geometry: AutonomousSourceGeometryV3OwnedDataSchema,
    geometryHash: hashSchema,
  })
  .strict();
export type AutonomousSourceGeometryCompilationV3 = z.infer<typeof compilationSchema>;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isUtf16CodePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return offset >= 0 && offset <= value.length;
  const left = value.charCodeAt(offset - 1);
  const right = value.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

function sha256ExactUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function invalidGeometryData(): z.ZodError {
  return new z.ZodError([
    { code: z.ZodIssueCode.custom, path: [], message: 'invalid_source_geometry_data' },
  ]);
}

function ownGeometry(value: unknown): AutonomousSourceGeometryV3 {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'policyData');
  return AutonomousSourceGeometryV3OwnedDataSchema.parse(owned);
}

/** Bounded facade for persisted geometry. Shape validation is data-only. */
export const AutonomousSourceGeometryV3Schema = Object.freeze({
  parse(value: unknown): AutonomousSourceGeometryV3 {
    try {
      return deepFreeze(ownGeometry(value));
    } catch {
      throw invalidGeometryData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousSourceGeometryV3> {
    try {
      return { success: true, data: deepFreeze(ownGeometry(value)) };
    } catch {
      return { success: false, error: invalidGeometryData() };
    }
  },
});

/** Hash validated geometry data with the exact nested V3 source recipe. */
export function hashAutonomousSourceGeometryV3(input: unknown): string {
  try {
    const geometry = AutonomousSourceGeometryV3Schema.parse(input);
    return hashAutomaticCaptureV2({
      domain: 'engram-autonomous-geometry-v1',
      geometry,
    });
  } catch {
    throw invalidGeometryData();
  }
}

/**
 * Compile exact raw source geometry. The wrapper fingerprint and quote spans
 * remain data only; this function does not prove their application origin or
 * grant actor, store, provider, acceptance, or write authority.
 */
export function compileAutonomousSourceGeometryV3(
  input: unknown,
): AutonomousSourceGeometryCompilationV3 {
  try {
    // Own the complete raw request before any Zod parsing or property access.
    const ownedInput = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    const checked = sourceGeometryInputSchema.parse(ownedInput);
    const rawContent = checked.rawContent;
    if (
      !isWellFormedUnicode(rawContent) ||
      Buffer.byteLength(rawContent, 'utf8') > MAX_SOURCE_BYTES
    ) {
      throw invalidGeometryData();
    }

    const rawUtf16Length = rawContent.length;
    let mappedHumanBody: string;
    let mode: AutonomousSourceGeometryV3['mode'];
    let humanRegion: AutonomousSourceGeometryV3['humanRegion'];
    let mappings: AutonomousSourceGeometryV3['mappings'];
    let applicationWrapper: AutonomousSourceGeometryV3['applicationWrapper'];

    if (checked.mapping.mode === 'full_body') {
      mappedHumanBody = rawContent;
      mode = 'full_body';
      humanRegion = null;
      mappings = [];
      applicationWrapper = null;
    } else {
      const { start, end } = checked.mapping.humanRegion;
      if (
        start >= end ||
        end > rawUtf16Length ||
        !isUtf16CodePointBoundary(rawContent, start) ||
        !isUtf16CodePointBoundary(rawContent, end)
      ) {
        throw invalidGeometryData();
      }
      mappedHumanBody = rawContent.slice(start, end);
      mode = 'application_region';
      humanRegion = { start, end };
      mappings = [
        {
          rawStart: start,
          rawEnd: end,
          mappedStart: 0,
          mappedEnd: mappedHumanBody.length,
        },
      ];
      applicationWrapper = checked.mapping.applicationWrapper;
    }

    if (!isWellFormedUnicode(mappedHumanBody)) throw invalidGeometryData();
    for (const region of checked.quoteRegions) {
      if (
        region.end > mappedHumanBody.length ||
        !isUtf16CodePointBoundary(mappedHumanBody, region.start) ||
        !isUtf16CodePointBoundary(mappedHumanBody, region.end)
      ) {
        throw invalidGeometryData();
      }
    }

    const rawContentHash = sha256ExactUtf8(rawContent);
    const mappedContentHash = sha256ExactUtf8(mappedHumanBody);
    const geometry = AutonomousSourceGeometryV3OwnedDataSchema.parse({
      version: 3,
      mode,
      rawContentHash,
      mappedContentHash,
      rawUtf16Length,
      mappedUtf16Length: mappedHumanBody.length,
      humanRegion,
      mappings,
      quoteRegionSpace: 'mapped_utf16',
      quoteRegions: checked.quoteRegions,
      applicationWrapper,
    });
    const geometryHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-geometry-v1',
      geometry,
    });
    return deepFreeze(compilationSchema.parse({ mappedHumanBody, geometry, geometryHash }));
  } catch {
    throw invalidGeometryData();
  }
}
