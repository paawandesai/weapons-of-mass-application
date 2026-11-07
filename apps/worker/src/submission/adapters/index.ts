import type { AtsId } from '@wma/shared';
import type { FormAdapter } from '../types';
import { ashbyAdapter } from './ashby';
import { greenhouseAdapter } from './greenhouse';
import { leverAdapter } from './lever';

export { screenshotOnFailure, findUnmappedRequired, reportUnmappedFields } from './common';
export type { UnmappedFieldOutcome } from './common';
export { classifyField } from './classify';
export { ashbyAdapter, greenhouseAdapter, leverAdapter };

export const adapters: readonly FormAdapter[] = [ashbyAdapter, greenhouseAdapter, leverAdapter];

export type AdapterSelection =
  { ok: true; adapter: FormAdapter } | { ok: false; reason: 'unsupported-ats' };

/**
 * Picks the adapter for a posting URL by hosted-vendor host. Anything else is the
 * `unsupported-ats` outcome, decided without opening a browser.
 */
export function selectAdapter(url: string): AdapterSelection {
  const adapter = adapters.find((a) => a.detect(url));
  return adapter ? { ok: true, adapter } : { ok: false, reason: 'unsupported-ats' };
}

export function adapterFor(ats: AtsId): FormAdapter {
  const adapter = adapters.find((a) => a.ats === ats);
  if (!adapter) throw new Error(`no adapter for ${ats}`);
  return adapter;
}
