import { z } from 'zod';
import { AutomaticCaptureBeginRequestV2Schema } from './AutomaticCapture.schema';

/** Backend-derived construction inputs; parsing them does not grant write authority. */
export const AutomaticHumanSourceBuildV2Schema = z
  .object({
    request: AutomaticCaptureBeginRequestV2Schema,
    sourceId: z.string().uuid(),
    storeHash: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: z.string().datetime(),
    previousEpisodeId: z.string().uuid().nullable(),
  })
  .strict()
  .refine((input) => input.request.purpose === 'human_turn_memory', {
    message: 'Human source construction requires human purpose',
  });
export type AutomaticHumanSourceBuildV2 = z.input<typeof AutomaticHumanSourceBuildV2Schema>;
