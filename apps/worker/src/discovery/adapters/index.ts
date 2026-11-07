import { getCurrentTenant, type TenantHandle } from '@wma/db';
import type { SourceAdapter } from '../types';
import { ashbyAdapter } from './ashby';
import { greenhouseAdapter } from './greenhouse';
import { hnAdapter } from './hn';
import { leverAdapter } from './lever';
import { linkedinAdapter } from './linkedin';
import { createSeededAdapter } from './seeded';

export {
  createSeededAdapter,
  ashbyAdapter,
  greenhouseAdapter,
  hnAdapter,
  leverAdapter,
  linkedinAdapter,
};

/** Board adapters first: in-run dedupe keeps the first (board) version of a posting. */
export const defaultAdapters = (): SourceAdapter[] => [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  hnAdapter,
  linkedinAdapter,
];

/** The adapters for one tenant's run: the defaults, plus the seeded postings for the demo tenant. */
export async function adaptersFor(
  handle: TenantHandle,
  base: SourceAdapter[] = defaultAdapters(),
): Promise<SourceAdapter[]> {
  const tenant = await getCurrentTenant(handle);
  return tenant.demo ? [...base, createSeededAdapter(handle)] : base;
}
