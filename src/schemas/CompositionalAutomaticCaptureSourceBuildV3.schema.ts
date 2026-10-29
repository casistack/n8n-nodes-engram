import { z } from 'zod';
import {
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  type CompositionalAutomaticCaptureBeginRequestV3Input,
} from './CompositionalAutomaticCaptureV3.schema';

const canonicalBackendTimestamp = z
  .string()
  .datetime({ precision: 3 })
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  }, 'Backend capture time must be canonical millisecond-precision UTC');

/** Backend-derived source-construction inputs; parsing grants no write authority. */
export const CompositionalAutomaticHumanSourceBuildV3Schema = z
  .object({
    request: CompositionalAutomaticCaptureBeginRequestV3Schema,
    sourceId: z.string().uuid(),
    storeHash: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: canonicalBackendTimestamp,
    previousEpisodeId: z.string().uuid().nullable(),
  })
  .strict();

type CompositionalAutomaticHumanSourceBuildV3SchemaInput = z.input<
  typeof CompositionalAutomaticHumanSourceBuildV3Schema
>;
export type CompositionalAutomaticHumanSourceBuildV3 = Omit<
  CompositionalAutomaticHumanSourceBuildV3SchemaInput,
  'request'
> & { request: CompositionalAutomaticCaptureBeginRequestV3Input };
