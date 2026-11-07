import { demoFormsOrigin } from '@wma/db';
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
 * The fixture forms server's URLs (`<origin>/forms/<vendor>/...`) belong to the demo tenant's
 * seeded postings. They route to the vendor's adapter only when this worker was started in demo
 * mode (`DEMO_FORMS_ORIGIN` or `DEMO_FORMS_PORT` set) and the URL is on exactly that origin, so a
 * production worker, which has neither, routes nothing here.
 */
function demoFormsAdapter(url: string, env: NodeJS.ProcessEnv): FormAdapter | null {
  if (!env.DEMO_FORMS_ORIGIN?.trim() && !env.DEMO_FORMS_PORT?.trim()) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== new URL(demoFormsOrigin(env)).origin) return null;
  const vendor = /^\/forms\/([a-z]+)\//.exec(u.pathname)?.[1];
  return adapters.find((a) => a.ats === vendor) ?? null;
}

/**
 * Picks the adapter for a posting URL by hosted-vendor host (or, in demo mode, by the fixture
 * forms path). Anything else is the `unsupported-ats` outcome, decided without opening a browser.
 */
export function selectAdapter(url: string, env: NodeJS.ProcessEnv = process.env): AdapterSelection {
  const adapter = adapters.find((a) => a.detect(url)) ?? demoFormsAdapter(url, env);
  return adapter ? { ok: true, adapter } : { ok: false, reason: 'unsupported-ats' };
}

export function adapterFor(ats: AtsId): FormAdapter {
  const adapter = adapters.find((a) => a.ats === ats);
  if (!adapter) throw new Error(`no adapter for ${ats}`);
  return adapter;
}
