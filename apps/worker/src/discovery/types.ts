import type { AtsId, BoardRegion, Candidate, Judgment } from '@wma/shared';
import type { ProfileDocument } from '@wma/shared';
import type { Http } from '@wma/discovery';

export type SourceId = 'ashby' | 'greenhouse' | 'lever' | 'hn-who-is-hiring' | 'linkedin-public';
export type SourceStatusValue = 'ok' | 'partial' | 'unavailable';

/** A resolved board on the user's list. */
export interface BoardRef {
  companyId: string;
  companyName: string;
  ats: AtsId;
  boardSlug: string;
  /** 'eu' for the EU-hosted Lever and Greenhouse boards, '' otherwise. */
  region: BoardRegion;
}

/** A company the user removed: its postings are dropped wherever they are found. */
export interface RemovedCompany {
  name: string;
  ats: AtsId | null;
  boardSlug: string | null;
  region: string;
}

export interface SourceContext {
  http: Http;
  boards: BoardRef[];
  profile: ProfileDocument;
  now: Date;
}

export interface SourceResult {
  status: SourceStatusValue;
  candidates: Candidate[];
  /** Short reason for partial/unavailable (no secrets, no response bodies). */
  detail?: string;
  failedBoards?: string[];
}

/** One discovery source. Adapters never throw for source failures: they report a status. */
export interface SourceAdapter {
  readonly id: SourceId;
  fetch(ctx: SourceContext): Promise<SourceResult>;
}

export interface SourceStatusEntry {
  status: SourceStatusValue;
  candidates: number;
  detail?: string;
  failed_boards?: string[];
}

export type { Judgment };
