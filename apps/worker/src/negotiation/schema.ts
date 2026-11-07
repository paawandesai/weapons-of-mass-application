import { z } from 'zod';

const amount = z.number().int().nonnegative().nullable();

/** Structured output of the `comparables-extract` prompt. */
export const ComparablesExtract = z.object({
  comparables: z
    .array(
      z.object({
        title: z.string().min(1),
        level: z.string().nullable(),
        location: z.string().nullable(),
        currency: z.string().nullable(),
        p25: amount,
        p50: amount,
        p75: amount,
        sample_size: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(8),
});
export type ComparablesExtract = z.infer<typeof ComparablesExtract>;

export const COMPARABLES_SOURCE = 'levels.fyi';

export interface Comparable {
  source: string;
  title: string;
  level: string | null;
  location: string | null;
  currency: string | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  sample_size: number | null;
  retrieved_at: string;
}

/** What `applications.negotiation` holds: the panel's data. */
export interface NegotiationData {
  posted_min: number | null;
  posted_max: number | null;
  currency: string | null;
  floor: number | null;
  comparables: Comparable[];
  fetched_at: string;
  /** Null when comparables were found; otherwise why not (`fetch_failed`, `extract_failed`, `no_data`). */
  error: string | null;
}
