import type { SourceAdapter } from '../types';
import { ashbyAdapter } from './ashby';
import { greenhouseAdapter } from './greenhouse';
import { hnAdapter } from './hn';
import { leverAdapter } from './lever';
import { linkedinAdapter } from './linkedin';

export { ashbyAdapter, greenhouseAdapter, hnAdapter, leverAdapter, linkedinAdapter };

/** Board adapters first: in-run dedupe keeps the first (board) version of a posting. */
export const defaultAdapters = (): SourceAdapter[] => [
  greenhouseAdapter,
  leverAdapter,
  ashbyAdapter,
  hnAdapter,
  linkedinAdapter,
];
